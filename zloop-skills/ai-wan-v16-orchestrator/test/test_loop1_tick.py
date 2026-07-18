import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from unittest import mock


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(SCRIPT_DIR))

import aiwan_inline_state_machine as core  # noqa: E402
import aiwan_loop1_tick as tick  # noqa: E402


class LocalHubResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._body = body

    def json(self):
        return self._body


class LocalAiwanHub:
    """Translate canonical zloop Runtime paths to a local model-tag-monitor."""

    def __init__(self, port):
        self.base_url = f"http://127.0.0.1:{port}"

    def post(self, path, json_body, timeout=90.0):
        return self._request("POST", path, json_body=json_body, timeout=timeout)

    def get(self, path, params=None, timeout=90.0):
        return self._request("GET", path, params=params, timeout=timeout)

    def _request(self, method, path, json_body=None, params=None, timeout=90.0):
        local_path = path.removeprefix("/v2/aiwan")
        if params:
            local_path += "?" + urllib.parse.urlencode(params)
        data = json.dumps(json_body).encode("utf-8") if json_body is not None else None
        request = urllib.request.Request(
            self.base_url + local_path,
            data=data,
            method=method,
            headers={"content-type": "application/json"} if data is not None else {},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return LocalHubResponse(response.status, json.loads(response.read().decode("utf-8")))
        except urllib.error.HTTPError as exc:
            return LocalHubResponse(exc.code, json.loads(exc.read().decode("utf-8")))


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for_server(hub, process):
    deadline = time.time() + 5
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"model-tag-monitor exited early: {process.returncode}")
        try:
            response = hub.get("/v2/aiwan/api/health", timeout=0.5)
            if response.ok:
                return
        except OSError:
            pass
        time.sleep(0.05)
    raise RuntimeError("model-tag-monitor did not become ready")


class FakeJobClient:
    def __init__(self):
        self.job = None
        self.handoff = None
        self.handoff_create_attempts = 0
        self.fail_handoff_once = False
        self.updates = []
        self.claims = []
        self.conflict_next = False
        self.create_conflict_next = False

    def create(self, payload):
        if payload["kind"] == "drilldown":
            self.handoff_create_attempts += 1
            if self.fail_handoff_once:
                self.fail_handoff_once = False
                raise RuntimeError("injected handoff create failure")
            if self.handoff is None:
                self.handoff = {**payload, "job_id": f"drilldown:{payload['analysis_key']}:b{payload['base_revision']}:h1", "state_revision": 1}
            return json.loads(json.dumps(self.handoff))
        if self.create_conflict_next:
            self.create_conflict_next = False
            raise tick.JobApiError("AIWAN_JOB_API_FAILED", "downstream 409 create conflict", 502)
        if self.job is None:
            self.job = {
                **payload,
                "job_id": f"base:{payload['analysis_key']}:b{payload['base_revision']}:h0",
                "state_revision": 1,
                "status": "ready",
                "lease_owner": None,
                "lease_expires_at": None,
                "execute_ids": {},
                "sql_checkpoints": {},
            }
        return self._copy()

    def get(self, analysis_key, base_revision):
        return self._copy()

    def claim(self, analysis_key, payload):
        self._assert_revision(payload)
        self.claims.append({"status_before": self.job["status"], **json.loads(json.dumps(payload))})
        self.job["status"] = "claimed" if self.job["status"] in {"ready", "retryable_failed"} else self.job["status"]
        self.job["lease_owner"] = payload["worker_id"]
        self.job["lease_expires_at"] = "2999-01-01T00:00:00.000Z"
        self.job["state_revision"] += 1
        return self._copy()

    def update(self, analysis_key, payload):
        if self.conflict_next:
            self.conflict_next = False
            raise tick.JobApiError("JOB_STATE_REVISION_CONFLICT", "injected CAS conflict", 409)
        self._assert_revision(payload)
        self.job["status"] = payload["status"]
        if payload.get("current_stage"):
            self.job["current_stage"] = payload["current_stage"]
        for name, checkpoint in (payload.get("sql_checkpoints") or {}).items():
            self.job["sql_checkpoints"][name] = {**self.job["sql_checkpoints"].get(name, {}), **checkpoint}
            if checkpoint.get("execute_id"):
                self.job["execute_ids"][name] = checkpoint["execute_id"]
        for key in ("artifact_uri", "artifact_hash", "error"):
            if key in payload:
                self.job[key] = payload[key]
        if payload["status"] in {"retryable_failed", "failed", "published", "superseded"}:
            self.job["lease_owner"] = None
            self.job["lease_expires_at"] = None
        self.job["state_revision"] += 1
        self.updates.append(json.loads(json.dumps(payload)))
        return self._copy()

    def _assert_revision(self, payload):
        if payload["expected_state_revision"] != self.job["state_revision"]:
            raise tick.JobApiError("JOB_STATE_REVISION_CONFLICT", "stale", 409)

    def _copy(self):
        return json.loads(json.dumps(self.job))


class FakeXinghe:
    def __init__(self):
        self.submissions = []
        self.statuses = {}

    def run_hive_sql(self, **kwargs):
        execute_id = f"exec-{len(self.submissions) + 1}"
        self.submissions.append({"execute_id": execute_id, **kwargs})
        self.statuses[execute_id] = "RUNNING"
        return {"execute_id": execute_id}

    def check_sql_status(self, execute_id=None, execute_ids=None):
        target = execute_id or execute_ids[0]
        return {"execute_id": target, "status": self.statuses[target]}


VALID_DISPLAY = {
    "board": "大盘风险等级中等，链路上估价到下单承压，拖累来自手机，下一步验证下单转化。",
    "category": "全局品类概览：以手机为主。",
    "monitor": "监测：关注手机口径稳定性。",
    "tiers": {
        "发展": "发展层风险集中，成交GMV下降，需下钻验证。",
        "孵化": "孵化层机会，成交订单提升，观察下单率。",
        "种子": "种子层风险，成交率波动，先验证口径。",
    },
    "secondaryCategories": {"电脑办公": "电脑办公板块贡献，链路看下单到发货。"},
    "categories": {},
}


def advance_to_published(args, jobs, xinghe, adapter):
    """模拟 agent 写好合规 analysis_result 后，再跑一跳 finalize 到 published。"""
    run_dir = tick.core.out_root() / "aiwan_runs" / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / tick.ANALYSIS_RESULT_FILE).write_text(
        json.dumps({"display_insights": VALID_DISPLAY}, ensure_ascii=False), encoding="utf-8"
    )
    return tick.run_tick(args, jobs, xinghe, adapter)


class FakeAdapter:
    def render_sqls(self, args, export_dir):
        export_dir.mkdir(parents=True, exist_ok=True)
        result = {}
        for name in tick.BASE_SCRIPTS:
            sql = f"select '{name}', '${{hiveconf:end_date}}';".replace("${hiveconf:end_date}", args.data_end_date)
            path = export_dir / f"{name}_{args.run_dt}.sql"
            path.write_text(sql, encoding="utf-8")
            result[name] = {"sql": sql, "path": str(path), "sha256": hashlib.sha256(sql.encode()).hexdigest()}
        return result

    def materialize(self, execute_id, csv_path, debug_dir, script_name):
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        csv_path.write_text("week_start_date,cate_name\n2026-07-13,手机\n", encoding="utf-8")
        return 1

    def package_base(self, args, export_dir, raw_root):
        raw_root.mkdir(parents=True, exist_ok=True)
        for name in ("active_fetch_manifest.json", f"sql_status_{args.run_dt}.json", f"raw_manifest_{args.run_dt}.json"):
            (raw_root / name).write_text("{}\n", encoding="utf-8")
        (raw_root / f"raw_cache_{args.run_dt}.zip").write_bytes(b"fake")
        return {"status": "success", "raw_cache_sha256": "fake-sha", "warnings": []}

    def process(self, args, run_dir, read_result):
        return {"status": "success", "output_type": "processed_data"}

    def analyze(self, args, run_dir, processed):
        return {"status": "success", "output_type": "analysis_result"}

    def validate(self, args, run_dir, processed, analysis):
        return {"status": "success", "output_type": "validation_result", "server_write_confirmed": True}


def make_args():
    return argparse.Namespace(
        run_id="loop1-test-run",
        week="2026-W29",
        run_dt="2026-07-17",
        data_end_date="2026-07-16",
        analysis_key="2026-W29:2026-07-16",
        base_revision=1,
        worker_id="loop1-test-worker",
        lease_seconds=3600,
        base_deadline_at=None,
        process_timeout_seconds=30,
    )


class Loop1TickTests(unittest.TestCase):
    def test_real_node_control_plane_persists_cross_tick_publish_and_handoff(self):
        with tempfile.TemporaryDirectory() as data_dir, tempfile.TemporaryDirectory() as output_dir:
            port = free_port()
            process = subprocess.Popen(
                ["node", "src/server.js"],
                cwd=REPO_ROOT / "model-tag-monitor",
                env={**os.environ, "DATA_DIR": data_dir, "PORT": str(port), "ACCESS_CODE": "LOOP1_INTEGRATION_TEST"},
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            hub = LocalAiwanHub(port)
            try:
                wait_for_server(hub, process)
                jobs = tick.HubJobClient(hub)
                xinghe = FakeXinghe()
                args = make_args()
                args.run_id = "loop1-http-integration"
                args.analysis_key = "2026-W29:2026-07-16-http-integration"
                args.worker_id = "loop1:http-integration:b1"
                adapter = FakeAdapter()

                with mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": output_dir}):
                    first = tick.run_tick(args, jobs, xinghe, adapter)
                    self.assertEqual(first["business_status"], "pending")
                    self.assertEqual(len(xinghe.submissions), 2)

                    second = tick.run_tick(args, jobs, xinghe, adapter)
                    self.assertEqual(second["business_status"], "pending")
                    self.assertEqual(len(xinghe.submissions), 2)

                    for execute_id in list(xinghe.statuses):
                        xinghe.statuses[execute_id] = "SUCCESS"
                    third = tick.run_tick(args, jobs, xinghe, adapter)
                    self.assertEqual(third["business_status"], "pending")
                    self.assertEqual(len(xinghe.submissions), 4)

                    for execute_id in list(xinghe.statuses):
                        xinghe.statuses[execute_id] = "SUCCESS"
                    fourth = tick.run_tick(args, jobs, xinghe, adapter)
                    self.assertEqual(fourth["business_status"], "analyze_pending")
                    fourth = advance_to_published(args, jobs, xinghe, adapter)

                self.assertEqual(fourth["business_status"], "published")
                self.assertEqual(fourth["handoff_status"], "ready")
                self.assertEqual(len(xinghe.submissions), 4)

                base = jobs.get(args.analysis_key, 1)
                self.assertEqual(base["status"], "published")
                self.assertEqual(set(base["sql_checkpoints"]), set(tick.BASE_SCRIPTS))
                self.assertTrue(all(item["status"] == "SUCCESS" for item in base["sql_checkpoints"].values()))
                created = datetime.fromisoformat(base["created_at"].replace("Z", "+00:00"))
                deadline = datetime.fromisoformat(base["base_deadline_at"].replace("Z", "+00:00"))
                self.assertEqual((deadline - created).total_seconds(), 3600)

                handoff = jobs.get(args.analysis_key, 1, kind="drilldown", handoff_revision=1)
                self.assertEqual(handoff["status"], "ready")
                self.assertEqual(handoff["model_enrichment_mode"], "disabled")
                self.assertIsNone(handoff["sla_deadline"])
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
                if process.stdout:
                    process.stdout.read()
                    process.stdout.close()
                stderr = process.stderr.read() if process.stderr else ""
                if process.stderr:
                    process.stderr.close()
                self.assertEqual(stderr, "")

    def test_default_run_and_worker_ids_are_stable_across_ticks(self):
        args = make_args()
        args.run_id = None
        args.worker_id = None
        args.analysis_key = None
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AIWAN_LOOP1_WORKER_ID", None)
            first = tick.apply_runtime_defaults(args)
        self.assertEqual(first.run_id, "loop1-2026-W29-2026-07-16-r1")
        self.assertEqual(first.worker_id, "loop1:2026-W29:2026-07-16:b1")
        second = tick.apply_runtime_defaults(argparse.Namespace(**vars(first)))
        self.assertEqual(second.run_id, first.run_id)
        self.assertEqual(second.worker_id, first.worker_id)

    def test_hub_job_client_uses_fixed_read_write_paths_and_actions(self):
        class Response:
            ok = True
            status_code = 200

            def json(self):
                return {"ok": True, "job": {"state_revision": 3}}

        class Hub:
            def __init__(self):
                self.posts = []

            def post(self, path, json_body, timeout):
                self.posts.append((path, json_body, timeout))
                return Response()

        hub = Hub()
        client = tick.HubJobClient(hub)
        client.create({"kind": "base", "analysis_key": "2026-W29:2026-07-16"})
        client.get("2026-W29:2026-07-16", 1)
        client.claim("2026-W29:2026-07-16", {"expected_state_revision": 1})
        result = client.update("2026-W29:2026-07-16", {"status": "sql_running"})
        self.assertEqual(result["state_revision"], 3)
        self.assertEqual([item[0] for item in hub.posts], [
            tick.JOBS_WRITE_PATH,
            tick.JOBS_READ_PATH,
            tick.JOBS_WRITE_PATH,
            tick.JOBS_WRITE_PATH,
        ])
        self.assertNotIn("action", hub.posts[1][1])
        self.assertEqual([hub.posts[index][1]["action"] for index in (0, 2, 3)], ["create", "claim", "state"])
        self.assertTrue(all(item[1]["analysis_key"] == "2026-W29:2026-07-16" for item in hub.posts))

    def test_submit_once_resume_without_resubmit_then_publish(self):
        jobs = FakeJobClient()
        xinghe = FakeXinghe()
        adapter = FakeAdapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            first = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(first["business_status"], "pending")
            self.assertEqual(tick.exit_code_for(first), 0)
            self.assertEqual(len(xinghe.submissions), 2)
            submitted_updates = [u for u in jobs.updates if u.get("sql_checkpoints")]
            self.assertEqual(len(submitted_updates), 2, "every execute_id is checkpointed immediately")

            second = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(second["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 2, "pending execute_ids are polled, never resubmitted")
            self.assertEqual(len(jobs.claims), 2, "same owner renews its active lease at every tick")
            self.assertEqual(jobs.claims[1]["status_before"], "sql_submitted", "renew keeps durable SQL progress instead of restarting")

            for execute_id in list(xinghe.statuses):
                xinghe.statuses[execute_id] = "SUCCESS"
            third = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(third["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 4)

            for execute_id in list(xinghe.statuses):
                xinghe.statuses[execute_id] = "SUCCESS"
            jobs.fail_handoff_once = True
            fourth = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(fourth["business_status"], "analyze_pending")
            fourth = advance_to_published(args, jobs, xinghe, adapter)
            self.assertEqual(fourth["business_status"], "published")
            self.assertEqual(tick.exit_code_for(fourth), 0)
            self.assertEqual(len(xinghe.submissions), 4)
            self.assertEqual(jobs.job["status"], "published")
            self.assertEqual(fourth["handoff_status"], "retryable_failed")
            self.assertIsNone(jobs.handoff)

            fifth = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(fifth["business_status"], "published")
            self.assertEqual(fifth["handoff_status"], "ready", "a published base retries a previously failed handoff create")
            self.assertEqual(jobs.handoff["kind"], "drilldown")
            self.assertEqual(jobs.handoff["handoff_revision"], 1)
            self.assertEqual(jobs.handoff["model_enrichment_mode"], "disabled")
            self.assertIsNone(jobs.handoff.get("sla_deadline"))
            self.assertEqual(len(xinghe.submissions), 4)


    def test_create_conflict_recovers_existing_job_without_resubmitting_sql(self):
        jobs = FakeJobClient()
        xinghe = FakeXinghe()
        adapter = FakeAdapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            first = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(first["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 2)
            jobs.create_conflict_next = True
            second = tick.run_tick(args, jobs, xinghe, adapter)
        self.assertEqual(second["business_status"], "pending")
        self.assertEqual(second["reason"], "sql_not_ready")
        self.assertEqual(tick.exit_code_for(second), 0)
        self.assertEqual(len(xinghe.submissions), 2, "existing execute_ids are recovered after create conflict")
        self.assertEqual(len(jobs.claims), 2, "recovered job continues into normal claim/renew flow")


    def test_reclaimed_claimed_job_with_completed_sql_resumes_materializing(self):
        jobs = FakeJobClient()
        xinghe = FakeXinghe()
        adapter = FakeAdapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            first = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(first["business_status"], "pending")
            for execute_id in list(xinghe.statuses):
                xinghe.statuses[execute_id] = "SUCCESS"
            second = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(second["business_status"], "pending")
            for execute_id in list(xinghe.statuses):
                xinghe.statuses[execute_id] = "SUCCESS"

            # Simulate the production stuck shape after an expired/retryable tick:
            # all SQL checkpoints are complete, but the server returns status=claimed.
            jobs.job["status"] = "claimed"
            jobs.job["current_stage"] = "read"
            before_submissions = len(xinghe.submissions)
            result = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(result["business_status"], "analyze_pending")
            result = advance_to_published(args, jobs, xinghe, adapter)

        self.assertEqual(result["business_status"], "published")
        self.assertEqual(len(xinghe.submissions), before_submissions, "completed SQLs must not be resubmitted")
        statuses = [u["status"] for u in jobs.updates]
        self.assertIn("sql_submitted", statuses)
        self.assertIn("materializing", statuses)
        self.assertEqual(jobs.job["status"], "published")

    def test_terminal_sql_failure_retries_twice_then_is_final(self):
        jobs = FakeJobClient()
        xinghe = FakeXinghe()
        adapter = FakeAdapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            first = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(first["business_status"], "pending")
            xinghe.statuses["exec-1"] = "FAILED"
            second = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(second["business_status"], "pending")
            self.assertEqual(second["reason"], "sql_terminal_retry_scheduled")
            self.assertEqual(tick.exit_code_for(second), 0)
            self.assertEqual(jobs.job["sql_checkpoints"]["category_daily_avg"]["retry_count"], 1)

            third = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(third["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 3)
            xinghe.statuses["exec-3"] = "FAILED"
            fourth = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(fourth["business_status"], "pending")
            self.assertEqual(jobs.job["sql_checkpoints"]["category_daily_avg"]["retry_count"], 2)

            fifth = tick.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(fifth["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 4)
            xinghe.statuses["exec-4"] = "FAILED"
            sixth = tick.run_tick(args, jobs, xinghe, adapter)

        self.assertEqual(sixth["business_status"], "failed")
        self.assertEqual(tick.exit_code_for(sixth), 1)
        self.assertEqual(jobs.job["status"], "failed")
        self.assertEqual(jobs.job["error"]["code"], "SQL_TERMINAL_FAILED")
        self.assertEqual(jobs.job["sql_checkpoints"]["category_daily_avg"]["retry_count"], 2)
        self.assertEqual(len(xinghe.submissions), 4)

    def test_cas_conflict_is_a_pending_tick_with_zero_exit(self):
        jobs = FakeJobClient()
        jobs.conflict_next = True
        xinghe = FakeXinghe()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            result = tick.run_tick(args, jobs, xinghe, FakeAdapter())
        self.assertEqual(result["business_status"], "pending")
        self.assertEqual(result["reason"], "job_state_revision_conflict")
        self.assertEqual(tick.exit_code_for(result), 0)

    def test_analyze_does_not_require_unwritten_previous_stage_outputs(self):
        captured = {}

        def fake_hub_post(path, body, timeout=0):
            captured.update(body)
            return {"ok": True, "run_id": "loop1-test-run", "context": {}}

        evidence = {
            "board": {"risk_level": "低", "chain_breakpoint": "链路稳定", "delta": {}},
            "evidence_index": {"cat:手机": {}},
            "category_top_changes": [{"category": "手机", "evidence_id": "cat:手机", "risk_level": "低", "chain_breakpoint": "链路稳定", "delta": {}, "cur": {}}],
            "cluster_top_changes": [],
            "tier_changes": {},
            "category_all": [],
            "model_contributors": [],
            "fulfillment_breakpoints": [],
            "data_quality_notes": [],
            "latest_week": "2026-W29",
            "prev_week": "2026-W28",
        }
        display = {"board": "x", "tiers": {}, "secondaryCategories": {}, "categories": {}, "category": "x", "monitor": "x", "warnings": []}
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(core, "hub_post", side_effect=fake_hub_post), mock.patch.object(core, "build_analysis_evidence", return_value=evidence), mock.patch.object(core, "make_findings", return_value=[{"id": "x"}]), mock.patch.object(core, "build_display_insights", return_value=display):
            core.execute_analyze(args, Path(tmp), {"process_summary": {}})
        self.assertNotIn("previous_stage_outputs", captured["include"])
        self.assertEqual(captured["input_type"], "metric_snapshot")


    def test_analyze_outputs_v155_old_server_contract_artifacts(self):
        captured = {}

        def fake_hub_post(path, body, timeout=0):
            captured.update(body)
            return {"ok": True, "run_id": "loop1-test-run", "context": {}}

        evidence = {
            "latest_week": "2026-W29",
            "prev_week": "2026-W28",
            "board": {"risk_level": "中", "chain_breakpoint": "成交量承压", "delta": {"gmv_delta": -1000, "deal_delta": -3, "avg_price_delta": 12}},
            "evidence_index": {
                "CAT_GMV_DOWN_001": {"section": "category_top_changes", "offset": 0, "source": "processed_data.category-cache"},
                "CLUSTER_GMV_DOWN_001": {"section": "cluster_top_changes", "offset": 0, "source": "processed_data.category-cache"},
            },
            "category_top_changes": [{
                "evidence_id": "CAT_GMV_DOWN_001",
                "category": "手机",
                "tier": "发展",
                "secondaryCategory": "手机通讯",
                "risk_level": "中",
                "direction": "down",
                "chain_breakpoint": "成交量承压",
                "cur": {"gmv": 1000, "dealCnt": 5},
                "prev": {"gmv": 2000, "dealCnt": 8},
                "delta": {"gmv_delta": -1000, "deal_delta": -3, "avg_price_delta": 12},
                "top_model": {"name": "iPhone 15", "gmv": 800, "dealCnt": 3},
            }],
            "cluster_top_changes": [{
                "evidence_id": "CLUSTER_GMV_DOWN_001",
                "name": "手机通讯",
                "risk_level": "中",
                "direction": "down",
                "cur": {"gmv": 1000, "dealCnt": 5},
                "prev": {"gmv": 2000, "dealCnt": 8},
                "delta": {"gmv_delta": -1000, "deal_delta": -3, "avg_price_delta": 12},
                "drag_categories": [{"category": "手机", "evidence_id": "CAT_GMV_DOWN_001"}],
                "opportunity_categories": [],
                "top_categories": [{"category": "手机", "evidence_id": "CAT_GMV_DOWN_001"}],
                "category_count": 1,
            }],
            "tier_changes": {},
            "category_all": [],
            "model_contributors": [],
            "fulfillment_breakpoints": [],
            "data_quality_notes": ["history_insufficient"],
            "known_gaps": ["history_insufficient"],
        }
        display = {"board": "风险等级中，链路存在拖累，下一步验证", "category": "品类判断", "monitor": "持续观察", "tiers": {"发展": "风险与机会并存，需要下钻验证成交GMV", "孵化": "风险与机会并存，需要下钻验证成交GMV", "种子": "风险与机会并存，需要下钻验证成交GMV"}, "secondaryCategories": {"手机通讯": "二级类目判断"}, "categories": {"手机": "手机品类判断"}, "warnings": ["history_insufficient"]}
        args = make_args()
        processed = {"process_summary": {"history_weeks_available": 2, "analysis_scope_hint": "wow_only"}}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(core, "hub_post", side_effect=fake_hub_post), mock.patch.object(core, "build_analysis_evidence", return_value=evidence), mock.patch.object(core, "build_display_insights", return_value=display):
            result = core.execute_analyze(args, Path(tmp), processed)
        self.assertEqual(result["display_contract"], core.DISPLAY_CONTRACT)
        self.assertIn("insights", result)
        self.assertIn("summary", result)
        self.assertIn("review_notes", result)
        self.assertIn("analysis_trace", result)
        self.assertEqual(result["analysis_scope"], "wow_only")
        self.assertEqual(result["model_trace"]["primary"], "GLM-5.2")
        self.assertEqual(result["model_trace"]["reviewer"], "DeepSeek V4 Pro")
        self.assertTrue(all(eid.startswith(("CAT_", "CLUSTER_", "MODEL_", "FULFILL_", "TREND_", "DQ_", "GAP_", "CORE_")) for finding in result["findings"] for eid in finding.get("evidence_ids", [])))
        self.assertIn("evidence_ids", result["insights"]["key_findings"][0])
        self.assertNotIn("previous_stage_outputs", captured["include"])

    def test_validate_requires_exact_reread_revision(self):
        args = make_args()
        tier_text = "风险与机会并存，需要下钻验证成交GMV"
        analysis = {
            "display_contract": core.DISPLAY_CONTRACT,
            "history_weeks": 8,
            "findings": [{"id": "x"}],
            "evidence_pack": {
                "evidence_index": {"cat:手机": {}},
                "category_top_changes": [{}],
                "cluster_top_changes": [{}],
                "model_contributors": [],
                "fulfillment_breakpoints": [],
            },
            "display_insights": {
                "board": "风险等级高，链路存在拖累，下一步验证",
                "category": "品类判断",
                "monitor": "持续观察",
                "tiers": {"发展": tier_text, "孵化": tier_text, "种子": tier_text},
                "secondaryCategories": {"手机通讯": "二级类目判断"},
                "categories": {"手机": "手机品类判断"},
            },
        }
        calls = []
        args.base_started_at = "2026-07-17T06:30:00+08:00"
        args.base_sla_deadline = "2026-07-17T07:30:00+08:00"

        def matching_hub(path, body, timeout=0):
            calls.append(body)
            if len(calls) == 1:
                return {"ok": True, "revision": 7}
            return {"ok": True, "run_id": args.run_id, "current_output": {"run_id": args.run_id, "revision": 7, "output_type": "validation_result"}, "context": {"metric_snapshot": {"analysisStatus": {"analysis_key": args.analysis_key, "data_end_date": args.data_end_date, "base_revision": args.base_revision, "deliveryState": "base_published", "model_enrichment_mode": "disabled"}}}}

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(core, "hub_post", side_effect=matching_hub):
            result = core.execute_validate(args, Path(tmp), {"status": "success"}, analysis)
        self.assertTrue(result["server_write_confirmed"])
        self.assertNotIn("previous_stage_outputs", calls[1]["include"])
        self.assertIn("metric_snapshot", calls[1]["include"])
        self.assertEqual(calls[0]["analysis_key"], args.analysis_key)
        self.assertEqual(calls[0]["data_end_date"], args.data_end_date)
        self.assertEqual(calls[0]["base_revision"], args.base_revision)
        self.assertEqual(calls[0]["model_enrichment_mode"], "disabled")
        self.assertEqual(calls[0]["base_started_at"], args.base_started_at)
        self.assertEqual(calls[0]["base_sla_deadline"], args.base_sla_deadline)

        def mismatching_hub(path, body, timeout=0):
            if body.get("stage") == "validate" and "payload" in body:
                return {"ok": True, "revision": 8}
            return {"ok": True, "run_id": args.run_id, "current_output": {"run_id": args.run_id, "revision": 8, "output_type": "validation_result"}, "context": {"metric_snapshot": {"analysisStatus": {"analysis_key": args.analysis_key, "data_end_date": "2026-07-15", "base_revision": args.base_revision, "deliveryState": "base_published", "model_enrichment_mode": "disabled"}}}}

        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(core, "hub_post", side_effect=mismatching_hub):
            with self.assertRaisesRegex(RuntimeError, "VALIDATE_REREAD_MISMATCH"):
                core.execute_validate(args, Path(tmp), {"status": "success"}, analysis)


if __name__ == "__main__":
    unittest.main()

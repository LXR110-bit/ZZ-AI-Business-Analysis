"""任务B（第二波）：Loop2 跨 tick 状态机——领交接单、机型 SQL 异步、增量发布。"""
import argparse
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

import aiwan_loop2_tick as loop2  # noqa: E402
from test_loop1_tick import FakeXinghe  # noqa: E402


class FakeDrilldownClient:
    """维护 base job + drilldown 交接单，支持 get/claim/update（CAS）。"""

    def __init__(self, handoff, base_job=None):
        self.handoff = handoff
        self.base_job = base_job if base_job is not None else {
            "job_id": "base:2026-W29:2026-07-16:b1",
            "kind": "base",
            "analysis_key": "2026-W29:2026-07-16",
            "week": "2026-W29",
            "data_end_date": "2026-07-16",
            "base_revision": 1,
            "status": "published",
            "publication_status": "published",
            "deliveryState": "base_published",
            "state_revision": 9,
            "model_enrichment_mode": "disabled",
        }
        self.updates = []
        self.claims = []

    def get(self, analysis_key, base_revision, kind="drilldown", handoff_revision=1):
        if kind == "base":
            return json.loads(json.dumps(self.base_job)) if self.base_job is not None else {}
        return self._copy()

    def claim(self, analysis_key, payload):
        self._assert(payload)
        self.claims.append(json.loads(json.dumps(payload)))
        if self.handoff["status"] in {"ready", "retryable_failed"}:
            self.handoff["status"] = "claimed"
        self.handoff["lease_owner"] = payload["worker_id"]
        self.handoff["lease_expires_at"] = "2999-01-01T00:00:00.000Z"
        self.handoff["state_revision"] += 1
        return self._copy()

    def update(self, analysis_key, payload):
        self._assert(payload)
        self.handoff["status"] = payload["status"]
        if payload.get("current_stage"):
            self.handoff["current_stage"] = payload["current_stage"]
        for name, cp in (payload.get("sql_checkpoints") or {}).items():
            self.handoff.setdefault("sql_checkpoints", {})
            self.handoff["sql_checkpoints"][name] = {**self.handoff["sql_checkpoints"].get(name, {}), **cp}
            if cp.get("execute_id"):
                self.handoff.setdefault("execute_ids", {})[name] = cp["execute_id"]
        for key in ("error", "warnings"):
            if key in payload:
                self.handoff[key] = payload[key]
        if payload["status"] in {"retryable_failed", "failed", "published", "superseded"}:
            self.handoff["lease_owner"] = None
            self.handoff["lease_expires_at"] = None
        self.handoff["state_revision"] += 1
        self.updates.append(json.loads(json.dumps(payload)))
        return self._copy()

    def _assert(self, payload):
        if payload["expected_state_revision"] != self.handoff["state_revision"]:
            raise loop2.JobApiError("JOB_STATE_REVISION_CONFLICT", "stale", 409)

    def _copy(self):
        return json.loads(json.dumps(self.handoff))


def make_handoff(**over):
    base = {
        "job_id": "drilldown:2026-W29:2026-07-16:b1:h1",
        "kind": "drilldown", "analysis_key": "2026-W29:2026-07-16",
        "week": "2026-W29", "data_end_date": "2026-07-16",
        "base_revision": 1, "handoff_revision": 1, "state_revision": 1,
        "status": "ready", "current_stage": "read",
        "model_enrichment_mode": "enabled",
        "drilldown_categories": [{"category": "组装机", "tier": "发展", "reason": "always_floor", "moved_metrics": ["gmv"]}],
        "sql_checkpoints": {}, "execute_ids": {},
        "lease_owner": None, "lease_expires_at": None,
    }
    base.update(over)
    return base


def make_args():
    return argparse.Namespace(
        run_id="loop2-test-run", week="2026-W29", run_dt="2026-07-17",
        data_end_date="2026-07-16", analysis_key="2026-W29:2026-07-16",
        base_revision=1, worker_id="loop2-test-worker", lease_seconds=3600,
    )


BASE_DISPLAY = {
    "board": "大盘风险等级中等，链路承压，拖累来自组装机，下一步验证。",
    "category": "全局品类概览。", "monitor": "监测口径。",
    "tiers": {"发展": "发展层风险，成交GMV下降，需下钻验证。"},
    "secondaryCategories": {"电脑办公": "电脑办公板块贡献。"},
    "categories": {"组装机": "组装机属于高影响风险品类，成交GMV下降需下钻。"},
}


class FakeLoop2Adapter:
    def __init__(self, core_present=True, history_failures=0, history_rows=None):
        self.core_present = core_present
        self.history_failures = history_failures
        self.history_rows = history_rows
        self.history_reads = []
        self.validated = None

    def render_model_sqls(self, args, export_dir, categories):
        export_dir.mkdir(parents=True, exist_ok=True)
        out = {}
        cats = "','".join(c["category"] if isinstance(c, dict) else c for c in categories)
        for name in loop2.MODEL_SCRIPTS:
            sql = f"select 1 from t where a.cate_name in ('{cats}'); -- {name}"
            path = export_dir / f"{name}_{args.run_dt}.sql"
            path.write_text(sql, encoding="utf-8")
            out[name] = {"sql": sql, "path": str(path), "sha256": hashlib.sha256(sql.encode()).hexdigest()}
        return out

    def materialize(self, execute_id, csv_path, debug_dir, script_name):
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        csv_path.write_text("cate_name,model_id\n组装机,1001\n", encoding="utf-8")
        return 1

    def process_models(self, args, run_dir, read_result, categories):
        model_rows = [
            {"category": "组装机", "model_id": "1001", "model_name": "主机A", "gmv": 5000, "gmv_delta": -800, "gmv_delta_pct": -0.3},
            {"category": "组装机", "model_id": "2002", "model_name": "主机B", "gmv": 100, "gmv_delta": -200, "gmv_delta_pct": -0.02},
        ]
        core = {"组装机": [{"model_id": "1001", "model_name": "主机A"}]} if self.core_present else None
        by_cat, warnings = loop2.select_candidate_models(model_rows, core_models=core, top_n=1, anomaly_cap=1)
        coverage = loop2.compute_coverage_by_category(by_cat, model_rows)
        return {"status": "success", "candidate_models": by_cat, "coverage_by_category": coverage, "warnings": warnings}

    def read_server_history_context(self, args, candidate_models):
        self.history_reads.append(json.loads(json.dumps(candidate_models)))
        if self.history_failures > 0:
            self.history_failures -= 1
            raise RuntimeError("temporary history read failure")
        return {
            "ok": True,
            "context": {
                "model_history": {
                    "status": "ok",
                    "weeks": ["2026-W27", "2026-W28", "2026-W29"],
                    "rows": self.history_rows or [
                        {"week": "2026-W27", "category": "组装机", "modelId": "1001", "modelName": "主机A", "gmv": 9000, "daysReceived": 7},
                        {"week": "2026-W28", "category": "组装机", "modelId": "1001", "modelName": "主机A", "gmv": 7000, "daysReceived": 7},
                        {"week": "2026-W29", "category": "组装机", "modelId": "1001", "modelName": "主机A", "gmv": 5000, "daysReceived": 7},
                    ],
                },
                "previous_model_drilldowns": {
                    "status": "ok",
                    "week": "2026-W28",
                    "modelDrilldowns": {"组装机": {"models": [{"model_id": "1001"}]}},
                },
                "rules": {"rules": {"waveThreshold": 0.1}, "version": "rules-test"},
                "loop2_context_meta": {"base_revision": 1, "core_models_snapshot_version": "core-test"},
            },
        }

    def read_base_display(self, args):
        return json.loads(json.dumps(BASE_DISPLAY))

    def validate(self, args, run_dir, merged_display):
        self.validated = merged_display
        return {"status": "success", "server_write_confirmed": True}


def advance_to_published(args, jobs, xinghe, adapter, model_drilldowns=None):
    run_dir = loop2.core.out_root() / "aiwan_runs" / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    drill = model_drilldowns or {"组装机": {"status": "complete", "attribution_status": "sufficient",
                                            "coverage": 0.8, "summary": "1001 机型贡献主要降幅。",
                                            "models": [{"model_id": "1001", "facts": ["1001 成交GMV下降"],
                                                        "hypotheses": [], "data_gaps": []}],
                                            "verification_questions": [], "warnings": []}}
    (run_dir / loop2.MODEL_ANALYSIS_RESULT_FILE).write_text(
        json.dumps({"modelDrilldowns": drill}, ensure_ascii=False), encoding="utf-8")
    return loop2.run_tick(args, jobs, xinghe, adapter)


class Loop2TickTests(unittest.TestCase):
    def test_pending_when_no_ready_handoff(self):
        jobs = FakeDrilldownClient(make_handoff(status="published"))
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            result = loop2.run_tick(args, jobs, FakeXinghe(), FakeLoop2Adapter())
        self.assertEqual(result["business_status"], "published")

    def test_pending_when_enrichment_disabled(self):
        jobs = FakeDrilldownClient(make_handoff(model_enrichment_mode="disabled"))
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            result = loop2.run_tick(args, jobs, FakeXinghe(), FakeLoop2Adapter())
        self.assertEqual(result["business_status"], "pending")
        self.assertEqual(result["reason"], "enrichment_disabled")

    def test_pending_when_no_drilldown_categories(self):
        jobs = FakeDrilldownClient(make_handoff(drilldown_categories=[]))
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            result = loop2.run_tick(args, jobs, FakeXinghe(), FakeLoop2Adapter())
        self.assertEqual(result["business_status"], "pending")
        self.assertEqual(result["reason"], "no_drilldown_categories")

    def test_pending_when_base_job_not_published_and_does_not_claim_or_submit_sql(self):
        base_job = {
            "job_id": "base:2026-W29:2026-07-16:b1",
            "kind": "base",
            "analysis_key": "2026-W29:2026-07-16",
            "status": "sql_running",
            "current_stage": "read",
            "deliveryState": "base_running",
            "state_revision": 3,
        }
        jobs = FakeDrilldownClient(make_handoff(), base_job=base_job)
        xinghe = FakeXinghe()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            result = loop2.run_tick(args, jobs, xinghe, FakeLoop2Adapter())
        self.assertEqual(result["business_status"], "pending")
        self.assertEqual(result["reason"], "base_not_published:sql_running:base_running")
        self.assertEqual(result["loop2_start_gate"], "base_publication_required")
        self.assertEqual(jobs.claims, [])
        self.assertEqual(xinghe.submissions, [])

    def test_late_published_base_job_allows_loop2_start(self):
        base_job = {
            "job_id": "base:2026-W29:2026-07-16:b1",
            "kind": "base",
            "analysis_key": "2026-W29:2026-07-16",
            "status": "published",
            "publication_status": "late_published",
            "deliveryState": "late_published",
            "state_revision": 10,
        }
        jobs = FakeDrilldownClient(make_handoff(), base_job=base_job)
        xinghe = FakeXinghe()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            result = loop2.run_tick(args, jobs, xinghe, FakeLoop2Adapter())
        self.assertEqual(result["business_status"], "pending")
        self.assertEqual(result["reason"], "sql_not_ready")
        self.assertEqual(len(jobs.claims), 1)
        self.assertEqual(len(xinghe.submissions), 1)

    def test_submits_model_sqls_once_and_polls_cross_tick(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            first = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(first["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 1)  # 单条推进

            second = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(second["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 1, "running SQL is polled, not resubmitted")

            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            third = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(third["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 2, "second model SQL submitted after first succeeds")

            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            fourth = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(fourth["business_status"], "analyze_pending")
            analyze_input = json.loads((Path(tmp) / "aiwan_runs" / args.run_id / loop2.MODEL_ANALYZE_INPUT_FILE).read_text(encoding="utf-8"))
            self.assertEqual(analyze_input["server_history_context"]["history_status"], "ok")
            self.assertTrue(analyze_input["system_evidence"]["allow_multiweek_trend"])
            self.assertEqual(
                analyze_input["system_evidence"]["trend_by_category"]["组装机"]["1001"]["previous_conclusion_state"],
                "continuous_context",
            )
            self.assertEqual(analyze_input["system_evidence"]["concentration_by_category"]["组装机"]["classification"], "concentrated_few_models")

    def test_user_canceled_model_sql_status_is_normalized_and_retried(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            first = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(first["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 1)

            xinghe.statuses["exec-1"] = "USER_CANCELED"
            second = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(second["business_status"], "pending")
            self.assertEqual(second["reason"], "model_sql_terminal_retry_scheduled")
            self.assertEqual(jobs.handoff["sql_checkpoints"]["model_summary"]["status"], "CANCELED")
            self.assertEqual(jobs.handoff["sql_checkpoints"]["model_summary"]["retry_count"], 1)

            third = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(third["business_status"], "pending")
            self.assertEqual(len(xinghe.submissions), 2)
            self.assertEqual(jobs.handoff["sql_checkpoints"]["model_summary"]["execute_id"], "exec-2")
            self.assertEqual(jobs.handoff["sql_checkpoints"]["model_summary"]["status"], "SUBMITTED")

    def test_history_read_retries_before_degrading(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter(history_failures=2)
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            result = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(result["business_status"], "analyze_pending")
            analyze_input = json.loads((Path(tmp) / "aiwan_runs" / args.run_id / loop2.MODEL_ANALYZE_INPUT_FILE).read_text(encoding="utf-8"))
        self.assertEqual(analyze_input["server_history_context"]["history_status"], "ok")
        self.assertEqual(len(adapter.history_reads), 3)

    def test_incomplete_current_week_is_excluded_from_continuous_trend(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter(history_rows=[
            {"week": "2026-W26", "category": "组装机", "modelId": "1001", "modelName": "主机A", "gmv": 10000, "daysReceived": 7},
            {"week": "2026-W27", "category": "组装机", "modelId": "1001", "modelName": "主机A", "gmv": 8000, "daysReceived": 7},
            {"week": "2026-W28", "category": "组装机", "modelId": "1001", "modelName": "主机A", "gmv": 6000, "daysReceived": 7},
            {"week": "2026-W29", "category": "组装机", "modelId": "1001", "modelName": "主机A", "gmv": 5000, "daysReceived": 3},
        ])
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            result = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(result["business_status"], "analyze_pending")
            analyze_input = json.loads((Path(tmp) / "aiwan_runs" / args.run_id / loop2.MODEL_ANALYZE_INPUT_FILE).read_text(encoding="utf-8"))
        trend = analyze_input["system_evidence"]["trend_by_category"]["组装机"]["1001"]
        self.assertEqual(trend["trend_gate"], "current_week_incomplete_excluded_from_continuous_trend")
        self.assertEqual(trend["series"][-1]["complete_week"], False)
        self.assertEqual(trend["series"][-1]["daysReceived"], 3)

    def test_history_read_failure_degrades_but_keeps_weekly_analysis(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter(history_failures=3)
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            result = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(result["business_status"], "analyze_pending")
            analyze_input = json.loads((Path(tmp) / "aiwan_runs" / args.run_id / loop2.MODEL_ANALYZE_INPUT_FILE).read_text(encoding="utf-8"))
        self.assertEqual(analyze_input["server_history_context"]["history_status"], "history_unavailable")
        self.assertFalse(analyze_input["system_evidence"]["allow_multiweek_trend"])
        self.assertIn(loop2.MODEL_HISTORY_UNAVAILABLE, analyze_input["warnings"])

    def test_finalize_merges_incrementally_and_publishes(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            third = loop2.run_tick(args, jobs, xinghe, adapter)
            self.assertEqual(third["business_status"], "analyze_pending")
            result = advance_to_published(args, jobs, xinghe, adapter)

        self.assertEqual(result["business_status"], "published")
        self.assertEqual(jobs.handoff["status"], "published")
        merged = adapter.validated
        self.assertIn("modelDrilldowns", merged)
        # Loop1 原品类文本保留，且拼上机型下钻摘要
        self.assertIn("高影响风险品类", merged["categories"]["组装机"])
        self.assertIn("1001 机型贡献主要降幅", merged["categories"]["组装机"])
        # Loop1 board/tiers 未被动
        self.assertEqual(merged["board"], BASE_DISPLAY["board"])
        self.assertEqual(merged["tiers"], BASE_DISPLAY["tiers"])

    def test_finalize_overrides_agent_coverage_with_deterministic(self):
        """agent 写的 coverage/attribution_status 必须被确定性值覆盖（brief §2：agent 只写不算）。"""
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter()
        args = make_args()
        bogus = {"组装机": {"status": "complete", "attribution_status": "sufficient",
                            "coverage": 0.99, "summary": "机型下钻摘要。",
                            "models": [{"model_id": "1001", "facts": ["f"], "hypotheses": [], "data_gaps": []}],
                            "verification_questions": [], "warnings": []}}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            result = advance_to_published(args, jobs, xinghe, adapter, model_drilldowns=bogus)
        self.assertEqual(result["business_status"], "published")
        dd = adapter.validated["modelDrilldowns"]["组装机"]
        # 确定性覆盖度：analyzed 800 / total 1000 = 0.8，覆盖掉 agent 的 0.99
        self.assertAlmostEqual(dd["coverage"], 0.8)
        self.assertEqual(dd["attribution_status"], "sufficient")
        self.assertNotEqual(dd["coverage"], 0.99)

    def test_core_snapshot_missing_surfaces_warning(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter(core_present=False)
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            for eid in list(xinghe.statuses):
                xinghe.statuses[eid] = "SUCCESS"
            loop2.run_tick(args, jobs, xinghe, adapter)
            result = advance_to_published(args, jobs, xinghe, adapter)
        self.assertEqual(result["business_status"], "published")
        self.assertIn(loop2.CORE_MODEL_SNAPSHOT_MISSING, jobs.handoff.get("warnings", []))


class Loop2FailureBranchTests(unittest.TestCase):
    """设计 §15：gate 失败 / validate 未确认 / superseded 需各有独立测试。"""

    def _drive_to_analyze_pending(self, jobs, xinghe, adapter, args):
        loop2.run_tick(args, jobs, xinghe, adapter)
        for eid in list(xinghe.statuses):
            xinghe.statuses[eid] = "SUCCESS"
        loop2.run_tick(args, jobs, xinghe, adapter)
        for eid in list(xinghe.statuses):
            xinghe.statuses[eid] = "SUCCESS"
        loop2.run_tick(args, jobs, xinghe, adapter)

    def test_gate_failure_returns_retryable_and_does_not_publish(self):
        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = FakeLoop2Adapter()
        args = make_args()
        bad = {"组装机": {"summary": "", "models": []}}  # 空 summary + 空 models → gate 失败
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            self._drive_to_analyze_pending(jobs, xinghe, adapter, args)
            result = advance_to_published(args, jobs, xinghe, adapter, model_drilldowns=bad)
        self.assertEqual(result["business_status"], "retryable_failed")
        self.assertEqual(result["error"]["code"], "MODEL_ANALYSIS_GATE_FAILED")
        self.assertNotEqual(jobs.handoff["status"], "published")

    def test_validate_not_confirmed_returns_retryable(self):
        class NoWriteAdapter(FakeLoop2Adapter):
            def validate(self, args, run_dir, merged_display):
                return {"status": "warn", "server_write_confirmed": False, "reason": "model_validate_not_wired"}

        jobs = FakeDrilldownClient(make_handoff())
        xinghe = FakeXinghe()
        adapter = NoWriteAdapter()
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            self._drive_to_analyze_pending(jobs, xinghe, adapter, args)
            result = advance_to_published(args, jobs, xinghe, adapter)
        self.assertEqual(result["business_status"], "retryable_failed")
        self.assertEqual(result["error"]["code"], "MODEL_VALIDATE_FAILED")
        self.assertNotEqual(jobs.handoff["status"], "published")

    def test_superseded_handoff_short_circuits(self):
        jobs = FakeDrilldownClient(make_handoff(status="superseded"))
        args = make_args()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"SANDBOX_OUTPUT_DIR": tmp}):
            result = loop2.run_tick(args, jobs, FakeXinghe(), FakeLoop2Adapter())
        self.assertEqual(result["business_status"], "superseded")
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()

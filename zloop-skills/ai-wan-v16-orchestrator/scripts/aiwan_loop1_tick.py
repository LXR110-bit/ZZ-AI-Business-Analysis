#!/usr/bin/env python3
"""Cross-tick Loop1 runner for the four base AIWAN SQLs.

The existing inline state machine remains the full6 compatibility entrypoint.
This runner persists SQL execute ids through the generic AIWAN job control
plane and treats an unfinished tick as a successful, pending scheduler tick.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import aiwan_inline_state_machine as core


BASE_SCRIPTS = [
    "category_daily_avg",
    "category_summary",
    "category_fulfill_daily_avg",
    "category_fulfill_summary",
]
MAX_ACTIVE_SQL = 2
MAX_SQL_RETRIES = 2
SUCCESS_STATUSES = set(core.TERMINAL_SUCCESS)
FAILED_STATUSES = set(core.TERMINAL_FAILED)
JOBS_READ_PATH = "/v2/aiwan/api/aiwan/jobs/read"
JOBS_WRITE_PATH = "/v2/aiwan/api/aiwan/jobs/write"


class JobApiError(RuntimeError):
    def __init__(self, code: str, message: str, status: int | None = None, details: Any = None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details


def _response_json(response: Any) -> dict[str, Any]:
    data = response.json()
    if not getattr(response, "ok", False) or not isinstance(data, dict) or data.get("ok") is not True:
        error = data.get("error") if isinstance(data, dict) else {}
        if not isinstance(error, dict):
            error = {}
        raise JobApiError(
            str(error.get("code") or "AIWAN_JOB_API_FAILED"),
            str(error.get("message") or f"AIWAN job API failed: {data!r}"),
            getattr(response, "status_code", None),
            error.get("details"),
        )
    return data


class HubJobClient:
    def __init__(self, hub_module: Any = None):
        self.hub = hub_module or core.hub
        if self.hub is None:
            raise RuntimeError("zloop_runtime.hub is unavailable")

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        body = {**payload, "action": "create"}
        return _response_json(self.hub.post(JOBS_WRITE_PATH, json_body=body, timeout=90.0))["job"]

    def get(self, analysis_key: str, base_revision: int, kind: str = "base", handoff_revision: int = 0) -> dict[str, Any]:
        body = {
            "analysis_key": analysis_key,
            "kind": kind,
            "base_revision": base_revision,
            "handoff_revision": handoff_revision,
        }
        return _response_json(self.hub.post(JOBS_READ_PATH, json_body=body, timeout=90.0))["job"]

    def claim(self, analysis_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = {**payload, "action": "claim", "analysis_key": analysis_key}
        return _response_json(self.hub.post(JOBS_WRITE_PATH, json_body=body, timeout=90.0))["job"]

    def update(self, analysis_key: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = {**payload, "action": "state", "analysis_key": analysis_key}
        return _response_json(self.hub.post(JOBS_WRITE_PATH, json_body=body, timeout=90.0))["job"]


class CoreAdapter:
    def render_sqls(self, args: argparse.Namespace, export_dir: Path) -> dict[str, dict[str, str]]:
        export_dir.mkdir(parents=True, exist_ok=True)
        rendered: dict[str, dict[str, str]] = {}
        for name in BASE_SCRIPTS:
            template = core.repo_root() / "references" / "read" / "sql" / f"{name}.sql"
            sql = core.render_sql(template.read_text(encoding="utf-8"), args.run_dt, args.data_end_date)
            path = export_dir / f"{name}_{args.run_dt}.sql"
            path.write_text(sql, encoding="utf-8")
            rendered[name] = {"sql": sql, "path": str(path), "sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest()}
        return rendered

    def materialize(self, execute_id: str, csv_path: Path, debug_dir: Path, script_name: str) -> int:
        return core.materialize_full_csv(execute_id, csv_path, debug_dir, script_name)

    def package_base(self, args: argparse.Namespace, export_dir: Path, raw_root: Path) -> dict[str, Any]:
        raw_root.mkdir(parents=True, exist_ok=True)
        command = [
            "node",
            str(core.repo_root() / "bin" / "package-raw-cache.js"),
            "--run-dt", args.run_dt,
            "--run-id", args.run_id,
            "--input-dir", str(export_dir),
            "--out-dir", str(raw_root),
            "--sql-scope", "base",
            "--scripts", ",".join(BASE_SCRIPTS),
        ]
        result = subprocess.run(command, text=True, capture_output=True, timeout=300)
        if result.returncode != 0:
            raise RuntimeError(f"package-raw-cache base failed: {result.stderr[-2000:] or result.stdout[-2000:]}")
        active_path = raw_root / "active_fetch_manifest.json"
        active = core.read_json(active_path)
        active.update({"week": args.week, "data_end_date": args.data_end_date, "week_start_dates": core.week_start_dates(args.week)})
        core.write_json(active_path, active)
        return active

    def process(self, args: argparse.Namespace, run_dir: Path, read_result: dict[str, Any]) -> dict[str, Any]:
        return core.execute_process(args, run_dir, read_result)

    def analyze(self, args: argparse.Namespace, run_dir: Path, processed: dict[str, Any]) -> dict[str, Any]:
        return core.execute_analyze(args, run_dir, processed)

    def validate(self, args: argparse.Namespace, run_dir: Path, processed: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
        return core.execute_validate(args, run_dir, processed, analysis)


def iso_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def lease_active(job: dict[str, Any]) -> bool:
    raw = job.get("lease_expires_at")
    if not raw:
        return False
    try:
        expires = datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return False
    return expires > datetime.now().astimezone().timestamp()


def pending_result(args: argparse.Namespace, job: dict[str, Any] | None, reason: str) -> dict[str, Any]:
    return {
        "ok": True,
        "business_status": "pending",
        "reason": reason,
        "run_id": args.run_id,
        "analysis_key": args.analysis_key,
        "job_status": job.get("status") if job else None,
        "state_revision": job.get("state_revision") if job else None,
        "sql_checkpoints": job.get("sql_checkpoints", {}) if job else {},
    }


def ensure_drilldown_handoff(job_client: Any, args: argparse.Namespace) -> dict[str, Any]:
    return job_client.create({
        "kind": "drilldown",
        "analysis_key": args.analysis_key,
        "week": args.week,
        "data_end_date": args.data_end_date,
        "loop1_run_id": args.run_id,
        "base_revision": args.base_revision,
        "handoff_revision": 1,
        "status": "ready",
        "current_stage": "read",
        "model_enrichment_mode": "disabled",
        "drilldown_categories": [],
        "execute_ids": {},
        "sql_hashes": {},
        "sql_checkpoints": {},
    })


def published_result(args: argparse.Namespace, job_client: Any, job: dict[str, Any], **extra: Any) -> dict[str, Any]:
    result = {"ok": True, "business_status": "published", "run_id": args.run_id, "analysis_key": args.analysis_key, "job": job, **extra}
    try:
        result["handoff_job"] = ensure_drilldown_handoff(job_client, args)
        result["handoff_status"] = "ready"
    except Exception as exc:
        result["handoff_status"] = "retryable_failed"
        result["handoff_error"] = str(exc)
    return result


def checkpoint_update(job_client: Any, args: argparse.Namespace, job: dict[str, Any], status: str, **fields: Any) -> dict[str, Any]:
    payload = {
        "kind": "base",
        "base_revision": args.base_revision,
        "handoff_revision": 0,
        "expected_state_revision": job["state_revision"],
        "worker_id": args.worker_id,
        "status": status,
        **fields,
    }
    return job_client.update(args.analysis_key, payload)


def submit_sql(xinghe: Any, name: str, sql: str, args: argparse.Namespace) -> str:
    response = core.call_with_supported_kwargs(
        xinghe.run_hive_sql,
        content=sql,
        sql=sql,
        title=f"AIWAN Loop1 {name} {args.run_dt}",
        business_id="5",
        business_name="聚合回收",
    )
    return core.normalize_execute_id(response)


def poll_sql(xinghe: Any, execute_id: str) -> str:
    response = core.call_with_supported_kwargs(xinghe.check_sql_status, execute_id=execute_id, execute_ids=[execute_id])
    return core.get_status_for(response, execute_id)


def build_read_result(args: argparse.Namespace, run_dir: Path, job: dict[str, Any], active: dict[str, Any]) -> dict[str, Any]:
    raw_root = run_dir / "read_artifacts"
    return {
        "stage": "read",
        "status": active.get("status", "success"),
        "output_type": "sql_result",
        "run_id": args.run_id,
        "week": args.week,
        "run_dt": args.run_dt,
        "data_end_date": args.data_end_date,
        "week_start_dates": core.week_start_dates(args.week),
        "sql_scope": "base",
        "sql_status": job.get("sql_checkpoints", {}),
        "warnings": active.get("warnings", []),
        "artifacts": {
            "input_dir": str(raw_root),
            "active_fetch_manifest": str(raw_root / "active_fetch_manifest.json"),
            "raw_cache": str(raw_root / f"raw_cache_{args.run_dt}.zip"),
            "sql_status": str(raw_root / f"sql_status_{args.run_dt}.json"),
            "raw_manifest": str(raw_root / f"raw_manifest_{args.run_dt}.json"),
        },
        "next_stage": "process",
    }


ANALYZE_INPUT_FILE = "analyze_input.json"
ANALYSIS_RESULT_FILE = "analysis_result.json"      # agent 写入
PROCESSED_RESULT_FILE = "processed_result.json"
ANALYSIS_SCAFFOLD_FILE = "analysis_scaffold.json"
REQUIRED_DISPLAY_KEYS = ("board", "category", "monitor", "tiers", "secondaryCategories", "categories")
CONTROLLED_LABELS = ("高影响风险品类", "明确机会品类", "异常风险品类", "低基数波动品类", "稳健品类")
BANNED_SUBJECTIVE = ("效果显著", "明显改善", "大幅提升", "表现优异")


def analyze_pending_result(args: argparse.Namespace, job: dict[str, Any] | None, run_dir: Path) -> dict[str, Any]:
    return {
        "ok": True,
        "business_status": "analyze_pending",
        "reason": "await_agent_analysis",
        "run_id": args.run_id,
        "analysis_key": args.analysis_key,
        "analyze_input": str(run_dir / ANALYZE_INPUT_FILE),
        "analysis_result_expected": str(run_dir / ANALYSIS_RESULT_FILE),
        "job_status": job.get("status") if job else None,
    }


def compute_digest(evidence_pack: dict[str, Any]) -> dict[str, Any]:
    """确定性预算 board/三层/板块 聚合，agent 只写叙述、不再自己从品类逐个加总。"""
    items = evidence_pack.get("category_all") or evidence_pack.get("category_top_changes") or []
    items = [i for i in items if isinstance(i, dict) and i.get("category")]

    def g(d: Any, k: str) -> float:
        try:
            return float((d or {}).get(k) or 0)
        except (TypeError, ValueError):
            return 0.0

    def roll(group_key: str) -> dict[str, Any]:
        out: dict[str, dict[str, Any]] = {}
        for it in items:
            key = str(it.get(group_key) or "未归类")
            b = out.setdefault(key, {"gmv": 0.0, "gmv_delta": 0.0, "deal_delta": 0.0, "category_count": 0, "drag": [], "opportunity": []})
            b["gmv"] += g(it.get("cur"), "gmv")
            b["gmv_delta"] += g(it.get("delta"), "gmv_delta")
            b["deal_delta"] += g(it.get("delta"), "deal_delta")
            b["category_count"] += 1
            gd = g(it.get("delta"), "gmv_delta")
            (b["drag"] if gd < 0 else b["opportunity"]).append((it["category"], gd))
        for b in out.values():
            b["drag"] = [c for c, _ in sorted(b["drag"], key=lambda x: x[1])[:5]]
            b["opportunity"] = [c for c, _ in sorted(b["opportunity"], key=lambda x: -x[1])[:3]]
            b["gmv"] = round(b["gmv"], 1)
            b["gmv_delta"] = round(b["gmv_delta"], 1)
            b["deal_delta"] = round(b["deal_delta"], 2)
        return out

    board = evidence_pack.get("board") or {}
    return {
        "board": {"delta": board.get("delta") or {}, "risk_level": board.get("risk_level"), "chain_breakpoint": board.get("chain_breakpoint")},
        "tiers": roll("tier"),
        "secondaryCategories": roll("secondaryCategory"),
        "units_note": (
            "cur/prev 为对应周指标，delta/delta_pct 已算好周环比（本周可能是滚动未结束周）。"
            "环比一律直接引用 delta 的 gmv_delta / gmv_delta_pct 等，禁止用 cur/prev 自己反推日均/累计口径（会浪费预算且易错）。"
            "tiers/secondaryCategories 的 gmv 与 gmv_delta 已按品类聚合好，直接引用，不要自己再逐个品类加总。"
        ),
    }


def build_analyze_input(args: argparse.Namespace, run_dir: Path, processed: dict[str, Any]) -> Path:
    """确定性证据：只让 agent 在证据之上写叙述，数字不交给 agent 发明。"""
    read_body = {
        "run_id": args.run_id, "stage": "analyze", "week": args.week,
        "input_type": "metric_snapshot", "history_weeks": 10,
        "include": ["run_meta", "history_10w", "rules", "dashboard_snapshot"],
    }
    try:
        server_context = core.hub_post(core.READ_PATH, read_body, timeout=130.0)
    except Exception as exc:  # 允许降级：无服务器上下文仍能出周环比证据
        server_context = {"ok": False, "error": str(exc)}
    evidence_pack = core.build_analysis_evidence(processed, server_context)
    findings = core.make_findings(evidence_pack)
    history_weeks = (
        processed.get("process_summary", {}).get("history_weeks_available")
        or evidence_pack.get("effective_history_weeks")
        or 0
    )
    ev_cats = evidence_pack.get("category_all") or evidence_pack.get("category_top_changes") or []
    cats = sorted({str(i.get("category")) for i in ev_cats if isinstance(i, dict) and i.get("category")})
    secondaries = sorted({str(i.get("name")) for i in evidence_pack.get("cluster_top_changes", []) if isinstance(i, dict) and i.get("name")})
    core.write_json(run_dir / PROCESSED_RESULT_FILE, processed)
    core.write_json(run_dir / ANALYSIS_SCAFFOLD_FILE, {
        "evidence_pack": evidence_pack,
        "findings": findings,
        "display_contract": core.DISPLAY_CONTRACT,
        "history_weeks": history_weeks,
        "analysis_scope": "wow_only" if float(history_weeks or 0) < 8 else "trend_10w",
        "server_context_ok": bool(server_context.get("ok")),
    })
    core.write_json(run_dir / ANALYZE_INPUT_FILE, {
        "run_id": args.run_id, "week": args.week, "run_dt": args.run_dt,
        "history_weeks": history_weeks,
        "display_contract": core.DISPLAY_CONTRACT,
        "required_display_keys": list(REQUIRED_DISPLAY_KEYS),
        "categories_to_cover": cats,
        "secondary_to_cover": secondaries,
        "digest": compute_digest(evidence_pack),
        "evidence_pack": evidence_pack,
        "instruction": (
            "读 analyze-parity-rubric.md + golden-fewshot.md，按 rubric 分批产出 display_insights，写到 analysis_result.json 的 display_insights 字段。"
            "board/三层/板块的聚合数字已在 digest 里确定性算好（含 units_note 口径说明）：直接引用 digest，**不要自己从 category 逐个加总、也不要用 cur/prev 反推口径**（那会烧光 turn 预算导致中途结束）。写作时优先用 digest，明细才查 evidence_pack。硬性要求（否则机器闸门会打回）："
            "(1) 数字只来自 evidence_pack/digest，禁编造；品类标签按 §3.1 判定矩阵。"
            "(2) categories 必须覆盖 categories_to_cover 全部品类，一个不少。"
            "(3) secondaryCategories 必须非空，覆盖 secondary_to_cover 全部板块（每板块一段：贡献/拖累点名+链路段）。"
            "(4) 每个 tier(发展/孵化/种子)文案必须同时含：风险或机会 + 下钻或验证或观察 + 至少一个指标词(成交GMV/成交订单/下单率/发货率/成交率)。"
            "(5) board 必须含：风险等级 + 链路 + 拖累或机会 + 验证或下一步。"
            "(6) 品类文案重复率必须<20%：GMV=0 或无成交的品类不能都套同一句模板，每条至少带品类名并给一句差异化说明。"
            "(7) 禁技术字段(orderRate/shipCnt/dealGmv/wow_pct/entity_type)；禁主观词(效果显著/明显改善/大幅提升)。"
        ),
    })
    return run_dir / ANALYZE_INPUT_FILE


def gate_agent_display(display: Any, scaffold: dict[str, Any]) -> list[str]:
    """机器闸门：agent 写的 display_insights 不合规就 fail，绝不退回模板/静默通过。"""
    errors: list[str] = []
    if not isinstance(display, dict):
        return ["display_insights_not_object"]
    for k in REQUIRED_DISPLAY_KEYS:
        if k not in display:
            errors.append(f"missing_display_key:{k}")
    tiers = display.get("tiers") or {}
    for t in core.REQUIRED_TIERS:
        if not str(tiers.get(t) or "").strip():
            errors.append(f"empty_tier:{t}")
    ev = scaffold.get("evidence_pack", {})
    ev_cats = {str(i.get("category")) for i in (ev.get("category_all") or ev.get("category_top_changes") or []) if isinstance(i, dict) and i.get("category")}
    out_cats = set((display.get("categories") or {}).keys())
    missing = ev_cats - out_cats
    if missing:
        errors.append(f"categories_missing:{sorted(missing)[:10]}(+{max(len(missing) - 10, 0)})")
    for txt in core.flatten_display_text(display):
        for w in BANNED_SUBJECTIVE:
            if w in txt:
                errors.append(f"banned_subjective:{w}")
                break
    for name, txt in (display.get("categories") or {}).items():
        if not any(lbl in str(txt) for lbl in CONTROLLED_LABELS):
            errors.append(f"category_missing_label:{name}")
    # 镜像 execute_validate 的展示深检，让 agent 一次写对，避免撞到 validate 才发现
    sec = display.get("secondaryCategories")
    if not (isinstance(sec, dict) and sec):
        errors.append("secondaryCategories_empty")
    for t in core.REQUIRED_TIERS:
        tt = str(tiers.get(t) or "")
        if tt.strip() and not (
            core.contains_any(tt, ("风险", "机会"))
            and core.contains_any(tt, ("下钻", "验证", "观察"))
            and core.contains_any(tt, ("成交GMV", "成交订单", "下单率", "发货率", "成交率"))
        ):
            errors.append(f"tier_{t}_quality_terms")
    bt = str(display.get("board") or "")
    if bt.strip() and not (
        core.contains_any(bt, ("风险等级",))
        and core.contains_any(bt, ("链路",))
        and core.contains_any(bt, ("拖累", "机会"))
        and core.contains_any(bt, ("验证", "下一步"))
    ):
        errors.append("board_quality_terms")
    cat_texts = [str(x) for x in (display.get("categories") or {}).values()]
    if cat_texts and core.duplicate_text_ratio(cat_texts) >= 0.2:
        errors.append(f"category_duplicate_ratio:{round(core.duplicate_text_ratio(cat_texts), 3)}")
    if core.contains_any("\n".join(core.flatten_display_text(display)), core.TECH_DISPLAY_TERMS):
        errors.append("display_technical_terms_leaked")
    return errors


def finalize_after_analyze(args: argparse.Namespace, run_dir: Path, job: dict[str, Any], job_client: Any, adapter: Any) -> dict[str, Any]:
    result_path = run_dir / ANALYSIS_RESULT_FILE
    if not result_path.exists():
        return analyze_pending_result(args, job, run_dir)
    scaffold = core.read_json(run_dir / ANALYSIS_SCAFFOLD_FILE)
    processed = core.read_json(run_dir / PROCESSED_RESULT_FILE)
    agent = core.read_json(result_path)
    display = agent.get("display_insights") if isinstance(agent, dict) and "display_insights" in agent else agent
    gate_errors = gate_agent_display(display, scaffold)
    if gate_errors:
        job = checkpoint_update(job_client, args, job, "retryable_failed", current_stage="analyze",
                                error={"code": "ANALYSIS_GATE_FAILED", "errors": gate_errors[:20]})
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id,
                "analysis_key": args.analysis_key,
                "error": {"code": "ANALYSIS_GATE_FAILED", "errors": gate_errors[:20]}, "job": job}
    analysis = {
        "stage": "analyze",
        "status": "warn" if display.get("warnings") else "success",
        "output_type": "analysis_result",
        "run_id": args.run_id, "week": args.week,
        "analysis_mode": "daily",
        "analysis_scope": scaffold.get("analysis_scope", "wow_only"),
        "history_weeks": scaffold.get("history_weeks", 0),
        "evidence_pack": scaffold.get("evidence_pack", {}),
        "findings": scaffold.get("findings", []),
        "display_contract": scaffold.get("display_contract", core.DISPLAY_CONTRACT),
        "display_insights": display,
        "summary": agent.get("summary", {}) if isinstance(agent, dict) else {},
        "review_notes": agent.get("review_notes", []) if isinstance(agent, dict) else [],
        "warnings": display.get("warnings", []),
        "llm_policy": {"executor": "sandbox_agent", "model": "claude-sonnet-4-6", "batched": True},
        "next_stage": "validate",
    }
    core.write_json(run_dir / "analysis_result_assembled.json", analysis)
    job = checkpoint_update(job_client, args, job, "validating", current_stage="validate")
    validation = adapter.validate(args, run_dir, processed, analysis)
    if validation.get("server_write_confirmed") is not True:
        # validate 深检未过：退回 analyze 让 agent 按 failed_checks 修 analysis_result 再重跑 finalize，
        # 不 raise（会把 job 卡在 validate、逼 agent 手动改服务端状态）。
        failed = validation.get("failed_checks", []) or []
        job = checkpoint_update(job_client, args, job, "retryable_failed", current_stage="analyze",
                                error={"code": "VALIDATE_CHECKS_FAILED", "failed_checks": failed[:30]})
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id,
                "analysis_key": args.analysis_key,
                "error": {"code": "VALIDATE_CHECKS_FAILED", "failed_checks": failed[:30]}, "job": job}
    job = checkpoint_update(job_client, args, job, "published", current_stage="validate")
    return published_result(args, job_client, job, stage_results={
        "read": "success", "process": processed.get("status"),
        "analyze": analysis.get("status"), "validate": validation.get("status"),
    }, artifacts_dir=str(run_dir))


def run_tick(
    args: argparse.Namespace,
    job_client: Any | None = None,
    xinghe_client: Any | None = None,
    adapter: Any | None = None,
) -> dict[str, Any]:
    job_client = job_client or HubJobClient()
    xinghe_client = xinghe_client or core.xinghe
    adapter = adapter or CoreAdapter()
    if xinghe_client is None:
        raise RuntimeError("zloop_runtime.xinghe is unavailable")

    run_dir = core.out_root() / "aiwan_runs" / args.run_id
    export_dir = run_dir / "read_exports"
    raw_root = run_dir / "read_artifacts"
    debug_dir = run_dir / "debug"
    for path in (run_dir, export_dir, raw_root, debug_dir):
        path.mkdir(parents=True, exist_ok=True)
    rendered = adapter.render_sqls(args, export_dir)
    sql_hashes = {name: rendered[name]["sha256"] for name in BASE_SCRIPTS}
    create_payload = {
        "kind": "base",
        "analysis_key": args.analysis_key,
        "week": args.week,
        "data_end_date": args.data_end_date,
        "loop1_run_id": args.run_id,
        "base_revision": args.base_revision,
        "handoff_revision": 0,
        "status": "ready",
        "current_stage": "read",
        "base_deadline_at": args.base_deadline_at,
        "sql_hashes": sql_hashes,
        "sql_checkpoints": {},
    }

    job: dict[str, Any] | None = None
    try:
        try:
            job = job_client.create(create_payload)
        except JobApiError as exc:
            recoverable_create_codes = {
                "JOB_REVISION_CONFLICT",
                "JOB_STATE_REVISION_CONFLICT",
                "JOB_ALREADY_EXISTS",
                "AIWAN_JOB_API_FAILED",
                "HUB_UPSTREAM_ERROR",
            }
            if exc.code not in recoverable_create_codes and exc.status not in {409, 502}:
                raise
            try:
                job = job_client.get(args.analysis_key, args.base_revision)
            except Exception:
                raise exc
        args.base_started_at = getattr(args, "base_started_at", None) or job.get("created_at") or f"{args.run_dt}T00:00:00+08:00"
        args.base_sla_deadline = getattr(args, "base_sla_deadline", None) or args.base_deadline_at or job.get("base_deadline_at")
        if job.get("status") == "published":
            return published_result(args, job_client, job)
        if job.get("status") in {"failed", "superseded"}:
            return {"ok": False, "business_status": job["status"], "run_id": args.run_id, "analysis_key": args.analysis_key, "job": job}

        if job.get("lease_owner") and lease_active(job) and job.get("lease_owner") != args.worker_id:
            return pending_result(args, job, "lease_held_by_other_worker")
        job = job_client.claim(args.analysis_key, {
            "kind": "base",
            "base_revision": args.base_revision,
            "handoff_revision": 0,
            "expected_state_revision": job["state_revision"],
            "worker_id": args.worker_id,
            "lease_seconds": args.lease_seconds,
            "current_stage": job.get("current_stage") or "read",
        })

        # read+process 已完成、等待/消费 agent 分析：跳过 SQL/process，直接走 validate 闸门
        if job.get("current_stage") in {"analyze", "validate"}:
            return finalize_after_analyze(args, run_dir, job, job_client, adapter)

        checkpoints = dict(job.get("sql_checkpoints") or {})
        for name, expected_hash in sql_hashes.items():
            actual_hash = (job.get("sql_hashes") or {}).get(name)
            if actual_hash and actual_hash != expected_hash:
                raise RuntimeError(f"SQL_HASH_MISMATCH: {name}")

        for name in BASE_SCRIPTS:
            checkpoint = checkpoints.get(name) or {}
            execute_id = checkpoint.get("execute_id") or (job.get("execute_ids") or {}).get(name)
            status = str(checkpoint.get("status") or "").upper()
            if not execute_id or status in SUCCESS_STATUSES or status in FAILED_STATUSES:
                continue
            polled = poll_sql(xinghe_client, str(execute_id))
            next_status = "sql_running" if job.get("status") in {"claimed", "sql_submitted", "sql_running"} else job["status"]
            if polled in FAILED_STATUSES:
                retry_count = int(checkpoint.get("retry_count") or 0)
                terminal = retry_count >= MAX_SQL_RETRIES
                job = checkpoint_update(
                    job_client,
                    args,
                    job,
                    "failed" if terminal else "retryable_failed",
                    current_stage="read",
                    sql_checkpoints={name: {
                        "execute_id": str(execute_id),
                        "sql_hash": sql_hashes[name],
                        "status": polled,
                        "retry_count": retry_count if terminal else retry_count + 1,
                    }},
                    error={
                        "code": "SQL_TERMINAL_FAILED" if terminal else "SQL_TERMINAL_RETRY_SCHEDULED",
                        "script": name,
                        "status": polled,
                        "retry_count": retry_count,
                        "max_retries": MAX_SQL_RETRIES,
                    },
                )
                if terminal:
                    return {"ok": False, "business_status": "failed", "run_id": args.run_id, "analysis_key": args.analysis_key, "job": job}
                return pending_result(args, job, "sql_terminal_retry_scheduled")
            job = checkpoint_update(job_client, args, job, next_status, current_stage="read", sql_checkpoints={name: {"execute_id": str(execute_id), "sql_hash": sql_hashes[name], "status": polled}})
            checkpoints = dict(job.get("sql_checkpoints") or {})

        active_count = sum(
            1 for item in checkpoints.values()
            if item.get("execute_id")
            and str(item.get("status") or "").upper() not in SUCCESS_STATUSES
            and str(item.get("status") or "").upper() not in FAILED_STATUSES
        )
        for name in BASE_SCRIPTS:
            checkpoint = checkpoints.get(name) or {}
            checkpoint_status = str(checkpoint.get("status") or "").upper()
            retrying = bool(checkpoint.get("execute_id") and checkpoint_status in FAILED_STATUSES)
            if (checkpoint.get("execute_id") and not retrying) or active_count >= MAX_ACTIVE_SQL:
                continue
            execute_id = submit_sql(xinghe_client, name, rendered[name]["sql"], args)
            state = "sql_submitted" if job.get("status") == "claimed" else job["status"]
            job = checkpoint_update(job_client, args, job, state, current_stage="read", sql_checkpoints={name: {
                "execute_id": execute_id,
                "sql_hash": sql_hashes[name],
                "status": "SUBMITTED",
                "retry_count": int(checkpoint.get("retry_count") or 0),
            }}, error={})
            checkpoints = dict(job.get("sql_checkpoints") or {})
            active_count += 1

        if not all(str((checkpoints.get(name) or {}).get("status") or "").upper() in SUCCESS_STATUSES for name in BASE_SCRIPTS):
            return pending_result(args, job, "sql_not_ready")

        if job.get("status") == "claimed":
            # A retryable/expired tick can be reclaimed after all four SQLs already
            # succeeded.  The job API only allows forward transitions, so bridge
            # claimed -> sql_submitted before resuming materialization instead of
            # trying an invalid claimed -> materializing jump.
            job = checkpoint_update(job_client, args, job, "sql_submitted", current_stage="read")
        if job.get("status") != "materializing":
            job = checkpoint_update(job_client, args, job, "materializing", current_stage="read")
        for name in BASE_SCRIPTS:
            checkpoint = (job.get("sql_checkpoints") or {}).get(name) or {}
            csv_path = export_dir / f"{name}_{args.run_dt}.csv"
            rows = adapter.materialize(str(checkpoint["execute_id"]), csv_path, debug_dir, name)
            if rows <= 0 and name not in core.FULFILL_OPTIONAL_EMPTY:
                raise RuntimeError(f"SQL {name} materialized empty CSV")
            job = checkpoint_update(job_client, args, job, "materializing", current_stage="read", sql_checkpoints={name: {
                "execute_id": str(checkpoint["execute_id"]),
                "sql_hash": sql_hashes[name],
                "status": "SUCCESS",
                "artifact_uri": str(csv_path),
                "artifact_hash": core.sha256_file(csv_path),
                "materialized_at": iso_now(),
            }})

        active = adapter.package_base(args, export_dir, raw_root)
        read_result = build_read_result(args, run_dir, job, active)
        job = checkpoint_update(job_client, args, job, "processing", current_stage="process", artifact_uri=read_result["artifacts"]["raw_cache"], artifact_hash=active.get("raw_cache_sha256"))
        processed = adapter.process(args, run_dir, read_result)
        # analyze 交回沙箱主 agent（Claude）分批撰写：落确定性证据后停在 analyze_pending，
        # 下一 tick 命中 current_stage=="analyze" 分支消费 agent 的 analysis_result.json 并走 validate 闸门。
        build_analyze_input(args, run_dir, processed)
        job = checkpoint_update(job_client, args, job, "analyzing", current_stage="analyze")
        return analyze_pending_result(args, job, run_dir)
    except JobApiError as exc:
        if exc.code in {"JOB_STATE_REVISION_CONFLICT", "JOB_LEASE_CONFLICT", "JOB_LEASE_EXPIRED", "JOB_NOT_CLAIMABLE"}:
            try:
                job = job_client.get(args.analysis_key, args.base_revision)
            except Exception:
                pass
            return pending_result(args, job, exc.code.lower())
        raise
    except Exception as exc:
        if job and job.get("status") not in {"published", "failed", "superseded", "retryable_failed"}:
            try:
                job = checkpoint_update(job_client, args, job, "retryable_failed", current_stage=job.get("current_stage") or "read", error={"code": "LOOP1_TICK_FAILED", "message": str(exc)[:1000]})
            except Exception:
                pass
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id, "analysis_key": args.analysis_key, "error": {"code": "LOOP1_TICK_FAILED", "message": str(exc)}, "job": job}


def exit_code_for(result: dict[str, Any]) -> int:
    return 0 if result.get("business_status") in {"pending", "analyze_pending", "published"} and result.get("ok") is True else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id")
    parser.add_argument("--week", required=True)
    parser.add_argument("--run-dt", required=True)
    parser.add_argument("--data-end-date", required=True)
    parser.add_argument("--analysis-key")
    parser.add_argument("--base-revision", type=int, default=1)
    parser.add_argument("--worker-id")
    parser.add_argument("--lease-seconds", type=int, default=3600)
    parser.add_argument("--base-deadline-at")
    parser.add_argument("--base-started-at")
    parser.add_argument("--base-sla-deadline")
    parser.add_argument("--process-timeout-seconds", type=int, default=900)
    return parser


def apply_runtime_defaults(args: argparse.Namespace) -> argparse.Namespace:
    args.analysis_key = args.analysis_key or f"{args.week}:{args.data_end_date}"
    args.run_id = args.run_id or f"loop1-{args.week}-{args.data_end_date}-r{args.base_revision}"
    args.worker_id = args.worker_id or os.environ.get("AIWAN_LOOP1_WORKER_ID") or f"loop1:{args.analysis_key}:b{args.base_revision}"
    return args


def main() -> None:
    args = apply_runtime_defaults(build_parser().parse_args())
    preflight = core.preflight()
    if preflight.get("ok") is not True:
        result = {"ok": False, "business_status": "failed", "error": {"code": "PREFLIGHT_FAILED", "details": preflight.get("errors", [])}, "preflight": preflight}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(2)
    result = run_tick(args)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    raise SystemExit(exit_code_for(result))


if __name__ == "__main__":
    main()

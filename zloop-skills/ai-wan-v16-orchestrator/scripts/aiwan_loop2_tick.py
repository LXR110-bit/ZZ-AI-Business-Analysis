#!/usr/bin/env python3
"""Cross-tick Loop2 runner：机型按需下钻（阶段 B/C）。

Loop2 领取 Loop1 写好的 drilldown 交接单（kind=drilldown, status=ready,
model_enrichment_mode=enabled），只对下钻品类跑机型 SQL（model_summary /
model_daily_avg），异步 submit + 跨 tick poll；物化后按 核心机型 ∪ GMV Top-N ∪
环比异动机型 收敛候选，交回沙箱 agent 按机型 rubric 写归因，最后**增量** merge 进
Loop1 已发布的 categories 卡片（不清空 Loop1 文本），并原子写 modelDrilldowns。

设计基线：`2026-07-17-aiwan-两跳Loop-机型按需下钻-设计-v2.md` §3.2/§5/§7/§8/§9。

复用 Loop1 的 job 控制面、SQL 提交/轮询、租约与 CAS 语义（见 aiwan_loop1_tick）。
ponytail: SQL 内窗口函数候选收敛（§7.1）与覆盖度扩展（§7.3）留待真实数据回测后启用
（§7.4 明确要求上线前做 scan/shuffle 实测），当前用「品类过滤 + 物化后候选收敛」的增量方案。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

import aiwan_inline_state_machine as core
import aiwan_core_models as core_models_mod
import aiwan_loop1_tick as loop1
from aiwan_loop1_tick import (  # 复用低层控制面/工具
    HubJobClient,
    JobApiError,
    iso_now,
    lease_active,
    poll_sql,
)

MODEL_SCRIPTS = ["model_summary", "model_daily_avg"]
MAX_ACTIVE_SQL = 1          # 机型 SQL 重，排队瓶颈，单条推进
MAX_SQL_RETRIES = 2
SUCCESS_STATUSES = set(core.TERMINAL_SUCCESS)
FAILED_STATUSES = set(core.TERMINAL_FAILED)

# 候选收敛口径（设计 §12，版本化，勿散落）
MODEL_GMV_TOP_N = 5
MODEL_ANOMALY_CAP = 5
MODEL_GMV_WOW_THRESHOLD = 0.10

CORE_MODEL_SNAPSHOT_MISSING = "CORE_MODEL_SNAPSHOT_MISSING"


# --------------------------------------------------------------------------- #
# 纯函数：SQL 品类过滤注入
# --------------------------------------------------------------------------- #
_STAT_DATE_WHERE = re.compile(r"(?m)^(\s*and\s+a\.stat_date\s+between\s+.*?'\$\{hiveconf:run_dt\}'|\s*and\s+a\.stat_date\s+between\s+.*?'[0-9]{4}-[0-9]{2}-[0-9]{2}')$")


def _hive_str_list(categories: list[str]) -> str:
    return ",".join("'" + str(c).replace("'", "''") + "'" for c in categories)


def inject_category_filter(sql: str, categories: list[str]) -> str:
    """在每个 stat_date where 之后注入 `and a.cate_name in (...)`（砍 shuffle/输出，不裁分区扫描）。

    只匹配真实 where 行（注释行以 `--` 开头，不会命中）。空名单原样返回。
    """
    cats = [c for c in (categories or []) if str(c).strip()]
    if not cats:
        return sql
    in_clause = f"  and a.cate_name in ({_hive_str_list(cats)})"

    def repl(match: re.Match) -> str:
        return match.group(1) + "\n" + in_clause

    return _STAT_DATE_WHERE.sub(repl, sql)


# --------------------------------------------------------------------------- #
# 纯函数：候选机型收敛（核心 ∪ GMV Top-N ∪ 环比异动）
# --------------------------------------------------------------------------- #
def select_candidate_models(
    model_rows: list[dict[str, Any]],
    *,
    core_models: dict[str, list[dict[str, Any]]] | None = None,
    top_n: int = MODEL_GMV_TOP_N,
    anomaly_cap: int = MODEL_ANOMALY_CAP,
    gmv_wow_threshold: float = MODEL_GMV_WOW_THRESHOLD,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """按品类收敛机型候选：核心机型(全保留) ∪ GMV Top-N ∪ 规则异动机型(限 cap)。

    返回 (by_category, warnings)。超异动上限的写入 truncated_candidates，不静默丢弃（§7.1）。
    core_models 为 None → 快照缺失，降级为 TopN + 异动并打 CORE_MODEL_SNAPSHOT_MISSING（§11）。
    """
    warnings: list[str] = []
    if core_models is None:
        warnings.append(CORE_MODEL_SNAPSHOT_MISSING)
    core_by_cat = core_models or {}

    def fnum(x: Any) -> float:
        try:
            return float(x or 0)
        except (TypeError, ValueError):
            return 0.0

    # 按品类分桶
    rows_by_cat: dict[str, list[dict[str, Any]]] = {}
    for r in model_rows:
        if not isinstance(r, dict):
            continue
        cat = str(r.get("category") or "").strip()
        if cat:
            rows_by_cat.setdefault(cat, []).append(r)

    out: dict[str, dict[str, Any]] = {}
    categories = set(rows_by_cat) | set(core_by_cat)
    for cat in categories:
        rows = rows_by_cat.get(cat, [])
        selected: dict[str, dict[str, Any]] = {}

        def ensure(model_id: str, name: str, row: dict[str, Any], reason: str) -> None:
            entry = selected.get(model_id)
            if entry is None:
                entry = {
                    "model_id": model_id,
                    "model_name": name,
                    "selection_reasons": [],
                    "gmv": fnum(row.get("gmv")),
                    "gmv_delta": row.get("gmv_delta"),
                    "gmv_delta_pct": row.get("gmv_delta_pct"),
                }
                selected[model_id] = entry
            if reason not in entry["selection_reasons"]:
                entry["selection_reasons"].append(reason)

        # GMV Top-N
        for row in sorted(rows, key=lambda r: -fnum(r.get("gmv")))[:max(top_n, 0)]:
            mid = str(row.get("model_id") or "").strip()
            if mid:
                ensure(mid, str(row.get("model_name") or ""), row, "gmv_top5")

        # 环比异动机型（|pct|>=阈值），按 |pct| 降序，超 cap 截断
        anomalies = []
        for row in rows:
            pct = row.get("gmv_delta_pct")
            try:
                if pct is not None and abs(float(pct)) >= gmv_wow_threshold:
                    anomalies.append(row)
            except (TypeError, ValueError):
                continue
        anomalies.sort(key=lambda r: -abs(fnum(r.get("gmv_delta_pct"))))
        truncated: list[dict[str, Any]] = []
        for i, row in enumerate(anomalies):
            mid = str(row.get("model_id") or "").strip()
            if not mid:
                continue
            if i < max(anomaly_cap, 0):
                ensure(mid, str(row.get("model_name") or ""), row, "anomaly")
            else:
                truncated.append({"model_id": mid, "model_name": str(row.get("model_name") or ""),
                                  "gmv_delta_pct": row.get("gmv_delta_pct")})

        # 核心机型（全保留，无论是否异动）
        row_index = {str(r.get("model_id") or "").strip(): r for r in rows}
        for core_m in core_by_cat.get(cat, []):
            mid = str(core_m.get("model_id") or "").strip()
            if not mid:
                continue
            ensure(mid, str(core_m.get("model_name") or row_index.get(mid, {}).get("model_name") or ""),
                   row_index.get(mid, {}), "core")

        out[cat] = {"models": list(selected.values()), "truncated_candidates": truncated}

    return out, warnings


# --------------------------------------------------------------------------- #
# 纯函数：机型归因增量 merge（不清空 Loop1 文本）
# --------------------------------------------------------------------------- #
def merge_model_drilldowns_into_display(
    display: dict[str, Any],
    model_drilldowns: dict[str, Any],
) -> dict[str, Any]:
    """增量 merge：新增顶层 modelDrilldowns，并把机型下钻摘要拼到已有 categories 卡片。

    绝不清空/覆盖 Loop1 的 board/tiers/secondaryCategories/categories 文本（§9.3）；
    Loop1 没写过的品类卡片不凭空造（validate 写契约不变）。
    """
    out = dict(display)
    out["modelDrilldowns"] = model_drilldowns
    cats = dict(out.get("categories") or {})
    for cat, dd in (model_drilldowns or {}).items():
        summary = (dd or {}).get("summary")
        if cat in cats and summary and summary not in str(cats[cat]):
            cats[cat] = f"{cats[cat]}｜机型下钻：{summary}"
    out["categories"] = cats
    return out


# --------------------------------------------------------------------------- #
# 机型 SQL 渲染适配器
# --------------------------------------------------------------------------- #
class Loop2CoreAdapter:
    def render_model_sqls(self, args: argparse.Namespace, export_dir: Path,
                          categories: list[Any]) -> dict[str, dict[str, str]]:
        export_dir.mkdir(parents=True, exist_ok=True)
        names = [c.get("category") if isinstance(c, dict) else c for c in categories]
        rendered: dict[str, dict[str, str]] = {}
        for name in MODEL_SCRIPTS:
            template = core.repo_root() / "references" / "read" / "sql" / f"{name}.sql"
            sql = core.render_sql(template.read_text(encoding="utf-8"), args.run_dt, args.data_end_date)
            sql = inject_category_filter(sql, [str(n) for n in names if n])
            path = export_dir / f"{name}_{args.run_dt}.sql"
            path.write_text(sql, encoding="utf-8")
            rendered[name] = {"sql": sql, "path": str(path), "sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest()}
        return rendered

    def materialize(self, execute_id: str, csv_path: Path, debug_dir: Path, script_name: str) -> int:
        return core.materialize_full_csv(execute_id, csv_path, debug_dir, script_name)

    def process_models(self, args: argparse.Namespace, run_dir: Path,
                       read_result: dict[str, Any], categories: list[Any]) -> dict[str, Any]:
        # 解析机型 CSV → 每机型 cur/prev → 候选收敛；核心机型快照缺失时降级并打 warn。
        parser_wired = hasattr(core, "load_model_rows_for_categories")
        model_rows = core.load_model_rows_for_categories(run_dir, categories) if parser_wired else []
        snapshot = core_models_mod.load_core_models(core.repo_root() / "references" / "process" / "core-models.json")
        names = [c.get("category") if isinstance(c, dict) else c for c in categories]
        core_by_cat = core_models_mod.active_core_models_by_category(snapshot, [str(n) for n in names if n]) \
            if core_models_mod.snapshot_is_usable(snapshot) else None
        by_cat, warnings = select_candidate_models(model_rows, core_models=core_by_cat)
        if not parser_wired:
            # 机型 CSV 解析器尚未接线：绝不静默产出空候选伪装成功，显式打 warn（见验收说明）。
            warnings.append("MODEL_ROWS_PARSER_NOT_WIRED")
        return {"status": "success", "candidate_models": by_cat, "warnings": warnings}

    def read_base_display(self, args: argparse.Namespace) -> dict[str, Any]:
        return core.read_published_display(args) if hasattr(core, "read_published_display") else {}

    def validate(self, args: argparse.Namespace, run_dir: Path, merged_display: dict[str, Any]) -> dict[str, Any]:
        if hasattr(core, "execute_model_validate"):
            return core.execute_model_validate(args, run_dir, merged_display)
        return {"status": "warn", "server_write_confirmed": False, "reason": "model_validate_not_wired"}


# --------------------------------------------------------------------------- #
# 跨 tick 状态机
# --------------------------------------------------------------------------- #
MODEL_ANALYZE_INPUT_FILE = "model_analyze_input.json"
MODEL_ANALYSIS_RESULT_FILE = "model_analysis_result.json"      # agent 写入
MODEL_ANALYSIS_SCAFFOLD_FILE = "model_analysis_scaffold.json"
PROCESSED_MODELS_FILE = "processed_models.json"


def _category_names(handoff: dict[str, Any]) -> list[str]:
    out = []
    for c in handoff.get("drilldown_categories") or []:
        name = c.get("category") if isinstance(c, dict) else c
        if name:
            out.append(str(name))
    return out


def pending_result(args: argparse.Namespace, handoff: dict[str, Any] | None, reason: str) -> dict[str, Any]:
    return {
        "ok": True, "business_status": "pending", "reason": reason,
        "run_id": args.run_id, "analysis_key": args.analysis_key,
        "handoff_status": handoff.get("status") if handoff else None,
        "state_revision": handoff.get("state_revision") if handoff else None,
    }


def analyze_pending_result(args: argparse.Namespace, handoff: dict[str, Any], run_dir: Path) -> dict[str, Any]:
    return {
        "ok": True, "business_status": "analyze_pending", "reason": "await_agent_model_analysis",
        "run_id": args.run_id, "analysis_key": args.analysis_key,
        "model_analyze_input": str(run_dir / MODEL_ANALYZE_INPUT_FILE),
        "model_analysis_result_expected": str(run_dir / MODEL_ANALYSIS_RESULT_FILE),
        "handoff_status": handoff.get("status"),
    }


def published_result(args: argparse.Namespace, handoff: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"ok": True, "business_status": "published", "run_id": args.run_id,
            "analysis_key": args.analysis_key, "handoff": handoff, **extra}


def checkpoint_update(job_client: Any, args: argparse.Namespace, handoff: dict[str, Any],
                      status: str, **fields: Any) -> dict[str, Any]:
    payload = {
        "kind": "drilldown", "base_revision": args.base_revision, "handoff_revision": 1,
        "expected_state_revision": handoff["state_revision"], "worker_id": args.worker_id,
        "status": status, **fields,
    }
    return job_client.update(args.analysis_key, payload)


def submit_model_sql(xinghe: Any, name: str, sql: str, args: argparse.Namespace) -> str:
    response = core.call_with_supported_kwargs(
        xinghe.run_hive_sql, content=sql, sql=sql,
        title=f"AIWAN Loop2 {name} {args.run_dt}", business_id="5", business_name="聚合回收",
    )
    return core.normalize_execute_id(response)


def build_model_analyze_input(args: argparse.Namespace, run_dir: Path,
                              processed: dict[str, Any], handoff: dict[str, Any]) -> Path:
    candidate_models = processed.get("candidate_models", {})
    warnings = processed.get("warnings", [])
    core.write_json(run_dir / MODEL_ANALYSIS_SCAFFOLD_FILE, {
        "candidate_models": candidate_models,
        "warnings": warnings,
        "drilldown_categories": _category_names(handoff),
    })
    core.write_json(run_dir / MODEL_ANALYZE_INPUT_FILE, {
        "run_id": args.run_id, "week": args.week, "run_dt": args.run_dt,
        "candidate_models": candidate_models,
        "warnings": warnings,
        "instruction": (
            "读机型归因 rubric。对每个下钻品类的候选机型写机型归因，写到 model_analysis_result.json 的 "
            "modelDrilldowns：每品类含 status/attribution_status/coverage/summary/models[]/verification_questions[]/"
            "truncated_candidates[]/warnings[]；每个机型结论标 fact/hypothesis/data_gap。数字只来自 "
            "candidate_models，禁编造；核心机型无论是否异动都要给主指标结论。分批产出避免超输出上限。"
        ),
    })
    return run_dir / MODEL_ANALYZE_INPUT_FILE


def gate_model_drilldowns(model_drilldowns: Any, scaffold: dict[str, Any]) -> list[str]:
    """机器闸门：agent 写的 modelDrilldowns 必须覆盖每个下钻品类且带非空 summary。"""
    if not isinstance(model_drilldowns, dict):
        return ["model_drilldowns_not_object"]
    errors: list[str] = []
    for cat in (scaffold.get("candidate_models") or {}):
        dd = model_drilldowns.get(cat)
        if not isinstance(dd, dict):
            errors.append(f"missing_drilldown:{cat}")
            continue
        if not str(dd.get("summary") or "").strip():
            errors.append(f"empty_summary:{cat}")
    return errors


def finalize_after_model_analyze(args: argparse.Namespace, run_dir: Path, handoff: dict[str, Any],
                                 job_client: Any, adapter: Any) -> dict[str, Any]:
    result_path = run_dir / MODEL_ANALYSIS_RESULT_FILE
    if not result_path.exists():
        return analyze_pending_result(args, handoff, run_dir)
    scaffold = core.read_json(run_dir / MODEL_ANALYSIS_SCAFFOLD_FILE)
    agent = core.read_json(result_path)
    model_drilldowns = agent.get("modelDrilldowns") if isinstance(agent, dict) else {}
    gate_errors = gate_model_drilldowns(model_drilldowns, scaffold)
    if gate_errors:
        handoff = checkpoint_update(job_client, args, handoff, "retryable_failed", current_stage="analyze",
                                    error={"code": "MODEL_ANALYSIS_GATE_FAILED", "errors": gate_errors[:20]})
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id,
                "analysis_key": args.analysis_key,
                "error": {"code": "MODEL_ANALYSIS_GATE_FAILED", "errors": gate_errors[:20]}, "handoff": handoff}
    base_display = adapter.read_base_display(args) or {}
    merged = merge_model_drilldowns_into_display(base_display, model_drilldowns)
    core.write_json(run_dir / "model_analysis_result_assembled.json", {"display_insights": merged})
    handoff = checkpoint_update(job_client, args, handoff, "validating", current_stage="validate")
    validation = adapter.validate(args, run_dir, merged)
    if validation.get("server_write_confirmed") is not True:
        handoff = checkpoint_update(job_client, args, handoff, "retryable_failed", current_stage="analyze",
                                    error={"code": "MODEL_VALIDATE_FAILED", "detail": validation.get("reason")})
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id,
                "analysis_key": args.analysis_key,
                "error": {"code": "MODEL_VALIDATE_FAILED", "detail": validation.get("reason")}, "handoff": handoff}
    warnings = scaffold.get("warnings", []) or []
    handoff = checkpoint_update(job_client, args, handoff, "published", current_stage="validate", warnings=warnings)
    return published_result(args, handoff, warnings=warnings, validate=validation.get("status"))


def run_tick(args: argparse.Namespace, job_client: Any | None = None,
             xinghe_client: Any | None = None, adapter: Any | None = None) -> dict[str, Any]:
    job_client = job_client or HubJobClient()
    xinghe_client = xinghe_client or core.xinghe
    adapter = adapter or Loop2CoreAdapter()
    if xinghe_client is None:
        raise RuntimeError("zloop_runtime.xinghe is unavailable")

    run_dir = core.out_root() / "aiwan_runs" / args.run_id
    export_dir = run_dir / "read_exports"
    raw_root = run_dir / "read_artifacts"
    debug_dir = run_dir / "debug"
    for path in (run_dir, export_dir, raw_root, debug_dir):
        path.mkdir(parents=True, exist_ok=True)

    handoff: dict[str, Any] | None = None
    try:
        try:
            handoff = job_client.get(args.analysis_key, args.base_revision, kind="drilldown", handoff_revision=1)
        except JobApiError:
            return pending_result(args, None, "no_handoff")
        if not handoff:
            return pending_result(args, None, "no_handoff")

        if handoff.get("status") == "published":
            return published_result(args, handoff)
        if handoff.get("status") in {"failed", "superseded"}:
            return {"ok": False, "business_status": handoff["status"], "run_id": args.run_id,
                    "analysis_key": args.analysis_key, "handoff": handoff}
        if handoff.get("model_enrichment_mode") != "enabled":
            return pending_result(args, handoff, "enrichment_disabled")
        categories = _category_names(handoff)
        if not categories:
            return pending_result(args, handoff, "no_drilldown_categories")

        if handoff.get("lease_owner") and lease_active(handoff) and handoff.get("lease_owner") != args.worker_id:
            return pending_result(args, handoff, "lease_held_by_other_worker")
        handoff = job_client.claim(args.analysis_key, {
            "kind": "drilldown", "base_revision": args.base_revision, "handoff_revision": 1,
            "expected_state_revision": handoff["state_revision"], "worker_id": args.worker_id,
            "lease_seconds": args.lease_seconds, "current_stage": handoff.get("current_stage") or "read",
        })

        if handoff.get("current_stage") in {"analyze", "validate"}:
            return finalize_after_model_analyze(args, run_dir, handoff, job_client, adapter)

        rendered = adapter.render_model_sqls(args, export_dir, handoff.get("drilldown_categories") or [])
        sql_hashes = {name: rendered[name]["sha256"] for name in MODEL_SCRIPTS}
        for name, expected_hash in sql_hashes.items():
            actual = (handoff.get("sql_hashes") or {}).get(name)
            if actual and actual != expected_hash:
                raise RuntimeError(f"MODEL_SQL_HASH_MISMATCH: {name}")

        checkpoints = dict(handoff.get("sql_checkpoints") or {})
        for name in MODEL_SCRIPTS:
            cp = checkpoints.get(name) or {}
            execute_id = cp.get("execute_id") or (handoff.get("execute_ids") or {}).get(name)
            status = str(cp.get("status") or "").upper()
            if not execute_id or status in SUCCESS_STATUSES or status in FAILED_STATUSES:
                continue
            polled = poll_sql(xinghe_client, str(execute_id))
            next_status = "sql_running" if handoff.get("status") in {"claimed", "sql_submitted", "sql_running"} else handoff["status"]
            if polled in FAILED_STATUSES:
                retry_count = int(cp.get("retry_count") or 0)
                terminal = retry_count >= MAX_SQL_RETRIES
                handoff = checkpoint_update(job_client, args, handoff, "failed" if terminal else "retryable_failed",
                    current_stage="read",
                    sql_checkpoints={name: {"execute_id": str(execute_id), "sql_hash": sql_hashes[name],
                                            "status": polled, "retry_count": retry_count if terminal else retry_count + 1}},
                    error={"code": "MODEL_SQL_TERMINAL_FAILED" if terminal else "MODEL_SQL_RETRY_SCHEDULED",
                           "script": name, "status": polled, "retry_count": retry_count, "max_retries": MAX_SQL_RETRIES})
                if terminal:
                    return {"ok": False, "business_status": "failed", "run_id": args.run_id,
                            "analysis_key": args.analysis_key, "handoff": handoff}
                return pending_result(args, handoff, "model_sql_terminal_retry_scheduled")
            handoff = checkpoint_update(job_client, args, handoff, next_status, current_stage="read",
                sql_checkpoints={name: {"execute_id": str(execute_id), "sql_hash": sql_hashes[name], "status": polled}})
            checkpoints = dict(handoff.get("sql_checkpoints") or {})

        active_count = sum(1 for item in checkpoints.values()
                           if item.get("execute_id")
                           and str(item.get("status") or "").upper() not in SUCCESS_STATUSES
                           and str(item.get("status") or "").upper() not in FAILED_STATUSES)
        for name in MODEL_SCRIPTS:
            cp = checkpoints.get(name) or {}
            cp_status = str(cp.get("status") or "").upper()
            retrying = bool(cp.get("execute_id") and cp_status in FAILED_STATUSES)
            if (cp.get("execute_id") and not retrying) or active_count >= MAX_ACTIVE_SQL:
                continue
            execute_id = submit_model_sql(xinghe_client, name, rendered[name]["sql"], args)
            state = "sql_submitted" if handoff.get("status") == "claimed" else handoff["status"]
            handoff = checkpoint_update(job_client, args, handoff, state, current_stage="read",
                sql_checkpoints={name: {"execute_id": execute_id, "sql_hash": sql_hashes[name],
                                        "status": "SUBMITTED", "retry_count": int(cp.get("retry_count") or 0)}}, error={})
            checkpoints = dict(handoff.get("sql_checkpoints") or {})
            active_count += 1

        if not all(str((checkpoints.get(name) or {}).get("status") or "").upper() in SUCCESS_STATUSES for name in MODEL_SCRIPTS):
            return pending_result(args, handoff, "sql_not_ready")

        if handoff.get("status") == "claimed":
            handoff = checkpoint_update(job_client, args, handoff, "sql_submitted", current_stage="read")
        if handoff.get("status") != "materializing":
            handoff = checkpoint_update(job_client, args, handoff, "materializing", current_stage="read")
        for name in MODEL_SCRIPTS:
            cp = (handoff.get("sql_checkpoints") or {}).get(name) or {}
            csv_path = export_dir / f"{name}_{args.run_dt}.csv"
            rows = adapter.materialize(str(cp["execute_id"]), csv_path, debug_dir, name)
            if rows <= 0:
                raise RuntimeError(f"model SQL {name} materialized empty CSV")
            handoff = checkpoint_update(job_client, args, handoff, "materializing", current_stage="read",
                sql_checkpoints={name: {"execute_id": str(cp["execute_id"]), "sql_hash": sql_hashes[name],
                                        "status": "SUCCESS", "artifact_uri": str(csv_path),
                                        "artifact_hash": core.sha256_file(csv_path), "materialized_at": iso_now()}})

        read_result = {"stage": "read", "run_id": args.run_id, "artifacts": {"input_dir": str(raw_root)}}
        handoff = checkpoint_update(job_client, args, handoff, "processing", current_stage="process")
        processed = adapter.process_models(args, run_dir, read_result, handoff.get("drilldown_categories") or [])
        core.write_json(run_dir / PROCESSED_MODELS_FILE, processed)
        build_model_analyze_input(args, run_dir, processed, handoff)
        handoff = checkpoint_update(job_client, args, handoff, "analyzing", current_stage="analyze")
        return analyze_pending_result(args, handoff, run_dir)
    except JobApiError as exc:
        if exc.code in {"JOB_STATE_REVISION_CONFLICT", "JOB_LEASE_CONFLICT", "JOB_LEASE_EXPIRED", "JOB_NOT_CLAIMABLE"}:
            return pending_result(args, handoff, exc.code.lower())
        raise
    except Exception as exc:
        if handoff and handoff.get("status") not in {"published", "failed", "superseded", "retryable_failed"}:
            try:
                handoff = checkpoint_update(job_client, args, handoff, "retryable_failed",
                    current_stage=handoff.get("current_stage") or "read",
                    error={"code": "LOOP2_TICK_FAILED", "message": str(exc)[:1000]})
            except Exception:
                pass
        return {"ok": False, "business_status": "retryable_failed", "run_id": args.run_id,
                "analysis_key": args.analysis_key, "error": {"code": "LOOP2_TICK_FAILED", "message": str(exc)}, "handoff": handoff}


def exit_code_for(result: dict[str, Any]) -> int:
    return 0 if result.get("ok", False) or result.get("business_status") in {"pending", "analyze_pending", "published"} else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AIWAN Loop2 机型下钻 tick")
    parser.add_argument("--analysis-key", required=True)
    parser.add_argument("--week", required=True)
    parser.add_argument("--run-dt", required=True)
    parser.add_argument("--data-end-date", required=True)
    parser.add_argument("--base-revision", type=int, default=1)
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--worker-id", default=None)
    parser.add_argument("--lease-seconds", type=int, default=3600)
    return parser


def apply_runtime_defaults(args: argparse.Namespace) -> argparse.Namespace:
    if not getattr(args, "run_id", None):
        args.run_id = f"loop2-{args.week}-{args.data_end_date}-r{args.base_revision}"
    if not getattr(args, "worker_id", None):
        args.worker_id = os.environ.get("AIWAN_LOOP2_WORKER_ID") or f"loop2:{args.week}:{args.data_end_date}:b{args.base_revision}"
    return args


def main() -> None:
    args = apply_runtime_defaults(build_parser().parse_args())
    result = run_tick(args)
    print(json.dumps(result, ensure_ascii=False))
    raise SystemExit(exit_code_for(result))


if __name__ == "__main__":
    main()

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
import time
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
SUCCESS_STATUSES = {core.normalize_sql_status(status) for status in core.TERMINAL_SUCCESS}
FAILED_STATUSES = {core.normalize_sql_status(status) for status in core.TERMINAL_FAILED}

# 候选收敛口径（设计 §12，版本化，勿散落）
MODEL_GMV_TOP_N = 5
MODEL_ANOMALY_CAP = 5
MODEL_GMV_WOW_THRESHOLD = 0.10
MODEL_COVERAGE_TARGET = 0.70   # 归因覆盖门槛（设计 §7.3/§12）

CORE_MODEL_SNAPSHOT_MISSING = "CORE_MODEL_SNAPSHOT_MISSING"
MODEL_HISTORY_UNAVAILABLE = "MODEL_HISTORY_UNAVAILABLE"
MODEL_HISTORY_PARTIAL = "MODEL_HISTORY_PARTIAL"
MODEL_HISTORY_WINDOW_WEEKS = 10
MODEL_HISTORY_RETRIES = 3
TREND_DEFAULT_THRESHOLD = 0.10
BASE_READY_STATUSES = {"published"}
BASE_READY_PUBLICATION_STATUSES = {"published", "late_published"}
BASE_READY_DELIVERY_STATES = {"base_published", "late_published"}


def sql_status(status: Any) -> str:
    return core.normalize_sql_status(status)


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

    out, count = _STAT_DATE_WHERE.subn(repl, sql)
    if count == 0:
        # 一处 where 都没匹配到：模板结构变了。绝不静默退化成全品类扫描（设计反复警告静默失败）。
        raise RuntimeError("inject_category_filter: no stat_date where matched; category filter would silently no-op")
    return out


# --------------------------------------------------------------------------- #
# 纯函数：候选机型收敛（核心 ∪ GMV Top-N ∪ 环比异动）
# --------------------------------------------------------------------------- #
def select_candidate_models(
    model_rows: list[dict[str, Any]],
    *,
    core_models: dict[str, list[dict[str, Any]]] | None = None,
    requested_categories: list[str] | None = None,
    top_n: int = MODEL_GMV_TOP_N,
    anomaly_cap: int = MODEL_ANOMALY_CAP,
    gmv_wow_threshold: float = MODEL_GMV_WOW_THRESHOLD,
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """按品类收敛机型候选：核心机型(全保留) ∪ GMV Top-N ∪ 规则异动机型(限 cap)。

    返回 (by_category, warnings)。超异动上限的写入 truncated_candidates，不静默丢弃（§7.1）。
    core_models 为 None → 快照缺失，降级为 TopN + 异动并打 CORE_MODEL_SNAPSHOT_MISSING（§11）。
    requested_categories 非空时只对下钻名单收敛（SQL 过滤失效时的兜底，避免混入非下钻品类）。
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
    if requested_categories:
        categories &= {str(c).strip() for c in requested_categories if str(c).strip()}
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
# 纯函数：确定性归因覆盖度（设计 §7.3，数字系统算、agent 只引用）
# --------------------------------------------------------------------------- #
def compute_coverage_by_category(
    by_category: dict[str, dict[str, Any]],
    model_rows: list[dict[str, Any]],
    *,
    target: float = MODEL_COVERAGE_TARGET,
) -> dict[str, dict[str, Any]]:
    """覆盖度 = 已归因机型 |ΔGMV| 之和 ÷ 品类全部机型 |ΔGMV| 之和（§7.3）。

    数字确定性计算，禁止交给 agent 自算（brief §2；Loop1 digest 同款教训）。
    品类无机型数据（分母为 0）时 coverage=None、attribution_status=unknown，不造假数。
    """
    def fabs(x: Any) -> float:
        try:
            return abs(float(x or 0))
        except (TypeError, ValueError):
            return 0.0

    total_by_cat: dict[str, float] = {}
    for r in model_rows:
        if not isinstance(r, dict):
            continue
        cat = str(r.get("category") or "").strip()
        if cat:
            total_by_cat[cat] = total_by_cat.get(cat, 0.0) + fabs(r.get("gmv_delta"))

    delta_by_cat_model: dict[tuple[str, str], float] = {}
    for r in model_rows:
        if not isinstance(r, dict):
            continue
        cat = str(r.get("category") or "").strip()
        mid = str(r.get("model_id") or "").strip()
        if cat and mid:
            delta_by_cat_model[(cat, mid)] = fabs(r.get("gmv_delta"))

    out: dict[str, dict[str, Any]] = {}
    for cat, sel in by_category.items():
        analyzed = 0.0
        for mdl in (sel or {}).get("models") or []:
            mid = str(mdl.get("model_id") or "").strip()
            analyzed += delta_by_cat_model.get((cat, mid), 0.0)
        total = total_by_cat.get(cat, 0.0)
        if total > 0:
            coverage = analyzed / total
            status = "sufficient" if coverage >= target else "insufficient_coverage"
        else:
            coverage = None
            status = "unknown"
        out[cat] = {
            "coverage": coverage,
            "attribution_status": status,
            "analyzed_abs_delta": analyzed,
            "total_abs_delta": total,
        }
    return out


# --------------------------------------------------------------------------- #
# 纯函数：服务器历史上下文 → 系统证据（趋势/集中度/上一期状态）
# --------------------------------------------------------------------------- #
def _num(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _pct_delta(cur: float, prev: float) -> float | None:
    if prev <= 0:
        return None
    return (cur - prev) / prev


def _direction(value: float | None, threshold: float) -> str:
    if value is None or abs(value) < threshold:
        return "flat"
    return "up" if value > 0 else "down"


def _is_complete_week(row: dict[str, Any]) -> bool:
    days = row.get("daysReceived", row.get("day_cnt", row.get("dayCnt")))
    if days is None or days == "":
        return True
    return _num(days) >= 7


def _row_model_id(row: dict[str, Any]) -> str:
    return str(row.get("model_id") or row.get("modelId") or "").strip()


def _row_model_name(row: dict[str, Any]) -> str:
    return str(row.get("model_name") or row.get("modelName") or "").strip()


def _model_key(row: dict[str, Any]) -> str:
    return _row_model_id(row) or _row_model_name(row)


def build_model_history_filters(candidate_models: dict[str, Any]) -> dict[str, list[str]]:
    categories: list[str] = []
    model_ids: list[str] = []
    model_names: list[str] = []
    for cat, bundle in (candidate_models or {}).items():
        if str(cat).strip():
            categories.append(str(cat).strip())
        for mdl in (bundle or {}).get("models") or []:
            mid = str(mdl.get("model_id") or "").strip()
            name = str(mdl.get("model_name") or "").strip()
            if mid:
                model_ids.append(mid)
            if name:
                model_names.append(name)
    return {
        "categories": sorted(set(categories)),
        "model_ids": sorted(set(model_ids)),
        "model_names": sorted(set(model_names)),
    }


def compute_concentration_by_category(
    by_category: dict[str, dict[str, Any]],
    coverage_by_category: dict[str, dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for cat, bundle in (by_category or {}).items():
        models = list((bundle or {}).get("models") or [])
        models.sort(key=lambda m: -abs(_num(m.get("gmv_delta"))))
        total = _num((coverage_by_category.get(cat) or {}).get("total_abs_delta"))
        shares: dict[str, float | None] = {}
        for n in (1, 3, 5):
            part = sum(abs(_num(m.get("gmv_delta"))) for m in models[:n])
            shares[f"top{n}"] = (part / total) if total > 0 else None
        top5 = shares["top5"]
        if top5 is None:
            concentration = "unknown"
        elif top5 >= 0.50:
            concentration = "concentrated_few_models"
        elif top5 <= 0.30:
            concentration = "broad_based_change"
        else:
            concentration = "mixed"
        out[cat] = {
            "metric": "abs_gmv_delta",
            "top1_share": shares["top1"],
            "top3_share": shares["top3"],
            "top5_share": top5,
            "classification": concentration,
            "top_models": [
                {"model_id": m.get("model_id"), "model_name": m.get("model_name"), "gmv_delta": m.get("gmv_delta")}
                for m in models[:5]
            ],
        }
    return out


def _previous_model_ids(previous_model_drilldowns: dict[str, Any], category: str) -> set[str]:
    prev = previous_model_drilldowns.get("modelDrilldowns") if isinstance(previous_model_drilldowns, dict) else {}
    dd = (prev or {}).get(category) if isinstance(prev, dict) else None
    out: set[str] = set()
    for mdl in (dd or {}).get("models") or []:
        mid = str(mdl.get("model_id") or mdl.get("modelId") or "").strip()
        if mid:
            out.add(mid)
    return out


def compute_model_trend_context(
    *,
    candidate_models: dict[str, Any],
    model_history: dict[str, Any],
    previous_model_drilldowns: dict[str, Any] | None,
    threshold: float = TREND_DEFAULT_THRESHOLD,
) -> dict[str, Any]:
    rows = [r for r in (model_history or {}).get("rows") or [] if isinstance(r, dict)]
    by_cat_model: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in rows:
        cat = str(row.get("category") or "").strip()
        key = _model_key(row)
        week = str(row.get("week") or "").strip()
        if cat and key and week:
            by_cat_model.setdefault((cat, key), []).append(row)
    for values in by_cat_model.values():
        values.sort(key=lambda r: str(r.get("week") or ""))

    out: dict[str, Any] = {}
    for cat, bundle in (candidate_models or {}).items():
        cat_out: dict[str, Any] = {}
        prev_ids = _previous_model_ids(previous_model_drilldowns or {}, cat)
        for mdl in (bundle or {}).get("models") or []:
            mid = str(mdl.get("model_id") or "").strip()
            name = str(mdl.get("model_name") or "").strip()
            history_rows = by_cat_model.get((cat, mid), []) if mid else []
            if not history_rows and name:
                history_rows = by_cat_model.get((cat, name), [])
            series = []
            prev_gmv: float | None = None
            for row in history_rows:
                gmv = _num(row.get("gmv"))
                pct = _pct_delta(gmv, prev_gmv) if prev_gmv is not None else None
                direction = _direction(pct, threshold)
                complete = _is_complete_week(row)
                series.append({
                    "week": row.get("week"),
                    "gmv": gmv,
                    "gmv_delta_pct": pct,
                    "direction": direction,
                    "complete_week": complete,
                    "daysReceived": row.get("daysReceived", row.get("day_cnt", row.get("dayCnt"))),
                })
                prev_gmv = gmv
            complete_moves = [x for x in series if x["complete_week"] and x["gmv_delta_pct"] is not None]
            last = series[-1] if series else None
            last_complete = complete_moves[-1] if complete_moves else None
            last_three = complete_moves[-3:]
            crossed = [x for x in last_three if x["direction"] != "flat"]
            directions = {x["direction"] for x in crossed}
            current_pct = _pct_delta(_num(mdl.get("gmv")), _num(mdl.get("gmv")) - _num(mdl.get("gmv_delta"))) \
                if mdl.get("gmv_delta") is not None else None
            current_direction = _direction(current_pct, threshold)
            previous_direction = complete_moves[-2]["direction"] if len(complete_moves) >= 2 else "unknown"
            if len(last_three) >= 3 and len(crossed) >= 2 and len(directions) == 1:
                trend_status = "sustained_trend"
            elif current_direction != "flat" and previous_direction not in {"unknown", "flat"} and previous_direction != current_direction:
                trend_status = "trend_reversal"
            elif current_direction == "flat" and previous_direction not in {"unknown", "flat"}:
                trend_status = "recovered_observation"
            elif current_direction != "flat":
                trend_status = "single_week_anomaly"
            else:
                trend_status = "normal_observation"
            if last and last.get("complete_week") is False:
                trend_gate = "current_week_incomplete_excluded_from_continuous_trend"
            else:
                trend_gate = "complete_weeks_only"
            prior_state = "first_seen"
            if mid and mid in prev_ids:
                if trend_status == "trend_reversal":
                    prior_state = "direction_reversed"
                elif trend_status == "recovered_observation":
                    prior_state = "recovered"
                else:
                    prior_state = "continuous_context"
            cat_out[mid or name] = {
                "model_id": mid or None,
                "model_name": name or None,
                "history_weeks": len(series),
                "complete_move_weeks": len(complete_moves),
                "current_sql_gmv_delta_pct": current_pct,
                "current_sql_direction": current_direction,
                "latest_history_direction": last_complete.get("direction") if last_complete else "unknown",
                "trend_status": trend_status,
                "trend_gate": trend_gate,
                "previous_conclusion_state": prior_state,
                "series": series[-MODEL_HISTORY_WINDOW_WEEKS:],
            }
        out[cat] = cat_out
    return out


def build_loop2_system_evidence(
    *,
    candidate_models: dict[str, Any],
    coverage_by_category: dict[str, Any],
    server_context: dict[str, Any],
) -> dict[str, Any]:
    context = server_context.get("context") if isinstance(server_context, dict) else {}
    model_history = (context or {}).get("model_history") or {}
    previous = (context or {}).get("previous_model_drilldowns") or {}
    rules = ((context or {}).get("rules") or {}).get("rules") or {}
    threshold = _num(rules.get("waveThreshold"), TREND_DEFAULT_THRESHOLD)
    status = str(model_history.get("status") or server_context.get("history_status") or "unavailable")
    concentration = compute_concentration_by_category(candidate_models, coverage_by_category)
    if status in {"ok", "partial"}:
        trends = compute_model_trend_context(
            candidate_models=candidate_models,
            model_history=model_history,
            previous_model_drilldowns=previous,
            threshold=threshold,
        )
    else:
        trends = {}
    return {
        "history_status": "ok" if status == "ok" else ("partial" if status == "partial" else "history_unavailable"),
        "allow_multiweek_trend": status in {"ok", "partial"},
        "allow_strong_opportunity_or_risk": status == "ok",
        "trend_rules": {
            "window_weeks": MODEL_HISTORY_WINDOW_WEEKS,
            "threshold": threshold,
            "continuous_trend": "3 complete weeks same direction and at least 2 weeks crossing threshold",
            "incomplete_week_policy": "show daily average and WoW, exclude from continuous trend and strong conclusions",
        },
        "concentration_by_category": concentration,
        "trend_by_category": trends,
        "previous_model_drilldowns": previous,
        "rules": (context or {}).get("rules"),
        "loop2_context_meta": (context or {}).get("loop2_context_meta"),
    }


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
        requested = [str(n) for n in names if n]
        core_by_cat = core_models_mod.active_core_models_by_category(snapshot, requested) \
            if core_models_mod.snapshot_is_usable(snapshot) else None
        by_cat, warnings = select_candidate_models(model_rows, core_models=core_by_cat,
                                                   requested_categories=requested)
        coverage = compute_coverage_by_category(by_cat, model_rows)
        if not parser_wired:
            # 机型 CSV 解析器尚未接线：绝不静默产出空候选伪装成功，显式打 warn（见验收说明）。
            warnings.append("MODEL_ROWS_PARSER_NOT_WIRED")
        return {"status": "success", "candidate_models": by_cat,
                "coverage_by_category": coverage, "warnings": warnings}

    def read_base_display(self, args: argparse.Namespace) -> dict[str, Any]:
        return core.read_published_display(args) if hasattr(core, "read_published_display") else {}

    def read_server_history_context(
        self,
        args: argparse.Namespace,
        candidate_models: dict[str, Any],
    ) -> dict[str, Any]:
        filters = build_model_history_filters(candidate_models)
        return core.hub_post(core.READ_PATH, {
            "run_id": args.run_id,
            "week": args.week,
            "stage": "analyze",
            "history_weeks": MODEL_HISTORY_WINDOW_WEEKS,
            "include": ["run_meta", "model_history", "previous_model_drilldowns", "rules", "loop2_context_meta"],
            "model_history_filters": filters,
        }, timeout=130.0)

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
MODEL_SERVER_CONTEXT_FILE = "model_server_context.json"


def _category_names(handoff: dict[str, Any]) -> list[str]:
    out = []
    for c in handoff.get("drilldown_categories") or []:
        name = c.get("category") if isinstance(c, dict) else c
        if name:
            out.append(str(name))
    return out


def pending_result(args: argparse.Namespace, handoff: dict[str, Any] | None, reason: str, **extra: Any) -> dict[str, Any]:
    return {
        "ok": True, "business_status": "pending", "reason": reason,
        "run_id": args.run_id, "analysis_key": args.analysis_key,
        "handoff_status": handoff.get("status") if handoff else None,
        "state_revision": handoff.get("state_revision") if handoff else None,
        **extra,
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


def base_job_is_ready_for_loop2(base_job: dict[str, Any] | None) -> bool:
    """Loop2 may start only after Loop1 base publication is durable.

    Fixed schedules are a buffer, not proof.  The runner must re-read the base
    control-plane job and only proceed after Loop1 has published (including
    late publication after the SLA deadline).  This prevents Loop2 from
    consuming half-built Loop1 context when a full Loop1 execution takes longer
    than expected.
    """
    if not isinstance(base_job, dict):
        return False
    status = str(base_job.get("status") or "")
    publication_status = str(base_job.get("publication_status") or "")
    delivery_state = str(base_job.get("deliveryState") or base_job.get("delivery_state") or "")
    if status in BASE_READY_STATUSES:
        return True
    if publication_status in BASE_READY_PUBLICATION_STATUSES:
        return True
    if delivery_state in BASE_READY_DELIVERY_STATES:
        return True
    return False


def base_job_snapshot(base_job: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(base_job, dict):
        return {}
    keys = (
        "job_id", "kind", "status", "current_stage", "state_revision", "publication_status",
        "deliveryState", "delivery_state", "model_enrichment_mode", "week", "data_end_date",
        "base_revision", "updated_at", "published_at", "base_deadline_at",
    )
    return {k: base_job.get(k) for k in keys if k in base_job}


def ensure_base_ready_for_loop2(args: argparse.Namespace, job_client: Any) -> tuple[bool, dict[str, Any] | None, str | None]:
    try:
        base_job = job_client.get(args.analysis_key, args.base_revision, kind="base", handoff_revision=0)
    except JobApiError as exc:
        if exc.code in {"JOB_NOT_FOUND", "AIWAN_JOB_NOT_FOUND"}:
            return False, None, "base_job_not_found"
        return False, None, f"base_job_read_failed:{exc.code}"
    if base_job_is_ready_for_loop2(base_job):
        return True, base_job, None
    status = str((base_job or {}).get("status") or "unknown")
    delivery_state = str((base_job or {}).get("deliveryState") or (base_job or {}).get("delivery_state") or "")
    if delivery_state:
        return False, base_job, f"base_not_published:{status}:{delivery_state}"
    return False, base_job, f"base_not_published:{status}"


def submit_model_sql(xinghe: Any, name: str, sql: str, args: argparse.Namespace) -> str:
    response = core.call_with_supported_kwargs(
        xinghe.run_hive_sql, content=sql, sql=sql,
        title=f"AIWAN Loop2 {name} {args.run_dt}", business_id="5", business_name="聚合回收",
    )
    return core.normalize_execute_id(response)


def read_server_history_context_with_retry(
    args: argparse.Namespace,
    adapter: Any,
    candidate_models: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    if not hasattr(adapter, "read_server_history_context"):
        return {
            "ok": False,
            "history_status": "unavailable",
            "error": {"code": "MODEL_HISTORY_READER_NOT_WIRED"},
            "context": {},
        }, [MODEL_HISTORY_UNAVAILABLE]
    last_error = None
    for attempt in range(1, MODEL_HISTORY_RETRIES + 1):
        try:
            ctx = adapter.read_server_history_context(args, candidate_models)
            if isinstance(ctx, dict) and ctx.get("ok") is True:
                model_history = ((ctx.get("context") or {}).get("model_history") or {})
                warnings: list[str] = []
                if model_history.get("status") == "partial":
                    warnings.append(MODEL_HISTORY_PARTIAL)
                ctx["history_retry_count"] = attempt - 1
                return ctx, warnings
            last_error = f"server returned ok={ctx.get('ok') if isinstance(ctx, dict) else None}"
        except Exception as exc:  # pragma: no cover - exercised by seam tests with fake adapter
            last_error = str(exc)
        if attempt < MODEL_HISTORY_RETRIES:
            time.sleep(0.2 * attempt)
    return {
        "ok": False,
        "history_status": "unavailable",
        "history_retry_count": MODEL_HISTORY_RETRIES,
        "error": {"code": "MODEL_HISTORY_READ_FAILED", "message": str(last_error or "")[:500]},
        "context": {},
    }, [MODEL_HISTORY_UNAVAILABLE]


def build_model_analyze_input(args: argparse.Namespace, run_dir: Path,
                              processed: dict[str, Any], handoff: dict[str, Any],
                              server_context: dict[str, Any] | None = None,
                              system_evidence: dict[str, Any] | None = None) -> Path:
    candidate_models = processed.get("candidate_models", {})
    coverage_by_category = processed.get("coverage_by_category", {})
    warnings = processed.get("warnings", [])
    system_evidence = system_evidence or build_loop2_system_evidence(
        candidate_models=candidate_models,
        coverage_by_category=coverage_by_category,
        server_context=server_context or {},
    )
    core.write_json(run_dir / MODEL_SERVER_CONTEXT_FILE, server_context or {})
    core.write_json(run_dir / MODEL_ANALYSIS_SCAFFOLD_FILE, {
        "candidate_models": candidate_models,
        "coverage_by_category": coverage_by_category,
        "system_evidence": system_evidence,
        "warnings": warnings,
        "drilldown_categories": _category_names(handoff),
    })
    core.write_json(run_dir / MODEL_ANALYZE_INPUT_FILE, {
        "run_id": args.run_id, "week": args.week, "run_dt": args.run_dt,
        "candidate_models": candidate_models,
        "coverage_by_category": coverage_by_category,
        "server_history_context": {
            "history_status": system_evidence.get("history_status"),
            "allow_multiweek_trend": system_evidence.get("allow_multiweek_trend"),
            "allow_strong_opportunity_or_risk": system_evidence.get("allow_strong_opportunity_or_risk"),
            "model_history": ((server_context or {}).get("context") or {}).get("model_history"),
            "previous_model_drilldowns": system_evidence.get("previous_model_drilldowns"),
            "rules": system_evidence.get("rules"),
            "loop2_context_meta": system_evidence.get("loop2_context_meta"),
        },
        "system_evidence": system_evidence,
        "warnings": warnings,
        "instruction": (
            "读机型归因 rubric。对每个下钻品类的候选机型写机型归因，写到 model_analysis_result.json 的 "
            "modelDrilldowns：每品类含 status/summary/models[]/verification_questions[]/truncated_candidates[]/"
            "warnings[]；每个机型结论标 fact/hypothesis/data_gap。本期原始数字只来自 candidate_models，禁编造；"
            "服务器 model_history / previous_model_drilldowns 只用于多周趋势、上一期状态和版本对齐，不能覆盖本期 SQL。"
            "coverage/attribution_status 由系统按 coverage_by_category 确定性给定，你不要自算或改写（会被覆盖）。"
            "trend/concentration/previous_conclusion_state 只引用 system_evidence，禁止自行计算趋势。"
            "history_status=history_unavailable 时，只写本周周环比和核心机型状态，禁止连续趋势、历史归因、强机会/强风险。"
            "当前周不完整时，可展示周日均和环比，但不得计入连续3周趋势或强结论。"
            "核心机型无论是否异动都要给主指标简短状态；只有越阈值、连续趋势或集中贡献的机型展开。分批产出避免超输出上限。"
        ),
    })
    return run_dir / MODEL_ANALYZE_INPUT_FILE


_EVIDENCE_LEVEL_KEYS = ("facts", "hypotheses", "data_gaps")


def gate_model_drilldowns(model_drilldowns: Any, scaffold: dict[str, Any]) -> list[str]:
    """机器闸门：agent 写的 modelDrilldowns 必须覆盖每个下钻品类、非空 summary、机型可追溯、证据分级齐全。

    - 候选品类缺失/非对象 → missing_drilldown
    - summary 为空 → empty_summary
    - 该品类有候选机型却没写机型结论 → empty_models
    - 机型 model_id 不在候选集（编造）→ unknown_model
    - 机型缺 fact/hypothesis/data_gap 任一分级 → missing_evidence_levels（§8.1/§8.3）
    """
    if not isinstance(model_drilldowns, dict):
        return ["model_drilldowns_not_object"]
    errors: list[str] = []
    candidates = scaffold.get("candidate_models") or {}
    system_evidence = scaffold.get("system_evidence") or {}
    allow_multiweek = system_evidence.get("allow_multiweek_trend") is True
    trend_by_cat = system_evidence.get("trend_by_category") or {}
    for cat, cand in candidates.items():
        dd = model_drilldowns.get(cat)
        if not isinstance(dd, dict):
            errors.append(f"missing_drilldown:{cat}")
            continue
        if not str(dd.get("summary") or "").strip():
            errors.append(f"empty_summary:{cat}")
        candidate_ids = {str(m.get("model_id") or "").strip() for m in (cand or {}).get("models") or []}
        models = dd.get("models")
        if candidate_ids and not (isinstance(models, list) and models):
            errors.append(f"empty_models:{cat}")
            continue
        for mdl in models or []:
            if not isinstance(mdl, dict):
                errors.append(f"model_not_object:{cat}")
                continue
            mid = str(mdl.get("model_id") or "").strip()
            if candidate_ids and mid not in candidate_ids:
                errors.append(f"unknown_model:{cat}:{mid}")
            if any(key not in mdl for key in _EVIDENCE_LEVEL_KEYS):
                errors.append(f"missing_evidence_levels:{cat}:{mid}")
            if not allow_multiweek and any(k in mdl for k in ("multiweek_trend", "historical_attribution", "trend_status")):
                errors.append(f"history_unavailable_forbids_multiweek:{cat}:{mid}")
            expected = ((trend_by_cat.get(cat) or {}).get(mid) or {}).get("trend_status")
            if expected and mdl.get("trend_status") is not None and mdl.get("trend_status") != expected:
                errors.append(f"trend_status_mismatch:{cat}:{mid}")
        if not allow_multiweek and any(k in dd for k in ("multiweek_trend", "historical_attribution", "trend_status")):
            errors.append(f"history_unavailable_forbids_category_trend:{cat}")
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
    # 覆盖度是确定性数字，用 scaffold 里系统算好的值覆盖 agent 写的，禁止 agent 自算（brief §2）。
    coverage_by_cat = scaffold.get("coverage_by_category") or {}
    for cat, dd in (model_drilldowns or {}).items():
        cov = coverage_by_cat.get(cat)
        if isinstance(dd, dict) and cov is not None:
            dd["coverage"] = cov.get("coverage")
            dd["attribution_status"] = cov.get("attribution_status")
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

        base_ready, base_job, base_reason = ensure_base_ready_for_loop2(args, job_client)
        if not base_ready:
            return pending_result(
                args, handoff, base_reason or "base_not_published",
                base_job=base_job_snapshot(base_job),
                loop2_start_gate="base_publication_required",
            )

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
            status = sql_status(cp.get("status"))
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
                           and sql_status(item.get("status")) not in SUCCESS_STATUSES
                           and sql_status(item.get("status")) not in FAILED_STATUSES)
        for name in MODEL_SCRIPTS:
            cp = checkpoints.get(name) or {}
            cp_status = sql_status(cp.get("status"))
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

        if not all(sql_status((checkpoints.get(name) or {}).get("status")) in SUCCESS_STATUSES for name in MODEL_SCRIPTS):
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
        server_context, history_warnings = read_server_history_context_with_retry(
            args, adapter, processed.get("candidate_models", {})
        )
        if history_warnings:
            processed["warnings"] = sorted(set((processed.get("warnings") or []) + history_warnings))
        system_evidence = build_loop2_system_evidence(
            candidate_models=processed.get("candidate_models", {}),
            coverage_by_category=processed.get("coverage_by_category", {}),
            server_context=server_context,
        )
        core.write_json(run_dir / PROCESSED_MODELS_FILE, processed)
        build_model_analyze_input(args, run_dir, processed, handoff, server_context, system_evidence)
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

"""核心机型快照：加载 + §6.3 同步校验（任务C）。

设计参照：`2026-07-17-aiwan-两跳Loop-机型按需下钻-设计-v2.md` §6。
业务飞书 sheet 尚未提供，包内 core-models.json 为占位空快照。Loop2 在快照不可用时
降级为 异动机型 + GMV Top-N 兜底并打 warn: CORE_MODEL_SNAPSHOT_MISSING。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

# 快照不可用的状态（占位/缺失/过期），Loop2 据此降级
UNUSABLE_STATUSES = {"pending_business_sheet", "missing", "snapshot_stale"}

# 飞书「02_机型与标签」表头 → 快照字段的默认映射。
# 注意：sheet 尚未提供，表头以业务实际为准；同步前必须核对并按需覆盖，勿静默沿用（设计 §6.2）。
DEFAULT_FEISHU_COLUMN_MAP: dict[str, str] = {
    "category": "品类",
    "secondary_category": "二级类目",
    "model_id": "机型ID",
    "model_name": "机型名称",
    "active": "是否核心观测机型",
    "anomaly_enabled": "是否用于异动分析",
    "reason": "关注理由",
    "owner": "负责人",
    "effective_from": "生效起",
    "effective_to": "生效止",
    "tags": "标签",
}
DEFAULT_TRUTHY = ("是", "Y", "y", "true", "True", "1")


def parse_feishu_core_model_rows(
    records: list[dict[str, Any]],
    *,
    column_map: dict[str, str] | None = None,
    truthy: Iterable[str] = DEFAULT_TRUTHY,
    tag_sep: str = ",",
) -> list[dict[str, Any]]:
    """把离线导出的飞书 sheet 记录映射为快照 rows（沙箱不直连飞书，先离线导出再喂进来）。

    是/否 列归一化为 bool，标签按分隔符切分，保留 1 起原始行号做可追溯。
    列名以传入 column_map 为准，默认映射仅为骨架，须按 sheet 实际表头校准。
    """
    cmap = column_map or DEFAULT_FEISHU_COLUMN_MAP
    truthy_set = {str(t) for t in truthy}
    out: list[dict[str, Any]] = []
    for idx, rec in enumerate(records, start=1):
        if not isinstance(rec, dict):
            continue

        def get(field: str) -> Any:
            col = cmap.get(field)
            return rec.get(col) if col else None

        raw_tags = get("tags")
        tags = [t.strip() for t in str(raw_tags).split(tag_sep) if t.strip()] if raw_tags else []
        out.append({
            "category": str(get("category") or "").strip(),
            "secondary_category": str(get("secondary_category") or "").strip(),
            "model_id": str(get("model_id") or "").strip(),
            "model_name": str(get("model_name") or "").strip(),
            "active": str(get("active") or "").strip() in truthy_set,
            "anomaly_enabled": str(get("anomaly_enabled") or "").strip() in truthy_set,
            "reason": str(get("reason") or "").strip(),
            "owner": str(get("owner") or "").strip(),
            "effective_from": get("effective_from"),
            "effective_to": get("effective_to"),
            "tags": tags,
            "source_row_numbers": [idx],
        })
    return out


def load_core_models(path: str | Path) -> dict[str, Any]:
    """读取核心机型快照。文件不存在时返回 status=missing 的空快照，绝不抛错阻断 Loop2。"""
    p = Path(path)
    if not p.exists():
        return {"status": "missing", "rows": []}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return {"status": "missing", "rows": [], "load_error": str(exc)}
    if not isinstance(data, dict):
        return {"status": "missing", "rows": []}
    data.setdefault("rows", [])
    return data


def snapshot_is_usable(snapshot: dict[str, Any]) -> bool:
    """有 active 行且状态非占位/缺失/过期，才算可用主源。"""
    if not isinstance(snapshot, dict):
        return False
    if str(snapshot.get("status") or "") in UNUSABLE_STATUSES:
        return False
    rows = snapshot.get("rows") or []
    return any(isinstance(r, dict) and r.get("active") and r.get("model_id") for r in rows)


def active_core_models_by_category(
    snapshot: dict[str, Any],
    categories: Iterable[str],
) -> dict[str, list[dict[str, Any]]]:
    """按品类分组返回 active 核心机型，仅保留请求名单内的品类。"""
    wanted = {str(c) for c in categories}
    out: dict[str, list[dict[str, Any]]] = {}
    for r in snapshot.get("rows") or []:
        if not isinstance(r, dict) or not r.get("active"):
            continue
        model_id = str(r.get("model_id") or "").strip()
        category = str(r.get("category") or "").strip()
        if not model_id or category not in wanted:
            continue
        out.setdefault(category, []).append(r)
    return out


def validate_core_models_rows(
    rows: list[dict[str, Any]],
    taxonomy_categories: Iterable[str],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """§6.3 校验：model_id 合法、品类在 taxonomy、同 model_id 多行合并标签、跨品类冲突拒绝。

    返回 (normalized_rows, report)。report 供同步报告使用。
    """
    taxo = {str(c) for c in taxonomy_categories}
    report: dict[str, Any] = {
        "rejected_invalid_model_id": [],
        "out_of_taxonomy": [],
        "merged_duplicates": 0,
        "conflicts": [],
    }
    merged: dict[tuple[str, str], dict[str, Any]] = {}
    model_to_category: dict[str, str] = {}

    for r in rows:
        if not isinstance(r, dict):
            continue
        model_id = str(r.get("model_id") or "").strip()
        category = str(r.get("category") or "").strip()
        if not model_id:
            report["rejected_invalid_model_id"].append(r)
            continue
        if category not in taxo:
            if category not in report["out_of_taxonomy"]:
                report["out_of_taxonomy"].append(category)
            continue
        prior_category = model_to_category.get(model_id)
        if prior_category is not None and prior_category != category:
            report["conflicts"].append({"model_id": model_id, "categories": [prior_category, category]})
            continue
        model_to_category[model_id] = category
        key = (category, model_id)
        if key in merged:
            base = merged[key]
            base["tags"] = sorted(set(base.get("tags") or []) | set(r.get("tags") or []))
            base["source_row_numbers"] = sorted(set(base.get("source_row_numbers") or []) | set(r.get("source_row_numbers") or []))
            report["merged_duplicates"] += 1
        else:
            row = dict(r)
            row["tags"] = list(row.get("tags") or [])
            row["source_row_numbers"] = list(row.get("source_row_numbers") or [])
            merged[key] = row

    return list(merged.values()), report

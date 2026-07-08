"""Dashboard v1.3.0-compatible payload adapter for 经营分析概览.

This module is intentionally deterministic and side-effect free. It converts the
existing model-tag-monitor `/api/dashboard` contract into the v0.4 workflow
`InputDict` shape used by prompts/schemas.
"""
from __future__ import annotations

import json
import math
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from .schemas import InputDict

MetricName = str

BOARD_METRIC_KEYS: dict[str, tuple[str, str]] = {
    "dau": ("kpi", "appDau"),
    "recycle_entrance_uv": ("kpi", "recycleEntranceUv"),
    "jikuang_uv": ("board", "conditionUv"),
    "gujia_uv": ("board", "evaUv"),
    "xiadan_uv": ("board", "orderUv"),
    "fahu_o_count": ("board", "shipCnt"),
    "chengjiao_orders": ("board", "dealCnt"),
    "chengjiao_gmv": ("board", "gmv"),
    "ke_danjia": ("derived", "avgPrice"),
}

REQUIRED_BOARD_FIELDS = [
    "jikuang_uv",
    "gujia_uv",
    "xiadan_uv",
    "fahu_o_count",
    "chengjiao_orders",
    "chengjiao_gmv",
]

STRATEGY_MISSING_WARNING = "未配置上周策略/预判，暂无法检核兑现"


@dataclass(frozen=True)
class DashboardBundle:
    """Current dashboard payload plus optional per-week history payloads."""

    current: dict[str, Any]
    history: list[dict[str, Any]]


def load_json_or_url(source: str) -> dict[str, Any]:
    """Load a dashboard payload from a JSON file or HTTP(S) URL."""
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=60) as resp:  # nosec B310 - internal tool URL
            return json.loads(resp.read().decode("utf-8"))
    return json.loads(Path(source).read_text(encoding="utf-8"))


def load_dashboard_bundle(source: str) -> DashboardBundle:
    """Load either a plain dashboard payload or a bundle fixture.

    Bundle fixture shape:
        {"current": {...}, "history": [{...}, ...]}
    """
    payload = load_json_or_url(source)
    if isinstance(payload.get("current"), dict):
        history = payload.get("history") if isinstance(payload.get("history"), list) else []
        return DashboardBundle(current=payload["current"], history=[h for h in history if isinstance(h, dict)])
    return DashboardBundle(current=payload, history=[])


def build_input_dict_from_bundle(
    bundle: DashboardBundle,
    week_label: str | None = None,
    last_week_strategies: str = "",
) -> dict[str, Any]:
    """Convert dashboard payload(s) into the workflow InputDict shape."""
    current = bundle.current
    week = week_label or str(current.get("week") or "")
    payload_by_week = _payload_map(bundle.history + [current])
    weeks = _ordered_weeks(current, payload_by_week)
    if week and week not in weeks:
        weeks.append(week)
        weeks.sort()

    board_series = {
        metric: _series_for_metric(metric, weeks, payload_by_week, current=current)
        for metric in BOARD_METRIC_KEYS
    }

    input_dict: dict[str, Any] = {
        "week_label": week,
        "data_reliability": _data_reliability(current, week, board_series),
        "dau": _metric_qoq(board_series["dau"], week, weeks),
        "jikuang_uv": _metric_qoq(board_series["jikuang_uv"], week, weeks),
        "gujia_uv": _metric_qoq(board_series["gujia_uv"], week, weeks),
        "xiadan_uv": _metric_qoq(board_series["xiadan_uv"], week, weeks),
        "fahu_o_count": _metric_qoq(board_series["fahu_o_count"], week, weeks),
        "chengjiao_orders": _metric_qoq(board_series["chengjiao_orders"], week, weeks),
        "chengjiao_gmv": _metric_qoq(board_series["chengjiao_gmv"], week, weeks),
        "ke_danjia": _metric_qoq(board_series["ke_danjia"], week, weeks),
        "clusters": _cluster_data(current, week, weeks, payload_by_week),
        "last_week_strategies": last_week_strategies or "",
    }
    # Validate early so caller never sends malformed payload to Codex.
    InputDict(**input_dict)
    return input_dict


def strategy_warnings(last_week_strategies: str = "") -> list[str]:
    """Return non-blocking workflow warnings."""
    if not (last_week_strategies or "").strip():
        return [STRATEGY_MISSING_WARNING]
    return []


def deterministic_insights_from_dashboard(current: dict[str, Any], warnings: Iterable[str] = ()) -> dict[str, Any]:
    """Build a lightweight deterministic insights object from /api/dashboard.

    This is the safe fallback when Codex is disabled, times out, or returns
    invalid JSON. It keeps the existing dashboard copy but adds governance
    metadata/warnings.
    """
    existing = current.get("insights") if isinstance(current.get("insights"), dict) else {}
    existing_tiers = existing.get("tiers") if isinstance(existing.get("tiers"), dict) else {}
    tiers = {**_fallback_tier_sentences(current), **existing_tiers}
    return {
        "board": existing.get("board") or _fallback_board_sentence(current),
        "tiers": tiers,
        "category": existing.get("category") or _fallback_category_sentence(current),
        "monitor": existing.get("monitor") or "监测页可继续查看机型级异动明细。",
        "warnings": list(warnings),
        "mode": "deterministic",
        "generatedBy": "business_overview_deterministic",
    }


def _payload_map(payloads: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for payload in payloads:
        week = str(payload.get("week") or "").strip()
        if week:
            out[week] = payload
    return out


def _ordered_weeks(current: dict[str, Any], payload_by_week: dict[str, dict[str, Any]]) -> list[str]:
    explicit = current.get("weeks") or current.get("weekWindow") or []
    weeks = [str(w) for w in explicit if w]
    for w in payload_by_week:
        if w not in weeks:
            weeks.append(w)
    return sorted(weeks)


def _series_for_metric(
    metric: MetricName,
    weeks: list[str],
    payload_by_week: dict[str, dict[str, Any]],
    current: dict[str, Any],
) -> dict[str, float | None]:
    series: dict[str, float | None] = {}
    for w in weeks:
        payload = payload_by_week.get(w)
        if payload:
            series[w] = _metric_value(payload, metric)
    # If only current payload is available, infer previous values from deltas.
    cur_week = str(current.get("week") or "")
    prev_week = str(current.get("prevWeek") or "")
    if cur_week and cur_week not in series:
        series[cur_week] = _metric_value(current, metric)
    if prev_week and prev_week not in series:
        inferred = _infer_prev_value(current, metric)
        if inferred is not None:
            series[prev_week] = inferred
    # For GMV, v1 compatibility exposes multi-week gmvTrend.
    if metric == "chengjiao_gmv":
        for item in current.get("gmvTrend") or []:
            w = str(item.get("week") or "")
            if w and w not in series:
                series[w] = _to_float(item.get("gmv"))
    return series


def _metric_value(payload: dict[str, Any], metric: MetricName) -> float | None:
    source, key = BOARD_METRIC_KEYS[metric]
    if source == "kpi":
        card = _kpi_card(payload, key)
        return _to_float(card.get("value")) if card else None
    if source == "derived":
        cur = (payload.get("board") or {}).get("cur") or {}
        gmv = _to_float(cur.get("gmv"))
        deal = _to_float(cur.get("dealCnt"))
        return gmv / deal if gmv is not None and deal and deal > 0 else None
    cur = (payload.get("board") or {}).get("cur") or {}
    if key == "conditionUv" and cur.get("conditionUv") is None:
        return _to_float(cur.get("jkuv"))
    return _to_float(cur.get(key))


def _infer_prev_value(payload: dict[str, Any], metric: MetricName) -> float | None:
    cur = _metric_value(payload, metric)
    if cur is None:
        return None
    source, key = BOARD_METRIC_KEYS[metric]
    if source == "kpi":
        card = _kpi_card(payload, key)
        delta_pct = _to_float(card.get("deltaPct")) if card else None
        if delta_pct is None or math.isclose(1 + delta_pct, 0):
            return None
        return cur / (1 + delta_pct)
    if source == "derived":
        # Prefer dashboard board deltas to infer previous avg price.
        gmv_prev = _infer_prev_value(payload, "chengjiao_gmv")
        deal_prev = _infer_prev_value(payload, "chengjiao_orders")
        return gmv_prev / deal_prev if gmv_prev is not None and deal_prev and deal_prev > 0 else None
    delta = _to_float(((payload.get("board") or {}).get("delta") or {}).get(key))
    return cur - delta if delta is not None else None


def _metric_qoq(series: dict[str, float | None], week: str, weeks: list[str]) -> dict[str, Any]:
    ordered = [w for w in weeks if w <= week]
    if week not in ordered:
        ordered.append(week)
        ordered.sort()
    idx = ordered.index(week) if week in ordered else len(ordered) - 1
    prev_week = ordered[idx - 1] if idx > 0 else ""
    week4 = ordered[idx - 4] if idx >= 4 else ""
    this = _num(series.get(week))
    prev = _num(series.get(prev_week)) if prev_week else 0.0
    week4_value = series.get(week4) if week4 else None
    tail_weeks = ordered[max(0, idx - 7): idx + 1]
    tail = [_num(series.get(w)) for w in tail_weeks if series.get(w) is not None]
    avg = sum(tail) / len(tail) if tail else None
    return {
        "this_week": this,
        "last_week": prev,
        "qoq": _pct(this, prev),
        "week4_ago": _to_float(week4_value),
        "yoy": _pct(this, _to_float(week4_value)) if week4_value is not None else None,
        "week8_avg": avg,
        "week8_position": _week8_position(this, avg),
        "week8_series": tail or None,
    }


def _cluster_data(
    current: dict[str, Any],
    week: str,
    weeks: list[str],
    payload_by_week: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for tier in ("发展", "孵化", "种子"):
        tier_series = {
            "gujia_uv": _tier_series(tier, "evaUv", weeks, payload_by_week),
            "xiadan_uv": _tier_series(tier, "orderUv", weeks, payload_by_week),
            "chengjiao_orders": _tier_series(tier, "dealCnt", weeks, payload_by_week),
            "chengjiao_gmv": _tier_series(tier, "gmv", weeks, payload_by_week),
        }
        cats = [c for c in current.get("categories") or [] if c.get("tier") == tier]
        out[tier] = {
            "name": tier,
            "gujia_uv": _metric_qoq(tier_series["gujia_uv"], week, weeks),
            "xiadan_uv": _metric_qoq(tier_series["xiadan_uv"], week, weeks),
            "chengjiao_orders": _metric_qoq(tier_series["chengjiao_orders"], week, weeks),
            "chengjiao_gmv": _metric_qoq(tier_series["chengjiao_gmv"], week, weeks),
            "categories": [_category_data(c) for c in cats],
        }
    return out


def _tier_series(tier: str, field: str, weeks: list[str], payload_by_week: dict[str, dict[str, Any]]) -> dict[str, float | None]:
    series: dict[str, float | None] = {}
    for w in weeks:
        payload = payload_by_week.get(w)
        if not payload:
            continue
        hit = next((t for t in payload.get("tiers") or [] if t.get("tier") == tier), None)
        if hit:
            series[w] = _to_float((hit.get("cur") or {}).get(field))
    return series


def _category_data(c: dict[str, Any]) -> dict[str, Any]:
    cur = c.get("cur") or {}
    trend = c.get("trend") or {}

    def m(field: str) -> dict[str, Any]:
        t = trend.get(field) or {}
        this = _to_float(cur.get(field))
        prev = _to_float(t.get("prev"))
        return {
            "this_week": _num(this),
            "last_week": _num(prev),
            "qoq": _pct(_num(this), prev),
            "week4_ago": None,
            "yoy": None,
            "week8_avg": None,
            "week8_position": None,
            "week8_series": None,
        }

    return {
        "name": str(c.get("category") or ""),
        "gujia_uv": m("evaUv"),
        "xiadan_uv": m("orderUv"),
        "chengjiao_orders": m("dealCnt"),
        "chengjiao_gmv": m("gmv"),
        "ke_danjia": None,
    }


def _data_reliability(current: dict[str, Any], week: str, board_series: dict[str, dict[str, float | None]]) -> dict[str, Any]:
    missing = [k for k in REQUIRED_BOARD_FIELDS if board_series.get(k, {}).get(week) is None]
    sync = "匹配" if current.get("week") == week and current.get("syncedAt") else "存疑(周次或同步时间缺失)"
    ratio_note = "无"
    jkuv = _to_float(board_series.get("jikuang_uv", {}).get(week))
    eva = _to_float(board_series.get("gujia_uv", {}).get(week))
    if jkuv and eva is not None:
        ratio = eva / jkuv
        if ratio > 1.5 or ratio < 0.3:
            ratio_note = f"估价UV/机况UV={ratio:.2f}，需复核口径"
    ok = not missing and sync == "匹配" and ratio_note == "无"
    reason = []
    if missing:
        reason.append("缺少字段:" + ",".join(missing))
    if sync != "匹配":
        reason.append(sync)
    if ratio_note != "无":
        reason.append(ratio_note)
    return {
        "可信": ok,
        "同步时点": sync,
        "口径断层": "无" if not missing else "缺少字段:" + ",".join(missing),
        "比值异常": ratio_note,
        "结论": "可信" if ok else "存疑(" + "；".join(reason) + ")",
    }


def _kpi_card(payload: dict[str, Any], key: str) -> dict[str, Any] | None:
    for card in payload.get("kpiCards") or []:
        if card.get("key") == key:
            return card
    return None


def _fallback_tier_sentences(current: dict[str, Any]) -> dict[str, str]:
    out = {}
    for t in current.get("tiers") or []:
        cur = t.get("cur") or {}
        out[str(t.get("tier") or "")] = f"{t.get('tier')}层覆盖 {cur.get('categoryCount', 0)} 个在售品类，成交GMV {_format_wan(cur.get('gmv'))}。"
    return out


def _fallback_board_sentence(current: dict[str, Any]) -> str:
    board = (current.get("board") or {}).get("cur") or {}
    return f"{current.get('week', '')}：成交GMV {_format_wan(board.get('gmv'))}，经营漏斗按周日均展示。"


def _fallback_category_sentence(current: dict[str, Any]) -> str:
    cats = sorted(current.get("categories") or [], key=lambda c: ((c.get("cur") or {}).get("gmv") or 0), reverse=True)
    if not cats:
        return "当前暂无品类数据。"
    return "重点关注：" + "、".join(str(c.get("category") or "") for c in cats[:3]) + "。"


def _format_wan(v: Any) -> str:
    n = _num(_to_float(v))
    if n >= 100000000:
        return f"{n / 100000000:.2f}亿"
    if n >= 10000:
        return f"{n / 10000:.1f}万"
    return str(round(n))


def _week8_position(this: float, avg: float | None) -> str | None:
    if avg is None or avg == 0:
        return None
    if this >= avg * 1.05:
        return "高于均值"
    if this <= avg * 0.95:
        return "低于均值"
    return "接近均值"


def _pct(cur: float, prev: float | None) -> str:
    if prev is None or prev == 0:
        return "N/A"
    return f"{((cur - prev) / prev * 100):+.1f}%"


def _to_float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _num(v: float | None) -> float:
    return float(v) if v is not None and math.isfinite(float(v)) else 0.0

"""wave.py 单元测试。"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from orchestrator.lib.monitor.schemas import FunnelRow, MonitorRules
from orchestrator.lib.monitor.wave import (
    build_series,
    calc_delta,
    calc_trend,
    compute_wave,
)


FIXTURE = Path(__file__).parent / "fixtures" / "cache_sample.json"


def _load_rows():
    with FIXTURE.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return [FunnelRow(**r) for r in data["rows"]]


# ---------- build_series ----------


def test_build_series_groups_by_cat_and_model():
    rows = _load_rows()
    series = build_series(rows)
    keys = set(series.keys())
    assert "手机||iPhone 15 Pro Max 256G" in keys
    assert "手机||Redmi K70 Pro" in keys
    assert "电脑||MacBook Pro 14 M3" in keys


def test_build_series_dedup_same_week_takes_last():
    rows = [
        FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.1),
        FunnelRow(category="A", modelName="M", week="W1", evaUv=200, orderRate=0.2),
    ]
    series = build_series(rows)
    entry = series["A||M"]
    assert entry.weekly["W1"].evaUv == 200
    assert entry.weekly["W1"].orderRate == 0.2


# ---------- calc_delta ----------


def test_calc_delta_prev_none_returns_all_none():
    cur = FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.1)
    delta = calc_delta(cur, None)
    assert delta.orderRate is None
    assert delta.evaRate is None


def test_calc_delta_prev_zero_returns_none():
    cur = FunnelRow(category="A", modelName="M", week="W2", evaUv=100, orderRate=0.1)
    prev = FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.0)
    delta = calc_delta(cur, prev)
    assert delta.orderRate is None


def test_calc_delta_normal_case():
    cur = FunnelRow(
        category="A", modelName="M", week="W2", evaUv=100,
        evaRate=0.2, orderRate=0.121, shipRate=0.9, dealRate=0.85, returnRate=0.03,
    )
    prev = FunnelRow(
        category="A", modelName="M", week="W1", evaUv=100,
        evaRate=0.1, orderRate=0.184, shipRate=0.9, dealRate=0.85, returnRate=0.03,
    )
    delta = calc_delta(cur, prev)
    # evaRate: (0.2 - 0.1) / 0.1 = 1.0
    assert math.isclose(delta.evaRate, 1.0)
    # orderRate: (0.121 - 0.184) / 0.184 = -0.3423913...
    assert math.isclose(delta.orderRate, -0.34239130434, abs_tol=1e-6)
    # shipRate: 0 变化
    assert math.isclose(delta.shipRate, 0.0, abs_tol=1e-9)


def test_calc_delta_missing_field():
    cur = FunnelRow(category="A", modelName="M", week="W2", evaUv=100, orderRate=None)
    prev = FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.1)
    delta = calc_delta(cur, prev)
    assert delta.orderRate is None


# ---------- calc_trend ----------


def test_calc_trend_short_list_returns_all_none():
    rows = [
        FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.1),
        FunnelRow(category="A", modelName="M", week="W2", evaUv=100, orderRate=0.2),
    ]
    trend = calc_trend(rows, weeks=3)
    assert trend.orderRate is None


def test_calc_trend_strictly_up():
    rows = [
        FunnelRow(category="A", modelName="M", week=f"W{i}", evaUv=100, orderRate=0.1 * i)
        for i in range(1, 4)
    ]
    trend = calc_trend(rows, weeks=3)
    assert trend.orderRate == "up"


def test_calc_trend_strictly_down():
    rows = [
        FunnelRow(category="A", modelName="M", week=f"W{i}", evaUv=100, orderRate=0.5 - 0.1 * i)
        for i in range(1, 4)
    ]
    trend = calc_trend(rows, weeks=3)
    assert trend.orderRate == "down"


def test_calc_trend_not_strictly_monotonic():
    rows = [
        FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.1),
        FunnelRow(category="A", modelName="M", week="W2", evaUv=100, orderRate=0.1),  # 相等,破坏严格递增
        FunnelRow(category="A", modelName="M", week="W3", evaUv=100, orderRate=0.2),
    ]
    trend = calc_trend(rows, weeks=3)
    assert trend.orderRate is None


def test_calc_trend_none_in_window_breaks():
    rows = [
        FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.1),
        FunnelRow(category="A", modelName="M", week="W2", evaUv=100, orderRate=None),
        FunnelRow(category="A", modelName="M", week="W3", evaUv=100, orderRate=0.3),
    ]
    trend = calc_trend(rows, weeks=3)
    assert trend.orderRate is None


def test_calc_trend_uses_tail_window():
    """N=3 时,前 2 周的形态不影响判定。"""
    rows = [
        # 前面故意搞乱
        FunnelRow(category="A", modelName="M", week="W1", evaUv=100, orderRate=0.9),
        FunnelRow(category="A", modelName="M", week="W2", evaUv=100, orderRate=0.5),
        # 尾部 3 周严格递增
        FunnelRow(category="A", modelName="M", week="W3", evaUv=100, orderRate=0.1),
        FunnelRow(category="A", modelName="M", week="W4", evaUv=100, orderRate=0.2),
        FunnelRow(category="A", modelName="M", week="W5", evaUv=100, orderRate=0.3),
    ]
    trend = calc_trend(rows, weeks=3)
    assert trend.orderRate == "up"


# ---------- compute_wave ----------


def test_compute_wave_only_returns_models_with_target_week():
    rows = _load_rows()
    rules = MonitorRules()
    # W23 只有 iPhone 一款
    results, weeks = compute_wave(rows, target_week="2025-W23", prev_week=None, rules=rules)
    assert len(results) == 1
    assert results[0].modelName == "iPhone 15 Pro Max 256G"
    assert results[0].prev is None
    assert results[0].delta.orderRate is None


def test_compute_wave_returns_full_weeks_list():
    rows = _load_rows()
    rules = MonitorRules()
    _, weeks = compute_wave(rows, target_week="2025-W27", prev_week="2025-W26", rules=rules)
    assert weeks == ["2025-W23", "2025-W24", "2025-W25", "2025-W26", "2025-W27"]


def test_compute_wave_iphone_trend_up_then_break():
    """iPhone 5 周 evaRate 严格递增,orderRate W23-W26 严格递增但 W27 掉,故 W27 不成立 up 趋势。"""
    rows = _load_rows()
    rules = MonitorRules(trendWeeks=3)
    results, _ = compute_wave(rows, target_week="2025-W27", prev_week="2025-W26", rules=rules)
    iphone = next(r for r in results if r.modelName == "iPhone 15 Pro Max 256G")
    # 尾部 3 周 evaRate: 0.22, 0.23, 0.235 → 严格递增
    assert iphone.trend.evaRate == "up"
    # 尾部 3 周 orderRate: 0.12, 0.184, 0.121 → 非单调
    assert iphone.trend.orderRate is None


def test_compute_wave_iphone_delta_matches_spec():
    """spec 示例:iPhone orderRate 从 18.4% → 12.1%,delta = -34.2%。"""
    rows = _load_rows()
    rules = MonitorRules()
    results, _ = compute_wave(rows, target_week="2025-W27", prev_week="2025-W26", rules=rules)
    iphone = next(r for r in results if r.modelName == "iPhone 15 Pro Max 256G")
    # (0.121 - 0.184) / 0.184
    assert math.isclose(iphone.delta.orderRate, -0.3423913, abs_tol=1e-6)

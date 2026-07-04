"""rules.py 单元测试。"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from orchestrator.lib.monitor.rules import (
    apply_rules,
    build_pool,
    detect_flags,
    load_rules_from_file,
)
from orchestrator.lib.monitor.schemas import (
    DeltaMap,
    FunnelRow,
    MonitorRules,
    TrendMap,
    WaveResult,
)
from orchestrator.lib.monitor.wave import compute_wave


FIXTURE = Path(__file__).parent / "fixtures" / "cache_sample.json"


def _load_rows():
    with FIXTURE.open("r", encoding="utf-8") as f:
        data = json.load(f)
    return [FunnelRow(**r) for r in data["rows"]]


def _make_wave(modelName: str, category: str, evaUv: int, delta_order: float | None = None, trend_order=None) -> WaveResult:
    cur = FunnelRow(
        category=category, modelName=modelName, week="W2", evaUv=evaUv,
        evaRate=0.2, orderRate=0.12, shipRate=0.9, dealRate=0.85, returnRate=0.03,
    )
    return WaveResult(
        category=category, modelName=modelName, cur=cur, prev=None,
        delta=DeltaMap(orderRate=delta_order),
        trend=TrendMap(orderRate=trend_order),
    )


# ---------- build_pool ----------


def test_build_pool_top_n_per_category():
    waves = [
        _make_wave("A1", "手机", 100),
        _make_wave("A2", "手机", 200),
        _make_wave("A3", "手机", 150),
        _make_wave("B1", "电脑", 50),
        _make_wave("B2", "电脑", 80),
    ]
    pool = build_pool(waves, top_n=2)
    # 手机 top2: A2(200), A3(150); 电脑 top2: B2(80), B1(50)
    names = [(w.category, w.modelName) for w in pool]
    assert ("手机", "A2") in names
    assert ("手机", "A3") in names
    assert ("手机", "A1") not in names
    assert ("电脑", "B2") in names
    assert ("电脑", "B1") in names


def test_build_pool_sorts_by_eva_uv_desc():
    waves = [
        _make_wave("Low", "手机", 100),
        _make_wave("High", "手机", 500),
        _make_wave("Mid", "手机", 200),
    ]
    pool = build_pool(waves, top_n=3)
    order = [w.modelName for w in pool]
    assert order == ["High", "Mid", "Low"]


def test_build_pool_stable_on_ties():
    """evaUv 同分时按 modelName 字典序稳定。"""
    waves = [
        _make_wave("Z", "手机", 100),
        _make_wave("A", "手机", 100),
        _make_wave("M", "手机", 100),
    ]
    pool = build_pool(waves, top_n=3)
    order = [w.modelName for w in pool]
    assert order == ["A", "M", "Z"]


# ---------- detect_flags ----------


def test_detect_flags_below_min_eva_uv_returns_empty():
    rules = MonitorRules(minEvaUv=100, waveThreshold=0.05)
    w = _make_wave("Small", "手机", evaUv=50, delta_order=-0.5, trend_order="down")
    flags = detect_flags(w, rules)
    assert flags == []


def test_detect_flags_wave_hit():
    rules = MonitorRules(minEvaUv=15, waveThreshold=0.1)
    w = _make_wave("A", "手机", evaUv=100, delta_order=-0.34)
    flags = detect_flags(w, rules)
    assert len(flags) == 1
    assert flags[0].type == "wave"
    assert flags[0].metric == "orderRate"
    assert flags[0].delta == -0.34


def test_detect_flags_wave_miss_below_threshold():
    rules = MonitorRules(minEvaUv=15, waveThreshold=0.1)
    w = _make_wave("A", "手机", evaUv=100, delta_order=-0.05)
    flags = detect_flags(w, rules)
    assert flags == []


def test_detect_flags_trend_hit():
    rules = MonitorRules(minEvaUv=15, waveThreshold=0.99)  # 阈值高,禁 wave
    w = _make_wave("A", "手机", evaUv=100, trend_order="up")
    flags = detect_flags(w, rules)
    assert len(flags) == 1
    assert flags[0].type == "trend"
    assert flags[0].direction == "up"


def test_detect_flags_wave_and_trend_both():
    rules = MonitorRules(minEvaUv=15, waveThreshold=0.1)
    w = _make_wave("A", "手机", evaUv=100, delta_order=-0.5, trend_order="down")
    flags = detect_flags(w, rules)
    types = sorted(f.type for f in flags)
    assert types == ["trend", "wave"]


# ---------- apply_rules 端到端 ----------


def test_apply_rules_end_to_end_iphone_hit():
    """iPhone W27 orderRate 从 18.4% → 12.1% 应命中 wave flag。"""
    rows = _load_rows()
    rules = MonitorRules()  # 默认 threshold=0.1
    waves, weeks = compute_wave(
        rows, target_week="2025-W27", prev_week="2025-W26", rules=rules
    )
    result = apply_rules(waves, weeks, "2025-W27", "2025-W26", rules)

    assert result.target_week == "2025-W27"
    assert result.prev_week == "2025-W26"
    iphone_watch = next(
        (w for w in result.watch_list if w.modelName == "iPhone 15 Pro Max 256G"),
        None,
    )
    assert iphone_watch is not None
    order_wave_flags = [
        f for f in iphone_watch.flags if f.type == "wave" and f.metric == "orderRate"
    ]
    assert len(order_wave_flags) == 1
    assert order_wave_flags[0].delta < -0.3  # 大幅下滑


def test_apply_rules_small_sample_excluded():
    """evaUv=12 的小样本机型 orderRate 涨 100%,但因 minEvaUv=15 应不入 watch_list。"""
    rows = _load_rows()
    rules = MonitorRules()
    waves, weeks = compute_wave(
        rows, target_week="2025-W27", prev_week="2025-W26", rules=rules
    )
    result = apply_rules(waves, weeks, "2025-W27", "2025-W26", rules)
    small = next(
        (w for w in result.watch_list if "小样本" in w.modelName), None
    )
    assert small is None, "小样本机型不应命中"


def test_apply_rules_pool_size_bounded_by_top_n():
    rows = _load_rows()
    rules = MonitorRules(poolTopN=2)  # 每个品类只留 2 条
    waves, weeks = compute_wave(
        rows, target_week="2025-W27", prev_week="2025-W26", rules=rules
    )
    result = apply_rules(waves, weeks, "2025-W27", "2025-W26", rules)
    # 手机品类 W27 有 4 个机型,取 top2 按 evaUv 降序:iPhone(1200), 华为(950)
    phones_in_pool = [w for w in result.pool if w.category == "手机"]
    assert len(phones_in_pool) == 2
    phone_names = sorted(w.modelName for w in phones_in_pool)
    assert "iPhone 15 Pro Max 256G" in phone_names
    assert "华为 Mate 60 Pro" in phone_names


# ---------- load_rules_from_file ----------


def test_load_rules_from_file_partial_override():
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump({"waveThreshold": 0.2, "minEvaUv": 50}, f)
        tmp_path = Path(f.name)
    try:
        rules = load_rules_from_file(tmp_path)
        assert rules.waveThreshold == 0.2
        assert rules.minEvaUv == 50
        # 其他字段保留默认
        assert rules.poolTopN == 20
        assert rules.trendWeeks == 3
    finally:
        tmp_path.unlink()


def test_load_rules_missing_file_fallback():
    rules = load_rules_from_file(Path("/nonexistent/path.json"), fallback_to_default=True)
    assert rules.waveThreshold == 0.1  # 默认


def test_load_rules_missing_file_strict_raises():
    with pytest.raises(FileNotFoundError):
        load_rules_from_file(Path("/nonexistent/path.json"), fallback_to_default=False)

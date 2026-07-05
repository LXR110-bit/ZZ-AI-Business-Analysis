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


# ============================================================
# 三级 fallback 分母保护(spec monitor_noise_reduction)
# ============================================================


from orchestrator.lib.monitor.rules import _effective_min_evauv


def test_effective_min_evauv_per_category_wins():
    """优先级 1:perCategoryMinEvaUv 命中时,忽略 minEvaUvPct 和全局 minEvaUv。"""
    rules = MonitorRules(
        minEvaUv=15,
        minEvaUvPct=0.02,
        perCategoryMinEvaUv={"手机": 500},
    )
    # 白名单命中:直接返回 500
    assert _effective_min_evauv("手机", 10000, rules) == 500
    # 未命中的品类降级到 pct
    assert _effective_min_evauv("台球杆", 5000, rules) == 100  # 5000 * 0.02


def test_effective_min_evauv_pct_fallback():
    """优先级 2:白名单空 + minEvaUvPct 生效。"""
    rules = MonitorRules(minEvaUv=15, minEvaUvPct=0.03, perCategoryMinEvaUv={})
    assert _effective_min_evauv("台球杆", 5000, rules) == 150  # 5000 * 0.03
    # cat_total=0 时 pct 仍生效,返回 0(不降级到全局兜底)
    assert _effective_min_evauv("空品类", 0, rules) == 0.0


def test_effective_min_evauv_global_fallback():
    """优先级 3:白名单空 + minEvaUvPct=None → 走全局兜底。"""
    rules = MonitorRules(minEvaUv=15, minEvaUvPct=None, perCategoryMinEvaUv={})
    assert _effective_min_evauv("任何品类", 5000, rules) == 15
    # 即使 cat_total 极大,也仍是全局值
    assert _effective_min_evauv("大品类", 999999, rules) == 15


def test_apply_rules_with_three_tier_fallback_integration():
    """集成测试:apply_rules 端到端验证三级 fallback 生效。"""
    # 造三个机型,delta_order=0.5 都能触发 wave flag
    wave_small_phone = _make_wave("小机型手机", "手机", 50, delta_order=0.5)
    wave_big_phone = _make_wave("大机型手机", "手机", 600, delta_order=0.5)
    wave_stick = _make_wave("台球杆机型", "台球杆", 20, delta_order=0.5)

    rules = MonitorRules(
        minEvaUv=15,
        perCategoryMinEvaUv={"手机": 500},  # 手机品类阈值 500
    )
    result = apply_rules(
        [wave_small_phone, wave_big_phone, wave_stick],
        all_weeks=["W1", "W2"],
        target_week="W2",
        prev_week="W1",
        rules=rules,
    )

    watch_names = {w.modelName for w in result.watch_list}
    # 小机型手机 evaUv=50 < 白名单阈值 500 → 被过滤
    assert "小机型手机" not in watch_names
    # 大机型手机 evaUv=600 >= 500 → 保留
    assert "大机型手机" in watch_names
    # 台球杆 evaUv=20 >= 全局 minEvaUv=15 → 保留(白名单没配)
    assert "台球杆机型" in watch_names


def test_apply_rules_backward_compat_no_new_fields():
    """向后兼容:老 rules(无新字段)升级后行为完全等同 baseline。"""
    wave_ok = _make_wave("大机型", "手机", 100, delta_order=0.5)
    wave_small = _make_wave("小机型", "手机", 10, delta_order=0.5)  # < minEvaUv=15
    # 老式配置(不填新字段)
    rules_old = MonitorRules(minEvaUv=15)
    result = apply_rules(
        [wave_ok, wave_small],
        all_weeks=["W1", "W2"],
        target_week="W2",
        prev_week="W1",
        rules=rules_old,
    )
    watch_names = {w.modelName for w in result.watch_list}
    assert "大机型" in watch_names
    assert "小机型" not in watch_names  # 被全局 minEvaUv=15 挡住


# ---------- categories.py ----------


def test_known_category_names_covers_real_snapshot():
    """categories.KNOWN_CATEGORY_NAMES 至少覆盖 real_snapshot 的 10 品类。"""
    from orchestrator.lib.monitor.categories import KNOWN_CATEGORY_NAMES, is_known_category

    real_snapshot_cats = {
        "主板", "便携/无线音箱", "内存条", "台球杆", "手表/腕表",
        "打印机/复印机", "数码相机", "显卡", "显示器", "盲盒收纳",
    }
    assert real_snapshot_cats.issubset(KNOWN_CATEGORY_NAMES)
    assert is_known_category("手机") is True
    assert is_known_category("陌生品类") is False


def test_categories_softcheck_does_not_block_runtime():
    """spec §四.3 决策核验:陌生品类名配了不报错,自然降级。"""
    rules = MonitorRules(
        perCategoryMinEvaUv={"陌生品类XXX": 999},  # 不在 KNOWN_CATEGORY_NAMES 里
    )
    wave_a = _make_wave("A", "陌生品类XXX", 500, delta_order=0.5)   # < 999 被过滤
    wave_b = _make_wave("B", "陌生品类XXX", 1500, delta_order=0.5)  # >= 999 保留
    result = apply_rules(
        [wave_a, wave_b],
        all_weeks=["W1", "W2"],
        target_week="W2",
        prev_week="W1",
        rules=rules,
    )
    watch_names = {w.modelName for w in result.watch_list}
    assert "A" not in watch_names
    assert "B" in watch_names

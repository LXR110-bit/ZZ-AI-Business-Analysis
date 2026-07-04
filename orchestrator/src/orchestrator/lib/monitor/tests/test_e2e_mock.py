"""端到端 mock 集成测试:fetch → wave → rules → agent_hook → build_report → dry_run push。

用 mock 数据把整条链跑通,证明各模块可拼装。
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

from orchestrator.lib.monitor.agent_hook import analyze_anomaly_with_agent
from orchestrator.lib.monitor.fetcher import fetch_funnel_data
from orchestrator.lib.monitor.pusher import build_report, push_to_feishu
from orchestrator.lib.monitor.rules import apply_rules
from orchestrator.lib.monitor.schemas import MonitorRules
from orchestrator.lib.monitor.wave import compute_wave


FIXTURE = Path(__file__).parent / "fixtures" / "cache_sample.json"


@pytest.fixture
def mock_cache_env(monkeypatch):
    monkeypatch.setenv("MONITOR_MOCK_CACHE", str(FIXTURE))
    monkeypatch.setenv("MONITOR_AGENT_MOCK", "1")
    monkeypatch.setenv("FEISHU_DRY_RUN", "1")


def test_e2e_model_dimension(mock_cache_env, tmp_path):
    """机型维度全链路 mock 跑一次。"""
    # ① 拉数
    rows = fetch_funnel_data("model", ("2025-W23", "2025-W27"))
    assert len(rows) > 0
    assert all(r.category and r.modelName for r in rows)

    # ② 波动计算
    rules = MonitorRules()
    waves, weeks = compute_wave(
        rows, target_week="2025-W27", prev_week="2025-W26", rules=rules
    )
    assert weeks == ["2025-W23", "2025-W24", "2025-W25", "2025-W26", "2025-W27"]

    # ③ 规则应用
    monitor_result = apply_rules(waves, weeks, "2025-W27", "2025-W26", rules)
    assert monitor_result.target_week == "2025-W27"
    assert len(monitor_result.pool) > 0
    assert len(monitor_result.watch_list) > 0

    # ④ AI 归因(mock)
    explanations = analyze_anomaly_with_agent(monitor_result.watch_list, top_k=5)
    assert len(explanations) == min(5, len(monitor_result.watch_list))
    for e in explanations:
        assert e.hypothesis
        assert e.confidence in ("high", "medium", "low")

    # ⑤ 打包 report
    report = build_report(
        monitor_result=monitor_result,
        explanations=explanations,
        dimension="model",
        dashboard_url="https://example.com/dashboard",
    )
    assert report.week == "2025-W27"
    assert report.summary.watch_count == len(monitor_result.watch_list)

    # ⑥ 推送(dry_run)
    result = push_to_feishu(report, outbox_dir=tmp_path)
    assert result["ok"] is True
    assert result["mode"] == "dry_run"
    outbox_path = Path(result["outbox_path"])
    assert outbox_path.exists()

    # 验证 outbox 内容可反序列化
    with outbox_path.open("r", encoding="utf-8") as f:
        dumped = json.load(f)
    assert dumped["report"]["dimension"] == "model"
    assert dumped["report"]["week"] == "2025-W27"
    assert dumped["meta"]["mode"] == "dry_run"


def test_e2e_category_dimension(mock_cache_env, tmp_path):
    """品类维度聚合后跑一次。"""
    rows = fetch_funnel_data("category", ("2025-W26", "2025-W27"))
    # fixture 里两个品类:手机、电脑
    categories = {r.category for r in rows}
    assert categories == {"手机", "电脑"}
    # category 维度下,category 名 == modelName
    for r in rows:
        assert r.category == r.modelName


def test_e2e_iphone_hypothesis_meaningful(mock_cache_env, tmp_path):
    """iPhone orderRate 大幅下滑,归因假设应该指向下单率下降。"""
    rows = fetch_funnel_data("model", ("2025-W23", "2025-W27"))
    rules = MonitorRules()
    waves, weeks = compute_wave(rows, "2025-W27", "2025-W26", rules)
    monitor_result = apply_rules(waves, weeks, "2025-W27", "2025-W26", rules)

    explanations = analyze_anomaly_with_agent(monitor_result.watch_list)
    iphone_hypo = next(
        (e for e in explanations if e.modelName == "iPhone 15 Pro Max 256G"),
        None,
    )
    assert iphone_hypo is not None
    # 假设文本应该提到下单率或下滑
    assert any(k in iphone_hypo.hypothesis for k in ["下单率", "下滑"])
    # orderRate 应该在 related_metrics 里
    assert "orderRate" in iphone_hypo.related_metrics
    # |delta| > 30% → high confidence
    assert iphone_hypo.confidence == "high"


def test_e2e_no_watch_no_explanations(mock_cache_env, tmp_path):
    """把阈值调超高,应该无命中 → 无归因。"""
    rows = fetch_funnel_data("model", ("2025-W26", "2025-W27"))
    rules = MonitorRules(waveThreshold=0.99, trendWeeks=99)  # 事实上没法命中
    waves, weeks = compute_wave(rows, "2025-W27", "2025-W26", rules)
    monitor_result = apply_rules(waves, weeks, "2025-W27", "2025-W26", rules)
    assert monitor_result.watch_list == []

    explanations = analyze_anomaly_with_agent(monitor_result.watch_list)
    assert explanations == []


def test_e2e_report_summary_counts(mock_cache_env, tmp_path):
    rows = fetch_funnel_data("model", ("2025-W23", "2025-W27"))
    rules = MonitorRules()
    waves, weeks = compute_wave(rows, "2025-W27", "2025-W26", rules)
    monitor_result = apply_rules(waves, weeks, "2025-W27", "2025-W26", rules)
    explanations = analyze_anomaly_with_agent(monitor_result.watch_list)

    report = build_report(
        monitor_result=monitor_result,
        explanations=explanations,
        dimension="model",
        dashboard_url="https://x",
    )
    # 同一机型可能同时贡献 rising 和 falling(如 iPhone: orderRate 大跌 + evaRate 连涨),
    # 故 rising_count + falling_count 可能 > watch_count,但单侧一定 ≤ watch_count
    assert report.summary.rising_count <= report.summary.watch_count
    assert report.summary.falling_count <= report.summary.watch_count
    assert report.summary.total_dims == len(monitor_result.pool)

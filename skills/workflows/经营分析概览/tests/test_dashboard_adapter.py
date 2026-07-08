from __future__ import annotations

from pathlib import Path

import pytest

from skills.workflows.经营分析概览.assertions import GateError, link_gate, pyramid_gate
from skills.workflows.经营分析概览.dashboard_adapter import (
    STRATEGY_MISSING_WARNING,
    build_input_dict_from_bundle,
    load_dashboard_bundle,
    strategy_warnings,
)
from skills.workflows.经营分析概览.run import build_deterministic_attribution_verdict, build_deterministic_link_verdict

FIXTURE = Path(__file__).parent / "fixtures" / "dashboard_bundle_w28.json"


def test_dashboard_adapter_builds_input_dict_from_w28_fixture():
    bundle = load_dashboard_bundle(str(FIXTURE))
    data = build_input_dict_from_bundle(bundle, last_week_strategies="")

    assert data["week_label"] == "2026-W28"
    assert data["data_reliability"]["结论"] == "可信"
    assert data["gujia_uv"]["this_week"] == 52602
    assert data["gujia_uv"]["last_week"] == 51929
    assert data["chengjiao_gmv"]["week4_ago"] == 3200000
    assert data["dau"]["this_week"] == 3702708
    assert data["clusters"]["发展"]["name"] == "发展"
    assert data["clusters"]["发展"]["categories"][0]["name"] == "组装机"


def test_missing_strategy_is_warning_not_blocker():
    assert strategy_warnings("") == [STRATEGY_MISSING_WARNING]
    assert strategy_warnings("上周加注运动相机") == []


def test_deterministic_verdicts_pass_gates():
    bundle = load_dashboard_bundle(str(FIXTURE))
    data = build_input_dict_from_bundle(bundle)
    link = link_gate(build_deterministic_link_verdict(data)).model_dump()
    attr = build_deterministic_attribution_verdict(data, link)

    assert link["风险等级"] in {"🔴", "🟡", "🟢"}
    assert attr["发展"]["归因"]["责任主体"] == ["不可归因"]
    assert attr["trigger_model_drill"] is False


def test_link_gate_rejects_green_when_pending_review():
    bad = {
        "数据可信度": "存疑(测试)",
        "待核标签": True,
        "定性名字": "测试",
        "风险等级": "🟢",
        "链路形态": "健康传导",
        "量价拆解": "测试",
        "瓶颈环节": "无",
        "逆势环节": "无",
        "判断依据": "测试",
        "环比结论": "GMV vs上周 N/A",
        "同比结论": "N/A",
        "近8周位置": "N/A",
        "趋势标签": "震荡区间",
        "dau_qoq": "N/A",
        "jikuang_qoq": "N/A",
        "gujia_qoq": "N/A",
        "xiadan_qoq": "N/A",
        "fahu_o_qoq": "N/A",
        "chengjiao_qoq": "N/A",
        "gmv_qoq": "N/A",
    }
    with pytest.raises(GateError):
        link_gate(bad)


def test_pyramid_gate_requires_findings():
    bad = {
        "序言": {"情境_S": "S", "冲突_C": "C", "疑问_Q": "Q"},
        "塔尖": {"核心判断": "持平", "动词": "持平", "对象": "大盘", "量价拆解": "N/A", "情绪基调": "🙂稳健"},
        "核心发现": {"Q1_大盘安全": [], "Q2_预判兑现": [], "Q3_资源怎么动": [], "兑现率": "N/A"},
        "下周行动": [],
        "风险等级": "🟢",
    }
    with pytest.raises(GateError):
        pyramid_gate(bad)


def test_registry_paths_exist():
    repo_root = Path(__file__).resolve().parents[4]
    registry = repo_root / "skills" / "workflows" / "REGISTRY.yaml"
    text = registry.read_text(encoding="utf-8")
    assert 'id: "model_weekly_data"' in text
    assert 'id: "business_overview"' in text
    for rel in ["skills/workflows/机型周数据", "skills/workflows/经营分析概览"]:
        assert (repo_root / rel).exists()

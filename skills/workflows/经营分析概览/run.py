"""经营分析概览 workflow 主流程.

Phase 1 is deterministic by default: it converts the dashboard contract into the
v0.4 input schema, applies guardrails, and formats a lightweight report. The
production Codex call is intentionally handled by the model-tag-monitor refresh
script so it can run read-only with an output schema and deterministic fallback.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any, Optional

from .assertions import attribution_gate, link_gate, model_gate
from .dashboard_adapter import build_input_dict_from_bundle, load_dashboard_bundle


# ============================================================
# Step 1：取数 + 算环比（纯 Python，无 AI）
# ============================================================

def step_1_fetch_and_calc(data_source: str, week_label: str | None = None, last_week_strategies: str = "") -> dict:
    """Load dashboard payload/bundle and build the workflow InputDict."""
    bundle = load_dashboard_bundle(data_source)
    return build_input_dict_from_bundle(
        bundle,
        week_label=week_label or None,
        last_week_strategies=last_week_strategies,
    )


# ============================================================
# Deterministic fallback verdicts（无 AI 时仍可跑通）
# ============================================================

def build_deterministic_link_verdict(input_dict: dict[str, Any]) -> dict[str, Any]:
    """Generate a conservative Step 2 verdict from InputDict only."""
    gmv = input_dict["chengjiao_gmv"]
    orders = input_dict["chengjiao_orders"]
    avg_price = input_dict["ke_danjia"]
    gmv_qoq = _parse_pct(gmv.get("qoq"))
    order_qoq = _parse_pct(orders.get("qoq"))
    price_qoq = _parse_pct(avg_price.get("qoq"))
    data_rel = input_dict.get("data_reliability") or {}

    if data_rel.get("可信") is False:
        risk = "🟡"
    elif gmv_qoq is not None and gmv_qoq < -3:
        risk = "🔴"
    elif any(v is not None and v < -5 for v in (gmv_qoq, order_qoq)):
        risk = "🟡"
    else:
        risk = "🟢"

    if order_qoq is not None and price_qoq is not None and order_qoq < 0 < price_qoq:
        shape = "量退价补"
        title = "量退价补"
    elif gmv_qoq is not None and gmv_qoq < 0:
        shape = "健康传导" if order_qoq is not None and order_qoq < 0 else "中游漏损"
        title = "整体承压"
    elif gmv_qoq is not None and gmv_qoq > 0:
        shape = "健康传导"
        title = "平稳增长"
    else:
        shape = "健康传导"
        title = "数据待观察"

    trend_label = _trend_label(gmv.get("week8_series") or [])
    reliability = data_rel.get("结论") or "可信"
    pending = reliability != "可信"

    return {
        "数据可信度": reliability,
        "待核标签": bool(pending),
        "定性名字": title,
        "风险等级": risk,
        "链路形态": shape,
        "量价拆解": f"GMV {gmv.get('qoq', 'N/A')}（成交订单 {orders.get('qoq', 'N/A')} × 客单价 {avg_price.get('qoq', 'N/A')}）",
        "瓶颈环节": _bottleneck(input_dict),
        "逆势环节": _reverse_signal(input_dict),
        "判断依据": "基于 dashboard v1.3.0 兼容 payload 的周日均经营漏斗自动生成，AI 不可用时作为保底判断。",
        "环比结论": f"GMV vs上周 {gmv.get('qoq', 'N/A')}",
        "同比结论": f"GMV vs4周前 {gmv.get('yoy') or 'N/A'}",
        "近8周位置": f"{gmv.get('week8_position') or 'N/A'}",
        "趋势标签": trend_label,
        "dau_qoq": input_dict["dau"].get("qoq", "N/A"),
        "jikuang_qoq": input_dict["jikuang_uv"].get("qoq", "N/A"),
        "gujia_qoq": input_dict["gujia_uv"].get("qoq", "N/A"),
        "xiadan_qoq": input_dict["xiadan_uv"].get("qoq", "N/A"),
        "fahu_o_qoq": input_dict["fahu_o_count"].get("qoq", "N/A"),
        "chengjiao_qoq": orders.get("qoq", "N/A"),
        "gmv_qoq": gmv.get("qoq", "N/A"),
    }


def build_deterministic_attribution_verdict(input_dict: dict[str, Any], link_verdict: dict[str, Any]) -> dict[str, Any]:
    """Generate a conservative Step 3 verdict from tier/category inputs."""
    board_gmv = _num(input_dict.get("chengjiao_gmv", {}).get("this_week"))
    clusters = input_dict.get("clusters") or {}
    out: dict[str, Any] = {}
    for name in ("发展", "孵化", "种子"):
        c = clusters.get(name) or {}
        gmv = c.get("chengjiao_gmv") or {}
        gujia = c.get("gujia_uv") or {}
        orders = c.get("chengjiao_orders") or {}
        gmv_qoq = _parse_pct(gmv.get("qoq"))
        gujia_qoq = _parse_pct(gujia.get("qoq"))
        orders_qoq = _parse_pct(orders.get("qoq"))
        impact = _impact(_num(gmv.get("this_week")), board_gmv)
        risk = "🔴" if gmv_qoq is not None and gmv_qoq < -8 else "🟡" if any(v is not None and v < -5 for v in (gmv_qoq, orders_qoq)) else "🟢"
        out[name] = {
            "风险等级": risk,
            "流量端": _traffic_label(gujia_qoq, gujia.get("qoq")),
            "转化端": _conversion_label(gujia_qoq, orders_qoq),
            "归因": {
                "责任主体": ["不可归因"],
                "时间属性": "短期波动",
                "证据": {"不可归因": "首版未接入策略、行情、竞对输入，仅基于看板漏斗信号做提醒"},
            },
            "影响度": impact,
            "可解决度": "待补充策略输入后判断",
            "建议操作": "先补充上周策略/预判，再结合品类下钻判断加注/收手",
            "品类下钻": _category_drill_items(c.get("categories") or []),
        }

    strategies = (input_dict.get("last_week_strategies") or "").strip()
    strategy_items = []
    if strategies:
        strategy_items.append({
            "策略": strategies[:80],
            "KPI": "经营漏斗周日均",
            "本周数据": link_verdict.get("量价拆解", ""),
            "兑现": "部分兑现",
            "解读": "首版自动分析仅做结构化提示，最终兑现判断需业务确认。",
        })

    out.update({
        "策略验证": strategy_items,
        "仲裁": [],
        "trigger_model_drill": False,
        "drilldown_targets": {},
        "下周行动": [
            "补充上周策略/预判输入，开启兑现检核。",
            "优先复盘高影响度且转化端恶化的品类。",
        ],
    })
    return out


# ============================================================
# Step 5：拼接输出（纯 Python，无 AI）
# ============================================================

def _format_attribution(attr) -> str:
    """v0.4：把二维归因矩阵格式化为可读字符串。兼容旧的字符串归因。"""
    if attr is None:
        return "待补充"
    if isinstance(attr, str):
        return attr
    subjects = attr.get("责任主体", [])
    time_attr = attr.get("时间属性", "")
    evidence = attr.get("证据", {})
    parts = []
    for s in subjects:
        ev = evidence.get(s, "")
        parts.append(f"{s}({ev})" if ev else s)
    subj_str = " + ".join(parts) if parts else "待补充"
    return f"{subj_str} × {time_attr}" if time_attr else subj_str


def step_5_format_output(
    link_verdict: dict,
    attribution_verdict: dict,
    model_verdict: Optional[dict],
    week_label: str,
) -> str:
    """将 Step 2-4 的输出拼接成老板风格的周报概览。"""
    lines = []
    lines.append(f"# {week_label} 经营分析概览")
    lines.append("")

    ld = link_verdict
    title = ld.get("定性名字", "待补充")
    if ld.get("待核标签"):
        title += "（数据待核）"
    lines.append(f"## 大盘定性：{title}")
    lines.append(f"**风险等级**：{ld.get('风险等级', '🟢')}")
    if ld.get("数据可信度") and ld.get("数据可信度") != "可信":
        lines.append(f"**⚠️ 数据可信度**：{ld.get('数据可信度')}")
    lines.append(f"**链路形态**：{ld.get('链路形态', '待补充')}")
    lines.append(f"**量价拆解**：{ld.get('量价拆解', '待补充')}")
    lines.append(f"**三基准**：环比 {ld.get('环比结论','?')} ｜ 同比 {ld.get('同比结论','N/A')} ｜ 近8周 {ld.get('近8周位置','N/A')}")
    lines.append(f"**趋势**：{ld.get('趋势标签', '待补充')}")
    lines.append("")

    lines.append("### 链路传导")
    lines.append(f"DAU {ld.get('dau_qoq','')} → 机况UV {ld.get('jikuang_qoq','')} → 估价UV {ld.get('gujia_qoq','')} → 下单UV {ld.get('xiadan_qoq','')} → 发货 {ld.get('fahu_o_qoq','')} → 成交 {ld.get('chengjiao_qoq','')} → GMV {ld.get('gmv_qoq','')}")
    lines.append(f"瓶颈环节：{ld.get('瓶颈环节', '无')}")
    lines.append(f"逆势环节：{ld.get('逆势环节', '无')}")
    lines.append("")

    av = attribution_verdict
    lines.append("## 品类簇归因")
    for cluster_name in ["发展", "孵化", "种子"]:
        cluster = av.get(cluster_name, {})
        if not cluster:
            continue
        risk = cluster.get("风险等级", "🟢")
        lines.append(f"### {cluster_name}品类 {risk}")
        lines.append(f"- 流量端：{cluster.get('流量端', '待补充')}")
        lines.append(f"- 转化端：{cluster.get('转化端', '待补充')}")
        lines.append(f"- 归因：{_format_attribution(cluster.get('归因'))}")
        lines.append(f"- 资源分配：影响度 {cluster.get('影响度', '?')}，可解决度 {cluster.get('可解决度', '?')}，建议 {cluster.get('建议操作', '待补充')}")
        for item in cluster.get("品类下钻", []):
            xz = item.get("此消彼长", "")
            xz_str = f" | {xz}" if xz else ""
            lines.append(f"  - **{item.get('品类名', '?')}**：流量{item.get('流量端', '')}/转化{item.get('转化端', '')} | 影响度 {item.get('影响度', '?')}{xz_str} | {item.get('建议操作', '')}")
        lines.append("")

    if av.get("仲裁"):
        lines.append("### 论点仲裁")
        for a in av["仲裁"]:
            lines.append(f"- 原判「{a.get('原判','')}」→ 因{a.get('证据','')} → 修正为「{a.get('修正为','')}」")
        lines.append("")

    if model_verdict:
        lines.append("## 机型归因")
        mv = model_verdict
        lines.append(f"品类：{mv.get('品类名', '')}")
        for m in mv.get("问题机型", []):
            lines.append(f"- 🔴 {m.get('机型名', '')}：{m.get('判断', '')}")
        for m in mv.get("机会机型", []):
            lines.append(f"- 🟢 {m.get('机型名', '')}：{m.get('判断', '')}")
        if mv.get("机型规律"):
            lines.append(f"\n机型规律：{mv['机型规律']}")
        if mv.get("跨品类复用"):
            lines.append(f"跨品类复用：{mv['跨品类复用']}")
        lines.append("")

    if av.get("策略验证"):
        lines.append("## 上周预判检核")
        for item in av["策略验证"]:
            lines.append(f"- {item.get('策略', '')} → {item.get('兑现', '')}")
        lines.append("")

    if av.get("下周行动"):
        lines.append("## 下周最优先行动")
        for i, action in enumerate(av["下周行动"], 1):
            lines.append(f"{i}. {action}")

    return "\n".join(lines)


# ============================================================
# 主流程
# ============================================================

def run(
    data_source: str,
    week_label: str | None = None,
    last_week_strategies: str = "",
    link_verdict: dict[str, Any] | None = None,
    attribution_verdict: dict[str, Any] | None = None,
    model_verdict: dict[str, Any] | None = None,
) -> str:
    """Execute the deterministic business overview workflow."""
    input_dict = step_1_fetch_and_calc(data_source, week_label, last_week_strategies)
    week = input_dict["week_label"]

    link_raw = link_verdict or build_deterministic_link_verdict(input_dict)
    link = link_gate(link_raw).model_dump()

    attr_raw = attribution_verdict or build_deterministic_attribution_verdict(input_dict, link)
    attr = attribution_gate(attr_raw).model_dump()

    model = None
    if model_verdict:
        model = model_gate(model_verdict).model_dump()

    return step_5_format_output(link, attr, model, week)


def _parse_pct(value: Any) -> float | None:
    if value in (None, "", "N/A"):
        return None
    try:
        return float(str(value).strip().replace("%", ""))
    except ValueError:
        return None


def _num(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    return n if math.isfinite(n) else 0.0


def _trend_label(series: list[Any]) -> str:
    nums = [_num(v) for v in series if v is not None]
    if len(nums) >= 2 and nums[-1] == max(nums):
        return "首次突破"
    if len(nums) >= 2 and nums[-1] == min(nums):
        return "首次突破"
    tail = nums[-3:]
    if len(tail) == 3 and tail[0] < tail[1] < tail[2]:
        return "上升通道"
    if len(tail) == 3 and tail[0] > tail[1] > tail[2]:
        return "下降通道"
    return "震荡区间"


def _bottleneck(input_dict: dict[str, Any]) -> str:
    order_qoq = _parse_pct(input_dict.get("xiadan_uv", {}).get("qoq"))
    ship_qoq = _parse_pct(input_dict.get("fahu_o_count", {}).get("qoq"))
    deal_qoq = _parse_pct(input_dict.get("chengjiao_orders", {}).get("qoq"))
    if order_qoq is not None and order_qoq < -5:
        return "下单UV"
    if ship_qoq is not None and ship_qoq < -5:
        return "发货"
    if deal_qoq is not None and deal_qoq < -5:
        return "成交"
    return "无"


def _reverse_signal(input_dict: dict[str, Any]) -> str:
    eva = _parse_pct(input_dict.get("gujia_uv", {}).get("qoq"))
    deal = _parse_pct(input_dict.get("chengjiao_orders", {}).get("qoq"))
    if eva is not None and deal is not None and eva < 0 < deal:
        return "成交"
    if eva is not None and deal is not None and eva > 0 > deal:
        return "成交转化"
    return "无"


def _traffic_label(gujia_qoq: float | None, raw: Any) -> str:
    if gujia_qoq is None:
        return "估价UV环比 N/A，流量端待补数据"
    if gujia_qoq < -5:
        return f"估价UV下滑（{raw}），流量端承压"
    if gujia_qoq > 5:
        return f"估价UV增长（{raw}），流量端改善"
    return f"估价UV小幅波动（{raw}），流量端基本稳定"


def _conversion_label(gujia_qoq: float | None, orders_qoq: float | None) -> str:
    if gujia_qoq is None or orders_qoq is None:
        return "转化端待补数据"
    diff = orders_qoq - gujia_qoq
    if diff > 0:
        return f"成交订单相对估价UV改善 {diff:+.1f}pp"
    if diff < -3:
        return f"成交订单相对估价UV恶化 {diff:+.1f}pp"
    return f"成交订单相对估价UV基本稳定 {diff:+.1f}pp"


def _impact(cluster_gmv: float, board_gmv: float) -> str:
    if board_gmv <= 0:
        return "N/A"
    return f"{cluster_gmv / board_gmv * 100:.1f}%"


def _category_drill_items(categories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ranked = sorted(categories, key=lambda c: _num((c.get("chengjiao_gmv") or {}).get("this_week")), reverse=True)
    out = []
    for c in ranked[:3]:
        out.append({
            "品类名": c.get("name", ""),
            "异常得分": 0.0,
            "影响度": 0.0,
            "流量端": c.get("gujia_uv", {}).get("qoq", "N/A"),
            "转化端": c.get("chengjiao_orders", {}).get("qoq", "N/A"),
            "此消彼长": "待补充同簇流向数据",
            "可解决度": "待判断",
            "元凶": "待 AI/人工归因",
            "建议操作": "进入品类/机型详情复盘",
            "停止条件": "连续两周恢复或策略验证不兑现",
            "值得下钻到机型层": False,
        })
    return out


def _load_json_file(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser(description="经营分析概览 workflow")
    parser.add_argument("--data-source", required=True, help="看板数据源路径/URL，或包含 current/history 的 JSON bundle")
    parser.add_argument("--week-label", default=None, help="周标签，如 2026-W27；默认读取 dashboard.week")
    parser.add_argument("--last-week-strategies", default="", help="上周策略清单")
    parser.add_argument("--link-verdict", default=None, help="可选：Step 2 JSON，用于测试/回放")
    parser.add_argument("--attribution-verdict", default=None, help="可选：Step 3 JSON，用于测试/回放")
    parser.add_argument("--model-verdict", default=None, help="可选：Step 4 JSON，用于测试/回放")
    parser.add_argument("--emit-input-json", action="store_true", help="仅输出 Step 1 InputDict JSON")
    parser.add_argument("--output", default=None, help="输出文件路径，默认 stdout")
    args = parser.parse_args()

    if args.emit_input_json:
        result_obj = step_1_fetch_and_calc(args.data_source, args.week_label, args.last_week_strategies)
        text = json.dumps(result_obj, ensure_ascii=False, indent=2)
    else:
        text = run(
            args.data_source,
            args.week_label,
            args.last_week_strategies,
            link_verdict=_load_json_file(args.link_verdict),
            attribution_verdict=_load_json_file(args.attribution_verdict),
            model_verdict=_load_json_file(args.model_verdict),
        )

    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"输出已写入: {args.output}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

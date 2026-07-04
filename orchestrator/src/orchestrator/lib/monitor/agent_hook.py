"""AI 归因入口:让 LLM 对 watchList 里的每个异常给出假设。

**当前版本状态**:MOCK 实现。
真实版会调 orchestrator.spawn_agent(subagent_type="analyst", ...) 让专家 agent
读取该机型的详细数据 + 上下文标签,生成假设。

Mock 策略:
- 根据 flags 类型和方向拼装一个规则化假设(不真调 LLM,零费用)
- 输出结构与真实版完全一致,调用方切换零改动

作者:Kiro
最后更新:2025-07-04
"""
from __future__ import annotations

import os
from typing import List, Optional

from .schemas import (
    RATE_NAME_MAP,
    AnomalyExplanation,
    WaveResultWithFlags,
)


# 从环境变量控制是否真调 LLM;默认关(mock 模式)
_USE_MOCK = os.environ.get("MONITOR_AGENT_MOCK", "1") == "1"


# ============================================================
# Mock 归因逻辑:根据 flag 组合生成模板化假设
# ============================================================


_HYPOTHESIS_TEMPLATES = {
    ("wave", "orderRate", "down"): (
        "下单率环比下滑 {delta_pct},疑似受价格竞争或库存告急影响,建议核查同期定价与广告投放。"
    ),
    ("wave", "orderRate", "up"): (
        "下单率环比上升 {delta_pct},可能来自新品发布或促销活动,建议放大同类营销动作。"
    ),
    ("wave", "evaRate", "down"): (
        "估价完成率下滑 {delta_pct},入口流量质量或估价页体验可能出现问题,建议排查前端埋点。"
    ),
    ("wave", "evaRate", "up"): (
        "估价完成率上升 {delta_pct},入口引流效率改善,或估价页新版本正向反馈。"
    ),
    ("wave", "shipRate", "down"): (
        "发货率下滑 {delta_pct},疑似仓储或物流链路异常,建议联动供应链核查。"
    ),
    ("wave", "dealRate", "down"): (
        "成交率下滑 {delta_pct},订单到成交的转化链路存在阻塞点,建议排查支付/审核环节。"
    ),
    ("wave", "returnRate", "up"): (
        "退回率环比上升 {delta_pct},质检或商品描述可能出问题,建议看退回原因分布。"
    ),
    ("trend", "orderRate", "down"): (
        "下单率连续 N 周下行,已成趋势性风险,建议立项专项优化。"
    ),
    ("trend", "orderRate", "up"): (
        "下单率连续 N 周上行,处于上升通道,建议加大资源倾斜。"
    ),
    ("trend", "evaRate", "up"): (
        "估价完成率连续 N 周上行,入口健康度持续改善。"
    ),
    ("trend", "returnRate", "up"): (
        "退回率连续 N 周上行,长期质量问题信号,需要供应链侧介入。"
    ),
}


_DEFAULT_TEMPLATE = "{metric_name}出现{flag_type}信号,建议深入分析该机型近期动态。"


def _format_delta(delta: Optional[float]) -> str:
    if delta is None:
        return ""
    pct = delta * 100
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.1f}%"


def _pick_primary_flag(watch: WaveResultWithFlags):
    """选影响面最大的 flag:wave 优先(有具体波幅),同类型选 |delta| 最大。"""
    if not watch.flags:
        return None
    waves = [f for f in watch.flags if f.type == "wave"]
    if waves:
        return max(waves, key=lambda f: abs(f.delta or 0))
    return watch.flags[0]


def _mock_hypothesis(watch: WaveResultWithFlags) -> AnomalyExplanation:
    primary = _pick_primary_flag(watch)
    if primary is None:
        return AnomalyExplanation(
            category=watch.category,
            modelName=watch.modelName,
            hypothesis="未命中任何异常规则,数据表现正常。",
            related_metrics=[],
            confidence="low",
        )

    # 匹配模板
    direction: Optional[str] = None
    if primary.type == "wave" and primary.delta is not None:
        direction = "up" if primary.delta > 0 else "down"
    elif primary.type == "trend":
        direction = primary.direction

    tmpl_key = (primary.type, primary.metric, direction)
    template = _HYPOTHESIS_TEMPLATES.get(tmpl_key, _DEFAULT_TEMPLATE)
    hypothesis = template.format(
        delta_pct=_format_delta(primary.delta),
        metric_name=primary.name,
        flag_type="波动" if primary.type == "wave" else "趋势",
    )

    # 相关指标:所有命中的 metric,加 evaUv(分母,永远相关)
    related = list({f.metric for f in watch.flags})
    related.append("evaUv")

    # 置信度:wave + |delta|>0.3 → high; 有 trend → medium; 其他 → low
    confidence = "low"
    if primary.type == "wave" and primary.delta is not None and abs(primary.delta) >= 0.3:
        confidence = "high"
    elif any(f.type == "trend" for f in watch.flags):
        confidence = "medium"

    return AnomalyExplanation(
        category=watch.category,
        modelName=watch.modelName,
        hypothesis=hypothesis,
        related_metrics=related,
        confidence=confidence,
    )


# ============================================================
# 真实版预留(未启用)
# ============================================================


def _real_analyze(watch: WaveResultWithFlags) -> AnomalyExplanation:
    """真实版:调 orchestrator.spawn_agent(subagent_type='analyst', ...)。

    当前未实现,阻塞项:
    - orchestrator.spawn_agent 稳定接口
    - analyst 专家 agent 的归因 prompt 模板
    - 该机型的详细上下文(近 30 天数据、标签、供应链状态)从哪里取
    """
    raise NotImplementedError(
        "真实版待接入。设 MONITOR_AGENT_MOCK=1 使用 mock 模式。"
    )


# ============================================================
# 主入口
# ============================================================


def analyze_anomaly_with_agent(
    watch_list: List[WaveResultWithFlags],
    top_k: Optional[int] = None,
) -> List[AnomalyExplanation]:
    """对 watch_list 里的每项生成归因假设。

    参数
    ----
    watch_list: apply_rules 输出的 watch_list
    top_k: 可选,只归因影响面最大的前 K 项(按 cur.evaUv 降序);None = 全部

    返回
    ----
    List[AnomalyExplanation],顺序与筛选后的 watch_list 一致
    """
    if not watch_list:
        return []

    # top_k 排序:按 evaUv 降序
    if top_k is not None and top_k > 0:
        sorted_watch = sorted(
            watch_list, key=lambda w: -(w.cur.evaUv or 0)
        )[:top_k]
    else:
        sorted_watch = watch_list

    analyzer = _mock_hypothesis if _USE_MOCK else _real_analyze
    return [analyzer(w) for w in sorted_watch]


__all__ = ["analyze_anomaly_with_agent"]

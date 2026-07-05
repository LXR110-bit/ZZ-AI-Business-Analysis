"""规则应用:池筛选 + 命中判定。

严格镜像 model-tag-monitor/src/monitor.js 中 monitor() 函数
自 `每个品类下按 targetWeek 的估价 UV 取 TOP N` 到 `return { ..., watchList, ... }`
的逻辑段落。

作者:Kiro
最后更新:2025-07-04
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from .schemas import (
    Flag,
    MonitorResult,
    MonitorRules,
    RATE_NAME_MAP,
    WaveResult,
    WaveResultWithFlags,
)


# ============================================================
# TOP N 入池:按 category 分组,组内 evaUv 降序取前 N
# ============================================================


def build_pool(
    wave_results: List[WaveResult],
    top_n: int,
) -> List[WaveResult]:
    """按品类分组,组内按 cur.evaUv 降序取前 top_n。

    与 Node 版
        list.sort((a, b) => (b.cur.evaUv || 0) - (a.cur.evaUv || 0));
        const topN = list.slice(0, R.poolTopN);
    等价。

    Python 侧的 sort 是 stable 的,与 V8 sort 在同分场景下**可能顺序不同**;
    我们通过第二排序键(modelName)显式稳定化,保证跨语言等价。
    """
    # 按 category 分组
    groups: Dict[str, List[WaveResult]] = {}
    for wr in wave_results:
        groups.setdefault(wr.category, []).append(wr)

    pool: List[WaveResult] = []
    for cat in sorted(groups.keys()):  # 遍历顺序确定,便于测试
        group = groups[cat]
        group.sort(
            key=lambda w: (
                -(w.cur.evaUv or 0),  # evaUv 降序
                w.modelName,  # 同分按 modelName 升序稳定
            )
        )
        pool.extend(group[:top_n])
    return pool


# ============================================================
# 三级 fallback 分母保护(spec monitor_noise_reduction)
# 优先级:perCategoryMinEvaUv[cat] > cat_total * minEvaUvPct > minEvaUv
# ============================================================


def _effective_min_evauv(
    category: str,
    cat_total_evauv: float,
    rules: MonitorRules,
) -> float:
    """三级 fallback,返回该品类下当前生效的最小 evaUv 阈值。

    优先级 1:perCategoryMinEvaUv[category] —— 业务方白名单
    优先级 2:cat_total_evauv * minEvaUvPct  —— 品类占比过滤
    优先级 3:rules.minEvaUv                  —— 全局兜底(现有行为)

    与 Node 版 effectiveMinEvaUv() 严格对应(见 model-tag-monitor/src/monitor.js)。
    """
    # 优先级 1
    if category in rules.perCategoryMinEvaUv:
        return rules.perCategoryMinEvaUv[category]
    # 优先级 2
    if rules.minEvaUvPct is not None:
        return cat_total_evauv * rules.minEvaUvPct
    # 优先级 3
    return rules.minEvaUv


# ============================================================
# 命中判定:遍历池,对每个转化率检查 wave + trend
# ============================================================


def detect_flags(
    wave: WaveResult,
    rules: MonitorRules,
    cat_total_evauv: float = 0.0,
) -> List[Flag]:
    """对单个 WaveResult 生成命中记录列表。

    与 Node 版:
        if (p.cur.evaUv >= effectiveMinEvaUv(p.category, catTotals[p.category] || 0, R)) {
          // 波动检测 / 趋势检测(同下)
        }
    等价。

    evaUv < effective_min_evauv(三级 fallback)时返回空列表(分母保护)。

    参数
    ----
    wave: 单个 WaveResult
    rules: MonitorRules
    cat_total_evauv: 该品类 target_week 的总 evaUv(供 minEvaUvPct 计算)。
                     默认值 0.0 主要为向后兼容 —— 外部单独调 detect_flags 时可省略,
                     结果仍等价于"pct=0 → effective=0 → 不触发分母保护"这一含义,
                     但生产路径必须由 apply_rules 传入真实值。
    """
    flags: List[Flag] = []
    effective_min = _effective_min_evauv(wave.category, cat_total_evauv, rules)
    if (wave.cur.evaUv or 0) < effective_min:
        return flags

    # 波动检测
    for rate_meta in rules.rates:
        k = rate_meta.key
        d = getattr(wave.delta, k)
        if d is not None and abs(d) >= rules.waveThreshold:
            flags.append(
                Flag(
                    type="wave",
                    metric=k,
                    name=rate_meta.name,
                    delta=d,
                )
            )

    # 趋势检测
    for rate_meta in rules.rates:
        k = rate_meta.key
        t = getattr(wave.trend, k)
        if t is not None:
            flags.append(
                Flag(
                    type="trend",
                    metric=k,
                    name=rate_meta.name,
                    direction=t,
                )
            )

    return flags


# ============================================================
# 主入口
# ============================================================


def apply_rules(
    wave_results: List[WaveResult],
    all_weeks: List[str],
    target_week: str,
    prev_week: Optional[str],
    rules: MonitorRules,
) -> MonitorResult:
    """完整的池筛选 + 命中判定。

    返回 MonitorResult,与 Node 版 monitor() 的返回值结构等价:
        { targetWeek, prevWeek, weeks, pool, watchList, rules }
    """
    # 三级 fallback 需要品类当周总 evaUv 用于 minEvaUvPct 计算。
    # 这里遍历全量 wave_results(不是 pool),因为占比语义是"该机型 evaUv
    # 占品类当周整体 evaUv 的比例",分母是品类全量,不是 top-N pool。
    cat_totals: Dict[str, float] = {}
    for wr in wave_results:
        if wr.cur and wr.cur.week == target_week:
            cat_totals[wr.category] = cat_totals.get(wr.category, 0.0) + (wr.cur.evaUv or 0)

    pool = build_pool(wave_results, rules.poolTopN)

    watch_list: List[WaveResultWithFlags] = []
    for wr in pool:
        cat_total = cat_totals.get(wr.category, 0.0)
        flags = detect_flags(wr, rules, cat_total)
        if flags:
            # WaveResult -> WaveResultWithFlags,复制字段
            watch_list.append(
                WaveResultWithFlags(
                    **wr.model_dump(),
                    flags=flags,
                )
            )

    return MonitorResult(
        targetWeek=target_week,
        prevWeek=prev_week,
        weeks=all_weeks,
        pool=pool,
        watchList=watch_list,
        rules=rules,
    )


# ============================================================
# 规则文件加载
# ============================================================


def load_rules_from_file(
    path: Path,
    fallback_to_default: bool = True,
) -> MonitorRules:
    """从 JSON 文件加载部分覆盖并 merge 到默认规则。

    JSON 格式示例(业务方后台可视化编辑生成):
        {
          "waveThreshold": 0.15,
          "minEvaUv": 20
        }

    参数
    ----
    path: 规则 JSON 文件路径
    fallback_to_default: 文件不存在时是否 fallback 到默认;False 时抛 FileNotFoundError
    """
    if not path.exists():
        if fallback_to_default:
            return MonitorRules()
        raise FileNotFoundError(f"rules file not found: {path}")

    with path.open("r", encoding="utf-8") as f:
        overrides: Dict[str, Any] = json.load(f)
    return MonitorRules.merge(overrides)


__all__ = [
    "build_pool",
    "detect_flags",
    "apply_rules",
    "load_rules_from_file",
]

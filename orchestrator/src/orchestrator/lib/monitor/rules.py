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
# 命中判定:遍历池,对每个转化率检查 wave + trend
# ============================================================


def detect_flags(
    wave: WaveResult,
    rules: MonitorRules,
) -> List[Flag]:
    """对单个 WaveResult 生成命中记录列表。

    与 Node 版:
        if (p.cur.evaUv >= R.minEvaUv) {
          // 波动检测
          for (const { key, name } of R.rates) {
            const d = p.delta[key];
            if (d !== null && Math.abs(d) >= R.waveThreshold) flags.push({type:'wave',...});
          }
          // 趋势检测
          for (const { key, name } of R.rates) {
            const t = p.trend[key];
            if (t) flags.push({type:'trend',...});
          }
        }
    等价。

    evaUv < minEvaUv 时返回空列表(分母保护)。
    """
    flags: List[Flag] = []
    if (wave.cur.evaUv or 0) < rules.minEvaUv:
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
    pool = build_pool(wave_results, rules.poolTopN)

    watch_list: List[WaveResultWithFlags] = []
    for wr in pool:
        flags = detect_flags(wr, rules)
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

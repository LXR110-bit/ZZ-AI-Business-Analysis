"""波动与趋势计算。

严格镜像 model-tag-monitor/src/monitor.js 中的
    - buildSeries(rows)
    - calcDelta(cur, prev)
    - calcTrend(weeklyList, weeks, ratesKeys)

三个函数,以及主入口 monitor() 的骨架。

作者:Kiro
最后更新:2025-07-04
"""
from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Tuple

from .schemas import (
    RATE_KEYS,
    DeltaMap,
    FunnelRow,
    MonitorRules,
    RateKey,
    TrendDir,
    TrendMap,
    WaveResult,
)


# ============================================================
# 内部数据结构
# ============================================================


class _SeriesEntry:
    """对应 Node 版 series 里的 entry:
    { category, modelName, weekly: Map<week, row> }
    """

    __slots__ = ("category", "modelName", "weekly")

    def __init__(self, category: str, modelName: str) -> None:
        self.category = category
        self.modelName = modelName
        # week -> FunnelRow
        self.weekly: Dict[str, FunnelRow] = {}


# ============================================================
# 按 (category, modelName) 聚合成时间序列
# ============================================================


def build_series(rows: Iterable[FunnelRow]) -> Dict[str, _SeriesEntry]:
    """把扁平 rows 聚合成 {"cat||model": SeriesEntry} 字典。

    与 Node 版 buildSeries 等价。
    重复 (cat, model, week) 键取最后一条,不合并。
    """
    result: Dict[str, _SeriesEntry] = {}
    for r in rows:
        key = f"{r.category}||{r.modelName}"
        entry = result.get(key)
        if entry is None:
            entry = _SeriesEntry(r.category, r.modelName)
            result[key] = entry
        entry.weekly[r.week] = r
    return result


# ============================================================
# 单机型单周 vs 上周的 5 个转化率 delta
# ============================================================


def calc_delta(cur: FunnelRow, prev: Optional[FunnelRow]) -> DeltaMap:
    """计算 5 个转化率的周环比。

    与 Node 版 calcDelta 等价:
      - prev 为 None → 全 None
      - cv 或 pv 为 None、或 pv == 0 → 该项为 None
      - 否则 (cv - pv) / pv
    """
    if prev is None:
        return DeltaMap()

    out: Dict[str, Optional[float]] = {}
    for k in RATE_KEYS:
        cv = getattr(cur, k)
        pv = getattr(prev, k)
        if cv is None or pv is None or pv == 0:
            out[k] = None
        else:
            out[k] = (cv - pv) / pv
    return DeltaMap(**out)


# ============================================================
# 连续 N 周同向趋势
# ============================================================


def calc_trend(
    weekly_list: List[FunnelRow],
    weeks: int,
    rates_keys: Optional[List[RateKey]] = None,
) -> TrendMap:
    """判断尾部 N 周是否严格单调。

    与 Node 版 calcTrend 等价:
      - weeklyList 已按 week 升序排列
      - 若长度 < weeks,直接返回全 None
      - 取尾部 weeks 条,循环相邻对:
          * 存在任何 None / pv == 0 → allUp = allDown = False,直接跳出
          * 严格递增(cv > pv 全部成立) → up
          * 严格递减(cv < pv 全部成立) → down
          * 其他 → None
    """
    keys: List[RateKey] = list(rates_keys) if rates_keys else list(RATE_KEYS)
    out: Dict[str, Optional[TrendDir]] = {k: None for k in keys}

    if len(weekly_list) < weeks:
        return TrendMap(**out)

    tail = weekly_list[-weeks:]

    for k in keys:
        all_up = True
        all_down = True
        for i in range(1, len(tail)):
            cv = getattr(tail[i], k)
            pv = getattr(tail[i - 1], k)
            if cv is None or pv is None or pv == 0:
                all_up = False
                all_down = False
                break
            if cv <= pv:
                all_up = False
            if cv >= pv:
                all_down = False
        if all_up:
            out[k] = "up"
        elif all_down:
            out[k] = "down"
        else:
            out[k] = None
    return TrendMap(**out)


# ============================================================
# 主入口:对每个池内 (cat, model) 生成 WaveResult
# ============================================================


def compute_wave(
    rows: List[FunnelRow],
    target_week: str,
    prev_week: Optional[str],
    rules: MonitorRules,
    tags_map: Optional[Dict[str, List[str]]] = None,
) -> Tuple[List[WaveResult], List[str]]:
    """生成 target_week 下所有 (cat, model) 的 WaveResult。

    返回 (wave_results, all_weeks_sorted)。

    注意:此函数不做 TOP N 截取和命中判定,那是 apply_rules 的事。
    这里只做纯计算,输出全量。

    与 Node 版 monitor() 中 `建立时序 → 每个品类下按 targetWeek 的估价 UV TOP N`
    之前的部分等价,但**不做 TOP N 过滤**;TOP N 移到 apply_rules。
    """
    tags_map = tags_map or {}
    series = build_series(rows)

    # 收集全部周次(升序)
    all_weeks: set[str] = set()
    for entry in series.values():
        all_weeks.update(entry.weekly.keys())
    weeks_sorted = sorted(all_weeks)

    results: List[WaveResult] = []
    for key, entry in series.items():
        cur = entry.weekly.get(target_week)
        if cur is None:
            # target_week 这周没这机型 → 不入结果
            continue
        prev = entry.weekly.get(prev_week) if prev_week else None
        delta = calc_delta(cur, prev)

        # 趋势用 target_week 及之前的所有周
        weekly_arr_asc = [
            entry.weekly[w] for w in sorted(entry.weekly.keys()) if w <= target_week
        ]
        trend = calc_trend(weekly_arr_asc, rules.trendWeeks, RATE_KEYS)

        results.append(
            WaveResult(
                category=entry.category,
                modelName=entry.modelName,
                tags=tags_map.get(key, []),
                cur=cur,
                prev=prev,
                delta=delta,
                trend=trend,
            )
        )

    return results, weeks_sorted


__all__ = [
    "build_series",
    "calc_delta",
    "calc_trend",
    "compute_wave",
]

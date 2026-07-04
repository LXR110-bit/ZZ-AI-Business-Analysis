"""数据入口:从数据源拉指定维度、指定周窗的漏斗原始数据。

**当前版本状态**:MOCK 实现。
真实版待飞书多维表格 app_token / table_id / 字段映射就位后接入。

Mock 策略:
- 从 `MOCK_DATA_PATH`(默认 `data/monitor_mock/cache_sample.json`)读一份预置数据
- 支持通过环境变量 `MONITOR_MOCK_CACHE` 覆盖路径
- 接口签名与真实版完全一致,调用方切换零改动

作者:Kiro
最后更新:2025-07-04
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from .schemas import FunnelRow, MonitorFetchError

Dimension = Literal["model", "category"]

# 默认 mock 数据位置(相对 repo 根)
_DEFAULT_MOCK_PATH = Path("data/monitor_mock/cache_sample.json")


def _resolve_mock_path(source_config: Optional[Dict[str, Any]] = None) -> Path:
    """解析 mock 数据文件路径,优先级:
    1. source_config['mock_path'](显式传参)
    2. 环境变量 MONITOR_MOCK_CACHE
    3. 默认路径 data/monitor_mock/cache_sample.json
    """
    if source_config and source_config.get("mock_path"):
        return Path(source_config["mock_path"])
    env_path = os.environ.get("MONITOR_MOCK_CACHE")
    if env_path:
        return Path(env_path)
    return _DEFAULT_MOCK_PATH


def _load_cache(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise MonitorFetchError(
            dimension="?",
            week="?",
            cause=FileNotFoundError(
                f"mock cache 不存在: {path}. "
                "配置 MONITOR_MOCK_CACHE 环境变量或传 source_config={'mock_path': ...}"
            ),
        )
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _filter_by_week_range(
    rows: List[Dict[str, Any]],
    week_range: Tuple[str, str],
) -> List[Dict[str, Any]]:
    """字典序比较周次(ISO 周格式保证正确)。"""
    lo, hi = week_range
    return [r for r in rows if lo <= r["week"] <= hi]


def _aggregate_to_category(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """把 modelName 层聚合成 category 层。

    聚合规则(与 Node 版 sync.js 的品类汇总口径对齐):
    - evaUv 求和
    - 5 个转化率:目前用简单加权平均(权重 = evaUv),不足在于对稀疏数据敏感
      TODO:真实版需要接入 evaCount/orderCount/... 分子分母求和后重算,更严谨
    """
    from collections import defaultdict

    agg: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for r in rows:
        key = (r["category"], r["week"])
        if key not in agg:
            agg[key] = {
                "category": r["category"],
                "modelName": r["category"],  # 品类维度下,modelName 就是 category 名
                "week": r["week"],
                "evaUv": 0,
                "_weighted": defaultdict(float),  # 转化率 * evaUv 累加
                "_weight_total": 0,
            }
        entry = agg[key]
        uv = r.get("evaUv", 0) or 0
        entry["evaUv"] += uv
        entry["_weight_total"] += uv
        for rate_key in ("evaRate", "orderRate", "shipRate", "dealRate", "returnRate"):
            v = r.get(rate_key)
            if v is not None:
                entry["_weighted"][rate_key] += v * uv

    out: List[Dict[str, Any]] = []
    for entry in agg.values():
        total_w = entry["_weight_total"]
        for rate_key in ("evaRate", "orderRate", "shipRate", "dealRate", "returnRate"):
            if total_w > 0:
                entry[rate_key] = entry["_weighted"].get(rate_key, 0) / total_w
            else:
                entry[rate_key] = None
        del entry["_weighted"]
        del entry["_weight_total"]
        out.append(entry)
    return out


def fetch_funnel_data(
    dimension: Dimension,
    week_range: Tuple[str, str],
    source_config: Optional[Dict[str, Any]] = None,
) -> List[FunnelRow]:
    """从数据源拉指定维度、指定周窗的漏斗原始数据。

    参数
    ----
    dimension: "model" | "category"
        model:直接返回机型级
        category:把机型层聚合成品类层
    week_range: (start_week, end_week),闭区间
    source_config: 数据源配置。当前 mock 版支持:
        - {"mock_path": "..."} 显式指定 fixture 路径

    返回
    ----
    List[FunnelRow],已按 dimension 聚合完毕

    异常
    ----
    MonitorFetchError:数据不存在或格式错
    """
    path = _resolve_mock_path(source_config)
    try:
        cache = _load_cache(path)
    except MonitorFetchError:
        raise
    except Exception as e:
        raise MonitorFetchError(dimension=dimension, week=str(week_range), cause=e)

    raw_rows = cache.get("rows", [])
    if not isinstance(raw_rows, list):
        raise MonitorFetchError(
            dimension=dimension,
            week=str(week_range),
            cause=ValueError(f"cache.rows 不是 list: {type(raw_rows)}"),
        )

    # 周窗过滤
    filtered = _filter_by_week_range(raw_rows, week_range)

    # 维度聚合
    if dimension == "category":
        filtered = _aggregate_to_category(filtered)

    # 转 Pydantic
    try:
        return [FunnelRow(**r) for r in filtered]
    except Exception as e:
        raise MonitorFetchError(dimension=dimension, week=str(week_range), cause=e)


__all__ = ["fetch_funnel_data", "Dimension"]

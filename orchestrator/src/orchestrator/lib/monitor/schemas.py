"""Pydantic schemas for the monitor lib.

严格对齐 model-tag-monitor/src/monitor.js 的字段命名与类型。
不做无谓的重命名(例如把 modelName 改成 model_name),保留 camelCase
以便与现有 Node cache.json 直接互通。

作者:Kiro
最后更新:2025-07-04
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# ============================================================
# 常量
# ============================================================

RateKey = Literal["evaRate", "orderRate", "shipRate", "dealRate", "returnRate"]

RATE_KEYS: List[RateKey] = [
    "evaRate",
    "orderRate",
    "shipRate",
    "dealRate",
    "returnRate",
]

RATE_NAME_MAP: Dict[str, str] = {
    "evaRate": "估价完成率",
    "orderRate": "估价下单率",
    "shipRate": "估价发货率",
    "dealRate": "估价成交率",
    "returnRate": "质检退回率",
}


# ============================================================
# 输入:漏斗原始数据(等价 cache.json 里的一行)
# ============================================================


class FunnelRow(BaseModel):
    """漏斗原始数据的一行。

    对应 Node 版 cache.json 里 rows[i] 的结构。
    转化率允许为 None(数据缺失或分母为 0 场景),下游需明确处理。
    """

    model_config = ConfigDict(extra="allow")  # 允许 evaCount 等辅助字段透传

    category: str = Field(..., description="品类,例:手机")
    modelName: str = Field(..., description="机型名,例:iPhone 15 Pro Max 256G")
    week: str = Field(..., description="周次,ISO 周或自定义格式")
    evaUv: int = Field(..., ge=0, description="估价 UV,分母指标")

    evaRate: Optional[float] = Field(None, description="估价完成率")
    orderRate: Optional[float] = Field(None, description="估价下单率")
    shipRate: Optional[float] = Field(None, description="估价发货率")
    dealRate: Optional[float] = Field(None, description="估价成交率")
    returnRate: Optional[float] = Field(None, description="质检退回率")


# ============================================================
# 规则配置
# ============================================================


class RateMeta(BaseModel):
    """转化率的元信息(供展示)。"""

    key: RateKey
    name: str


class MonitorRules(BaseModel):
    """监测参数配置。

    严格对齐 Node 版 monitor.js 的 DEFAULT_RULES。
    支持从 JSON 部分覆盖:
        rules = MonitorRules.merge({"waveThreshold": 0.15})
    """

    poolTopN: int = Field(20, ge=1, description="每个品类取估价 UV TOP N 入池")
    poolMinWeek: Optional[str] = Field(
        None,
        description="强制指定目标周;None = 用最新周",
    )
    waveThreshold: float = Field(
        0.1,
        ge=0.0,
        description="波动阈值,|delta| >= 此值即命中 wave flag",
    )
    trendWeeks: int = Field(3, ge=2, description="连续 N 周同向阈值")
    minEvaUv: int = Field(15, ge=0, description="分母保护,evaUv 低于此值不参与判定")

    rates: List[RateMeta] = Field(
        default_factory=lambda: [
            RateMeta(key=k, name=RATE_NAME_MAP[k]) for k in RATE_KEYS
        ]
    )

    @classmethod
    def merge(cls, overrides: Optional[Dict[str, Any]] = None) -> "MonitorRules":
        """从部分覆盖字典构造 MonitorRules。

        业务方后台管理页会写这样的 JSON:
            {"waveThreshold": 0.15, "minEvaUv": 20}
        本方法把它 merge 到默认值上。
        """
        if not overrides:
            return cls()
        base = cls().model_dump()
        base.update(overrides)
        return cls(**base)


# ============================================================
# 输出:波动结果
# ============================================================


class DeltaMap(BaseModel):
    """5 个转化率的周环比 delta。None 表示无法计算。"""

    evaRate: Optional[float] = None
    orderRate: Optional[float] = None
    shipRate: Optional[float] = None
    dealRate: Optional[float] = None
    returnRate: Optional[float] = None


TrendDir = Literal["up", "down"]


class TrendMap(BaseModel):
    """5 个转化率的连续 N 周趋势。None 表示未形成连续同向。"""

    evaRate: Optional[TrendDir] = None
    orderRate: Optional[TrendDir] = None
    shipRate: Optional[TrendDir] = None
    dealRate: Optional[TrendDir] = None
    returnRate: Optional[TrendDir] = None


class WaveResult(BaseModel):
    """单个 (category, modelName) 的波动 + 趋势结果。"""

    category: str
    modelName: str
    tags: List[str] = Field(default_factory=list)
    cur: FunnelRow
    prev: Optional[FunnelRow] = None
    delta: DeltaMap
    trend: TrendMap


# ============================================================
# 输出:命中 flag
# ============================================================


FlagType = Literal["wave", "trend"]


class Flag(BaseModel):
    """一条命中记录,对应 Node 版 flags 数组的一项。"""

    type: FlagType
    metric: RateKey
    name: str
    # 波动 flag 有 delta,趋势 flag 有 direction
    delta: Optional[float] = None
    direction: Optional[TrendDir] = None


class WaveResultWithFlags(WaveResult):
    """带命中记录的 WaveResult,进入 watch_list 的形态。"""

    flags: List[Flag] = Field(default_factory=list)


# ============================================================
# 输出:主函数结果
# ============================================================


class MonitorResult(BaseModel):
    """apply_rules 的最终输出。"""

    target_week: str = Field(..., alias="targetWeek")
    prev_week: Optional[str] = Field(None, alias="prevWeek")
    weeks: List[str]
    pool: List[WaveResult]
    watch_list: List[WaveResultWithFlags] = Field(..., alias="watchList")
    rules: MonitorRules

    model_config = ConfigDict(populate_by_name=True)


# ============================================================
# AI 归因(spawn_agent 输出)
# ============================================================


ConfidenceLevel = Literal["high", "medium", "low"]


class AnomalyExplanation(BaseModel):
    """spawn_agent 对单个异常项的归因假设。"""

    category: str
    modelName: str
    hypothesis: str = Field(..., max_length=200)
    related_metrics: List[str] = Field(default_factory=list)
    confidence: ConfidenceLevel


# ============================================================
# 推送:飞书报告
# ============================================================


class MonitorReportSummary(BaseModel):
    total_dims: int
    watch_count: int
    rising_count: int
    falling_count: int


class MonitorReport(BaseModel):
    """推送给飞书的完整报告 payload。"""

    dimension: Literal["model", "category"]
    week: str
    summary: MonitorReportSummary
    top_anomalies: List[AnomalyExplanation]
    dashboard_url: str
    report_url: Optional[str] = None


# ============================================================
# 异常
# ============================================================


class MonitorError(Exception):
    """monitor lib 通用异常基类。"""


class MonitorFetchError(MonitorError):
    """fetch_funnel_data 抛出。"""

    def __init__(self, dimension: str, week: str, cause: Optional[Exception] = None):
        self.dimension = dimension
        self.week = week
        self.cause = cause
        super().__init__(f"MonitorFetchError(dim={dimension}, week={week}): {cause}")


class MonitorPushError(MonitorError):
    """push_to_feishu 抛出。"""


__all__ = [
    "RATE_KEYS",
    "RATE_NAME_MAP",
    "RateKey",
    "FunnelRow",
    "RateMeta",
    "MonitorRules",
    "DeltaMap",
    "TrendMap",
    "TrendDir",
    "WaveResult",
    "Flag",
    "FlagType",
    "WaveResultWithFlags",
    "MonitorResult",
    "ConfidenceLevel",
    "AnomalyExplanation",
    "MonitorReport",
    "MonitorReportSummary",
    "MonitorError",
    "MonitorFetchError",
    "MonitorPushError",
]

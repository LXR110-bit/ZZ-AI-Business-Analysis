"""
Pydantic 输入/输出结构（v0.4）
负责 spawn_agent 调用前后的 schema 验证
v0.4 变更：三基准(环比/同比/近8周)、数据可信度、二维归因矩阵、
          品类间此消彼长、论点仲裁、金字塔顶层输出
"""
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, field_validator


# ============================================================
# 通用：单指标三基准数据结构（v0.4：环比+同比+近8周）
# ============================================================

def _validate_pct(v: str, field_name: str) -> str:
    """校验百分比字符串"""
    if v == "N/A":
        return v
    if "%" not in v or len(v) < 2:
        raise ValueError(f"{field_name} 必须包含 %，得到: {v}")
    try:
        float(v.rstrip("%"))
    except ValueError:
        raise ValueError(f"{field_name} 数字部分不可解析: {v}")
    return v


class MetricQoQ(BaseModel):
    """单指标的三基准数据（v0.4：环比 + 同比 + 近8周对比 + 趋势）"""
    this_week: float = Field(..., description="本周值（日均）")
    last_week: float = Field(..., description="上周值（日均）")
    qoq: str = Field(..., description="环比百分比（vs上周），如 -2.0%")
    # v0.4 新增三基准
    week4_ago: Optional[float] = Field(None, description="4周前值（同比基准）")
    yoy: Optional[str] = Field(None, description="同比百分比（vs4周前），如 +1.2%")
    week8_avg: Optional[float] = Field(None, description="近8周均值")
    week8_position: Optional[str] = Field(
        None, description="近8周位置：高于均值/接近均值/低于均值"
    )
    week8_series: Optional[List[float]] = Field(
        None, description="近8周序列，用于趋势判断"
    )

    @field_validator("qoq")
    @classmethod
    def validate_qoq(cls, v: str) -> str:
        return _validate_pct(v, "qoq")

    @field_validator("yoy")
    @classmethod
    def validate_yoy(cls, v: Optional[str]) -> Optional[str]:
        return None if v is None else _validate_pct(v, "yoy")

    @field_validator("week8_position")
    @classmethod
    def validate_position(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in ("高于均值", "接近均值", "低于均值"):
            raise ValueError(f"week8_position 取值非法: {v}")
        return v


# ============================================================
# Step 1 输出：input_dict → Step 2 输入
# ============================================================

class CategoryData(BaseModel):
    """单个品类"""
    name: str
    gujia_uv: MetricQoQ
    xiadan_uv: MetricQoQ
    chengjiao_orders: MetricQoQ
    chengjiao_gmv: MetricQoQ
    ke_danjia: Optional[MetricQoQ] = None


class ClusterData(BaseModel):
    """品类簇：发展/孵化/种子"""
    name: str = Field(..., pattern="发展|孵化|种子")
    gujia_uv: MetricQoQ
    xiadan_uv: MetricQoQ
    chengjiao_orders: MetricQoQ
    chengjiao_gmv: MetricQoQ
    categories: List[CategoryData] = Field(default_factory=list)


class DataReliability(BaseModel):
    """v0.4：数据可信度校验结果（Step -1）"""
    可信: bool = Field(..., description="三查是否全部通过")
    同步时点: str = Field(..., description="数据同步周次 vs 分析周次，如 匹配/滞后2周")
    口径断层: str = Field("无", description="是否有环节环比突兀为0或极端值")
    比值异常: str = Field("无", description="相邻环节比值是否异常")
    结论: str = Field(..., description="可信 / 存疑(原因)")


class InputDict(BaseModel):
    """Step 1 取数算环比后的数据结构"""
    week_label: str
    data_reliability: Optional[DataReliability] = None  # v0.4
    dau: MetricQoQ
    jikuang_uv: MetricQoQ
    gujia_uv: MetricQoQ
    xiadan_uv: MetricQoQ
    fahu_o_count: MetricQoQ
    chengjiao_orders: MetricQoQ
    chengjiao_gmv: MetricQoQ
    ke_danjia: MetricQoQ
    clusters: Dict[str, ClusterData]
    last_week_strategies: str = ""


# ============================================================
# Step 2 输出：link_verdict
# ============================================================

class LinkVerdict(BaseModel):
    """Step 2 spawn_agent 必须返回的结构（v0.4）"""
    # v0.4 数据可信度（先于一切）
    数据可信度: str = Field("可信", description="可信 / 存疑(原因)")
    待核标签: bool = Field(False, description="数据存疑时为 True，结论加'待核'")

    定性名字: str
    风险等级: str = Field(..., description="🔴/🟡/🟢")
    链路形态: str = Field(
        ..., description="健康传导/中游漏损/量退价补/少数大单驱动/单点断裂"
    )
    量价拆解: str
    瓶颈环节: str = "无"
    逆势环节: str = "无"
    判断依据: str

    # v0.4 三基准对比
    环比结论: str = Field(..., description="GMV 环比 vs 上周")
    同比结论: str = Field("N/A", description="GMV 同比 vs 4周前")
    近8周位置: str = Field("N/A", description="高于/接近/低于 均值 → 真实趋势/短期回调/正常波动")
    趋势标签: str = Field(..., description="下降通道/上升通道/震荡区间/首次突破")

    # 各环节环比（用于 Step 5 拼接）
    dau_qoq: str
    jikuang_qoq: str
    gujia_qoq: str
    xiadan_qoq: str
    fahu_o_qoq: str
    chengjiao_qoq: str
    gmv_qoq: str


# ============================================================
# Step 3 输出：attribution_verdict
# ============================================================

class StrategyValidationItem(BaseModel):
    策略: str
    KPI: str
    本周数据: str
    兑现: str = Field(..., description="兑现/部分兑现/未兑现/反向")
    解读: str


class CategoryDrillItem(BaseModel):
    品类名: str
    异常得分: float
    影响度: float
    流量端: str
    转化端: str
    此消彼长: str = Field(
        "外部流失",
        description="内部竞争(流向X品类)/外部流失/跨簇转移(流向Y簇)"
    )  # v0.4
    可解决度: str
    元凶: str
    建议操作: str
    停止条件: str
    值得下钻到机型层: bool


# v0.4：归因二维矩阵（责任主体 × 时间属性）
_RESPONSIBLE_SUBJECTS = {"市场行情", "我方动作", "竞对动作", "用户结构变化", "不可归因"}
_TIME_ATTRS = {"一次性事件", "短期波动", "结构性趋势"}


class AttributionMatrix(BaseModel):
    """v0.4：二维归因，责任主体(可多个,各带证据) × 时间属性(单选)"""
    责任主体: List[str] = Field(
        ..., description="市场行情/我方动作/竞对动作/用户结构变化/不可归因"
    )
    时间属性: str = Field(..., description="一次性事件/短期波动/结构性趋势")
    证据: Dict[str, str] = Field(
        default_factory=dict, description="每个责任主体对应的证据"
    )

    @field_validator("责任主体")
    @classmethod
    def validate_subjects(cls, v: List[str]) -> List[str]:
        if not v:
            raise ValueError("责任主体不能为空")
        bad = [s for s in v if s not in _RESPONSIBLE_SUBJECTS]
        if bad:
            raise ValueError(f"责任主体取值非法: {bad}")
        return v

    @field_validator("时间属性")
    @classmethod
    def validate_time_attr(cls, v: str) -> str:
        if v not in _TIME_ATTRS:
            raise ValueError(f"时间属性取值非法: {v}")
        return v


class ArbitrationNote(BaseModel):
    """v0.4：论点交叉仲裁记录（Skill1定性 vs Skill2归因 打架）"""
    原判: str
    证据: str
    修正为: str = Field(..., description="新标签 / 保留+局部说明 / 存疑并列")


class ClusterVerdict(BaseModel):
    风险等级: str
    流量端: str
    转化端: str
    归因: AttributionMatrix  # v0.4：从单标签字符串升级为二维矩阵
    影响度: str = Field(..., description="占大盘GMV比例字符串，如 2.1%")
    可解决度: str = Field(..., description="等市场恢复/可控可改/不可改")
    建议操作: str
    品类下钻: List[CategoryDrillItem] = Field(default_factory=list)


class AttributionVerdict(BaseModel):
    发展: ClusterVerdict
    孵化: ClusterVerdict
    种子: ClusterVerdict
    策略验证: List[StrategyValidationItem] = Field(default_factory=list)
    仲裁: List[ArbitrationNote] = Field(default_factory=list)  # v0.4
    trigger_model_drill: bool = False
    drilldown_targets: dict = Field(default_factory=dict)
    下周行动: List[str] = Field(default_factory=list)


# ============================================================
# Step 4 输出：model_verdict
# ============================================================

class ModelDrilldownItem(BaseModel):
    机型名: str
    估价次数: int
    转化率: str
    判断: str
    建议: str


class ModelVerdict(BaseModel):
    品类名: str
    问题机型: List[ModelDrilldownItem] = Field(default_factory=list)
    机会机型: List[ModelDrilldownItem] = Field(default_factory=list)
    机型规律: str = ""
    规律状态: str = "首次发现"
    跨品类复用: str = ""
    风险等级: str = "🟢"


# ============================================================
# Step 5 输出：金字塔顶层结构（v0.4）
# 序言(SCQA) + 塔尖(单一判断+动词) + 核心发现(三问分组)
# ============================================================

class Preface(BaseModel):
    """v0.4：SCQA 序言"""
    情境_S: str = Field(..., description="上周处于什么状态")
    冲突_C: str = Field(..., description="本周发生了什么打破了那个状态")
    疑问_Q: str = Field(..., description="所以现在最该回答什么")


class Apex(BaseModel):
    """v0.4：塔尖——单一核心判断 + 动词"""
    核心判断: str = Field(..., description="定调+风险等级+动词(加注/持平/收手)+对象")
    动词: str = Field(..., description="加注/持平/收手")
    对象: str = Field(..., description="动词指向的具体品类/机型")
    量价拆解: str = Field(..., description="GMV拆解+真假增长")
    情绪基调: str = Field(..., description="🚀兴奋/🙂稳健/😐警惕/😰紧张")

    @field_validator("动词")
    @classmethod
    def validate_verb(cls, v: str) -> str:
        if v not in ("加注", "持平", "收手"):
            raise ValueError(f"动词必须三选一(加注/持平/收手): {v}")
        return v


class Finding(BaseModel):
    """v0.4：单条核心发现，必须挂 Skill 凭据"""
    发现: str
    凭据: str = Field(..., description="来源 Skill + 数据，如 Skill 1: GMV -2.0%")


class KeyFindings(BaseModel):
    """v0.4：核心发现按老板三问 MECE 分组"""
    Q1_大盘安全: List[Finding] = Field(default_factory=list)
    Q2_预判兑现: List[Finding] = Field(default_factory=list)
    Q3_资源怎么动: List[Finding] = Field(default_factory=list)
    兑现率: str = Field("N/A", description="M/N + 打分")


class PyramidReport(BaseModel):
    """v0.4：Skill 5 金字塔式最终输出"""
    序言: Preface
    塔尖: Apex
    核心发现: KeyFindings
    下周行动: List[str] = Field(
        default_factory=list, description="1-2条，每条含凭据+停止条件"
    )
    风险等级: str = Field(..., description="🔴/🟡/🟢")

    @field_validator("下周行动")
    @classmethod
    def validate_actions(cls, v: List[str]) -> List[str]:
        if len(v) > 2:
            raise ValueError(f"下周行动最多 2 条，得到 {len(v)} 条")
        return v

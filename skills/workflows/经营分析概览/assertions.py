"""
守门检验：所有 spawn_agent 输出必须通过的断言
v0.4：新增数据可信度、三基准趋势、二维归因证据、金字塔顶层守门
"""
from .schemas import (
    LinkVerdict,
    AttributionVerdict,
    ModelVerdict,
    PyramidReport,
)


class GateError(RuntimeError):
    """守门检验失败"""
    pass


def link_gate(verdict: dict) -> LinkVerdict:
    """Step 2 守门"""
    try:
        v = LinkVerdict(**verdict)
    except Exception as e:
        raise GateError(f"Step 2 schema 失败: {e}")

    if not v.定性名字.strip():
        raise GateError("定性名字不能为空")
    if not v.判断依据.strip():
        raise GateError("判断依据不能为空")
    # v0.4：数据存疑时风险等级不得为 🟢
    if v.待核标签 and v.风险等级 == "🟢":
        raise GateError("数据存疑(待核)时，风险等级不得下🟢")
    # v0.4：趋势标签必须合法
    if v.趋势标签 not in ("下降通道", "上升通道", "震荡区间", "首次突破"):
        raise GateError(f"趋势标签非法: {v.趋势标签}")

    return v


def attribution_gate(verdict: dict) -> AttributionVerdict:
    """Step 3 守门"""
    try:
        v = AttributionVerdict(**verdict)
    except Exception as e:
        raise GateError(f"Step 3 schema 失败: {e}")

    for cn in ("发展", "孵化", "种子"):
        c = getattr(v, cn)
        # v0.4：二维归因——每个责任主体都要有证据（不可归因除外）
        for subj in c.归因.责任主体:
            if subj == "不可归因":
                continue
            if not c.归因.证据.get(subj, "").strip():
                raise GateError(f"{cn} 责任主体'{subj}'缺少证据")
        if c.影响度 == "0%":
            raise GateError(f"{cn} 影响度不应为 0%")

    if v.trigger_model_drill and not v.drilldown_targets:
        raise GateError("trigger_model_drill=true 但 drilldown_targets 为空")

    return v


def pyramid_gate(report: dict) -> PyramidReport:
    """Step 5 守门（v0.4 金字塔顶层输出）"""
    try:
        v = PyramidReport(**report)
    except Exception as e:
        raise GateError(f"Step 5 schema 失败: {e}")

    # 塔尖动词必须指向具体对象
    if not v.塔尖.对象.strip():
        raise GateError("塔尖动词必须指向具体对象（不能空泛）")
    # 每条核心发现必须挂凭据
    for group_name in ("Q1_大盘安全", "Q2_预判兑现", "Q3_资源怎么动"):
        for f in getattr(v.核心发现, group_name):
            if not f.凭据.strip():
                raise GateError(f"{group_name} 有发现缺少 Skill 凭据")
    # 至少要有一条核心发现
    total = (len(v.核心发现.Q1_大盘安全) + len(v.核心发现.Q2_预判兑现)
             + len(v.核心发现.Q3_资源怎么动))
    if total == 0:
        raise GateError("核心发现三组不能全空")

    return v


def model_gate(verdict: dict) -> ModelVerdict:
    """Step 4 守门"""
    try:
        v = ModelVerdict(**verdict)
    except Exception as e:
        raise GateError(f"Step 4 schema 失败: {e}")

    if not v.问题机型 and not v.机会机型:
        raise GateError("问题机型 和 机会机型 不能同时为空")
    if not v.机型规律.strip():
        raise GateError("机型规律不能为空")

    return v

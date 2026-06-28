"""Router 层：读 skill 元数据 → LLM 生成调用计划。

设计参考新架构图：用户请求 → Agent 层 → Router 层（本模块）→ Skill 层 → Review Gate → 交付
"""
__version__ = "0.1.0"

from .skill_loader import SkillMeta, load_skills
from .planner import CallPlan, plan_call

__all__ = ["SkillMeta", "load_skills", "CallPlan", "plan_call"]

"""Review Gate 层：业务输出对抗审查。

设计参考新架构图：用户请求 → Agent → Router → Skill → [Review Gate] → 交付

Review Gate 是输出类 Skill 的强制门：未通过 §6 自检的输出禁止交付给用户。
"""
__version__ = "0.1.0"

from .critic import review
from .verdict import CheckResult, Issue, Verdict

__all__ = ["review", "Verdict", "CheckResult", "Issue"]

"""品类名常量。

orchestrator/lib/monitor/ 独立维护,不跨 skill 依赖(避免中文字符串
"手表/腕表" "便携/无线音箱" 这种带斜杠特殊字符的品类名遍布代码)。

用途
----
仅用于:
  - IDE 提示(未来可加 Literal 类型)
  - 配置校验工具(可选,离线跑,不作 runtime 强制)

**不做 runtime 强制**:业务方在 `rules.perCategoryMinEvaUv` 里配置陌生品类名
不会报错(松散校验,符合 Postel's Law:"对内严格对外宽容"),自然降级到
`minEvaUvPct` → `minEvaUv` 兜底。

未来维护
----
业务方若在飞书表格里新增/改名品类,请同步这里的 KNOWN_CATEGORY_NAMES
(或做 migration 脚本从 raw 数据自动同步)。

作者:数据 Agent
最后更新:2026-07-04(spec monitor_noise_reduction 阶段 2 引入)
"""
from __future__ import annotations

# ============================================================
# 已知业务品类白名单
# 覆盖:
#   - 主品类(未来接入,当前 real_snapshot 未包含)
#   - 当前 data/real_snapshot 覆盖的 10 个品类
# ============================================================
KNOWN_CATEGORY_NAMES: frozenset[str] = frozenset({
    # 主品类(未来接入)
    "手机",
    "笔记本电脑",
    "台式主机",
    "iPad",
    # 当前 real_snapshot 覆盖(按 raw_*.json 文件名)
    "主板",
    "便携/无线音箱",
    "内存条",
    "台球杆",
    "手表/腕表",
    "打印机/复印机",
    "数码相机",
    "显卡",
    "显示器",
    "盲盒收纳",
})


def is_known_category(name: str) -> bool:
    """返回品类名是否在已知白名单里。

    仅供配置校验工具使用,**runtime 请勿基于此做拒绝**(松散校验)。
    """
    return name in KNOWN_CATEGORY_NAMES

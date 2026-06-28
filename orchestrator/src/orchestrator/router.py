"""轻量路由：LLM 决定派给哪个专家。MVP-1 阶段先走简单的关键词路由。"""
from __future__ import annotations

import re


EXPERTS = {
    "daily_analyst": {
        "name": "专家 A · 日常分析师",
        "keywords": ["周报", "月报", "汇报", "周汇报", "月汇报", "数据汇报", "活动复盘", "对比分析", "多维度", "拆解"],
    },
    "user_analyst": {
        "name": "专家 B · 用户分析师",
        "keywords": ["画像", "人群", "用户行为", "用户路径", "复购", "留存", "流失"],
    },
    "diagnostician": {
        "name": "专家 C · 诊断核验师",
        "keywords": ["为什么", "归因", "诊断", "原因", "异常", "波动", "异动", "实验", "ab 实验", "相关性"],
    },
}


def route(question: str) -> tuple[str, str]:
    """返回 (expert_id, reason)。MVP-1: 关键词匹配。"""
    q = question.lower()
    scores: dict[str, int] = {k: 0 for k in EXPERTS}
    matched_words: dict[str, list[str]] = {k: [] for k in EXPERTS}

    for eid, info in EXPERTS.items():
        for kw in info["keywords"]:
            if kw.lower() in q:
                scores[eid] += 1
                matched_words[eid].append(kw)

    best = max(scores, key=lambda x: scores[x])
    if scores[best] == 0:
        # 默认走 daily_analyst
        return "daily_analyst", "无明确关键词命中，默认派给日常分析师"
    return best, f"命中关键词 {matched_words[best]}"


def explain(expert_id: str) -> str:
    return EXPERTS[expert_id]["name"]

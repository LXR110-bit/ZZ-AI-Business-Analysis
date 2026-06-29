"""调 LLM 生成调用计划（call plan）。

中转站对 OpenAI SDK 的 x-stainless-* 头敏感（返回 502 upstream_error），
所以这里用 requests 直调 /v1/chat/completions，跟 curl 等价。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import requests

from .skill_loader import SkillMeta


SYSTEM_PROMPT = """你是品类数据分析系统的「Router」。

任务：读用户问题 + 所有可用 Skill 的元数据 → 输出 JSON「调用计划」。

输出严格 JSON（不要任何 markdown 装饰），格式：

{
  "intent": "用户问题的核心意图（≤ 30 字）",
  "skills": [
    {"name": "skill_name", "order": 1, "rationale": "为什么调这个"}
  ],
  "fallback": false,
  "uncertain": false,
  "notes": ""
}

规则：
1. order 从 1 开始，按执行先后递增
2. 一个 Skill 也用数组形式：[{...}]
3. 找不到合适 Skill → fallback=true，skills=[]，notes 写"用户问题不在已知能力范围"
4. 意图模糊 / 信息不足 → uncertain=true，notes 写"需要用户补充：xxx"
5. 不要凭印象编 Skill 名，只能从下面给的 Skill 列表里选
6. 如果是组合任务（如：先查再写文档），按依赖顺序列出多个 Skill
"""


@dataclass
class PlannedSkill:
    name: str
    order: int
    rationale: str


@dataclass
class CallPlan:
    intent: str
    skills: list[PlannedSkill]
    fallback: bool
    uncertain: bool
    notes: str
    raw: dict[str, Any]

    def to_json(self) -> str:
        return json.dumps({
            "intent": self.intent,
            "skills": [{"name": s.name, "order": s.order, "rationale": s.rationale} for s in self.skills],
            "fallback": self.fallback,
            "uncertain": self.uncertain,
            "notes": self.notes,
        }, ensure_ascii=False, indent=2)


def _format_skill_catalog(skills: list[SkillMeta]) -> str:
    lines = []
    for s in skills:
        line = f"- **{s.name}** ({s.category}): {s.description}"
        if s.trigger:
            line += f" | 触发：{s.trigger}"
        lines.append(line)
    return "\n".join(lines)


def _extract_json(text: str) -> dict:
    """从文本里抓最外层 JSON 对象（容错处理 markdown 围栏）."""
    text = text.strip()
    # 去 markdown 围栏
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
    return json.loads(text)


def plan_call(
    query: str,
    skills: list[SkillMeta],
    model: str = "gpt-5.4-mini",
    api_key: str | None = None,
    base_url: str | None = None,
    timeout: int = 120,
) -> CallPlan:
    """根据用户问题 + skill 元数据，让 LLM 生成调用计划。"""
    api_key = api_key or os.environ.get("OPENAI_API_KEY")
    base_url = base_url or os.environ.get("OPENAI_BASE_URL", "")
    if not api_key:
        raise RuntimeError("缺 OPENAI_API_KEY")
    if not base_url:
        raise RuntimeError("缺 OPENAI_BASE_URL")

    # 中转站约定：/v1/chat/completions
    endpoint = base_url.rstrip("/")
    if not endpoint.endswith("/v1"):
        endpoint += "/v1"
    endpoint += "/chat/completions"

    user_msg = f"""用户问题：
{query}

可用 Skill 列表：
{_format_skill_catalog(skills)}

请输出 JSON 调用计划。"""

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
    }

    resp = requests.post(
        endpoint,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )
    resp.raise_for_status()
    body = resp.json()

    content = body["choices"][0]["message"]["content"]
    raw = _extract_json(content)

    return CallPlan(
        intent=str(raw.get("intent", "")).strip(),
        skills=[
            PlannedSkill(
                name=str(s.get("name", "")),
                order=int(s.get("order", i + 1)),
                rationale=str(s.get("rationale", "")),
            )
            for i, s in enumerate(raw.get("skills", []))
        ],
        fallback=bool(raw.get("fallback", False)),
        uncertain=bool(raw.get("uncertain", False)),
        notes=str(raw.get("notes", "")),
        raw=raw,
    )

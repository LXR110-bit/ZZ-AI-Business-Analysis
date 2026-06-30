"""Critic 主函数：调中转站 LLM 对 agent 输出做对抗审查."""
from __future__ import annotations

import json
import os
from pathlib import Path

import requests

from .verdict import Verdict


PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"
CRITIC_SYSTEM_PROMPT_FILE = PROMPTS_DIR / "critic_system.md"


def _load_system_prompt() -> str:
    return CRITIC_SYSTEM_PROMPT_FILE.read_text(encoding="utf-8")


def _build_user_message(task: str, agent_output: str, principle_text: str) -> str:
    return f"""## 原始任务

{task}

---

## Agent 待审输出

{agent_output}

---

## 原则层（principles/core.md 全文）

{principle_text}

---

请按 §6 自检清单逐条评估，输出 JSON。"""


def _extract_json(text: str) -> dict:
    """容错抓 JSON：去 markdown 围栏 + 兼容空字符串."""
    text = (text or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        text = "\n".join(lines)
    if not text:
        return {}
    return json.loads(text)


def review(
    task: str,
    agent_output: str,
    principle_text: str,
    model: str = "gpt-5.5",
    api_key: str | None = None,
    base_url: str | None = None,
    timeout: int = 180,
) -> Verdict:
    """对抗审查 agent 输出。

    Args:
        task: 原始用户任务描述
        agent_output: agent 草稿输出（待审）
        principle_text: 原则层全文（principles/core.md）
        model: 审查模型（默认 gpt-5.5，需要强推理）
        api_key: OpenAI 兼容 API key；默认从 OPENAI_API_KEY env
        base_url: API base url；默认从 OPENAI_BASE_URL env，自动补 /v1
        timeout: HTTP 超时秒数

    Returns:
        Verdict 对象，含 passed / verdict / checks / issues
    """
    api_key = api_key or os.environ.get("OPENAI_API_KEY")
    base_url = base_url or os.environ.get("OPENAI_BASE_URL", "")
    if not api_key:
        raise RuntimeError("缺 OPENAI_API_KEY env var")
    if not base_url:
        raise RuntimeError("缺 OPENAI_BASE_URL env var")

    endpoint = base_url.rstrip("/")
    if not endpoint.endswith("/v1"):
        endpoint += "/v1"
    endpoint += "/chat/completions"

    system_prompt = _load_system_prompt()
    user_msg = _build_user_message(task, agent_output, principle_text)

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
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
    return Verdict.from_dict(raw)

"""CI AI Code Reviewer entry point.

每次 PR opened / synchronize 时，GitHub Action 调用本脚本：
  - 拉 PR 改动 diff（gh api）
  - 拼 prompt，调中转站 gpt-5.5（requests，不用 openai SDK）
  - 把审查结论作为一条 PR 评论留下（gh pr review --comment）

env 入口：
  - GITHUB_TOKEN       (Actions 自动注入)
  - GITHUB_REPOSITORY  (owner/repo)
  - PR_NUMBER          (PR 号)
  - OPENAI_API_KEY     (repo secret)
  - OPENAI_BASE_URL    (repo secret，不带 /v1，代码自动补)

仓库 secret 缺时 → 留 setup-hint 评论，exit 0；不阻断 workflow。
"""
from __future__ import annotations

import json

import requests


def extract_json(text: str) -> dict:
    """去 markdown 围栏并 parse JSON。空串返回 {}。

    中转站偶尔会把 JSON 包在 ```json ... ``` 里，即使 response_format=json_object。
    """
    text = (text or "").strip()
    if not text:
        return {}
    if text.startswith("```"):
        lines = text.split("\n")
        if lines and lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        text = "\n".join(lines).strip()
        if not text:
            return {}
    return json.loads(text)


def assemble_diff(files: list[dict], max_chars: int = 60_000) -> str:
    """渲染 PR 改动文件为单块 markdown，每个文件一个 fenced diff。

    - 二进制文件（无 `patch` 键）标 `(binary, skipped)`，不出 diff 围栏
    - 总长度超过 `max_chars` 时截断，并附 `[truncated, original was N chars]`
    """
    parts: list[str] = []
    for f in files:
        name = f.get("filename", "<unknown>")
        status = f.get("status", "modified")
        adds = f.get("additions", 0)
        dels = f.get("deletions", 0)
        header = f"### {name} ({status}, +{adds}/-{dels})"
        patch = f.get("patch")
        if patch is None:
            parts.append(f"{header}\n\n(binary, skipped)\n")
        else:
            parts.append(f"{header}\n\n```diff\n{patch}\n```\n")
    full = "\n".join(parts)
    if len(full) > max_chars:
        truncated = full[:max_chars]
        return f"{truncated}\n...[truncated, original was {len(full)} chars]"
    return full


SYSTEM_PROMPT = """你是严谨的工程 code reviewer。审查给定 PR 的代码 diff，输出结构化结论。

严苛 by design：宁可多报，也不要漏掉真问题；但不要无中生有，每条 finding 必须有 diff 中可定位的依据。

输出 JSON（不要 markdown 围栏）：
{
  "summary": "1-2 句概括 PR 的核心改动 + 总体评价",
  "findings": [
    {
      "severity": "BLOCKER|MAJOR|MINOR|NIT",
      "file": "相对路径",
      "line": "diff 中的行号或行号范围（hunk 里的 +N）",
      "category": "correctness|security|performance|readability|test|style",
      "why": "问题是什么，为什么有问题",
      "suggestion": "怎么改（可包含代码片段）"
    }
  ]
}

严重度定义：
- BLOCKER: 会导致功能错误、数据丢失、安全漏洞、生产事故
- MAJOR: 不会立即崩，但显著降低质量/可维护性/性能
- MINOR: 风格、命名、注释、轻微逻辑改进
- NIT: 可选优化

如果没有任何 finding，返回 `"findings": []`。
绝不输出空 summary。"""


def build_messages(pr_title: str, pr_body: str, diff_text: str) -> list[dict]:
    """拼 chat-completions 的 messages 数组（system + user）."""
    user = f"""## PR 标题

{pr_title}

## PR 描述

{pr_body or "(空)"}

## 改动 diff

{diff_text}
"""
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def call_llm(
    messages: list[dict],
    api_key: str,
    base_url: str,
    model: str = "gpt-5.5",
    timeout: int = 180,
) -> dict:
    """POST chat-completions 到中转站，返回解析过的 JSON dict。

    - 不走 openai SDK（SDK 加的 x-stainless-* 头会被中转站拒为 502）
    - base_url 自动补 /v1（idempotent）
    - response_format=json_object，temperature=0.0
    """
    if not api_key:
        raise RuntimeError("缺 OPENAI_API_KEY env var")
    if not base_url:
        raise RuntimeError("缺 OPENAI_BASE_URL env var")

    endpoint = base_url.rstrip("/")
    if not endpoint.endswith("/v1"):
        endpoint += "/v1"
    endpoint += "/chat/completions"

    payload = {
        "model": model,
        "messages": messages,
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
    content = resp.json()["choices"][0]["message"]["content"]
    return extract_json(content)


def main() -> int:
    raise NotImplementedError

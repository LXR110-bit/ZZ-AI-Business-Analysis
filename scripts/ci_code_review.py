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


def main() -> int:
    raise NotImplementedError

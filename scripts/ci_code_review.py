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


def main() -> int:
    raise NotImplementedError

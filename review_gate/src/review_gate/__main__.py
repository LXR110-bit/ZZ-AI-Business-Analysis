"""CLI: python -m review_gate --task "..." --output @file --principles principles/core.md"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .critic import review


def _read_input(value: str) -> str:
    """支持 @filename 引用文件内容."""
    if value.startswith("@"):
        return Path(value[1:]).read_text(encoding="utf-8")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Review Gate CLI - 业务输出对抗审查")
    parser.add_argument("--task", required=True, help='原始用户任务（或 @file 引用文件）')
    parser.add_argument("--output", required=True, help='Agent 待审输出（或 @file）')
    parser.add_argument("--principles", required=True, help="原则层文件路径，如 principles/core.md")
    parser.add_argument("--model", default="gpt-5.5", help="审查模型（默认 gpt-5.5）")
    args = parser.parse_args()

    task = _read_input(args.task)
    agent_output = _read_input(args.output)
    principle_text = Path(args.principles).read_text(encoding="utf-8")

    verdict = review(task, agent_output, principle_text, model=args.model)
    print(verdict.to_json())
    sys.exit(0 if verdict.passed else 1)


if __name__ == "__main__":
    main()

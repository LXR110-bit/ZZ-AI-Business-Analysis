"""CLI 入口：调试用，直接命令行触发 agent 工作流。"""
from __future__ import annotations

import argparse
import sys

from . import router
from .expert_runner import run_expert


def main() -> None:
    parser = argparse.ArgumentParser(description="ZZ Agent 工作流 CLI")
    parser.add_argument("question", help="用户问题")
    parser.add_argument("--expert", help="强制指定专家（不走路由）")
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    if args.expert:
        expert_id = args.expert
        reason = "强制指定"
    else:
        expert_id, reason = router.route(args.question)

    print(f"━━━ 路由 ━━━", file=sys.stderr)
    print(f"  专家: {router.explain(expert_id)}", file=sys.stderr)
    print(f"  原因: {reason}", file=sys.stderr)
    print(f"━━━ 启动专家 ━━━", file=sys.stderr)

    result = run_expert(expert_id, args.question, timeout=args.timeout)

    print(f"━━━ 完成 ({result.get('duration_sec', '?')}s) ━━━", file=sys.stderr)
    print(result["stdout"])
    if not result["ok"]:
        print("--- STDERR ---", file=sys.stderr)
        print(result["stderr"], file=sys.stderr)
        sys.exit(result.get("exit_code", 1))


if __name__ == "__main__":
    main()

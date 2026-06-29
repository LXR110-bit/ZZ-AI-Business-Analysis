"""CLI：python -m router "<用户问题>"

会输出 JSON 调用计划到 stdout，调试用。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .planner import plan_call
from .skill_loader import load_skills


def main() -> None:
    parser = argparse.ArgumentParser(description="Router CLI - 出调用计划")
    parser.add_argument("query", help="用户问题")
    parser.add_argument(
        "--repo-root",
        default=str(Path(__file__).resolve().parents[3]),
        help="仓库根目录（默认：自动检测）",
    )
    parser.add_argument("--model", default="gpt-5.4-mini", help="路由用的模型")
    parser.add_argument("--list-skills", action="store_true", help="只列 skill 不调 LLM")
    args = parser.parse_args()

    skills = load_skills(args.repo_root)

    if args.list_skills:
        print(f"扫到 {len(skills)} 个 Skill：", file=sys.stderr)
        for s in skills:
            print(f"  [{s.category:18s}] {s.name:30s} - {s.description[:60]}")
        return

    if not skills:
        print('{"error": "未扫描到任何 Skill"}', file=sys.stdout)
        sys.exit(2)

    plan = plan_call(args.query, skills, model=args.model)
    print(plan.to_json())


if __name__ == "__main__":
    main()

"""周报监测 CLI 入口:一条命令跑完整条链。

用法示例
--------
# 机型维度,自动挑最近一周做 target,dry_run 推送
python -m orchestrator.lib.monitor.cli run --dimension model

# 品类维度,指定目标周
python -m orchestrator.lib.monitor.cli run --dimension category --target-week 2025-W27

# 只输出到磁盘,不推送
python -m orchestrator.lib.monitor.cli run --dimension model --no-push

# 输出:
#   data/monitor_output/{dimension}_{week}.json   (供前端读)
#   data/outbox/{dimension}_{week}_{ts}.json      (dry_run 推送记录)

作者:Kiro
最后更新:2025-07-04
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Tuple

from .agent_hook import analyze_anomaly_with_agent
from .fetcher import fetch_funnel_data
from .pusher import build_report, push_to_feishu
from .rules import apply_rules, load_rules_from_file
from .schemas import MonitorRules
from .wave import compute_wave


logger = logging.getLogger("monitor.cli")


def _resolve_target_and_prev(
    rows,
    target_week_override: Optional[str],
) -> Tuple[str, Optional[str]]:
    """从 rows 里的可用周次确定 (target_week, prev_week)。"""
    all_weeks = sorted({r.week for r in rows})
    if not all_weeks:
        raise SystemExit("❌ 没有可用的周数据")

    if target_week_override:
        if target_week_override not in all_weeks:
            raise SystemExit(
                f"❌ target-week {target_week_override} 不在数据中,可用:{all_weeks}"
            )
        target = target_week_override
    else:
        target = all_weeks[-1]

    idx = all_weeks.index(target)
    prev = all_weeks[idx - 1] if idx > 0 else None
    return target, prev


def _dump_monitor_output(
    monitor_result,
    dimension: str,
    out_dir: Path,
) -> Path:
    """把 MonitorResult 序列化到 data/monitor_output/,供前端读。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{dimension}_{monitor_result.target_week}.json"
    payload = {
        "generated_at": datetime.now().isoformat(),
        "dimension": dimension,
        **monitor_result.model_dump(by_alias=True),
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return path


def cmd_run(args: argparse.Namespace) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # ① 规则
    if args.rules_file:
        rules = load_rules_from_file(Path(args.rules_file), fallback_to_default=True)
        logger.info("规则来自 %s: waveThreshold=%.2f", args.rules_file, rules.waveThreshold)
    else:
        rules = MonitorRules()

    # ② 拉数
    week_range = tuple(args.week_range.split(","))  # type: ignore[assignment]
    if len(week_range) != 2:
        raise SystemExit("❌ --week-range 需要 'start,end' 两个周次")
    logger.info("拉取 %s 维度 %s..%s", args.dimension, week_range[0], week_range[1])
    rows = fetch_funnel_data(args.dimension, week_range)  # type: ignore[arg-type]
    logger.info("拉到 %d 行", len(rows))

    # ③ target / prev
    target, prev = _resolve_target_and_prev(rows, args.target_week)
    logger.info("目标周 %s, 参考周 %s", target, prev)

    # ④ 计算 & 规则
    waves, weeks = compute_wave(rows, target, prev, rules)
    monitor_result = apply_rules(waves, weeks, target, prev, rules)
    logger.info(
        "pool=%d watch=%d",
        len(monitor_result.pool),
        len(monitor_result.watch_list),
    )

    # ⑤ 落盘(给前端)
    out_path = _dump_monitor_output(
        monitor_result,
        args.dimension,
        Path(args.output_dir),
    )
    logger.info("MonitorResult → %s", out_path)

    # ⑥ AI 归因
    explanations = analyze_anomaly_with_agent(
        monitor_result.watch_list, top_k=args.top_k
    )
    logger.info("归因假设 %d 条", len(explanations))

    # ⑦ 推送
    if args.no_push:
        logger.info("--no-push,跳过推送")
        return 0

    report = build_report(
        monitor_result=monitor_result,
        explanations=explanations,
        dimension=args.dimension,
        dashboard_url=args.dashboard_url,
        report_url=args.report_url,
        top_anomalies_k=args.top_k,
    )
    push_result = push_to_feishu(
        report,
        chat_id=args.chat_id,
        dry_run=args.dry_run,
        outbox_dir=Path(args.outbox_dir) if args.outbox_dir else None,
    )
    logger.info("推送结果: %s", push_result)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="monitor",
        description="周报监测 CLI",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("run", help="跑一次完整监测")
    p.add_argument(
        "--dimension",
        choices=["model", "category"],
        required=True,
        help="监测维度",
    )
    p.add_argument(
        "--week-range",
        default="2025-W01,2025-W99",
        help="拉数周窗,格式 start,end(默认拉所有)",
    )
    p.add_argument(
        "--target-week",
        default=None,
        help="目标周,不填则用数据中最新一周",
    )
    p.add_argument(
        "--rules-file",
        default=None,
        help="规则 JSON 文件路径(部分覆盖默认规则)",
    )
    p.add_argument(
        "--output-dir",
        default="data/monitor_output",
        help="MonitorResult JSON 输出目录",
    )
    p.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="归因和推送时展示的 top K 异常",
    )
    p.add_argument(
        "--dashboard-url",
        default="https://example.com/dashboard",
        help="卡片跳转看板 URL",
    )
    p.add_argument(
        "--report-url",
        default=None,
        help="PDF 报告 URL(可选)",
    )
    p.add_argument(
        "--chat-id",
        default=None,
        help="飞书群 open_chat_id",
    )
    p.add_argument(
        "--no-push",
        action="store_true",
        help="跳过推送,只落盘",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        default=None,
        help="强制 dry_run(默认走环境变量 FEISHU_DRY_RUN)",
    )
    p.add_argument(
        "--outbox-dir",
        default=None,
        help="dry_run 输出目录",
    )
    p.set_defaults(func=cmd_run)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())

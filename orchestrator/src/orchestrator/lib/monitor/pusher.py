"""飞书推送出口:把 MonitorReport 推到飞书群。

**当前版本状态**:MOCK / DRY-RUN 实现。
真实版会调 tools/feishu_push/send_card.py 的 push_card(),但该 tool 目前由
飞书推送 Agent 独立开发中(见 docs/superpowers/handoffs/feishu_push_agent_bootstrap.md)。

策略:
- 默认 dry_run 模式:把 payload 序列化到 data/outbox/{dimension}_{week}_{ts}.json
- 环境变量 `FEISHU_DRY_RUN=0` 才会尝试真实推送
- 真实版接口预留 _real_push(),先抛 NotImplementedError

作者:Kiro
最后更新:2025-07-04
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .schemas import (
    AnomalyExplanation,
    MonitorPushError,
    MonitorReport,
    MonitorReportSummary,
    MonitorResult,
    WaveResultWithFlags,
)

logger = logging.getLogger(__name__)


# ============================================================
# Report 构造:MonitorResult + 归因 → MonitorReport
# ============================================================


def build_report(
    monitor_result: MonitorResult,
    explanations: List[AnomalyExplanation],
    dimension: str,
    dashboard_url: str,
    report_url: Optional[str] = None,
    top_anomalies_k: int = 5,
) -> MonitorReport:
    """把算法输出打包成飞书推送用的 MonitorReport。

    参数
    ----
    monitor_result: apply_rules 的输出
    explanations: analyze_anomaly_with_agent 的输出
    dimension: "model" 或 "category"
    dashboard_url: 完整看板 URL(卡片按钮跳转)
    report_url: 可选,PDF 报告 URL
    top_anomalies_k: 推送卡片里最多展示几个异常
    """
    watch = monitor_result.watch_list
    rising = _count_direction(watch, "up")
    falling = _count_direction(watch, "down")
    summary = MonitorReportSummary(
        total_dims=len(monitor_result.pool),
        watch_count=len(watch),
        rising_count=rising,
        falling_count=falling,
    )

    return MonitorReport(
        dimension=dimension,  # type: ignore[arg-type]
        week=monitor_result.target_week,
        summary=summary,
        top_anomalies=explanations[:top_anomalies_k],
        dashboard_url=dashboard_url,
        report_url=report_url,
    )


def _count_direction(
    watch: List[WaveResultWithFlags],
    direction: str,
) -> int:
    """统计 watchList 里含指定方向 flag 的机型数(去重)。

    一个机型有多个 down flag 也只算一次。
    """
    count = 0
    for w in watch:
        for f in w.flags:
            if f.type == "wave" and f.delta is not None:
                d = "up" if f.delta > 0 else "down"
                if d == direction:
                    count += 1
                    break
            elif f.type == "trend" and f.direction == direction:
                count += 1
                break
    return count


# ============================================================
# 推送入口
# ============================================================


def push_to_feishu(
    report: MonitorReport,
    chat_id: Optional[str] = None,
    dry_run: Optional[bool] = None,
    outbox_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """推送 MonitorReport 到飞书群。

    参数
    ----
    report: 待推送报告
    chat_id: 飞书群 open_chat_id(真实推送时必填,dry_run 时可空)
    dry_run: 强制模式;None = 走环境变量 FEISHU_DRY_RUN,默认 True
    outbox_dir: dry_run 输出目录,默认 data/outbox

    返回
    ----
    {"ok": bool, "mode": "dry_run" | "real", "outbox_path": ... | "message_id": ...}

    异常
    ----
    MonitorPushError:真实推送失败
    """
    if dry_run is None:
        dry_run = os.environ.get("FEISHU_DRY_RUN", "1") == "1"

    if dry_run:
        return _dry_run_dump(report, outbox_dir)
    return _real_push(report, chat_id)


def _dry_run_dump(
    report: MonitorReport,
    outbox_dir: Optional[Path] = None,
) -> Dict[str, Any]:
    """把 MonitorReport 序列化到 outbox 目录,不真发消息。"""
    outbox = Path(outbox_dir) if outbox_dir else Path("data/outbox")
    outbox.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"{report.dimension}_{report.week}_{ts}.json"
    path = outbox / filename

    payload = {
        "report": report.model_dump(),
        "meta": {
            "generated_at": datetime.now().isoformat(),
            "mode": "dry_run",
        },
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    logger.info("[dry_run] MonitorReport dumped → %s", path)
    return {"ok": True, "mode": "dry_run", "outbox_path": str(path)}


def _real_push(
    report: MonitorReport,
    chat_id: Optional[str],
) -> Dict[str, Any]:
    """真实推送:调 tools/feishu_push/send_card.py。

    当前未实现,阻塞项:
    - tools/feishu_push/send_card.py 的 push_card() 由飞书推送 Agent 交付
    - 飞书群 chat_id / webhook 由用户提供
    """
    if not chat_id:
        raise MonitorPushError("chat_id 缺失,无法真实推送")
    raise NotImplementedError(
        "tools/feishu_push/send_card.push_card 尚未接入。"
        "使用 FEISHU_DRY_RUN=1 (默认) 走 dry_run。"
    )


__all__ = ["build_report", "push_to_feishu"]

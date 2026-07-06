"""按月发富文本 post 到群 (WEEKLY_REPORT_CHAT_ID)."""
from __future__ import annotations
import os
from .constants import DAILY_AVG_WIKI_NODES
from .lark_helper import im_send_post

WIKI_PREFIX = "https://zhuanspirit.feishu.cn/wiki/"


def _wiki_url(month: str) -> str | None:
    node = DAILY_AVG_WIKI_NODES.get(month)
    return WIKI_PREFIX + node if node else None


def notify(months: list[str], zip_names: list[str], by_month_stats: dict) -> None:
    """按覆盖的月份发一条 post 消息, 附各月日均表链接."""
    chat_id = os.environ.get("WEEKLY_REPORT_CHAT_ID")
    if not chat_id:
        raise RuntimeError("WEEKLY_REPORT_CHAT_ID not set")

    months_sorted = sorted(months)
    weeks = set()
    inserted_total = 0
    failed_tabs: list[str] = []
    for m in months_sorted:
        mstat = by_month_stats.get(m, {})
        for w in mstat.get("weeks", []):
            weeks.add(w)
        for sid, tab_stats in mstat.get("tabs", {}).items():
            summary = tab_stats.get("summary", {}) or {}
            avg = tab_stats.get("daily_avg", {}) or {}
            if isinstance(summary, dict) and summary.get("status") == "error":
                failed_tabs.append(f"{m}/summary/{sid}")
            if isinstance(avg, dict) and avg.get("status") == "error":
                failed_tabs.append(f"{m}/daily/{sid}")
            inserted_total += avg.get("inserted_rows", 0) if isinstance(avg, dict) else 0
    weeks_label = " / ".join(sorted(weeks))
    months_label = ", ".join(months_sorted)

    title = f"【机型周数据 已更新】" if not failed_tabs else f"【机型周数据 部分更新】"
    lines = [
        f"覆盖月份: {months_label}",
        f"涉及周: {weeks_label}",
        f"数据源 zip: {len(zip_names)} 份",
        f"日均表(周日均)行数(合计): {inserted_total}",
    ]
    if failed_tabs:
        lines.append("")
        lines.append(f"⚠️ 失败 tab: {len(failed_tabs)}")
        for t in failed_tabs:
            lines.append(f"  - {t}")
    lines.append("")
    lines.append("各月日均表:")
    for m in months_sorted:
        url = _wiki_url(m)
        if url:
            lines.append(f"  {m}: {url}")
    im_send_post(chat_id, title=title, content_lines=lines)

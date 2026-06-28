"""MCP server: data_tools (stdio)."""
from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from . import analysis, email_reader

mcp = FastMCP("data_tools")


# === Email tools ===

@mcp.tool()
def list_emails(
    subject_contains: str | None = None,
    sender: str | None = None,
    since: str | None = None,
    max_results: int = 20,
) -> list[dict]:
    """列出匹配的邮件（按主题/发件人/日期）。

    参数:
        subject_contains: 主题包含的关键词，如 "[Agent数据][周报][iPhone]"
        sender: 发件人邮箱
        since: 起始日期 'YYYY-MM-DD'
        max_results: 最大返回数
    """
    items = email_reader.list_emails(
        subject_contains=subject_contains,
        sender=sender,
        since=since,
        max_results=max_results,
    )
    return [
        {
            "uid": e.uid,
            "subject": e.subject,
            "sender": e.sender,
            "date": e.date,
            "attachments": e.attachments,
        }
        for e in items
    ]


@mcp.tool()
def download_attachment(uid: str, attachment_name: str) -> dict:
    """下载指定邮件的指定附件，返回本地路径。"""
    path = email_reader.download_attachment(uid, attachment_name)
    return {"file_path": path, "name": attachment_name, "uid": uid}


# === Analysis atoms ===

@mcp.tool()
def parse_csv(file_path: str) -> dict:
    """解析 CSV 文件，返回 schema + 前 10 行预览。"""
    return analysis.parse_csv(file_path)


@mcp.tool()
def split_dimension(file_path: str, by: str, metric: str, agg: str = "sum") -> dict:
    """按维度拆解指标。

    参数:
        file_path: CSV 路径
        by: 拆解维度（列名）
        metric: 指标（列名）
        agg: 聚合方式 sum/mean/count
    """
    return analysis.split_dimension(file_path, by, metric, agg)


@mcp.tool()
def calc_caliber(
    file_path: str,
    metric: str,
    period_col: str,
    current_period: str,
    compare_period: str,
    label: str = "环比",
) -> dict:
    """计算同比/环比。"""
    return analysis.calc_caliber(
        file_path, metric, period_col, current_period, compare_period, label
    )


@mcp.tool()
def match_framework(question: str) -> dict:
    """匹配适用的分析框架（参考原则层 §1-§5）。"""
    return analysis.match_framework(question)


@mcp.tool()
def get_case(question: str, similarity_threshold: float = 0.7) -> dict:
    """从历史案例库找相似案例（MVP-1 stub）。"""
    return analysis.get_case(question, similarity_threshold)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

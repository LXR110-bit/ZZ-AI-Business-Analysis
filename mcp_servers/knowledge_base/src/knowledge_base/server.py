"""MCP server: knowledge_base (stdio)."""
from __future__ import annotations

import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("knowledge_base")

KB_ROOT = Path(__file__).resolve().parents[4] / "knowledge"


@mcp.tool()
def query_metric(name: str) -> dict:
    """查指标口径表（GMV/UV/转化率等的定义）。

    MVP-1：从本地 knowledge/metrics_dictionary.md 解析。
    """
    f = KB_ROOT / "metrics_dictionary.md"
    if not f.exists():
        return {"name": name, "found": False, "note": "指标口径表未初始化"}
    content = f.read_text(encoding="utf-8")
    sections = content.split("## ")
    for sec in sections:
        if sec.lstrip().lower().startswith(name.lower()):
            return {"name": name, "found": True, "definition": sec.strip()}
    return {"name": name, "found": False, "available": [
        s.split("\n", 1)[0].strip() for s in sections if s.strip()
    ][:20]}


@mcp.tool()
def get_framework(scenario: str) -> dict:
    """查分析框架库（按场景）。MVP-1：返回原则层引导。"""
    return {
        "scenario": scenario,
        "frameworks": [
            "§1 三层穿透", "§2 生命周期×阈值", "§3 价值链瓶颈",
            "§4 异动诊断四问", "§5 动作闭环",
        ],
        "note": "MVP-1 阶段建议直接读 principles/core.md 获取详细内容；MVP-2 会拆分到 knowledge/frameworks/",
    }


@mcp.tool()
def get_baseline(category: str, metric: str) -> dict:
    """查品类基线表（健康水位值）。MVP-1 stub。"""
    return {
        "category": category,
        "metric": metric,
        "baseline": None,
        "note": "MVP-1 stub - 品类基线表待品类运营贡献后接入",
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

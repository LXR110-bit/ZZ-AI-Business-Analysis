"""MCP server: knowledge_base — 查飞书 base 知识库（4 张表）。

source of truth：飞书 base `N6OVb2qz5aKxf9sY9kRc7y6onYd`
- tbl1hVd85juddTNY  04.口径表（业务问题 → SQL 片段）
- tblWdOaeJzyxWdOe  02.字段表（字段类型 / 坑点）
- tblJ6CSz02t6NIaI  03.维值表（枚举值 → 业务含义）
- tblftpX7cOIusYmF  01.底表清单（Hive 物理表）

git 里的 wiki_seed/*.json 是镜像备份，不是 source of truth。
"""
from __future__ import annotations

import json
import subprocess

from mcp.server.fastmcp import FastMCP


mcp = FastMCP("knowledge_base")

BASE_TOKEN = "N6OVb2qz5aKxf9sY9kRc7y6onYd"
TABLE_DEFINITIONS = "tbl1hVd85juddTNY"   # 04 口径表
TABLE_FIELDS = "tblWdOaeJzyxWdOe"        # 02 字段表
TABLE_DIM_VALUES = "tblJ6CSz02t6NIaI"    # 03 维值表
TABLE_TABLES = "tblftpX7cOIusYmF"        # 01 底表清单

# 各表的搜索字段名（对应飞书表里的中文列名）
# ⚠ 业务方在飞书改这些列名时，记得同步改下面
SEARCH_FIELD_DEFINITION = "口径名"     # 04 表
SEARCH_FIELD_FIELD = "字段名"           # 02 表
SEARCH_FIELD_DIM_VALUE = "业务含义"     # 03 表
SEARCH_FIELD_TABLE = "中文名"            # 01 表


def _lark_search(table_id: str, keyword: str, search_field: str, limit: int = 10) -> dict:
    """统一封装：调 lark-cli base +record-search，返回 dict.

    捕获所有 subprocess 异常（含 TimeoutExpired），不抛给上层 MCP。
    """
    try:
        proc = subprocess.run(
            [
                "lark-cli", "base", "+record-search",
                "--as", "bot",
                "--base-token", BASE_TOKEN,
                "--table-id", table_id,
                "--keyword", keyword,
                "--search-field", search_field,
                "--limit", str(limit),
                "--format", "json",
            ],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "lark-cli 超时（30s）"}
    except FileNotFoundError:
        return {"ok": False, "error": "lark-cli 未安装"}
    except Exception as e:
        return {"ok": False, "error": f"lark-cli 调用异常: {type(e).__name__}: {e}"}

    if proc.returncode != 0:
        return {"ok": False, "error": "lark-cli 调用失败", "stderr": proc.stderr[:500]}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": "lark-cli 返回非 JSON", "raw": proc.stdout[:500]}


@mcp.tool()
def query_metric(name: str) -> dict:
    """查指标口径定义（如 GMV、UV、转化率、Push 触达 等）。

    source: 飞书 base 04 口径表。
    返回最多 5 条匹配，含口径名、业务描述、SQL 片段、备注。
    """
    result = _lark_search(TABLE_DEFINITIONS, name, SEARCH_FIELD_DEFINITION, limit=5)
    return {
        "metric": name,
        "source": "飞书 base 04 口径表",
        **result,
    }


@mcp.tool()
def query_field(name: str) -> dict:
    """查字段定义（如 uid、order_amount、push_status 等）。

    source: 飞书 base 02 字段表。
    返回字段类型、所属底表、是否主键、坑点备注。
    """
    result = _lark_search(TABLE_FIELDS, name, SEARCH_FIELD_FIELD, limit=5)
    return {
        "field": name,
        "source": "飞书 base 02 字段表",
        **result,
    }


@mcp.tool()
def query_dim_value(value_or_meaning: str) -> dict:
    """查枚举值的业务含义（如 order_state=80 → 已成交）。

    source: 飞书 base 03 维值表。
    """
    result = _lark_search(TABLE_DIM_VALUES, value_or_meaning, SEARCH_FIELD_DIM_VALUE, limit=5)
    return {
        "query": value_or_meaning,
        "source": "飞书 base 03 维值表",
        **result,
    }


@mcp.tool()
def query_table(name: str) -> dict:
    """查 Hive 底表信息（更新频率、分区策略、中文名）。

    source: 飞书 base 01 底表清单。
    """
    result = _lark_search(TABLE_TABLES, name, SEARCH_FIELD_TABLE, limit=5)
    return {
        "table": name,
        "source": "飞书 base 01 底表清单",
        **result,
    }


@mcp.tool()
def get_framework(scenario: str) -> dict:
    """查分析框架（按场景）。

    framework 暂仍在 principles/core.md，未来可挪到飞书 wiki。
    返回原则层引导。
    """
    return {
        "scenario": scenario,
        "frameworks": [
            "§1 三层穿透", "§2 生命周期×阈值", "§3 价值链瓶颈",
            "§4 异动诊断四问", "§5 动作闭环",
        ],
        "note": "framework 内容详见 principles/core.md（未来或迁飞书 wiki）",
    }


@mcp.tool()
def get_baseline(category: str, metric: str) -> dict:
    """查品类基线水位（按品类 + 指标）。

    暂未在飞书 base 建表，stub。等业务方贡献基线表后接入。
    """
    return {
        "category": category,
        "metric": metric,
        "baseline": None,
        "note": "品类基线表待业务方建表后接入；当前不可查",
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

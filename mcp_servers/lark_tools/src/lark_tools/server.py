"""MCP server: lark_tools (stdio). 包 lark-cli 的常用操作。"""
from __future__ import annotations

import json
import subprocess

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("lark_tools")


def _run_lark(args: list[str]) -> dict:
    """跑 lark-cli，强制 --json 输出，解析返回。"""
    cmd = ["lark-cli"] + args
    if "--json" not in args and "--format" not in args:
        cmd.append("--json")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        return {
            "ok": False,
            "error": "lark-cli 调用失败",
            "stderr": proc.stderr[:2000],
            "stdout": proc.stdout[:2000],
            "cmd": " ".join(cmd),
        }
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": True, "raw": proc.stdout}


@mcp.tool()
def send_im(receive_id: str, text: str, receive_id_type: str = "open_id") -> dict:
    """发飞书 IM 文本消息（bot 身份）。

    参数:
        receive_id: 目标 ID（open_id / chat_id / email / user_id / union_id）
        text: 文本内容
        receive_id_type: open_id / chat_id / email / user_id / union_id
    """
    return _run_lark([
        "im", "+send-text",
        "--receive-id", receive_id,
        "--receive-id-type", receive_id_type,
        "--text", text,
    ])


@mcp.tool()
def write_doc(title: str, content_markdown: str, parent_token: str | None = None) -> dict:
    """在飞书创建一篇 Markdown 文档。

    参数:
        title: 文档标题（CLI 会自动作为 H1 加到正文前）
        content_markdown: Markdown 正文
        parent_token: 目标文件夹 token 或 wiki 节点 token；不填则放云空间根目录
    """
    args = [
        "docs", "+create",
        "--title", title,
        "--doc-format", "markdown",
        "--content", content_markdown,
    ]
    if parent_token:
        args += ["--parent-token", parent_token]
    return _run_lark(args)


@mcp.tool()
def read_wiki_node(node_token: str) -> dict:
    """读飞书知识库节点元信息。"""
    return _run_lark(["wiki", "+node-get", "--token", node_token])


@mcp.tool()
def list_wiki_children(parent_node_token: str) -> dict:
    """列知识库节点下的子节点。"""
    return _run_lark(["wiki", "+node-list", "--parent-node-token", parent_node_token])


@mcp.tool()
def fetch_doc(doc_token: str) -> dict:
    """读取飞书文档内容。"""
    return _run_lark(["docs", "+fetch", "--token", doc_token])


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()

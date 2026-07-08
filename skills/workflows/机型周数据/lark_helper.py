"""薄的 lark-cli subprocess 封装:统一 --as bot、JSON 解析、错误抛错."""
from __future__ import annotations
import json
import os
import subprocess
import time
from typing import Any


class LarkError(RuntimeError):
    pass


LARK_CLI_TIMEOUT = int(os.environ.get("LARK_CLI_TIMEOUT", "90"))


def run_lark(*args: str, as_identity: str = "bot") -> dict[str, Any]:
    """跑 lark-cli, 返回 data dict (或抛 LarkError). lark-cli 出错时把 JSON 写到 stderr."""
    cmd = ["lark-cli", *args, "--as", as_identity]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=LARK_CLI_TIMEOUT)
    except subprocess.TimeoutExpired as e:
        raise LarkError(f"{args[:3]} timed out after {LARK_CLI_TIMEOUT}s") from e
    payload = r.stdout if r.stdout and "{" in r.stdout else r.stderr
    try:
        j = json.loads(payload[payload.index("{"):])
    except (ValueError, json.JSONDecodeError) as e:
        raise LarkError(f"non-json output from {args[:2]}: stdout={r.stdout[:200]} stderr={r.stderr[:200]}") from e
    if not j.get("ok", False):
        err = j.get("error", {}).get("message", "?")
        raise LarkError(f"{args[:3]} failed: {err}")
    return j.get("data", {})


def _is_transient_lark_error(e: Exception) -> bool:
    msg = str(e).lower()
    return (
        "timeout" in msg
        or "network error" in msg
        or "1204" in msg
        or "429" in msg
        or "rate" in msg
        or "server_error" in msg
        or "20050" in msg
        or "invalid json response" in msg
        or "601125300" in msg
    )


def _read_retry(fn, attempts: int = 2):
    last_err: Exception | None = None
    for attempt in range(attempts):
        try:
            return fn()
        except LarkError as e:
            last_err = e
            if _is_transient_lark_error(e):
                time.sleep(3 * (attempt + 1))
                continue
            raise
    if last_err:
        raise last_err


def sheets_workbook_info(token: str) -> list[dict[str, Any]]:
    """返回子 sheet 列表."""
    d = _read_retry(lambda: run_lark("sheets", "+workbook-info", "--spreadsheet-token", token))
    return d.get("sheets", [])


def sheets_csv_get(token: str, sheet_id: str, range_: str) -> str:
    """读一个 range 的 annotated_csv 字符串."""
    d = _read_retry(lambda: run_lark("sheets", "+csv-get", "--spreadsheet-token", token, "--sheet-id", sheet_id, "--range", range_))
    return d.get("annotated_csv", "")


def sheets_last_data_row(token: str, sheet_id: str, header_col_range: str = "A2:A") -> int:
    """探测 sheet 里最后一行有值的行号 (1-based, header 假定在第 1 行)."""
    # 简化:直接 workbook-info 拿 row_count 里首列非空的最大 row
    # A2:A 是从第 2 行到底部
    csv = sheets_csv_get(token, sheet_id, "A1:A")
    last = 1
    for line in csv.splitlines():
        # [row=N] value
        if not line.startswith("[row="):
            continue
        n_str, _, rest = line[len("[row="):].partition("] ")
        try:
            n = int(n_str)
        except ValueError:
            continue
        if rest.strip():
            last = max(last, n)
    return last


def sheets_dim_insert(token: str, sheet_id: str, position: int, count: int) -> None:
    run_lark(
        "sheets", "+dim-insert",
        "--spreadsheet-token", token, "--sheet-id", sheet_id,
        "--position", str(position), "--count", str(count),
    )


def sheets_cells_set(token: str, sheet_id: str, range_: str, cells_2d: list[list[dict[str, Any]]]) -> None:
    """cells_2d 是 [[{value: ...}, ...], ...] 结构."""
    payload = json.dumps(cells_2d, ensure_ascii=False)
    run_lark(
        "sheets", "+cells-set",
        "--spreadsheet-token", token, "--sheet-id", sheet_id,
        "--range", range_, "--cells", payload,
    )




def sheets_cells_clear(token: str, sheet_id: str, range_: str) -> None:
    """清空一个 range 的 cell 值+样式 (高危, 加 --yes 自动确认)."""
    run_lark(
        "sheets", "+cells-clear", "--yes",
        "--spreadsheet-token", token, "--sheet-id", sheet_id,
        "--range", range_,
    )



def sheets_dim_delete(token: str, sheet_id: str, range_: str) -> None:
    """删除行/列范围 (高危, 加 --yes 自动确认). range_ 如 "5:100" 或 "C:F"."""
    run_lark(
        "sheets", "+dim-delete", "--yes",
        "--spreadsheet-token", token, "--sheet-id", sheet_id,
        "--range", range_,
    )

def sheets_csv_put(token: str, sheet_id: str, start_cell: str, csv_text: str) -> None:
    """用 csv-put 追加,更省 payload."""
    try:
        r = subprocess.run(
            ["lark-cli", "sheets", "+csv-put", "--as", "bot",
             "--spreadsheet-token", token, "--sheet-id", sheet_id,
             "--start-cell", start_cell, "--csv", "-"],
            input=csv_text, capture_output=True, text=True, timeout=LARK_CLI_TIMEOUT,
        )
    except subprocess.TimeoutExpired as e:
        raise LarkError(f"csv-put timed out after {LARK_CLI_TIMEOUT}s") from e
    payload = r.stdout if r.stdout and "{" in r.stdout else r.stderr
    try:
        j = json.loads(payload[payload.index("{"):])
    except (ValueError, json.JSONDecodeError) as e:
        raise LarkError(f"csv-put non-json: stdout={r.stdout[:200]} stderr={r.stderr[:200]}") from e
    if not j.get("ok", False):
        err = j.get("error", {}).get("message", "?")
        raise LarkError(f"csv-put failed: {err}")


def im_send_post(chat_id: str, title: str, content_lines: list[str]) -> None:
    """发富文本群消息."""
    content = [[{"tag": "text", "text": line}] for line in content_lines]
    post = {"zh_cn": {"title": title, "content": content}}
    run_lark(
        "im", "+messages-send",
        "--chat-id", chat_id,
        "--msg-type", "post", "--content", json.dumps(post, ensure_ascii=False),
    )


def col_letter(n: int) -> str:
    r = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        r = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[rem] + r
    return r

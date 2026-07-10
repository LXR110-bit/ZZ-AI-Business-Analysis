"""飞书交互式卡片推送 CLI + 库.

用法(CLI)::

    python -m tools.feishu_push.send_card \\
        --template monitor_weekly \\
        --payload examples/example_monitor_payload.json \\
        --chat-id oc_xxx           # 或 --webhook-url / --open-id
        --dry-run

用法(库)::

    from tools.feishu_push.send_card import push_card

    result = push_card(
        template="monitor_weekly",
        payload={...},
        chat_id="oc_xxx",
        dry_run=False,
        fallback=True,
    )
    # -> {"status": "sent"|"outbox", "message_id": str|None,
    #     "fallback_used": bool, "channel": str}

推送通道自动选择:
- 传 ``webhook_url``  → 走自定义机器人 webhook(urllib POST)
- 传 ``chat_id`` / ``open_id`` → 走 bot 身份(``lark-cli api POST /open-apis/im/v1/messages``)

降级链(``fallback=True``,默认):
    interactive card → post 富文本 → text 纯文本 → outbox JSON 落盘

设计原则:
- 只用标准库(urllib / subprocess),不引第三方
- 模板 = card_templates/*.json,变量 ``{{key}}`` 简单字符串替换
- 支持结构化循环占位 ``{"__loop__": "list_key", "item_template": "..."}``
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError


HERE = Path(__file__).resolve().parent
TEMPLATE_DIR = HERE / "card_templates"
DEFAULT_OUTBOX = HERE / "outbox"

# 飞书消息大小上限,超过降级
CARD_MAX_BYTES = 30 * 1024
LARK_CLI_TIMEOUT = 30
WEBHOOK_TIMEOUT = 20

# 允许通过环境变量覆盖 lark-cli 调用前缀.用于:
# - server 上 lark-cli 只有 root 能执行 → 设成 "sudo -n lark-cli"
# - 换用其它兼容 CLI(留出接口,不建议)
# 空字符串或未设置 → 默认 "lark-cli"
LARK_CLI_CMD_ENV = "LARK_CLI_CMD"

log = logging.getLogger("feishu_push")


class PushError(Exception):
    """所有推送异常统一走这一个,让调用方好接."""


class TemplateError(PushError):
    pass


class TransportError(PushError):
    pass


# ---------- 模板加载 & 渲染 ----------

_PLACEHOLDER_RE = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")


def _load_template(name: str) -> Any:
    path = TEMPLATE_DIR / f"{name}.json"
    if not path.exists():
        raise TemplateError(f"卡片模板不存在: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise TemplateError(f"模板 JSON 解析失败 {path}: {e}") from e


def _resolve_path(payload: dict, dotted: str) -> Any:
    """``a.b.c`` → payload['a']['b']['c'];找不到返回 None."""
    cur: Any = payload
    for seg in dotted.split("."):
        if not isinstance(cur, dict) or seg not in cur:
            return None
        cur = cur[seg]
    return cur


def _substitute_string(s: str, payload: dict) -> str:
    """对字符串做 {{key}} 替换.整体等于占位符时返回原值(保留类型)."""
    m = _PLACEHOLDER_RE.fullmatch(s)
    if m:
        val = _resolve_path(payload, m.group(1))
        return "" if val is None else str(val)

    def repl(match: re.Match[str]) -> str:
        val = _resolve_path(payload, match.group(1))
        return "" if val is None else str(val)

    return _PLACEHOLDER_RE.sub(repl, s)


def _expand_tree(node: Any, payload: dict) -> Any:
    """深度遍历模板对象,做循环展开 + 字符串替换."""
    if isinstance(node, dict):
        # 循环占位对象:{"__loop__": "list_key", "item_template": "name"}
        if "__loop__" in node and "item_template" in node:
            list_key = node["__loop__"]
            item_tmpl_name = node["item_template"]
            items = _resolve_path(payload, list_key) or []
            item_tmpl = _load_template(item_tmpl_name)
            return [_expand_tree(item_tmpl, item) for item in items]
        return {k: _expand_tree(v, payload) for k, v in node.items()}
    if isinstance(node, list):
        out: list[Any] = []
        for child in node:
            expanded = _expand_tree(child, payload)
            # __loop__ 在数组里展开成 list,要 flatten 一层
            if isinstance(child, dict) and "__loop__" in child:
                if isinstance(expanded, list):
                    out.extend(expanded)
                    continue
            out.append(expanded)
        return out
    if isinstance(node, str):
        return _substitute_string(node, payload)
    return node


def render_card(template: str, payload: dict) -> dict:
    """渲染卡片消息.返回 {"msg_type": "interactive", "card": {...}}."""
    tmpl = _load_template(template)
    rendered = _expand_tree(tmpl, payload)
    if not isinstance(rendered, dict) or "card" not in rendered:
        raise TemplateError(f"模板 {template} 顶层结构非法,必须含 card 字段")
    return rendered


# ---------- 降级:富文本 & 纯文本 ----------

def _fallback_post_message(template: str, payload: dict) -> dict:
    """卡片发不出去时的富文本降级 (msg_type=post)."""
    if template == "generic_alert":
        return {
            "msg_type": "post",
            "content": {"post": {"zh_cn": {
                "title": payload.get("title") or "系统预警",
                "content": [[{"tag": "text", "text": str(payload.get("body") or "-")}]],
            }}},
        }

    week = payload.get("week", "")
    total = payload.get("total", "")
    watch_count = payload.get("watch_count", "")
    delta = f"{payload.get('delta_symbol', '')}{payload.get('delta', '')}"
    lines: list[list[dict]] = [
        [{"tag": "text", "text": f"📊 本周概况:覆盖 {total} · 异常 {watch_count} · 环比 {delta}"}],
    ]
    for a in (payload.get("top_anomalies") or [])[:5]:
        lines.append([{
            "tag": "text",
            "text": f"{a.get('rank')}. {a.get('name')}  {a.get('metric_current')} ← {a.get('metric_prev')} {a.get('delta_label', '')}",
        }])
        if a.get("hypothesis"):
            lines.append([{"tag": "text", "text": f"   假设:{a['hypothesis']}"}])
    if payload.get("dashboard_url"):
        lines.append([{"tag": "a", "text": "打开监测详情", "href": payload["dashboard_url"]}])
    return {
        "msg_type": "post",
        "content": {"post": {"zh_cn": {"title": f"机型监测周报 · {week}", "content": lines}}},
    }


def _fallback_text_message(template: str, payload: dict) -> dict:
    """再降级:纯文本."""
    if template == "generic_alert":
        return {"msg_type": "text", "content": {"text": f"{payload.get('title') or '系统预警'}\n{payload.get('body') or '-'}"}}

    week = payload.get("week", "")
    lines = [f"机型监测周报 · {week}",
             f"覆盖 {payload.get('total')} · 异常 {payload.get('watch_count')}"]
    for a in (payload.get("top_anomalies") or [])[:3]:
        lines.append(f"- {a.get('name')} {a.get('delta_label', '')}")
    if payload.get("dashboard_url"):
        lines.append(f"详情: {payload['dashboard_url']}")
    return {"msg_type": "text", "content": {"text": "\n".join(lines)}}


# ---------- 传输:webhook / bot ----------

def _send_via_webhook(webhook_url: str, message: dict) -> dict:
    """POST 到自定义机器人 webhook.

    飞书返回 ``{"code":0, "msg":"success", ...}``,失败 code != 0.
    """
    body = json.dumps(message, ensure_ascii=False).encode("utf-8")
    req = urllib_request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=WEBHOOK_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except HTTPError as e:
        raise TransportError(f"webhook HTTP {e.code}: {e.read()[:500]!r}") from e
    except URLError as e:
        raise TransportError(f"webhook 连接失败: {e}") from e
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise TransportError(f"webhook 返回非 JSON: {raw[:500]}") from e
    if data.get("code") not in (0, None):
        raise TransportError(f"webhook 业务失败: {data}")
    return {"raw": data, "message_id": data.get("data", {}).get("message_id")}


def _send_via_lark_cli(receive_id: str, receive_id_type: str, message: dict) -> dict:
    """走 bot 身份的 lark-cli.用 ``api POST /open-apis/im/v1/messages``.

    这条通道要求同机器上 lark-cli 已用 ``--as bot`` 登录且 bridge 存有 App Secret.
    """
    msg_type = message["msg_type"]
    content = message.get("card") if msg_type == "interactive" else message.get("content")
    if content is None:
        raise TransportError(f"消息缺 content/card 字段: {message}")
    body = {
        "receive_id": receive_id,
        "msg_type": msg_type,
        # 飞书 API 要求 content 是 JSON 字符串
        "content": json.dumps(content, ensure_ascii=False),
    }
    # LARK_CLI_CMD 允许 "sudo -n lark-cli" 之类前缀,按 shell 词切分
    import shlex
    cli_prefix = shlex.split(os.environ.get(LARK_CLI_CMD_ENV, "").strip() or "lark-cli")
    cmd = [
        *cli_prefix, "api", "POST", "/open-apis/im/v1/messages",
        "--as", "bot",
        "--params", json.dumps({"receive_id_type": receive_id_type}, ensure_ascii=False),
        "--data", json.dumps(body, ensure_ascii=False),
        "--format", "json",
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=LARK_CLI_TIMEOUT)
    except FileNotFoundError as e:
        raise TransportError("lark-cli 未安装或不在 PATH") from e
    except subprocess.TimeoutExpired as e:
        raise TransportError(f"lark-cli 超时 {LARK_CLI_TIMEOUT}s") from e
    if proc.returncode != 0:
        raise TransportError(f"lark-cli 失败 rc={proc.returncode}: {proc.stderr[:500]}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"raw": proc.stdout[:500], "message_id": None}
    return {"raw": data, "message_id": data.get("data", {}).get("message_id")}


# ---------- outbox 落盘 ----------

def _write_outbox(message: dict, reason: str, outbox_dir: Path) -> Path:
    outbox_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{time.strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:6]}.json"
    path = outbox_dir / fname
    envelope = {
        "written_at": time.strftime("%Y-%m-%dT%H:%M:%S%z") or time.strftime("%Y-%m-%dT%H:%M:%S"),
        "reason": reason,
        "message": message,
    }
    path.write_text(json.dumps(envelope, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


# ---------- 主入口 ----------

def _send_message(
    message: dict,
    *,
    webhook_url: str | None,
    receive_id: str | None,
    receive_id_type: str,
) -> dict:
    """把已渲染好的 message 走对应通道发出去.抛 TransportError."""
    if webhook_url:
        return _send_via_webhook(webhook_url, message)
    if receive_id:
        return _send_via_lark_cli(receive_id, receive_id_type, message)
    raise TransportError("必须提供 webhook_url 或 receive_id 之一")


def push_card(
    *,
    template: str,
    payload: dict,
    webhook_url: str | None = None,
    chat_id: str | None = None,
    open_id: str | None = None,
    fallback: bool = True,
    dry_run: bool = False,
    outbox_dir: Path | None = None,
) -> dict:
    """渲染卡片并推送(核心 API).

    返回::

        {"status": "sent"|"outbox",
         "message_id": str|None,
         "fallback_used": bool,
         "channel": "webhook"|"bot"|"outbox",
         "outbox_path": str|None}
    """
    outbox_dir = outbox_dir or DEFAULT_OUTBOX
    receive_id = chat_id or open_id
    receive_id_type = "chat_id" if chat_id else "open_id"
    channel = "webhook" if webhook_url else ("bot" if receive_id else "outbox")

    card_message = render_card(template, payload)
    encoded = json.dumps(card_message, ensure_ascii=False).encode("utf-8")
    oversize = len(encoded) > CARD_MAX_BYTES

    if dry_run:
        path = _write_outbox(card_message, "dry_run", outbox_dir)
        return {"status": "outbox", "message_id": None, "fallback_used": False,
                "channel": "outbox", "outbox_path": str(path)}

    # 尝试三级发送:card → post → text.oversize 时跳过 card 一级.
    attempts: list[tuple[str, dict]] = []
    if not oversize:
        attempts.append(("interactive", card_message))
    if fallback:
        attempts.append(("post", _fallback_post_message(template, payload)))
        attempts.append(("text", _fallback_text_message(template, payload)))
    elif oversize:
        # 不允许降级但卡片超大,只能落 outbox
        path = _write_outbox(card_message, "oversize_no_fallback", outbox_dir)
        return {"status": "outbox", "message_id": None, "fallback_used": False,
                "channel": "outbox", "outbox_path": str(path)}

    last_error: Exception | None = None
    for idx, (kind, msg) in enumerate(attempts):
        try:
            result = _send_message(
                msg,
                webhook_url=webhook_url,
                receive_id=receive_id,
                receive_id_type=receive_id_type,
            )
            log.info("推送成功 kind=%s message_id=%s", kind, result.get("message_id"))
            return {
                "status": "sent",
                "message_id": result.get("message_id"),
                "fallback_used": idx > 0,
                "channel": channel,
                "outbox_path": None,
                "kind": kind,
            }
        except TransportError as e:
            log.warning("推送失败 kind=%s: %s", kind, e)
            last_error = e
            continue

    # 全都失败,落 outbox 兜底
    path = _write_outbox(card_message, f"all_transports_failed: {last_error}", outbox_dir)
    log.error("推送全链路失败,已落 outbox: %s", path)
    return {"status": "outbox", "message_id": None, "fallback_used": True,
            "channel": "outbox", "outbox_path": str(path),
            "error": str(last_error) if last_error else "unknown"}


# ---------- CLI ----------

def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m tools.feishu_push.send_card",
        description="飞书交互式卡片推送 CLI(支持 bot / webhook 双通道)",
    )
    p.add_argument("--template", required=True, help="卡片模板名(不含 .json)")
    p.add_argument("--payload", required=True, help="业务数据 JSON 文件路径")
    p.add_argument("--webhook-url", help="自定义机器人 webhook,与 --chat-id/--open-id 二选一")
    p.add_argument("--chat-id", help="目标群 chat_id(bot 通道)")
    p.add_argument("--open-id", help="目标用户 open_id(bot 通道)")
    p.add_argument("--dry-run", action="store_true", help="不真发,渲染后落 outbox 供 review")
    p.add_argument("--no-fallback", action="store_true", help="卡片失败直接抛,不走 post/text 降级")
    p.add_argument("--outbox-dir", default=str(DEFAULT_OUTBOX), help="dry-run/兜底落盘目录")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_argparser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    # 环境变量兜底,与 bootstrap 文档一致
    webhook_url = args.webhook_url or os.environ.get("FEISHU_TEST_WEBHOOK")
    chat_id = args.chat_id or os.environ.get("FEISHU_CHAT_ID")
    open_id = args.open_id or os.environ.get("FEISHU_OPEN_ID")
    dry_run = args.dry_run or os.environ.get("FEISHU_DRY_RUN") == "1"

    payload_path = Path(args.payload)
    if not payload_path.exists():
        print(f"payload 文件不存在: {payload_path}", file=sys.stderr)
        return 2
    payload = json.loads(payload_path.read_text(encoding="utf-8"))

    if not dry_run and not (webhook_url or chat_id or open_id):
        print("必须指定 --webhook-url / --chat-id / --open-id 之一,或用 --dry-run", file=sys.stderr)
        return 2

    try:
        result = push_card(
            template=args.template,
            payload=payload,
            webhook_url=webhook_url,
            chat_id=chat_id,
            open_id=open_id,
            fallback=not args.no_fallback,
            dry_run=dry_run,
            outbox_dir=Path(args.outbox_dir),
        )
    except (TemplateError, PushError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "sent" or dry_run else 3


if __name__ == "__main__":
    raise SystemExit(main())

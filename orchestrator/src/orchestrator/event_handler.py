"""飞书事件处理器：从 lark-cli event consume 的 NDJSON 流读取消息，路由到专家，回复结果。

运行方式：
    lark-cli event consume im.message.receive_v1 --as bot --quiet | python -m orchestrator.event_handler

设计要点：
- 单进程长驻，按行读 stdin
- 去重：event_id 已处理过的跳过
- 异步：消息进来立刻确认收到，专家执行用线程池，结果回来再回复
- 容错：单条消息处理异常不影响后续；崩了由 systemd 拉起
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import router
from .expert_runner import run_expert

# ---- 日志 ----
LOG_DIR = Path(os.environ.get("LOG_DIR", "/root/workspace/ZZ-AI-Business-Analysis/logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "event_handler.log"),
        logging.StreamHandler(sys.stderr),
    ],
)
log = logging.getLogger("event_handler")

# ---- 去重（内存级，重启会清空；线上跑的话 event_id 几乎不会重复推送，够用）----
SEEN_EVENT_IDS: set[str] = set()
SEEN_LOCK = threading.Lock()
SEEN_MAX = 10000

# ---- 配置 ----
BOT_OPEN_ID = os.environ.get("BOT_OPEN_ID", "")  # 用于群聊里识别"是不是 @ 我"
WORKER_TIMEOUT = int(os.environ.get("EXPERT_TIMEOUT", "600"))
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "2"))

executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="expert")


def reply_text(message_id: str, text: str) -> dict:
    """通过 lark-cli 回复消息。"""
    try:
        proc = subprocess.run(
            [
                "lark-cli", "im", "+messages-reply",
                "--message-id", message_id,
                "--text", text,
                "--as", "bot",
                "--format", "json",
            ],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            log.error("reply 失败 message_id=%s rc=%d stderr=%s",
                      message_id, proc.returncode, proc.stderr[:500])
            return {"ok": False, "stderr": proc.stderr}
        return {"ok": True, "raw": proc.stdout[:500]}
    except subprocess.TimeoutExpired:
        log.error("reply 超时 message_id=%s", message_id)
        return {"ok": False, "error": "timeout"}
    except Exception as e:
        log.exception("reply 异常 message_id=%s", message_id)
        return {"ok": False, "error": str(e)}


def extract_question(content_raw: str, message_type: str) -> str:
    """从 content 提取用户问题。content 是 JSON 字符串。"""
    if not content_raw:
        return ""
    try:
        c = json.loads(content_raw) if content_raw.startswith("{") else {"text": content_raw}
    except json.JSONDecodeError:
        return content_raw.strip()
    if message_type == "text":
        return (c.get("text") or "").strip()
    if message_type == "post":
        parts = []
        for line in c.get("content", []):
            for seg in line:
                if seg.get("tag") == "text":
                    parts.append(seg.get("text", ""))
        return "\n".join(parts).strip()
    return content_raw.strip()


def strip_mention(text: str) -> str:
    """剥掉 '@_user_1 '、'@机器人 ' 这类 mention 前缀。"""
    # lark-cli 把 mention 渲染成 @_user_N 形式
    import re
    return re.sub(r"@[\w_]+\s*", "", text).strip()


def handle_message(evt: dict) -> None:
    """单条消息的完整处理。在 worker 线程里跑。"""
    event_id = evt.get("event_id", "")
    message_id = evt.get("message_id") or evt.get("id", "")
    chat_type = evt.get("chat_type", "")
    sender_id = evt.get("sender_id", "")
    message_type = evt.get("message_type", "text")
    content_raw = evt.get("content", "")

    if not message_id:
        log.warning("缺 message_id，跳过 event_id=%s", event_id)
        return

    # 提问解析
    question = extract_question(content_raw, message_type)
    question = strip_mention(question)

    # 群聊里没有 @ 到 bot 就忽略（粗略：BOT_OPEN_ID 在 content 里出现）
    # MVP-1 简化：群聊只处理带 @ 的，p2p 全处理
    if chat_type == "group" and BOT_OPEN_ID and BOT_OPEN_ID not in content_raw:
        log.info("群聊未 @ 我，跳过 message_id=%s", message_id)
        return

    if not question:
        log.info("空问题，跳过 message_id=%s", message_id)
        return

    log.info("处理 message_id=%s sender=%s chat_type=%s q=%r",
             message_id, sender_id, chat_type, question[:80])

    # 立即"已签收"回执
    reply_text(message_id, f"收到，正在跑分析（专家执行中，预计 1-3 分钟）…")

    # 路由
    expert_id, reason = router.route(question)
    log.info("路由 message_id=%s expert=%s reason=%s", message_id, expert_id, reason)

    # 启动专家
    t0 = time.time()
    try:
        result = run_expert(expert_id, question, timeout=WORKER_TIMEOUT)
    except Exception as e:
        log.exception("run_expert 异常 message_id=%s", message_id)
        reply_text(message_id, f"专家执行异常：{e}")
        return
    elapsed = time.time() - t0

    if result.get("ok"):
        body = (result.get("stdout") or "").strip()
        if not body:
            body = "(专家执行成功但无输出)"
        # 飞书文本消息长度上限保险，截断
        if len(body) > 5000:
            body = body[:4900] + "\n\n…(已截断)"
        reply = f"【{router.explain(expert_id)}】({elapsed:.0f}s)\n\n{body}"
    else:
        err = (result.get("stderr") or result.get("error") or "未知错误")[:1000]
        reply = f"【{router.explain(expert_id)}】执行失败 ({elapsed:.0f}s)\n\n{err}"

    reply_text(message_id, reply)
    log.info("回复完成 message_id=%s elapsed=%.1fs", message_id, elapsed)


def is_duplicate(event_id: str) -> bool:
    if not event_id:
        return False
    with SEEN_LOCK:
        if event_id in SEEN_EVENT_IDS:
            return True
        SEEN_EVENT_IDS.add(event_id)
        if len(SEEN_EVENT_IDS) > SEEN_MAX:
            # 简单清理：清掉前一半（粗略 FIFO，事件 ID 时间序近似）
            for eid in list(SEEN_EVENT_IDS)[: SEEN_MAX // 2]:
                SEEN_EVENT_IDS.discard(eid)
    return False


def main() -> None:
    log.info("event_handler started, BOT_OPEN_ID=%s MAX_WORKERS=%d",
             BOT_OPEN_ID or "(unset, 群聊将全接)", MAX_WORKERS)
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            log.warning("非 JSON 行: %r", line[:200])
            continue

        event_id = evt.get("event_id", "")
        if is_duplicate(event_id):
            log.debug("重复 event_id=%s 跳过", event_id)
            continue

        # 异步处理，主循环不阻塞
        executor.submit(handle_message, evt)


if __name__ == "__main__":
    main()

"""腾讯企业邮箱 IMAP 读邮件 + 解附件."""
from __future__ import annotations

import email
import imaplib
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from email.header import decode_header
from email.message import Message
from pathlib import Path


@dataclass
class EmailSummary:
    uid: str
    subject: str
    sender: str
    date: str
    attachments: list[str]


def _decode(s: str | bytes) -> str:
    """Decode RFC 2047 encoded subject/from headers."""
    if isinstance(s, bytes):
        s = s.decode("utf-8", errors="ignore")
    parts = decode_header(s)
    out = []
    for txt, enc in parts:
        if isinstance(txt, bytes):
            out.append(txt.decode(enc or "utf-8", errors="ignore"))
        else:
            out.append(txt)
    return "".join(out)


def _connect() -> imaplib.IMAP4_SSL:
    host = os.environ.get("IMAP_HOST", "imap.exmail.qq.com")
    port = int(os.environ.get("IMAP_PORT", "993"))
    user = os.environ["IMAP_USER"]
    pwd = os.environ["IMAP_PASSWORD"]
    imap = imaplib.IMAP4_SSL(host, port)
    imap.login(user, pwd)
    return imap


def list_emails(
    subject_contains: str | None = None,
    sender: str | None = None,
    since: str | None = None,
    folder: str = "INBOX",
    max_results: int = 20,
) -> list[EmailSummary]:
    """列邮件，按主题/发件人/日期过滤。

    since: 'YYYY-MM-DD' 或 None。
    返回最新优先。
    """
    imap = _connect()
    try:
        imap.select(folder)
        criteria = []
        if subject_contains:
            criteria += ["SUBJECT", subject_contains.encode("utf-8")]
        if sender:
            criteria += ["FROM", sender]
        if since:
            try:
                dt = datetime.strptime(since, "%Y-%m-%d")
                criteria += ["SINCE", dt.strftime("%d-%b-%Y")]
            except ValueError:
                pass
        if not criteria:
            criteria = ["ALL"]
        typ, data = imap.search(None, *criteria)
        if typ != "OK":
            return []
        uids = data[0].split()
        uids = uids[-max_results:][::-1]  # 最新优先
        out: list[EmailSummary] = []
        for uid in uids:
            typ, msg_data = imap.fetch(uid, "(RFC822.HEADER)")
            if typ != "OK":
                continue
            for part in msg_data:
                if isinstance(part, tuple):
                    msg = email.message_from_bytes(part[1])
                    atts = _list_attachments_meta(imap, uid)
                    out.append(EmailSummary(
                        uid=uid.decode(),
                        subject=_decode(msg.get("Subject", "")),
                        sender=_decode(msg.get("From", "")),
                        date=msg.get("Date", ""),
                        attachments=atts,
                    ))
        return out
    finally:
        try:
            imap.logout()
        except Exception:
            pass


def _list_attachments_meta(imap: imaplib.IMAP4_SSL, uid: bytes) -> list[str]:
    """Quick scan for attachment filenames without downloading."""
    typ, data = imap.fetch(uid, "(BODYSTRUCTURE)")
    if typ != "OK":
        return []
    # Lazy parse: regex the filename hints. (Robust enough for typical CSVs.)
    raw = b"".join(p if isinstance(p, bytes) else p[1] for p in data if p).decode("utf-8", errors="ignore")
    names = re.findall(r'"(?:NAME|FILENAME)"\s+"([^"]+)"', raw, re.I)
    return list({_decode(n) for n in names})


def download_attachment(uid: str, attachment_name: str, save_dir: str | None = None) -> str:
    """下载附件到本地，返回本地路径。"""
    save_dir = save_dir or tempfile.mkdtemp(prefix="agent_data_")
    Path(save_dir).mkdir(parents=True, exist_ok=True)
    imap = _connect()
    try:
        imap.select("INBOX")
        typ, msg_data = imap.fetch(uid.encode() if isinstance(uid, str) else uid, "(RFC822)")
        if typ != "OK":
            raise RuntimeError(f"fetch failed for uid={uid}")
        raw = b"".join(p if isinstance(p, bytes) else p[1] for p in msg_data if p)
        msg = email.message_from_bytes(raw)
        for part in msg.walk():
            if part.get_content_disposition() != "attachment":
                continue
            fname = _decode(part.get_filename() or "")
            if fname == attachment_name:
                path = Path(save_dir) / fname
                payload = part.get_payload(decode=True)
                path.write_bytes(payload or b"")
                return str(path)
        raise FileNotFoundError(f"attachment {attachment_name!r} not found in uid={uid}")
    finally:
        try:
            imap.logout()
        except Exception:
            pass

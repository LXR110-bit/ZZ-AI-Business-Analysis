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
    include_attachments: bool = True,
) -> list[EmailSummary]:
    """列邮件，按主题/发件人/日期过滤。

    since: 'YYYY-MM-DD' 或 None。
    include_attachments: if False, skip attachment scanning (faster).
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
                    atts = _list_attachments_meta(imap, uid) if include_attachments else []
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
    """Scan for attachment filenames from BODYSTRUCTURE."""
    typ, data = imap.fetch(uid, "(BODYSTRUCTURE)")
    if typ != "OK":
        return []
    raw = b"".join(p if isinstance(p, bytes) else p[1] for p in data if p).decode("utf-8", errors="ignore")
    # Standard quoted filename: "NAME" "somefile.xlsx"
    names = re.findall(r'"(?:NAME|FILENAME)"\s+"([^"]+)"', raw, re.I)
    # RFC 2047 encoded: =?utf-8?B?...?= possibly multi-line continuation
    # Match individual encoded-word sequences (one filename = one or more consecutive encoded-words)
    encoded_words = re.findall(r'=\?[^?]+\?[BbQq]\?[^?]+\?=', raw)
    if encoded_words:
        # Group consecutive encoded-words into filenames by decoding incrementally
        current_parts: list[str] = []
        for ew in encoded_words:
            decoded_part = _decode(ew)
            current_parts.append(decoded_part)
            joined = "".join(current_parts)
            # A complete filename ends with a known extension
            if re.search(r'\.(xlsx|xls|csv|zip|rar|pdf)$', joined, re.I):
                names.append(joined)
                current_parts = []
    decoded_set = set()
    for n in names:
        d = _decode(n)
        if d:
            decoded_set.add(d)
    return list(decoded_set)


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

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
from pathlib import Path


@dataclass
class EmailSummary:
    uid: str
    subject: str
    sender: str
    date: str
    attachments: list[str]


def _decode(s: str | bytes | None) -> str:
    """Decode RFC 2047 encoded subject/from/filename headers."""
    if s is None:
        return ""
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


def _fetch_bytes(imap: imaplib.IMAP4_SSL, uid: bytes | str, query: str) -> bytes:
    """Fetch a UID-scoped IMAP payload and concatenate tuple/byte parts safely."""
    uid_b = uid.encode() if isinstance(uid, str) else uid
    typ, data = imap.uid("FETCH", uid_b, query)
    if typ != "OK":
        return b""
    chunks: list[bytes] = []
    for part in data:
        if isinstance(part, tuple):
            chunks.append(part[1])
        elif isinstance(part, bytes):
            chunks.append(part)
    return b"".join(chunks)


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
    include_attachments: False 时跳过附件扫描，适合只需要先筛邮件的场景。
    返回最新优先。uid 始终是 IMAP UID，不是易变 sequence number。
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
        typ, data = imap.uid("SEARCH", None, *criteria)
        if typ != "OK":
            return []
        uids = data[0].split()
        uids = uids[-max_results:][::-1]  # 最新优先
        out: list[EmailSummary] = []
        for uid in uids:
            raw_header = _fetch_bytes(imap, uid, "(RFC822.HEADER)")
            if not raw_header:
                continue
            msg = email.message_from_bytes(raw_header)
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


def _looks_like_attachment_name(name: str) -> bool:
    return bool(re.search(r"\.(xlsx|xls|csv|zip|rar|pdf)$", name, re.I))


def _dedupe_names(names: list[str], require_extension: bool = False) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for name in names:
        decoded = _decode(name).strip()
        if not decoded or decoded in seen:
            continue
        if require_extension and not _looks_like_attachment_name(decoded):
            continue
        seen.add(decoded)
        out.append(decoded)
    return out


def _extract_attachment_names_from_message(msg: email.message.Message) -> list[str]:
    names: list[str] = []
    for part in msg.walk():
        disposition = (part.get_content_disposition() or "").lower()
        filename = part.get_filename()
        if disposition == "attachment" or filename:
            decoded = _decode(filename)
            if decoded:
                names.append(decoded)
    return _dedupe_names(names)


def _list_attachments_meta(imap: imaplib.IMAP4_SSL, uid: bytes | str) -> list[str]:
    """Scan attachment filenames without downloading payloads when possible.

    Some Tencent/Exmail BODYSTRUCTURE responses encode Chinese filenames as
    RFC 2047 words or otherwise omit the simple quoted NAME/FILENAME pattern.
    When the quick BODYSTRUCTURE regex misses, fall back to parsing the full
    RFC822 MIME envelope so daily .zip and .xlsx attachments are not skipped.
    """
    raw_bs = _fetch_bytes(imap, uid, "(BODYSTRUCTURE)").decode("utf-8", errors="ignore")
    names = re.findall(r'"(?:NAME|FILENAME)"\s+"([^"]+)"', raw_bs, re.I)
    # RFC 2047 encoded filename values may be split across adjacent encoded
    # words.  Decode contiguous groups, but accept them only when they look like
    # complete filenames; otherwise continue to the MIME fallback below.
    names.extend(re.findall(r'(?:=\?[^?]+\?[BbQq]\?[^?]+\?=\s*)+', raw_bs))
    decoded = _dedupe_names(names, require_extension=True)
    if decoded:
        return decoded

    raw_msg = _fetch_bytes(imap, uid, "(RFC822)")
    if not raw_msg:
        return []
    return _extract_attachment_names_from_message(email.message_from_bytes(raw_msg))


def download_attachment(uid: str, attachment_name: str, save_dir: str | None = None) -> str:
    """下载附件到本地，返回本地路径。"""
    save_dir = save_dir or tempfile.mkdtemp(prefix="agent_data_")
    Path(save_dir).mkdir(parents=True, exist_ok=True)
    imap = _connect()
    try:
        imap.select("INBOX")
        raw = _fetch_bytes(imap, uid, "(RFC822)")
        if not raw:
            raise RuntimeError(f"fetch failed for uid={uid}")
        msg = email.message_from_bytes(raw)
        target = _decode(attachment_name)
        for part in msg.walk():
            disposition = (part.get_content_disposition() or "").lower()
            fname = _decode(part.get_filename() or "")
            if disposition != "attachment" and not fname:
                continue
            if fname == target:
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

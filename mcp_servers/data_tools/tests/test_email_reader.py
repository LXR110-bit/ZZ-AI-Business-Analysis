from __future__ import annotations

from email.message import EmailMessage

from data_tools.email_reader import _dedupe_names, _fetch_bytes, _list_attachments_meta, download_attachment


class FakeIMAP:
    def __init__(self, raw_message: bytes):
        self.raw_message = raw_message

    def uid(self, command: str, uid: bytes, query: str):
        assert command == "FETCH"
        if query == "(BODYSTRUCTURE)":
            # Regression: Tencent/Exmail can return a BODYSTRUCTURE that lacks
            # the simple quoted NAME/FILENAME pattern used by the old parser.
            return "OK", [(b"1 (BODYSTRUCTURE (\"APPLICATION\" \"OCTET-STREAM\" NIL NIL NIL))", b"")]
        if query == "(RFC822)":
            return "OK", [(b"1 (RFC822 {123}", self.raw_message)]
        raise AssertionError(query)


class FlakyIMAP:
    def __init__(self):
        self.calls = 0

    def uid(self, command: str, uid: bytes, query: str):
        assert command == "FETCH"
        self.calls += 1
        if self.calls == 1:
            return "OK", []
        return "OK", [(b"1 (RFC822 {4}", b"data")]


class EmptyBodyIMAP:
    def select(self, folder: str):
        assert folder == "INBOX"

    def uid(self, command: str, uid: bytes, query: str):
        assert command == "FETCH"
        return "OK", []

    def logout(self):
        return None


class AttachmentIMAP:
    def __init__(self, raw_message: bytes):
        self.raw_message = raw_message

    def select(self, folder: str):
        assert folder == "INBOX"

    def uid(self, command: str, uid: bytes, query: str):
        assert command == "FETCH"
        assert query == "(RFC822)"
        return "OK", [(b"1 (RFC822 {123}", self.raw_message)]

    def logout(self):
        return None


def test_list_attachments_meta_falls_back_to_rfc822_for_xlsx():
    msg = EmailMessage()
    msg["Subject"] = "AI小万_品类漏斗数据周日均"
    msg.set_content("see attachment")
    msg.add_attachment(
        b"fake-xlsx",
        maintype="application",
        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="AI小万_品类漏斗数据周日均_747566503.xlsx",
    )

    names = _list_attachments_meta(FakeIMAP(msg.as_bytes()), b"276")

    assert names == ["AI小万_品类漏斗数据周日均_747566503.xlsx"]


def test_dedupe_names_collapses_repeated_bodystructure_filename():
    names = _dedupe_names(
        [
            "AI小万_品类漏斗数据周日均_748082971.xlsxAI小万_品类漏斗数据周日均_748082971.xlsx",
        ],
        require_extension=True,
    )

    assert names == ["AI小万_品类漏斗数据周日均_748082971.xlsx"]


def test_fetch_bytes_retries_empty_ok_payload(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr("data_tools.email_reader.time.sleep", sleeps.append)
    imap = FlakyIMAP()

    payload = _fetch_bytes(imap, "289", "(RFC822)", attempts=2, initial_delay_seconds=0.5)

    assert payload == b"data"
    assert imap.calls == 2
    assert sleeps == [0.5]


def test_download_attachment_reconnects_after_empty_fetch(monkeypatch, tmp_path):
    msg = EmailMessage()
    msg["Subject"] = "AI小万_机型漏斗数据周日均"
    msg.set_content("see attachment")
    msg.add_attachment(
        b"zip-bytes",
        maintype="application",
        subtype="zip",
        filename="AI小万_机型漏斗数据周日均_748091261.zip",
    )
    connections = [EmptyBodyIMAP(), AttachmentIMAP(msg.as_bytes())]

    monkeypatch.setenv("IMAP_FETCH_RETRIES", "1")
    monkeypatch.setenv("IMAP_DOWNLOAD_RETRIES", "2")
    monkeypatch.setenv("IMAP_DOWNLOAD_RETRY_DELAY_SECONDS", "0")
    monkeypatch.setattr("data_tools.email_reader._connect", lambda: connections.pop(0))
    monkeypatch.setattr("data_tools.email_reader.time.sleep", lambda _: None)

    path = download_attachment("291", "AI小万_机型漏斗数据周日均_748091261.zip", str(tmp_path))

    assert (tmp_path / "AI小万_机型漏斗数据周日均_748091261.zip").read_bytes() == b"zip-bytes"
    assert path.endswith("AI小万_机型漏斗数据周日均_748091261.zip")
    assert connections == []

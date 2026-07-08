from __future__ import annotations

from email.message import EmailMessage

from data_tools.email_reader import _list_attachments_meta


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

"""knowledge_base server 测试 — mock lark-cli subprocess."""
from __future__ import annotations

from unittest.mock import patch, Mock

from knowledge_base import server


def _fake_proc(stdout: str, returncode: int = 0):
    m = Mock()
    m.returncode = returncode
    m.stdout = stdout
    m.stderr = ""
    return m


def test_lark_search_normal():
    fake = _fake_proc('{"ok": true, "data": [{"id": "rec1"}]}')
    with patch.object(server.subprocess, "run", return_value=fake) as run:
        result = server._lark_search("tblX", "GMV", "口径名")
    args = run.call_args[0][0]
    assert args[0] == "lark-cli"
    assert "--base-token" in args
    assert "GMV" in args
    assert result == {"ok": True, "data": [{"id": "rec1"}]}


def test_lark_search_failure():
    fake = _fake_proc("", returncode=1)
    fake.stderr = "boom"
    with patch.object(server.subprocess, "run", return_value=fake):
        result = server._lark_search("tblX", "GMV", "口径名")
    assert result["ok"] is False


def test_lark_search_non_json():
    fake = _fake_proc("not json")
    with patch.object(server.subprocess, "run", return_value=fake):
        result = server._lark_search("tblX", "GMV", "口径名")
    assert result["ok"] is False


def test_query_metric_wraps():
    fake = _fake_proc('{"ok": true, "data": []}')
    with patch.object(server.subprocess, "run", return_value=fake):
        r = server.query_metric.fn("GMV")
    assert r["metric"] == "GMV"
    assert r["source"] == "飞书 base 04 口径表"


def test_query_field_wraps():
    fake = _fake_proc('{"ok": true, "data": []}')
    with patch.object(server.subprocess, "run", return_value=fake):
        r = server.query_field.fn("uid")
    assert r["field"] == "uid"


def test_query_dim_value_wraps():
    fake = _fake_proc('{"ok": true, "data": []}')
    with patch.object(server.subprocess, "run", return_value=fake):
        r = server.query_dim_value.fn("已成交")
    assert r["query"] == "已成交"


def test_query_table_wraps():
    fake = _fake_proc('{"ok": true, "data": []}')
    with patch.object(server.subprocess, "run", return_value=fake):
        r = server.query_table.fn("回收订单")
    assert r["table"] == "回收订单"


def test_get_baseline_stub():
    r = server.get_baseline.fn("iPhone", "GMV")
    assert r["baseline"] is None

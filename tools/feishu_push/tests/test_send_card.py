"""单测:tools.feishu_push.send_card.

跑法::

    cd 项目根
    python -m pytest tools/feishu_push/tests -v
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest import mock

import pytest

from tools.feishu_push import send_card
from tools.feishu_push.send_card import (
    PushError,
    TemplateError,
    TransportError,
    push_card,
    render_card,
)


ROOT = Path(__file__).resolve().parents[1]
SAMPLE_PAYLOAD = json.loads((ROOT / "examples" / "example_monitor_payload.json").read_text("utf-8"))


# ---------- 模板渲染 ----------

def test_render_card_fills_variables():
    card = render_card("monitor_weekly", SAMPLE_PAYLOAD)
    assert card["msg_type"] == "interactive"
    title = card["card"]["header"]["title"]["content"]
    assert "2025-W27" in title


def test_render_card_expands_loop_into_items():
    card = render_card("monitor_weekly", SAMPLE_PAYLOAD)
    # 找到所有 div.text.content,应该能看到 3 条异常
    elements = card["card"]["elements"]
    div_contents = [e["text"]["content"] for e in elements if e.get("tag") == "div"]
    joined = "\n".join(div_contents)
    for a in SAMPLE_PAYLOAD["top_anomalies"]:
        assert a["name"] in joined
        assert a["delta_label"] in joined


def test_render_card_url_button_uses_dashboard_url():
    card = render_card("monitor_weekly", SAMPLE_PAYLOAD)
    actions = next(e for e in card["card"]["elements"] if e.get("tag") == "action")
    urls = [a["url"] for a in actions["actions"]]
    assert SAMPLE_PAYLOAD["dashboard_url"] in urls
    assert SAMPLE_PAYLOAD["report_url"] in urls


def test_render_card_missing_variable_becomes_empty():
    payload = {"week": "W1"}  # 故意漏掉 total 等
    card = render_card("monitor_weekly", payload)
    # 不应抛,变量位置留空
    body = card["card"]["elements"][0]["text"]["content"]
    assert "W1" not in body  # week 只在标题
    # 未填的 total/watch_count 变成空串
    assert "覆盖机型  ·" in body or "覆盖机型 **" in body


def test_render_card_unknown_template_raises():
    with pytest.raises(TemplateError):
        render_card("does_not_exist", {})


def test_render_generic_alert():
    payload = {
        "title": "⚠️ 数据管道异常",
        "template_color": "red",
        "body": "上游 sheet 拉取失败,已重试 3 次",
        "button_text": "查看日志",
        "link_url": "http://47.84.94.234:8848/logs",
    }
    card = render_card("generic_alert", payload)
    assert card["card"]["header"]["template"] == "red"
    action = next(e for e in card["card"]["elements"] if e.get("tag") == "action")
    assert action["actions"][0]["url"] == payload["link_url"]


# ---------- 推送:dry-run 落 outbox ----------

def test_push_card_dry_run_writes_outbox(tmp_path):
    result = push_card(
        template="monitor_weekly",
        payload=SAMPLE_PAYLOAD,
        chat_id="oc_test",
        dry_run=True,
        outbox_dir=tmp_path,
    )
    assert result["status"] == "outbox"
    assert result["channel"] == "outbox"
    path = Path(result["outbox_path"])
    assert path.exists()
    envelope = json.loads(path.read_text("utf-8"))
    assert envelope["reason"] == "dry_run"
    assert envelope["message"]["msg_type"] == "interactive"


# ---------- 推送:bot 通道成功 ----------

def test_push_card_bot_success(tmp_path):
    fake = {"raw": {"code": 0}, "message_id": "om_abc"}
    with mock.patch.object(send_card, "_send_via_lark_cli", return_value=fake) as m:
        result = push_card(
            template="monitor_weekly",
            payload=SAMPLE_PAYLOAD,
            chat_id="oc_test",
            outbox_dir=tmp_path,
        )
    assert result["status"] == "sent"
    assert result["message_id"] == "om_abc"
    assert result["fallback_used"] is False
    assert result["channel"] == "bot"
    call_args = m.call_args
    assert call_args.args[0] == "oc_test"
    assert call_args.args[1] == "chat_id"
    # 传给 lark-cli 的消息类型应是 interactive
    assert call_args.args[2]["msg_type"] == "interactive"


# ---------- 推送:降级链 ----------

def test_push_card_falls_back_to_post_when_card_fails(tmp_path):
    """卡片失败 → post 成功."""
    seen: list[str] = []

    def fake_send(receive_id, receive_id_type, msg):
        seen.append(msg["msg_type"])
        if msg["msg_type"] == "interactive":
            raise TransportError("simulated card failure")
        return {"raw": {"code": 0}, "message_id": "om_post"}

    with mock.patch.object(send_card, "_send_via_lark_cli", side_effect=fake_send):
        result = push_card(
            template="monitor_weekly",
            payload=SAMPLE_PAYLOAD,
            chat_id="oc_test",
            outbox_dir=tmp_path,
        )
    assert result["status"] == "sent"
    assert result["fallback_used"] is True
    assert result["kind"] == "post"
    assert seen == ["interactive", "post"]


def test_push_card_all_fail_writes_outbox(tmp_path):
    """三级全挂 → outbox."""
    with mock.patch.object(
        send_card, "_send_via_lark_cli",
        side_effect=TransportError("boom"),
    ):
        result = push_card(
            template="monitor_weekly",
            payload=SAMPLE_PAYLOAD,
            chat_id="oc_test",
            outbox_dir=tmp_path,
        )
    assert result["status"] == "outbox"
    assert result["fallback_used"] is True
    assert "boom" in result["error"]
    assert Path(result["outbox_path"]).exists()


def test_push_card_no_fallback_raises_via_outbox(tmp_path):
    """fallback=False 时,卡片失败直接落 outbox(不会尝试 post/text)."""
    with mock.patch.object(
        send_card, "_send_via_lark_cli",
        side_effect=TransportError("card 500"),
    ) as m:
        result = push_card(
            template="monitor_weekly",
            payload=SAMPLE_PAYLOAD,
            chat_id="oc_test",
            fallback=False,
            outbox_dir=tmp_path,
        )
    # 只调用了一次(interactive),没走 post/text
    assert m.call_count == 1
    assert result["status"] == "outbox"


# ---------- 推送:webhook 通道 ----------

def test_push_card_webhook_channel(tmp_path):
    fake = {"raw": {"code": 0}, "message_id": None}
    with mock.patch.object(send_card, "_send_via_webhook", return_value=fake) as m:
        result = push_card(
            template="monitor_weekly",
            payload=SAMPLE_PAYLOAD,
            webhook_url="https://example.com/hook/xxx",
            outbox_dir=tmp_path,
        )
    assert result["status"] == "sent"
    assert result["channel"] == "webhook"
    assert m.call_args.args[0] == "https://example.com/hook/xxx"


def test_push_card_requires_channel(tmp_path):
    """既没 webhook 也没 receive_id → transport 层报错走 outbox."""
    with mock.patch.object(
        send_card, "_send_via_lark_cli",
        side_effect=AssertionError("不该被调"),
    ):
        result = push_card(
            template="monitor_weekly",
            payload=SAMPLE_PAYLOAD,
            outbox_dir=tmp_path,
        )
    assert result["status"] == "outbox"


# ---------- oversize 保护 ----------

def test_push_card_oversize_skips_card_layer(tmp_path):
    """卡片超阈值时直接走 post,不试 interactive."""
    big_payload = dict(SAMPLE_PAYLOAD)
    big_payload["top_anomalies"] = [
        {"rank": i, "name": "x" * 200, "metric_current": "y" * 200,
         "metric_prev": "z" * 200, "delta_label": "(+0%)", "hypothesis": "h" * 500}
        for i in range(200)
    ]
    seen: list[str] = []

    def fake_send(receive_id, receive_id_type, msg):
        seen.append(msg["msg_type"])
        return {"raw": {"code": 0}, "message_id": "om_post"}

    with mock.patch.object(send_card, "_send_via_lark_cli", side_effect=fake_send):
        result = push_card(
            template="monitor_weekly",
            payload=big_payload,
            chat_id="oc_test",
            outbox_dir=tmp_path,
        )
    assert result["status"] == "sent"
    # 没试 interactive,直接从 post 开始
    assert seen[0] == "post"
    assert "interactive" not in seen


# ---------- CLI ----------

def test_cli_dry_run_smoke(tmp_path, capsys):
    payload_path = ROOT / "examples" / "example_monitor_payload.json"
    outbox = tmp_path / "outbox"
    rc = send_card.main([
        "--template", "monitor_weekly",
        "--payload", str(payload_path),
        "--dry-run",
        "--outbox-dir", str(outbox),
    ])
    assert rc == 0
    captured = json.loads(capsys.readouterr().out)
    assert captured["status"] == "outbox"
    assert captured["channel"] == "outbox"
    assert Path(captured["outbox_path"]).exists()


def test_cli_missing_channel_returns_2(tmp_path, capsys):
    payload_path = ROOT / "examples" / "example_monitor_payload.json"
    rc = send_card.main([
        "--template", "monitor_weekly",
        "--payload", str(payload_path),
    ])
    assert rc == 2


def test_cli_unknown_payload_file(capsys):
    rc = send_card.main([
        "--template", "monitor_weekly",
        "--payload", "/tmp/does-not-exist-xxx.json",
        "--dry-run",
    ])
    assert rc == 2

def test_generic_alert_fallback_uses_alert_content(tmp_path):
    """generic_alert 降级文本不能套用周报字段。"""
    payload = {
        "title": "🚨 日更失败",
        "template_color": "red",
        "body": "失败阶段: coverage\n页面已保留昨天版本",
        "button_text": "查看 Dashboard",
        "link_url": "http://47.84.94.234:8848/",
    }
    seen: list[dict] = []

    def fake_send(receive_id, receive_id_type, msg):
        seen.append(msg)
        if msg["msg_type"] == "interactive":
            raise TransportError("card failed")
        return {"raw": {"code": 0}, "message_id": "om_alert"}

    with mock.patch.object(send_card, "_send_via_lark_cli", side_effect=fake_send):
        result = push_card(
            template="generic_alert",
            payload=payload,
            chat_id="oc_test",
            outbox_dir=tmp_path,
        )
    assert result["status"] == "sent"
    assert result["kind"] == "post"
    assert "日更失败" in seen[1]["content"]["post"]["zh_cn"]["title"]
    assert "页面已保留昨天版本" in seen[1]["content"]["post"]["zh_cn"]["content"][0][0]["text"]

"""critic.py 测试（不调真实 LLM）."""
from __future__ import annotations

import json
from unittest.mock import patch, Mock

import pytest

from review_gate import critic
from review_gate.verdict import Verdict


def test_build_user_message_contains_inputs():
    msg = critic._build_user_message(
        task="iPhone 周报",
        agent_output="本周成交涨了 5%",
        principle_text="§1 三层穿透...",
    )
    assert "iPhone 周报" in msg
    assert "本周成交涨了 5%" in msg
    assert "§1 三层穿透" in msg
    # 顺序：任务 → 输出 → 原则
    assert msg.find("iPhone") < msg.find("成交") < msg.find("§1")


def test_extract_json_plain():
    assert critic._extract_json('{"passed": true}') == {"passed": True}


def test_extract_json_markdown_fenced():
    assert critic._extract_json('```json\n{"passed": true}\n```') == {"passed": True}


def test_extract_json_empty():
    assert critic._extract_json("") == {}


def test_review_missing_api_key(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        critic.review("t", "o", "p")


def test_review_missing_base_url(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="OPENAI_BASE_URL"):
        critic.review("t", "o", "p")


def test_review_auto_append_v1(monkeypatch):
    """验证 base_url 不带 /v1 时自动补."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://v2.qixuw.com")
    captured: dict = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        m = Mock()
        m.raise_for_status = lambda: None
        m.json = lambda: {
            "choices": [{"message": {"content": json.dumps({
                "passed": True, "verdict": "PASS", "checks": [], "issues": [], "summary": "ok"
            })}}]
        }
        return m

    with patch.object(critic.requests, "post", side_effect=fake_post):
        v = critic.review("t", "o", "p")
    assert captured["url"] == "https://v2.qixuw.com/v1/chat/completions"
    assert v.passed is True


def test_review_explicit_v1_not_doubled(monkeypatch):
    """base_url 已经带 /v1 不应该再追加."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-x")
    captured: dict = {}

    def fake_post(url, **kwargs):
        captured["url"] = url
        m = Mock()
        m.raise_for_status = lambda: None
        m.json = lambda: {
            "choices": [{"message": {"content": '{"passed": false, "verdict": "FAIL"}'}}]
        }
        return m

    with patch.object(critic.requests, "post", side_effect=fake_post):
        critic.review("t", "o", "p", base_url="https://x.com/v1")
    assert captured["url"] == "https://x.com/v1/chat/completions"

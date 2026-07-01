"""event_handler 的 _review_with_retry 单测（mock review_gate + run_expert）."""
from __future__ import annotations

from unittest.mock import patch, MagicMock

import pytest


@pytest.fixture
def fake_principles(monkeypatch):
    """模拟 PRINCIPLES_TEXT 已加载."""
    from orchestrator import event_handler
    monkeypatch.setattr(event_handler, "PRINCIPLES_TEXT", "§1-§9...")
    monkeypatch.setattr(event_handler, "REVIEW_GATE_ENABLED", True)
    return event_handler


def test_review_gate_disabled_returns_original(monkeypatch):
    from orchestrator import event_handler
    monkeypatch.setattr(event_handler, "REVIEW_GATE_ENABLED", False)
    out, verdict, attempts = event_handler._review_with_retry("daily_analyst", "q", "原 output")
    assert out == "原 output"
    assert verdict is None
    assert attempts == 0


def test_pass_first_try_no_retry(fake_principles):
    fake_verdict = MagicMock(passed=True, issues=[])
    with patch("orchestrator.event_handler.review_output", return_value=fake_verdict) as rev:
        out, verdict, attempts = fake_principles._review_with_retry("daily_analyst", "q", "好 output", max_retries=2)
    assert out == "好 output"
    assert attempts == 1
    assert verdict.passed
    rev.assert_called_once()


def test_fail_then_pass_after_retry(fake_principles):
    fail_verdict = MagicMock(passed=False, issues=[MagicMock(check="§4", what="缺四问", fix="补四问")])
    pass_verdict = MagicMock(passed=True, issues=[])
    with patch("orchestrator.event_handler.review_output", side_effect=[fail_verdict, pass_verdict]):
        with patch("orchestrator.event_handler.run_expert", return_value={"ok": True, "stdout": "改好 output"}):
            out, verdict, attempts = fake_principles._review_with_retry(
                "daily_analyst", "q", "差 output", max_retries=2
            )
    assert out == "改好 output"
    assert attempts == 2
    assert verdict.passed


def test_fail_until_max_retries(fake_principles):
    fail_verdict = MagicMock(passed=False, issues=[MagicMock(check="§5", what="无 ROI", fix="加 ROI")])
    with patch("orchestrator.event_handler.review_output", return_value=fail_verdict):
        with patch("orchestrator.event_handler.run_expert", return_value={"ok": True, "stdout": "再改"}):
            out, verdict, attempts = fake_principles._review_with_retry(
                "daily_analyst", "q", "原 output", max_retries=2
            )
    assert attempts == 3  # 初始 + 2 retry
    assert not verdict.passed


def test_review_exception_falls_through(fake_principles):
    with patch("orchestrator.event_handler.review_output", side_effect=RuntimeError("net down")):
        out, verdict, attempts = fake_principles._review_with_retry("daily_analyst", "q", "原 output")
    assert out == "原 output"
    assert verdict is None

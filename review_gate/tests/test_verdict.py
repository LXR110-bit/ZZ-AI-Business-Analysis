"""Verdict dataclass 测试."""
from __future__ import annotations

import json

from review_gate.verdict import CheckResult, Issue, Verdict


def test_from_dict_normal_pass():
    d = {
        "passed": True,
        "verdict": "PASS",
        "checks": [
            {"check": "§1", "passed": True, "reason": "ok"},
            {"check": "§2", "passed": True, "reason": "ok"},
        ],
        "issues": [],
        "summary": "全部通过",
    }
    v = Verdict.from_dict(d)
    assert v.passed is True
    assert v.verdict == "PASS"
    assert len(v.checks) == 2
    assert v.checks[0].check == "§1"
    assert v.issues == []
    assert v.summary == "全部通过"


def test_from_dict_normal_fail():
    d = {
        "passed": False,
        "verdict": "FAIL",
        "checks": [
            {"check": "§1", "passed": True, "reason": "ok"},
            {"check": "§4", "passed": False, "reason": "缺四问"},
        ],
        "issues": [
            {"check": "§4", "what": "未做异动归因", "fix": "补四问"},
        ],
        "summary": "缺一项",
    }
    v = Verdict.from_dict(d)
    assert v.passed is False
    assert v.verdict == "FAIL"
    failed = v.failed_checks()
    assert len(failed) == 1
    assert failed[0].check == "§4"


def test_from_dict_missing_fields():
    """容错：缺字段不应抛异常."""
    v = Verdict.from_dict({})
    assert v.passed is False
    assert v.verdict == "FAIL"
    assert v.checks == []
    assert v.issues == []


def test_from_dict_lowercase_verdict():
    """verdict 字段会被统一大写."""
    v = Verdict.from_dict({"passed": True, "verdict": "pass"})
    assert v.verdict == "PASS"


def test_from_dict_malformed_check():
    """checks 里混进非 dict 应该被跳过，不抛."""
    d = {
        "passed": False,
        "verdict": "FAIL",
        "checks": [
            {"check": "§1", "passed": True},
            "not a dict",  # 非法
            None,
            {"check": "§2", "passed": False, "reason": "x"},
        ],
    }
    v = Verdict.from_dict(d)
    assert len(v.checks) == 2  # 跳过非法


def test_to_json_roundtrip():
    original = {
        "passed": False,
        "verdict": "FAIL",
        "checks": [{"check": "§1", "passed": False, "reason": "no"}],
        "issues": [{"check": "§1", "what": "缺", "fix": "补"}],
        "summary": "炸",
    }
    v = Verdict.from_dict(original)
    re_parsed = json.loads(v.to_json())
    assert re_parsed["passed"] is False
    assert re_parsed["verdict"] == "FAIL"
    assert re_parsed["checks"][0]["check"] == "§1"
    assert re_parsed["issues"][0]["fix"] == "补"


def test_check_result_isolated():
    c = CheckResult.from_dict({"check": "§7", "passed": True})
    assert c.reason == ""


def test_issue_isolated():
    i = Issue.from_dict({"check": "§5", "what": "缺 ROI"})
    assert i.fix == ""

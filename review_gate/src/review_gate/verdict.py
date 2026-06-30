"""Verdict / CheckResult / Issue dataclasses + JSON 解析."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class CheckResult:
    check: str       # e.g. "§1 三层穿透"
    passed: bool
    reason: str = ""

    @classmethod
    def from_dict(cls, d: dict) -> "CheckResult":
        return cls(
            check=str(d.get("check", "")),
            passed=bool(d.get("passed", False)),
            reason=str(d.get("reason", "")),
        )


@dataclass
class Issue:
    check: str   # e.g. "§4"
    what: str    # 错在哪
    fix: str = ""  # 怎么改

    @classmethod
    def from_dict(cls, d: dict) -> "Issue":
        return cls(
            check=str(d.get("check", "")),
            what=str(d.get("what", "")),
            fix=str(d.get("fix", "")),
        )


@dataclass
class Verdict:
    passed: bool
    verdict: str
    checks: list[CheckResult] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)
    summary: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, d: dict) -> "Verdict":
        return cls(
            passed=bool(d.get("passed", False)),
            verdict=str(d.get("verdict", "FAIL")).upper(),
            checks=[CheckResult.from_dict(c) for c in d.get("checks", []) if isinstance(c, dict)],
            issues=[Issue.from_dict(i) for i in d.get("issues", []) if isinstance(i, dict)],
            summary=str(d.get("summary", "")),
            raw=d if isinstance(d, dict) else {},
        )

    def to_json(self) -> str:
        return json.dumps({
            "passed": self.passed,
            "verdict": self.verdict,
            "checks": [asdict(c) for c in self.checks],
            "issues": [asdict(i) for i in self.issues],
            "summary": self.summary,
        }, ensure_ascii=False, indent=2)

    def failed_checks(self) -> list[CheckResult]:
        return [c for c in self.checks if not c.passed]

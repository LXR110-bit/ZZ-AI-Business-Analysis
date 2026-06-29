"""skill_loader 的基本测试。"""
from __future__ import annotations

from pathlib import Path

import pytest

from router.skill_loader import _infer_category, _parse_frontmatter, load_skills


def test_parse_frontmatter_valid():
    text = """---
name: weekly_report
description: 生成周报
---

# 内容
"""
    meta = _parse_frontmatter(text)
    assert meta == {"name": "weekly_report", "description": "生成周报"}


def test_parse_frontmatter_no_frontmatter():
    assert _parse_frontmatter("# 没有 frontmatter") is None
    assert _parse_frontmatter("") is None


def test_parse_frontmatter_unterminated():
    assert _parse_frontmatter("---\nname: x\n") is None


def test_infer_category():
    assert _infer_category(Path("skills/process/weekly_report.md")) == "process"
    assert _infer_category(Path("skills/implementation/yoy.md")) == "implementation"
    assert _infer_category(Path("experts/daily_analyst/skills/weekly_report.md")) == "daily_analyst"
    assert _infer_category(Path("README.md")) == "uncategorized"


def test_load_skills_from_real_repo():
    repo_root = Path(__file__).resolve().parents[2]  # router/tests/ → repo root
    skills = load_skills(repo_root)
    # MVP-1 至少有 6 个 skill（周报 / 多维 + 4 个 stub）
    assert len(skills) >= 6, f"只扫到 {len(skills)} 个 skill"
    names = {s.name for s in skills}
    assert "weekly_report" in names

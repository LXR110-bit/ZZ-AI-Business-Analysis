from __future__ import annotations

import importlib
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

mail_sources = importlib.import_module("skills.workflows.机型周数据.mail_sources")


def test_required_mail_sources_are_exactly_six():
    sources = mail_sources.required_sources()

    assert [source.source_key for source in sources] == [
        "category_daily_avg",
        "model_summary",
        "category_summary",
        "model_daily_avg",
        "category_fulfill_daily_avg",
        "category_fulfill_summary",
    ]
    assert all(source.required for source in sources)
    assert sources[0].subject_contains == "AI小万_品类漏斗数据周日均"
    assert sources[1].role == "backup"
    assert sources[1].required is True
    assert sources[3].output_filename("2026-07") == "model_daily_avg_2026-07.csv"


def test_missing_required_sources_reports_subjects():
    present = {"model_daily_avg", "model_summary"}

    missing = mail_sources.missing_required_sources(present)

    assert [source.source_key for source in missing] == [
        "category_daily_avg",
        "category_summary",
        "category_fulfill_daily_avg",
        "category_fulfill_summary",
    ]
    assert missing[0].subject_contains == "AI小万_品类漏斗数据周日均"

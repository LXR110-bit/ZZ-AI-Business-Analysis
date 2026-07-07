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


import json

import pandas as pd

local_imports = importlib.import_module("skills.workflows.机型周数据.local_imports")


def test_write_local_imports_outputs_csv_manifest_and_active(tmp_path: Path):
    outputs = {
        "model_daily_avg": pd.DataFrame(
            [
                {"统计周": "2026-W27", "成交量日均": 2.5, "成交GMV日均": 300.0},
                {"统计周": "2026-W27", "成交量日均": 1.5, "成交GMV日均": 200.0},
            ]
        ),
        "model_summary": pd.DataFrame(
            [{"统计周": "2026-W27", "成交量汇总": 28, "成交GMV汇总": 3500.0}]
        ),
    }

    result = local_imports.write_local_imports(
        outputs=outputs,
        month="2026-07",
        run_id="20260707_093000",
        output_root=tmp_path,
        mail_metadata={"model_daily_avg": {"zip": "a.zip"}},
    )

    assert result["status"] == "ok"
    assert (tmp_path / "model_daily_avg_2026-07.csv").exists()
    assert (tmp_path / "model_summary_2026-07.csv").exists()
    assert not list((tmp_path / ".tmp").glob("**/*.tmp")) if (tmp_path / ".tmp").exists() else True

    manifest = json.loads(Path(result["manifest_path"]).read_text(encoding="utf-8"))
    assert manifest["schema_version"] == 1
    assert manifest["run_id"] == "20260707_093000"
    assert manifest["month"] == "2026-07"
    assert manifest["outputs"]["model_daily_avg"]["row_count"] == 2
    assert manifest["outputs"]["model_daily_avg"]["column_count"] == 3
    assert manifest["outputs"]["model_daily_avg"]["metric_sums"]["成交量日均"] == 4.0
    assert len(manifest["outputs"]["model_daily_avg"]["sha256"]) == 64

    active = json.loads((tmp_path / "active.json").read_text(encoding="utf-8"))
    assert active["run_id"] == "20260707_093000"
    assert active["outputs"]["model_daily_avg"].endswith("model_daily_avg_2026-07.csv")
    assert active["manifest"].endswith("manifests/20260707_093000.json")
    for csv_path in active["outputs"].values():
        assert Path(csv_path).exists()


def test_write_local_imports_does_not_update_active_when_csv_write_fails(monkeypatch, tmp_path: Path):
    old_active = {"schema_version": 1, "run_id": "old", "outputs": {}, "manifest": "old.json"}
    (tmp_path / "active.json").write_text(json.dumps(old_active), encoding="utf-8")
    outputs = {
        "model_daily_avg": pd.DataFrame([{"统计周": "2026-W27", "成交量日均": 1.0}]),
        "model_summary": pd.DataFrame([{"统计周": "2026-W27", "成交量汇总": 7.0}]),
    }
    real_atomic_write_csv = local_imports._atomic_write_csv
    calls = {"count": 0}

    def fail_on_second_csv(df, path, tmp_dir):
        calls["count"] += 1
        if calls["count"] == 2:
            raise RuntimeError("simulated csv failure")
        return real_atomic_write_csv(df, path, tmp_dir)

    monkeypatch.setattr(local_imports, "_atomic_write_csv", fail_on_second_csv)

    with pytest.raises(RuntimeError, match="simulated csv failure"):
        local_imports.write_local_imports(
            outputs=outputs,
            month="2026-07",
            run_id="20260707_093000",
            output_root=tmp_path,
        )

    active = json.loads((tmp_path / "active.json").read_text(encoding="utf-8"))
    assert active == old_active

from __future__ import annotations

import importlib
import sys
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

pipeline = importlib.import_module("skills.workflows.机型周数据.pipeline")


def test_run_local_imports_pipeline_writes_files_without_sheets(monkeypatch, tmp_path: Path):
    raw_by_source = {
        "model_daily_avg": pd.DataFrame([{"日期": date(2026, 7, 6), "统计周": "2026-W28", "成交量日均": 1.0}]),
        "model_summary": pd.DataFrame([{"日期": date(2026, 7, 6), "统计周": "2026-W28", "成交量汇总": 7.0}]),
        "category_daily_avg": pd.DataFrame([{"日期": date(2026, 7, 6), "统计周": "2026-W28", "成交量日均": 2.0}]),
        "category_summary": pd.DataFrame([{"日期": date(2026, 7, 6), "统计周": "2026-W28", "成交量汇总": 14.0}]),
        "category_fulfill_daily_avg": pd.DataFrame([{"日期": date(2026, 7, 6), "统计周": "2026-W28", "签收量日均": 3.0}]),
        "category_fulfill_summary": pd.DataFrame([{"日期": date(2026, 7, 6), "统计周": "2026-W28", "签收量汇总": 21.0}]),
    }

    monkeypatch.setattr(pipeline, "load_local_source_frames", lambda lookback_days: (raw_by_source, {"mail_count": 6}))

    def fail_upsert(*args, **kwargs):
        raise AssertionError("local imports mode must not call Sheets upsert")

    monkeypatch.setattr(pipeline, "upsert_tab", fail_upsert)

    result = pipeline.run_local_imports_pipeline(
        target_months={"2026-07"},
        lookback_days=14,
        output_root=tmp_path,
        run_id="20260707_093000",
    )

    assert result["status"] == "ok"
    assert result["months"] == ["2026-07"]
    assert (tmp_path / "model_daily_avg_2026-07.csv").exists()
    assert (tmp_path / "category_fulfill_summary_2026-07.csv").exists()


import zipfile

import pytest


def _write_xlsx_zip(tmp_path: Path, source_key: str, rows: list[dict]) -> Path:
    xlsx_path = tmp_path / f"{source_key}.xlsx"
    zip_path = tmp_path / f"{source_key}.zip"
    pd.DataFrame(rows).to_excel(xlsx_path, index=False)
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.write(xlsx_path, arcname=f"{source_key}.xlsx")
    return zip_path


def test_load_local_source_frames_reads_all_six_zips(monkeypatch, tmp_path: Path):
    zip_map = {}
    for source_key in [
        "category_daily_avg",
        "model_summary",
        "category_summary",
        "model_daily_avg",
        "category_fulfill_daily_avg",
        "category_fulfill_summary",
    ]:
        zip_map[source_key] = [
            _write_xlsx_zip(
                tmp_path,
                source_key,
                [{"日期": "2026-07-06", "统计周": "2026-W28", "成交量": 1}],
            )
        ]

    monkeypatch.setattr(
        pipeline,
        "fetch_recent_zips_by_subject",
        lambda lookback_days: (zip_map, {"mail_count": 6}),
    )

    frames, metadata = pipeline.load_local_source_frames(lookback_days=14)

    assert sorted(frames) == sorted(zip_map)
    assert metadata["mail_count"] == 6
    assert frames["model_daily_avg"].iloc[0]["统计周"] == "2026-W28"


def test_load_local_source_frames_fails_when_source_has_no_xlsx(monkeypatch, tmp_path: Path):
    empty_zip = tmp_path / "empty.zip"
    with zipfile.ZipFile(empty_zip, "w"):
        pass
    monkeypatch.setattr(
        pipeline,
        "fetch_recent_zips_by_subject",
        lambda lookback_days: ({"model_daily_avg": [empty_zip]}, {"mail_count": 1}),
    )

    with pytest.raises(ValueError, match="no xlsx files"):
        pipeline.load_local_source_frames(lookback_days=14)


run_mod = importlib.import_module("skills.workflows.机型周数据.run")


def test_run_main_local_imports_mode_calls_local_pipeline(monkeypatch, tmp_path: Path):
    calls = {}

    monkeypatch.setattr(run_mod, "_acquire_singleton_lock", lambda: open(__file__, "r", encoding="utf-8"))
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "机型周数据",
            "--local-imports",
            "--months",
            "2026-07",
            "--local-output-dir",
            str(tmp_path),
            "--local-run-id",
            "20260707_093000",
            "--skip-notify",
        ],
    )

    def fake_local_pipeline(**kwargs):
        calls.update(kwargs)
        return {"status": "ok", "months": ["2026-07"], "by_month": {}}

    monkeypatch.setattr(run_mod, "run_local_imports_pipeline", fake_local_pipeline)

    assert run_mod.main() == 0
    assert calls["target_months"] == {"2026-07"}
    assert calls["output_root"] == tmp_path
    assert calls["run_id"] == "20260707_093000"

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

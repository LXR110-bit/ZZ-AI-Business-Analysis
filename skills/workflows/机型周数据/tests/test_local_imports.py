from __future__ import annotations

import zipfile

import pandas as pd

from skills.workflows.机型周数据 import pipeline
from skills.workflows.机型周数据.mail_sources import required_sources


def _write_xlsx(path, row: dict) -> None:
    pd.DataFrame([row]).to_excel(path, index=False)


def _row_for_source(source_key: str) -> dict:
    base = {
        "week_start_date": "2026-07-06",
        "品类名称": "手机",
        "day_cnt": 2,
        "下单uv": 4,
        "下单量": 4,
        "发货量": 3,
        "签收量": 3,
        "质检量": 2,
        "成交量": 1,
        "退回量": 0,
        "成交gmv": 1000,
    }
    if source_key.startswith("model_"):
        base.update({"机型id": "1001", "机型名称": "测试机型", "机况uv": 20, "估价uv": 10})
    elif "fulfill" in source_key:
        base.update({"履约方式（只取线上流程）": "邮寄"})
    else:
        base.update({"机况uv": 20, "估价uv": 10})
    return base


def test_local_imports_accepts_zip_and_xlsx_week_start_snapshots(tmp_path, monkeypatch):
    source_files = {}
    for source in required_sources():
        xlsx = tmp_path / f"{source.source_key}.xlsx"
        _write_xlsx(xlsx, _row_for_source(source.source_key))
        if source.source_key in {"model_summary", "model_daily_avg"}:
            zpath = tmp_path / f"{source.source_key}.zip"
            with zipfile.ZipFile(zpath, "w") as zf:
                zf.write(xlsx, arcname="1.out.xlsx")
            source_files[source.source_key] = [zpath]
        else:
            source_files[source.source_key] = [xlsx]

    def fake_fetch(lookback_days=14):
        return source_files, {
            "since": "2026-07-08",
            "sources": {key: [{"attachment": paths[0].name}] for key, paths in source_files.items()},
            "mail_count": len(source_files),
        }

    monkeypatch.setattr(pipeline, "fetch_recent_zips_by_subject", fake_fetch)

    output_root = tmp_path / "imports"
    result = pipeline.run_local_imports_pipeline(output_root=output_root, run_id="unit_test_20260708")

    assert result["status"] == "ok"
    assert result["months"] == ["2026-07"]
    expected = {source.output_filename("2026-07") for source in required_sources()}
    assert {path.name for path in output_root.glob("*.csv")} == expected

    model = pd.read_csv(output_root / "model_daily_avg_2026-07.csv")
    category = pd.read_csv(output_root / "category_daily_avg_2026-07.csv")
    assert str(model.loc[0, "week_start_date"]) == "2026-07-06"
    assert int(model.loc[0, "day_cnt"]) == 2
    assert int(category.loc[0, "day_cnt"]) == 2

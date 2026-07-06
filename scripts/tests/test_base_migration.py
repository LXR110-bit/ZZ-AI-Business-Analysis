from __future__ import annotations

import importlib
import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

base_migration = importlib.import_module("skills.workflows.机型周数据.base_migration")
constants = importlib.import_module("skills.workflows.机型周数据.constants")


def _raw_df(sheet_id: str) -> pd.DataFrame:
    tab = constants.INTERMEDIATE_TABS[sheet_id]
    rows = []
    for day in [date(2026, 7, 1), date(2026, 7, 2)]:
        row = {
            "日期": day,
            "品类名称": "手机",
            "机型ID": "1001",
            "机型名称": "iPhone 15",
        }
        for dim in tab["extra_dims"]:
            row[dim] = f"{dim}-A"
        for i, metric in enumerate(tab["metrics"], start=1):
            row[metric] = i
        rows.append(row)
    return pd.DataFrame(rows)


def test_build_latest_week_exports_produces_ten_unique_tables():
    raw = {sid: _raw_df(sid) for sid in constants.INTERMEDIATE_TABS}

    week, exports = base_migration.build_latest_week_exports("2026-06", raw, "20260706_162530")

    assert week == "2026-W27"
    assert len(exports) == 10
    names = [e.base_table_name for e in exports]
    assert len(names) == len(set(names))
    assert all(len(name) <= 31 for name in names)
    assert {e.kind for e in exports} == {"summary", "daily_avg"}
    assert all(e.row_count == 1 for e in exports)


def test_write_base_package_manifest_contains_counts_and_metric_sums(tmp_path: Path):
    raw = {sid: _raw_df(sid) for sid in constants.INTERMEDIATE_TABS}
    week, exports = base_migration.build_latest_week_exports("2026-06", raw, "20260706_162530")

    manifest = base_migration.write_base_package("2026-06", week, "20260706_162530", exports, output_root=tmp_path)

    manifest_path = Path(manifest["manifest_path"])
    xlsx_path = Path(manifest["xlsx_path"])
    assert manifest_path.exists()
    assert xlsx_path.exists()
    loaded = json.loads(manifest_path.read_text())
    assert loaded["table_count"] == 10
    assert loaded["total_rows"] == 10
    first_summary = next(t for t in loaded["tables"] if t["kind"] == "summary" and t["source_sheet_id"] == "6725f1")
    assert first_summary["metric_sums"]["估价UV汇总"] == 4.0


def test_matching_active_record_ids_only_matches_same_week_and_table():
    records = [
        {"record_id": "rec_old", "fields": {"统计周": "2026-W27", "Base表名": "W27_汇总_日期机型_202607061625", "active": True}},
        {"record_id": "rec_inactive", "fields": {"统计周": "2026-W27", "Base表名": "W27_汇总_日期机型_202607061625", "active": False}},
        {"record_id": "rec_other_week", "fields": {"统计周": "2026-W28", "Base表名": "W27_汇总_日期机型_202607061625", "active": True}},
        {"record_id": "rec_other_table", "fields": {"统计周": "2026-W27", "Base表名": "W27_日均_日期机型_202607061625", "active": True}},
    ]

    ids = base_migration.matching_active_record_ids(
        records,
        "2026-W27",
        set(),
        table_names={"W27_汇总_日期机型_202607061625"},
    )

    assert ids == ["rec_old"]


def test_matching_active_record_ids_archives_prior_run_by_logical_key():
    records = [
        {
            "record_id": "rec_old_run",
            "fields": {
                "记录键": "2026-W27|summary|6725f1|20260706_100000",
                "统计周": "2026-W27",
                "Base表名": "W27_汇总_日期机型_202607061000",
                "active": True,
            },
        },
        {
            "record_id": "rec_other_sheet",
            "fields": {
                "记录键": "2026-W27|summary|7rBBpo|20260706_100000",
                "统计周": "2026-W27",
                "Base表名": "W27_汇总_估价属性成色_202607061000",
                "active": True,
            },
        },
    ]

    ids = base_migration.matching_active_record_ids(records, "2026-W27", {"2026-W27|summary|6725f1"})

    assert ids == ["rec_old_run"]


def test_build_index_rows_marks_new_version_active():
    manifest = {
        "week": "2026-W27",
        "month": "2026-06",
        "run_id": "20260706_162530",
        "tables": [
            {
                "kind": "summary",
                "source_sheet_id": "6725f1",
                "business_name": "日期机型维度",
                "base_table_name": "W27_汇总_日期机型_202607061625",
                "rows": 123,
                "cols": 17,
            }
        ],
    }

    fields, rows = base_migration.build_index_rows(manifest, {"W27_汇总_日期机型_202607061625": "tbl_x"})

    row = dict(zip(fields, rows[0]))
    assert row["记录键"] == "2026-W27|summary|6725f1|20260706_162530"
    assert row["active"] is True
    assert row["状态"] == "已发布"
    assert row["Base表ID"] == "tbl_x"


def test_load_base_targets_resolves_model_june_targets():
    targets = {
        (target.family, target.kind, target.month): target
        for target in base_migration.load_base_targets()
    }

    assert targets[("model", "summary", "2026-04")].base_token == "VPnqbP4TYaoPl6soQSncd2lNn9e"
    assert targets[("model", "daily_avg", "2026-04")].base_token == "Jv8bbncUUaTaNosCTsQcm6x3nYc"
    assert targets[("category", "summary", "2026-04")].base_token == "HsJ3bmeazah0ggsxUsec2Wfpnsh"
    assert targets[("category", "daily_avg", "2026-04")].base_token == "XZbvbmmyGaEhn2sHc8ucphR2ndc"
    assert targets[("model", "summary", "2026-06")].base_token == "VK0HbNP5daIibss2ME9cTySfnlh"
    assert targets[("model", "daily_avg", "2026-06")].base_token == "M2ETbrDL7agQAzsQJw3cXgGxnWb"
    assert targets[("model", "summary", "2026-07")].base_token == "WDvlbaajfaAMzCs5uXrcLtpMnch"
    assert targets[("model", "daily_avg", "2026-07")].base_token == "QMUZbewNaaCUO5sUsLJcUVM4nAe"


def test_mapped_targets_for_exports_resolves_model_july_targets():
    raw = {sid: _raw_df(sid) for sid in constants.INTERMEDIATE_TABS}
    _, exports = base_migration.build_latest_week_exports("2026-07", raw, "20260706_162530")

    targets = base_migration.mapped_targets_for_exports("2026-07", exports, family="model")

    assert set(targets) == {"summary", "daily_avg"}
    assert targets["summary"].base_token == "WDvlbaajfaAMzCs5uXrcLtpMnch"


def test_mapped_targets_for_exports_fails_fast_when_missing_month_target():
    raw = {sid: _raw_df(sid) for sid in constants.INTERMEDIATE_TABS}
    _, exports = base_migration.build_latest_week_exports("2026-08", raw, "20260706_162530")

    try:
        base_migration.mapped_targets_for_exports("2026-08", exports, family="model")
    except base_migration.LarkError as exc:
        assert "summary" in str(exc)
        assert "daily_avg" in str(exc)
    else:
        raise AssertionError("expected missing model targets for 2026-08")


def test_write_base_package_can_split_target_package(tmp_path: Path):
    raw = {sid: _raw_df(sid) for sid in constants.INTERMEDIATE_TABS}
    week, exports = base_migration.build_latest_week_exports("2026-06", raw, "20260706_162530")
    summary_exports = [export for export in exports if export.kind == "summary"]

    manifest = base_migration.write_base_package(
        "2026-06",
        week,
        "20260706_162530",
        summary_exports,
        output_root=tmp_path,
        package_subdir="model_summary_2026-06",
        package_label="机型维度汇总6月",
        extra_manifest={"target_mode": "mapped_targets"},
    )

    assert Path(manifest["manifest_path"]).parent.name == "model_summary_2026-06"
    assert manifest["table_count"] == 5
    assert manifest["target_mode"] == "mapped_targets"

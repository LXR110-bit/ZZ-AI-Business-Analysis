"""Publish lightweight Base validation records for local CSV imports."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


VALIDATION_INDEX_FIELDS = [
    "记录键",
    "run_id",
    "数据月份",
    "source_key",
    "role",
    "active",
    "状态",
    "文件路径",
    "row_count",
    "column_count",
    "sha256",
    "metric_sums_json",
]


def build_validation_index_rows(manifest: dict[str, Any], active: bool = True) -> tuple[list[str], list[list[Any]]]:
    rows: list[list[Any]] = []
    run_id = str(manifest["run_id"])
    month = str(manifest["month"])
    status = "已发布" if manifest.get("validation_status") == "pass" else "校验失败"
    for source_key, output in sorted(manifest.get("outputs", {}).items()):
        rows.append(
            [
                f"{month}|{source_key}|{run_id}",
                run_id,
                month,
                source_key,
                output.get("role", ""),
                active,
                status,
                output.get("path", ""),
                int(output.get("row_count", 0)),
                int(output.get("column_count", 0)),
                output.get("sha256", ""),
                json.dumps(output.get("metric_sums", {}), ensure_ascii=False, sort_keys=True),
            ]
        )
    return VALIDATION_INDEX_FIELDS, rows


def load_manifest(path: Path | str) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))

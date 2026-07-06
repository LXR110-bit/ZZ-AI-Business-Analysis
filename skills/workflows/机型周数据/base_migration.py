"""Feishu Base migration path for the weekly model funnel workflow.

This module deliberately keeps the high-volume path file-import based:
DataFrame -> XLSX -> ``drive +import --type bitable``.  Base record APIs are
only used for the small publish index, never for the large fact tables.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import pandas as pd

from .constants import (
    DAILY_AVG_TOKENS,
    INTERMEDIATE_TABS,
    SUMMARY_TOKENS,
    SUMMARY_TO_DAILY_AVG_SID,
)
from .lark_helper import LARK_CLI_TIMEOUT, LarkError, run_lark
from .pipeline import (
    _to_daily_avg_df,
    aggregate_by_week,
    fetch_recent_zips,
    load_raw_by_tab,
    split_by_month,
)

BASE_PACKAGE_ROOT = Path(os.environ.get("MODEL_WEEKLY_BASE_PACKAGE_ROOT", "/tmp/机型周数据_base_migration"))
BASE_NAME_PREFIX = os.environ.get("MODEL_WEEKLY_BASE_NAME_PREFIX", "机型周数据")
BASE_TARGETS_PATH = Path(os.environ.get("MODEL_WEEKLY_BASE_TARGET_MAP", str(Path(__file__).with_name("base_targets.json"))))
INDEX_TABLE_NAME = "周索引"

# Keep names <= Excel's 31-char sheet-name limit even with a 12-char run suffix.
TAB_NAME_ALIASES = {
    "6725f1": "日期机型",
    "7rBBpo": "估价属性成色",
    "053Pci": "履约",
    "VsIzPj": "估价属性成色履约",
    "B0ZJKk": "质检成交",
}
KIND_LABELS = {"summary": "汇总", "daily_avg": "日均"}

INDEX_FIELDS = [
    {"name": "记录键", "type": "text"},
    {"name": "统计周", "type": "text"},
    {"name": "数据月份", "type": "text"},
    {"name": "run_id", "type": "text"},
    {"name": "version", "type": "text"},
    {"name": "状态", "type": "text"},
    {"name": "active", "type": "checkbox"},
    {"name": "表类型", "type": "text"},
    {"name": "业务表名", "type": "text"},
    {"name": "Base表名", "type": "text"},
    {"name": "Base表ID", "type": "text"},
    {"name": "行数", "type": "number", "style": {"type": "plain", "precision": 0, "thousands_separator": True}},
    {"name": "列数", "type": "number", "style": {"type": "plain", "precision": 0, "thousands_separator": True}},
    {"name": "校验结果", "type": "text"},
    {"name": "导入时间", "type": "datetime", "style": {"format": "yyyy-MM-dd HH:mm"}},
    {"name": "备注", "type": "text"},
]


@dataclass(frozen=True)
class BaseTableExport:
    month: str
    week: str
    kind: str
    source_sheet_id: str
    daily_sheet_id: str | None
    business_name: str
    base_table_name: str
    df: pd.DataFrame

    @property
    def row_count(self) -> int:
        return int(len(self.df))

    @property
    def col_count(self) -> int:
        return int(len(self.df.columns))


@dataclass(frozen=True)
class BaseTarget:
    """One user-created Base document that receives one workbook import."""

    family: str
    kind: str
    month: str
    label: str
    title: str
    base_token: str
    wiki_node_token: str | None = None
    table_id: str | None = None
    view_id: str | None = None
    url: str | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BaseTarget":
        required = ("family", "kind", "month", "base_token")
        missing = [k for k in required if not data.get(k)]
        if missing:
            raise ValueError(f"base target missing required fields {missing}: {data}")
        return cls(
            family=str(data["family"]),
            kind=str(data["kind"]),
            month=str(data["month"]),
            label=str(data.get("label") or f"{data['family']} {data['kind']} {data['month']}"),
            title=str(data.get("title") or data.get("label") or ""),
            base_token=str(data["base_token"]),
            wiki_node_token=str(data["wiki_node_token"]) if data.get("wiki_node_token") else None,
            table_id=str(data["table_id"]) if data.get("table_id") else None,
            view_id=str(data["view_id"]) if data.get("view_id") else None,
            url=str(data["url"]) if data.get("url") else None,
        )


def load_base_targets(path: Path | str | None = BASE_TARGETS_PATH) -> list[BaseTarget]:
    """Load user-created Base targets.

    The file is optional for package-only runs.  Import runs can choose the
    mapped-target flow when this file contains the requested month/kind.
    """
    if path is None:
        return []
    p = Path(path)
    if not p.exists():
        return []
    payload = json.loads(p.read_text(encoding="utf-8"))
    raw_targets = payload.get("targets", [])
    if not isinstance(raw_targets, list):
        raise ValueError(f"base target map {p} must contain a targets list")
    targets = [BaseTarget.from_dict(x) for x in raw_targets if isinstance(x, dict)]
    seen: set[tuple[str, str, str]] = set()
    duplicates: list[tuple[str, str, str]] = []
    for target in targets:
        key = (target.family, target.kind, target.month)
        if key in seen:
            duplicates.append(key)
        seen.add(key)
    if duplicates:
        raise ValueError(f"duplicate base targets in {p}: {duplicates}")
    return targets


def find_base_target(month: str, kind: str, family: str = "model", path: Path | str | None = BASE_TARGETS_PATH) -> BaseTarget | None:
    for target in load_base_targets(path):
        if target.family == family and target.kind == kind and target.month == month:
            return target
    return None


def mapped_targets_for_exports(
    month: str,
    exports: list[BaseTableExport],
    family: str = "model",
    path: Path | str | None = BASE_TARGETS_PATH,
) -> dict[str, BaseTarget]:
    kinds = sorted({export.kind for export in exports})
    targets: dict[str, BaseTarget] = {}
    missing: list[str] = []
    for kind in kinds:
        target = find_base_target(month, kind, family=family, path=path)
        if target is None:
            missing.append(kind)
        else:
            targets[kind] = target
    if missing:
        raise LarkError(f"missing Base targets for family={family!r} month={month}: kinds={missing}")
    return targets


def _safe_run_suffix(run_id: str) -> str:
    compact = re.sub(r"[^0-9A-Za-z]", "", run_id)
    if len(compact) >= 12:
        return compact[:12]
    return (compact or datetime.now().strftime("%Y%m%d%H%M"))[:12]


def default_run_id(now: datetime | None = None) -> str:
    return (now or datetime.now()).strftime("%Y%m%d_%H%M%S")


def default_base_name(month: str, prefix: str = BASE_NAME_PREFIX) -> str:
    return f"{prefix}_{month}"


def _latest_week(agg: dict[str, pd.DataFrame]) -> str | None:
    latest: str | None = None
    for df in agg.values():
        if df.empty:
            continue
        week = str(df["统计周"].max())
        if latest is None or week > latest:
            latest = week
    return latest


def _base_table_name(week: str, kind: str, source_sheet_id: str, run_id: str) -> str:
    week_short = week.replace("2026-", "").replace("-", "")
    alias = TAB_NAME_ALIASES[source_sheet_id]
    suffix = _safe_run_suffix(run_id)
    name = f"{week_short}_{KIND_LABELS[kind]}_{alias}_{suffix}"
    if len(name) > 31:
        raise ValueError(f"Base import sheet name exceeds Excel limit: {name!r} ({len(name)})")
    return name


def build_latest_week_exports(month: str, tab_dfs: dict[str, pd.DataFrame], run_id: str) -> tuple[str, list[BaseTableExport]]:
    """Aggregate one month and return the latest-week summary/daily exports."""
    agg = aggregate_by_week(tab_dfs)
    latest = _latest_week(agg)
    if latest is None:
        return "", []
    exports: list[BaseTableExport] = []
    for sid, tab in INTERMEDIATE_TABS.items():
        df_sum = agg.get(sid, pd.DataFrame())
        if not df_sum.empty:
            df_sum = df_sum[df_sum["统计周"] == latest].reset_index(drop=True)
        daily_sid = SUMMARY_TO_DAILY_AVG_SID[sid]
        df_daily = _to_daily_avg_df(df_sum, sid)
        exports.append(
            BaseTableExport(
                month=month,
                week=latest,
                kind="summary",
                source_sheet_id=sid,
                daily_sheet_id=None,
                business_name=tab["name"],
                base_table_name=_base_table_name(latest, "summary", sid, run_id),
                df=df_sum,
            )
        )
        exports.append(
            BaseTableExport(
                month=month,
                week=latest,
                kind="daily_avg",
                source_sheet_id=sid,
                daily_sheet_id=daily_sid,
                business_name=tab["name"],
                base_table_name=_base_table_name(latest, "daily_avg", sid, run_id),
                df=df_daily,
            )
        )
    return latest, exports


def _metric_sums(df: pd.DataFrame) -> dict[str, float]:
    sums: dict[str, float] = {}
    for col in df.columns:
        if pd.api.types.is_numeric_dtype(df[col]):
            val = df[col].sum()
            try:
                sums[str(col)] = round(float(val), 6)
            except (TypeError, ValueError):
                pass
    return sums


def write_base_package(
    month: str,
    week: str,
    run_id: str,
    exports: list[BaseTableExport],
    output_root: Path = BASE_PACKAGE_ROOT,
    package_subdir: str | None = None,
    package_label: str = "机型周数据",
    extra_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write the XLSX import package and manifest for one month/week/run."""
    package_dir = output_root / week / run_id
    if package_subdir:
        package_dir = package_dir / package_subdir
    package_dir.mkdir(parents=True, exist_ok=True)
    safe_label = re.sub(r"[\\/:\*\?\"<>\|]+", "_", package_label).strip() or "机型周数据"
    xlsx_path = package_dir / f"{safe_label}_{month}_{week}_{run_id}.xlsx"
    manifest_path = package_dir / "manifest.json"

    with pd.ExcelWriter(xlsx_path, engine="openpyxl") as writer:
        for export in exports:
            export.df.to_excel(writer, index=False, sheet_name=export.base_table_name)

    tables = []
    for export in exports:
        tables.append(
            {
                "month": export.month,
                "week": export.week,
                "kind": export.kind,
                "source_sheet_id": export.source_sheet_id,
                "daily_sheet_id": export.daily_sheet_id,
                "business_name": export.business_name,
                "base_table_name": export.base_table_name,
                "rows": export.row_count,
                "cols": export.col_count,
                "columns": [str(c) for c in export.df.columns],
                "metric_sums": _metric_sums(export.df),
            }
        )
    manifest = {
        "schema_version": 1,
        "mode": "base_migration_package",
        "month": month,
        "week": week,
        "run_id": run_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "xlsx_path": str(xlsx_path),
        "manifest_path": str(manifest_path),
        "table_count": len(tables),
        "total_rows": int(sum(t["rows"] for t in tables)),
        "tables": tables,
    }
    if extra_manifest:
        manifest.update(extra_manifest)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def _run_lark_file_arg(args: list[str], cwd: Path, as_identity: str) -> dict[str, Any]:
    cmd = ["lark-cli", *args, "--as", as_identity]
    try:
        proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True, timeout=LARK_CLI_TIMEOUT)
    except subprocess.TimeoutExpired as e:
        raise LarkError(f"{args[:3]} timed out after {LARK_CLI_TIMEOUT}s") from e
    payload = proc.stdout if proc.stdout and "{" in proc.stdout else proc.stderr
    try:
        parsed = json.loads(payload[payload.index("{"):])
    except (ValueError, json.JSONDecodeError) as e:
        raise LarkError(f"non-json output from {args[:2]}: stdout={proc.stdout[:200]} stderr={proc.stderr[:200]}") from e
    if not parsed.get("ok", False):
        raise LarkError(f"{args[:3]} failed: {parsed.get('error', {}).get('message', '?')}")
    return parsed.get("data", {})


def _deep_find_first(obj: Any, keys: set[str]) -> Any:
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key in keys and value:
                return value
        for value in obj.values():
            found = _deep_find_first(value, keys)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = _deep_find_first(item, keys)
            if found:
                return found
    return None


def _items_from_data(data: dict[str, Any], candidate_keys: Iterable[str]) -> list[dict[str, Any]]:
    for key in candidate_keys:
        value = data.get(key)
        if isinstance(value, list):
            return [x for x in value if isinstance(x, dict)]
    nested = data.get("data")
    if isinstance(nested, dict):
        return _items_from_data(nested, candidate_keys)
    return []


def _records_from_record_list_data(data: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize ``base +record-list`` responses to record dicts.

    ``lark-cli base +record-list`` can return either API-shaped records
    (``records`` / ``items``) or a compact table-shaped payload:

    ``{"fields": [...], "data": [[...]], "record_id_list": [...]}``

    The publish flow needs real ``record_id`` + field-name mapping in order to
    archive previous active versions before inserting the new run.
    """
    items = _items_from_data(data, ["records", "items", "list"])
    if items:
        return items

    rows = data.get("data")
    fields = data.get("fields")
    record_ids = data.get("record_id_list") or data.get("record_ids") or []
    if not isinstance(rows, list) or not isinstance(fields, list):
        return []

    field_names = [str(field) for field in fields]
    normalized: list[dict[str, Any]] = []
    for idx, row in enumerate(rows):
        if isinstance(row, dict):
            fields_dict = row
        elif isinstance(row, list):
            fields_dict = {
                field_name: row[pos] if pos < len(row) else None
                for pos, field_name in enumerate(field_names)
            }
        else:
            continue
        record: dict[str, Any] = {"fields": fields_dict}
        if isinstance(record_ids, list) and idx < len(record_ids) and record_ids[idx]:
            record["record_id"] = str(record_ids[idx])
        normalized.append(record)
    return normalized


def resolve_base_token_by_title(title: str, as_identity: str = "user") -> str | None:
    try:
        data = run_lark("base", "+title-resolve", "--title", title, as_identity=as_identity)
    except LarkError:
        return None
    return _deep_find_first(data, {"base_token", "app_token", "token"})


def create_month_base(month: str, as_identity: str = "user", base_name_prefix: str = BASE_NAME_PREFIX) -> str:
    data = run_lark(
        "base",
        "+base-create",
        "--name",
        default_base_name(month, base_name_prefix),
        "--table-name",
        INDEX_TABLE_NAME,
        "--fields",
        json.dumps(INDEX_FIELDS, ensure_ascii=False),
        "--time-zone",
        "Asia/Shanghai",
        as_identity=as_identity,
    )
    token = _deep_find_first(data, {"base_token", "app_token", "token"})
    if not token:
        raise LarkError(f"base-create did not return a base token: {data}")
    return str(token)


def resolve_or_create_month_base(month: str, explicit_token: str | None = None, as_identity: str = "user", base_name_prefix: str = BASE_NAME_PREFIX) -> str:
    if explicit_token:
        return explicit_token
    env_key = f"MODEL_WEEKLY_BASE_TOKEN_{month.replace('-', '_')}"
    if os.environ.get(env_key):
        return os.environ[env_key]
    if os.environ.get("MODEL_WEEKLY_BASE_TOKEN"):
        return os.environ["MODEL_WEEKLY_BASE_TOKEN"]
    title = default_base_name(month, base_name_prefix)
    token = resolve_base_token_by_title(title, as_identity=as_identity)
    if token:
        return str(token)
    return create_month_base(month, as_identity=as_identity, base_name_prefix=base_name_prefix)


def base_table_list(base_token: str, as_identity: str = "user") -> list[dict[str, Any]]:
    data = run_lark("base", "+table-list", "--base-token", base_token, as_identity=as_identity)
    return _items_from_data(data, ["tables", "items", "list"])


def _table_name(table: dict[str, Any]) -> str:
    return str(table.get("name") or table.get("table_name") or table.get("title") or "")


def _table_id(table: dict[str, Any]) -> str:
    return str(table.get("table_id") or table.get("id") or table.get("tableId") or "")


def ensure_index_table(base_token: str, as_identity: str = "user") -> str:
    for table in base_table_list(base_token, as_identity=as_identity):
        if _table_name(table) == INDEX_TABLE_NAME:
            table_id = _table_id(table)
            if table_id:
                return table_id
    data = run_lark(
        "base",
        "+table-create",
        "--base-token",
        base_token,
        "--name",
        INDEX_TABLE_NAME,
        "--fields",
        json.dumps(INDEX_FIELDS, ensure_ascii=False),
        as_identity=as_identity,
    )
    table_id = _deep_find_first(data, {"table_id", "id", "tableId"})
    if not table_id:
        raise LarkError(f"table-create did not return a table id: {data}")
    return str(table_id)


def import_package_to_base(xlsx_path: Path, base_token: str, as_identity: str = "user") -> dict[str, Any]:
    # lark-cli drive +import intentionally rejects absolute --file paths. Run from the package dir.
    return _run_lark_file_arg(
        ["drive", "+import", "--file", xlsx_path.name, "--type", "bitable", "--target-token", base_token, "--name", xlsx_path.stem],
        cwd=xlsx_path.parent,
        as_identity=as_identity,
    )


def _record_id(record: dict[str, Any]) -> str:
    return str(record.get("record_id") or record.get("id") or record.get("recordId") or "")


def _record_fields(record: dict[str, Any]) -> dict[str, Any]:
    fields = record.get("fields")
    return fields if isinstance(fields, dict) else record


def list_index_records(base_token: str, index_table_id: str, as_identity: str = "user") -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    offset = 0
    while True:
        data = run_lark(
            "base",
            "+record-list",
            "--base-token",
            base_token,
            "--table-id",
            index_table_id,
            "--limit",
            "200",
            "--offset",
            str(offset),
            "--format",
            "json",
            as_identity=as_identity,
        )
        page = _records_from_record_list_data(data)
        records.extend(page)
        has_more = bool(data.get("has_more") or data.get("hasMore"))
        if not has_more or len(page) < 200:
            break
        offset += len(page)
    return records


def _index_logical_key(fields: dict[str, Any]) -> str | None:
    """Return the stable publish key without run_id.

    记录键 is written as ``统计周|表类型|source_sheet_id|run_id``.  Imported Base
    table names include run_id, so deduping by Base表名 would leave old
    versions active forever.  The first three parts are the logical table key.
    """
    key = fields.get("记录键")
    if not key:
        return None
    parts = str(key).split("|")
    if len(parts) < 3:
        return None
    return "|".join(parts[:3])


def matching_active_record_ids(
    records: list[dict[str, Any]],
    week: str,
    logical_keys: set[str],
    table_names: set[str] | None = None,
) -> list[str]:
    ids: list[str] = []
    for record in records:
        fields = _record_fields(record)
        active = fields.get("active")
        logical_key = _index_logical_key(fields)
        table_name = fields.get("Base表名")
        matches_logical_key = logical_key in logical_keys if logical_key else False
        matches_table_name = table_names is not None and table_name in table_names
        if fields.get("统计周") == week and active is True and (matches_logical_key or matches_table_name):
            rid = _record_id(record)
            if rid:
                ids.append(rid)
    return ids


def _chunked(values: list[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(values), size):
        yield values[i : i + size]


def archive_index_records(base_token: str, index_table_id: str, record_ids: list[str], as_identity: str = "user") -> int:
    total = 0
    for chunk in _chunked(record_ids, 200):
        run_lark(
            "base",
            "+record-batch-update",
            "--base-token",
            base_token,
            "--table-id",
            index_table_id,
            "--json",
            json.dumps({"record_id_list": chunk, "patch": {"active": False, "状态": "已归档"}}, ensure_ascii=False),
            as_identity=as_identity,
        )
        total += len(chunk)
    return total


def build_index_rows(manifest: dict[str, Any], base_tables: dict[str, str], status: str = "已发布", active: bool = True) -> tuple[list[str], list[list[Any]]]:
    fields = [
        "记录键",
        "统计周",
        "数据月份",
        "run_id",
        "version",
        "状态",
        "active",
        "表类型",
        "业务表名",
        "Base表名",
        "Base表ID",
        "行数",
        "列数",
        "校验结果",
        "导入时间",
        "备注",
    ]
    imported_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rows: list[list[Any]] = []
    for table in manifest["tables"]:
        base_table_name = table["base_table_name"]
        key = f"{manifest['week']}|{table['kind']}|{table['source_sheet_id']}|{manifest['run_id']}"
        rows.append(
            [
                key,
                manifest["week"],
                manifest["month"],
                manifest["run_id"],
                manifest["run_id"],
                status,
                active,
                table["kind"],
                table["business_name"],
                base_table_name,
                base_tables.get(base_table_name, ""),
                int(table["rows"]),
                int(table["cols"]),
                "manifest_matched",
                imported_at,
                "drive_import_bitable",
            ]
        )
    return fields, rows


def publish_manifest_to_index(base_token: str, index_table_id: str, manifest: dict[str, Any], as_identity: str = "user") -> dict[str, Any]:
    tables = base_table_list(base_token, as_identity=as_identity)
    table_map = {_table_name(t): _table_id(t) for t in tables if _table_name(t)}
    expected_names = {t["base_table_name"] for t in manifest["tables"]}
    logical_keys = {f"{manifest['week']}|{t['kind']}|{t['source_sheet_id']}" for t in manifest["tables"]}
    missing = sorted(expected_names - set(table_map))
    if missing:
        raise LarkError(f"imported Base tables missing after import: {missing[:5]}")

    existing = list_index_records(base_token, index_table_id, as_identity=as_identity)
    to_archive = matching_active_record_ids(existing, manifest["week"], logical_keys, table_names=expected_names)
    archived = archive_index_records(base_token, index_table_id, to_archive, as_identity=as_identity) if to_archive else 0

    fields, rows = build_index_rows(manifest, table_map, status="已发布", active=True)
    created = 0
    for chunk_rows in [rows[i : i + 200] for i in range(0, len(rows), 200)]:
        run_lark(
            "base",
            "+record-batch-create",
            "--base-token",
            base_token,
            "--table-id",
            index_table_id,
            "--json",
            json.dumps({"fields": fields, "rows": chunk_rows}, ensure_ascii=False),
            as_identity=as_identity,
        )
        created += len(chunk_rows)
    return {"archived_records": archived, "created_records": created, "base_tables": {name: table_map[name] for name in expected_names}}


def import_manifest_to_base(
    manifest: dict[str, Any],
    base_token: str,
    as_identity: str = "user",
    target: BaseTarget | None = None,
) -> dict[str, Any]:
    """Import one manifest's workbook into a Base and publish its index."""
    result: dict[str, Any] = {"base_token": base_token}
    if target:
        result.update(
            {
                "target_label": target.label,
                "target_family": target.family,
                "target_kind": target.kind,
                "target_month": target.month,
                "target_url": target.url,
            }
        )
    import_data = import_package_to_base(Path(manifest["xlsx_path"]), base_token, as_identity=as_identity)
    result["import"] = import_data
    if import_data.get("ready") is False or import_data.get("timed_out") is True:
        result["status"] = "import_pending"
        return result

    index_table_id = ensure_index_table(base_token, as_identity=as_identity)
    publish = publish_manifest_to_index(base_token, index_table_id, manifest, as_identity=as_identity)
    result["index_table_id"] = index_table_id
    result["publish"] = publish
    result["status"] = "published"
    return result


def write_and_import_mapped_target_packages(
    month: str,
    week: str,
    run_id: str,
    exports: list[BaseTableExport],
    output_root: Path,
    target_family: str = "model",
    target_map_path: Path | str | None = BASE_TARGETS_PATH,
    as_identity: str = "user",
) -> dict[str, Any]:
    """Split summary/daily exports and import each part to a user-created Base.

    User-created targets are keyed by ``family + kind + month``.  For the
    current workflow, family=model receives two Base docs per month:
    one for summary sheets and one for daily-average sheets.
    """
    targets = mapped_targets_for_exports(month, exports, family=target_family, path=target_map_path)
    result: dict[str, Any] = {"mode": "mapped_targets", "family": target_family, "targets": {}}
    for kind, target in sorted(targets.items()):
        kind_exports = [export for export in exports if export.kind == kind]
        label = target.label or f"{target_family}_{kind}"
        manifest = write_base_package(
            month,
            week,
            run_id,
            kind_exports,
            output_root=output_root,
            package_subdir=f"{target_family}_{kind}_{month}",
            package_label=label,
            extra_manifest={
                "target_mode": "mapped_targets",
                "target_family": target_family,
                "target_kind": kind,
                "target_label": target.label,
                "target_title": target.title,
                "target_base_token": target.base_token,
                "target_url": target.url,
            },
        )
        target_result = {
            "status": "packaged",
            "kind": kind,
            "label": target.label,
            "url": target.url,
            "base_token": target.base_token,
            "package_dir": str(Path(manifest["manifest_path"]).parent),
            "xlsx_path": manifest["xlsx_path"],
            "manifest_path": manifest["manifest_path"],
            "table_count": manifest["table_count"],
            "total_rows": manifest["total_rows"],
        }
        target_result.update(import_manifest_to_base(manifest, target.base_token, as_identity=as_identity, target=target))
        result["targets"][kind] = target_result
    statuses = {target_result.get("status") for target_result in result["targets"].values()}
    result["status"] = "published" if statuses == {"published"} else "import_pending" if "import_pending" in statuses else "partial"
    return result


def run_base_migration_pipeline(
    target_months: set[str] | None = None,
    lookback_days: int = 14,
    output_root: Path = BASE_PACKAGE_ROOT,
    run_id: str | None = None,
    import_to_base: bool = False,
    base_token: str | None = None,
    as_identity: str = "user",
    base_name_prefix: str = BASE_NAME_PREFIX,
    import_mode: str = "auto",
    target_map_path: Path | str | None = BASE_TARGETS_PATH,
    target_family: str = "model",
) -> dict[str, Any]:
    if import_mode not in {"auto", "mapped", "monthly"}:
        raise ValueError(f"invalid import_mode={import_mode!r}; expected auto, mapped, or monthly")
    run_id = run_id or default_run_id()
    print(f"[base-migration] fetch zips lookback_days={lookback_days}", flush=True)
    zips = fetch_recent_zips(lookback_days=lookback_days)
    print(f"[base-migration] zips={[z.name for z in zips]}", flush=True)
    if not zips:
        return {"status": "no_email", "mode": "base_migration", "run_id": run_id}

    print("[base-migration] load raw start", flush=True)
    raw = load_raw_by_tab(zips)
    print("[base-migration] load raw done", flush=True)
    by_month = split_by_month(raw)
    if target_months:
        by_month = {m: v for m, v in by_month.items() if m in target_months}
    if not by_month:
        return {"status": "no_data_in_target_months", "mode": "base_migration", "run_id": run_id, "zips": [z.name for z in zips]}

    by_month_result: dict[str, Any] = {}
    any_error = False
    for month, tab_dfs in sorted(by_month.items()):
        try:
            week, exports = build_latest_week_exports(month, tab_dfs, run_id)
            if not exports:
                by_month_result[month] = {"status": "empty", "month": month}
                continue
            manifest = write_base_package(month, week, run_id, exports, output_root=output_root)
            month_result: dict[str, Any] = {
                "status": "packaged",
                "month": month,
                "week": week,
                "run_id": run_id,
                "package_dir": str(Path(manifest["manifest_path"]).parent),
                "xlsx_path": manifest["xlsx_path"],
                "manifest_path": manifest["manifest_path"],
                "table_count": manifest["table_count"],
                "total_rows": manifest["total_rows"],
                "tables": manifest["tables"],
            }
            if import_to_base:
                use_mapped_targets = (
                    import_mode == "mapped"
                    or (
                        import_mode == "auto"
                        and base_token is None
                        and target_map_path is not None
                        and Path(target_map_path).exists()
                    )
                )
                if use_mapped_targets:
                    target_import = write_and_import_mapped_target_packages(
                        month,
                        week,
                        run_id,
                        exports,
                        output_root=output_root,
                        target_family=target_family,
                        target_map_path=target_map_path,
                        as_identity=as_identity,
                    )
                    month_result["target_import"] = target_import
                    month_result["status"] = target_import.get("status", "partial")
                    if month_result["status"] != "published":
                        any_error = True
                else:
                    token = resolve_or_create_month_base(month, explicit_token=base_token, as_identity=as_identity, base_name_prefix=base_name_prefix)
                    month_result.update(import_manifest_to_base(manifest, token, as_identity=as_identity))
                    if month_result["status"] != "published":
                        any_error = True
            by_month_result[month] = month_result
        except Exception as exc:  # keep other months inspectable
            any_error = True
            by_month_result[month] = {"status": "error", "month": month, "error": repr(exc)}
            print(f"[base-migration] {month} FAILED: {exc!r}", flush=True)

    return {
        "status": "partial" if any_error else "ok",
        "mode": "base_migration",
        "run_id": run_id,
        "zips": [z.name for z in zips],
        "months": sorted(by_month.keys()),
        "by_month": by_month_result,
    }

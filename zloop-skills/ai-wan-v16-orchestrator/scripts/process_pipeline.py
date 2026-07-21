"""Memory-conscious AI 小万 PROCESS pipeline.

This module is deliberately stdlib-only.  It keeps the v1.5.5 artifact
contract, but reads CSVs row-by-row and aggregates before building JSON
payloads so the process stage does not need a large Node heap.
"""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import shutil
import tempfile
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator


CONTRACT_VERSION = "ai-wan-v1.5.5-process"
FETCH_CONTRACT_VERSION = "ai-wan-v1.5.5-fetch"
CATEGORY_MAPPING_CONTRACT_VERSION = "ai-wan-category-mapping/v1"
CATEGORY_MAPPING_BASE_TOKEN = "NKw4b2eKxaKhDTsOrD9cONklnGb"
CATEGORY_MAPPING_TABLE = "品类映射"
KEEP_WEEKS = 10
DASHBOARD_WINDOW_WEEKS = 2
MIN_HISTORY_WEEKS_FOR_TREND = 8
RAW_SCRIPTS = (
    "category_daily_avg",
    "category_summary",
    "category_fulfill_daily_avg",
    "category_fulfill_summary",
    "sqldau",
    "model_daily_avg",
    "model_summary",
)
BASE_SCRIPTS = tuple(script for script in RAW_SCRIPTS if not script.startswith("model_"))
MATERIALIZE_SCRIPTS = set(RAW_SCRIPTS) - {"model_summary"}
METRIC_HEADERS = (
    "机况uv", "估价uv", "下单uv", "下单量", "发货量", "签收量", "质检量",
    "成交量", "退回量", "成交gmv",
)
METRIC_ALIASES = {
    "机况uv": ("机况uv", "机况UV", "ji_kuang_uv", "jkuv", "jk_uv"),
    "估价uv": ("估价uv", "估价UV", "gu_jia_uv", "eva_uv", "evaUv"),
    "下单uv": ("下单uv", "下单UV", "xia_dan_uv", "order_uv", "orderUv"),
    "下单量": ("下单量", "xia_dan_cnt", "order_cnt", "orderCnt"),
    "发货量": ("发货量", "fa_huo_cnt", "ship_cnt", "shipCnt"),
    "签收量": ("签收量", "qian_shou_cnt", "sign_cnt", "signCnt"),
    "质检量": ("质检量", "zhi_jian_cnt", "qc_cnt", "qcCnt"),
    "成交量": ("成交量", "cheng_jiao_cnt", "deal_cnt", "dealCnt"),
    "退回量": ("退回量", "tui_hui_cnt", "return_cnt", "returnCnt"),
    "成交gmv": ("成交gmv", "成交GMV", "cheng_jiao_gmv", "deal_gmv", "gmv"),
}
CACHE_METRICS = (
    "jkuv", "evaUv", "orderUv", "orderCnt", "shipCnt", "signCnt", "qcCnt",
    "dealCnt", "returnCnt", "gmv",
)
ORDER_CHAIN_EMPTY_CODE = "DATA_INTEGRITY_ORDER_CHAIN_EMPTY"
ORDER_CHAIN_METRICS = ("orderUv", "orderCnt", "shipCnt", "signCnt", "qcCnt", "dealCnt", "gmv")
UV_METRICS = ("jkuv", "evaUv")
MODEL_DETAIL_HEADERS = (
    "核心属性（估价）", "成色等级（估价）", "核心属性（质检）", "成色等级（质检）",
    "履约方式（只取线上流程）",
)
DEFAULT_VOCAB = {
    "core": ["核心", "非核心", "观察"],
    "lifecycle": ["新品", "主流", "长尾", "淘汰"],
    "price": ["高价段", "中价段", "低价段"],
    "custom": {},
}
LOW_VOLUME_BASELINE_THRESHOLDS = {"gmv": 1000, "dealCnt": 2, "orderCnt": 5, "evaUv": 20}
DEFAULT_MODEL_CACHE_TOP_N_PER_CATEGORY_WEEK = 80


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, fallback: Any = None) -> Any:
    if not path.exists():
        return fallback
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _sort_json(value: Any) -> Any:
    if isinstance(value, list):
        return [_sort_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _sort_json(value[key]) for key in sorted(value)}
    return value


def sha256_json(value: Any) -> str:
    payload = json.dumps(_sort_json(value), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def rel(root: Path, path: Path) -> str:
    return path.relative_to(root).as_posix()


def normalize_header(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip().replace("_", "")).lower()


def text_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return str(value).strip()
    if isinstance(value, list):
        return ",".join(item for item in (text_value(v) for v in value) if item)
    if isinstance(value, dict):
        for key in ("text", "name", "value", "en_name", "fields"):
            if key in value:
                return text_value(value[key])
    return ""


def to_num(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        return float(value) if value == value else 0.0
    try:
        return float(str(value).replace(",", "").replace("%", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _number_string(value: float) -> int | float:
    numeric = float(value)
    return int(numeric) if numeric.is_integer() else numeric


def first(row: dict[str, Any], candidates: Iterable[str]) -> Any:
    for candidate in candidates:
        if candidate in row:
            return row[candidate]
    normalized = {normalize_header(key): key for key in row}
    for candidate in candidates:
        hit = normalized.get(normalize_header(candidate))
        if hit is not None:
            return row[hit]
    return ""


def parse_csv_file(path: Path, repair_model_name_commas: bool = False) -> tuple[list[str], list[dict[str, str]], dict[str, int]]:
    """Parse CSV with the legacy model-name comma repair.

    The iterator is intentionally consumed one row at a time by callers; the
    returned list is retained only for small metadata/fixture paths.
    """
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        try:
            original = next(reader)
        except StopIteration:
            return [], [], {"fixed_rows": 0, "bad_rows": 0}
        headers: list[str] = []
        seen: dict[str, int] = {}
        for value in original:
            base = str(value or "").strip()
            count = seen.get(base, 0)
            seen[base] = count + 1
            headers.append(base if count == 0 else f"{base}.{count}")
        model_index = next((i for i, header in enumerate(headers) if normalize_header(header) in {
            normalize_header(x) for x in ("机型名称", "型号名称", "型号", "model_name", "model_name_label", "modelName")
        }), -1)
        rows: list[dict[str, str]] = []
        repair = {"fixed_rows": 0, "bad_rows": 0}
        for columns in reader:
            if not columns or all(not str(item).strip() for item in columns):
                continue
            if repair_model_name_commas and len(columns) > len(headers) and model_index >= 0:
                surplus = len(columns) - len(headers)
                columns = (columns[:model_index] + [",".join(columns[model_index:model_index + surplus + 1])] +
                           columns[model_index + surplus + 1:])
                repair["fixed_rows"] += 1
            if len(columns) != len(headers):
                repair["bad_rows"] += 1
            rows.append({header: (columns[i] if i < len(columns) else "") for i, header in enumerate(headers)})
    return headers, rows, repair


def iter_csv_file(path: Path, repair_model_name_commas: bool = False) -> tuple[list[str], Iterator[dict[str, str]], dict[str, int]]:
    """Return headers and a lazy row iterator, keeping file memory bounded."""
    handle = path.open("r", encoding="utf-8-sig", newline="")
    reader = csv.reader(handle)
    try:
        original = next(reader)
    except StopIteration:
        handle.close()
        return [], iter(()), {"fixed_rows": 0, "bad_rows": 0}
    headers: list[str] = []
    seen: dict[str, int] = {}
    for value in original:
        base = str(value or "").strip()
        count = seen.get(base, 0)
        seen[base] = count + 1
        headers.append(base if count == 0 else f"{base}.{count}")
    model_index = next((i for i, header in enumerate(headers) if normalize_header(header) in {
        normalize_header(x) for x in ("机型名称", "型号名称", "型号", "model_name", "model_name_label", "modelName")
    }), -1)
    repair = {"fixed_rows": 0, "bad_rows": 0}

    def rows() -> Iterator[dict[str, str]]:
        try:
            for columns in reader:
                if not columns or all(not str(item).strip() for item in columns):
                    continue
                if repair_model_name_commas and len(columns) > len(headers) and model_index >= 0:
                    surplus = len(columns) - len(headers)
                    columns = (columns[:model_index] + [",".join(columns[model_index:model_index + surplus + 1])] +
                               columns[model_index + surplus + 1:])
                    repair["fixed_rows"] += 1
                if len(columns) != len(headers):
                    repair["bad_rows"] += 1
                yield {header: (columns[i] if i < len(columns) else "") for i, header in enumerate(headers)}
        finally:
            handle.close()

    return headers, rows(), repair


def csv_data_row_count(path: Path) -> int:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return max(sum(1 for _ in csv.reader(handle)) - 1, 0)


def csv_escape(value: Any) -> str:
    return str(value if value is not None else "")


def write_csv(path: Path, headers: list[str], rows: Iterable[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=headers, extrasaction="ignore", lineterminator="\n")
        writer.writeheader()
        writer.writerows({header: csv_escape(row.get(header, "")) for header in headers} for row in rows)


def add_days(date_str: str, days: int) -> str:
    try:
        return (date.fromisoformat(str(date_str)) + timedelta(days=days)).isoformat()
    except ValueError:
        return ""


def date_diff_days(a: str, b: str) -> int | None:
    try:
        return (date.fromisoformat(str(a)) - date.fromisoformat(str(b))).days
    except ValueError:
        return None


def date_to_iso_week(date_str: str) -> str:
    try:
        iso = date.fromisoformat(str(date_str).strip()).isocalendar()
        return f"{iso.year}-W{iso.week:02d}"
    except ValueError:
        return ""


def rolling_info(week_start: str, run_dt: str) -> dict[str, Any]:
    end_date = add_days(week_start, 6)
    diff = date_diff_days(run_dt, week_start)
    if diff is None:
        return {"day_cnt": 0, "week": "", "startDate": week_start, "endDate": end_date, "rolling_status": "unknown"}
    day_count = min(7, max(1, diff + 1))
    status = "rolling" if day_count < 7 and (date_diff_days(run_dt, end_date) or 0) <= 0 else "final"
    return {
        "day_cnt": 7 if status == "final" else day_count,
        "week": date_to_iso_week(week_start),
        "startDate": week_start,
        "endDate": end_date,
        "rolling_status": status,
    }


def explicit_daily_average_header(header: str) -> bool:
    return bool(re.search(r"日均|daily[_\s-]*avg|avg[_\s-]*daily", str(header or ""), re.I))


def canonical_import_rows(script: str, rows: Iterable[dict[str, str]], run_dt: str, repairs: dict[str, int]) -> Iterator[dict[str, str]]:
    for raw in rows:
        week_start = str(first(raw, ("week_start_date", "周开始", "开始日期", "统计日期", "日期", "startDate"))).strip()
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", week_start):
            continue
        info = rolling_info(week_start, run_dt)
        base: dict[str, str] = {"week_start_date": week_start}
        if script == "sqldau":
            days = to_num(first(raw, ("day_cnt", "已收到天数", "daysReceived"))) or info["day_cnt"]
            base.update({
                "day_cnt": str(_number_string(days)),
                "APP日均DAU": str(first(raw, ("avg_dau", "APP日均DAU", "APP日均 DAU", "appDau", "dau"))).strip(),
                "回收入口UV": str(first(raw, ("avg_recycle_entrance_uv", "回收入口UV", "回收入口 UV", "recycleEntranceUv", "entryUv"))).strip(),
            })
            yield base
            continue
        if "category" in script:
            base["品类名称"] = str(first(raw, ("品类名称", "品类", "三级品类", "cate_name", "cate_name_label", "category_name", "category_name_label"))).strip()
        if "fulfill" in script:
            base["履约方式（只取线上流程）"] = str(first(raw, ("履约方式（只取线上流程）", "履约方式", "order_source_name", "fulfillmentMethod", "fulfill_type", "fulfillment_type"))).strip()
        if "model" in script:
            base.update({
                "品类名称": str(first(raw, ("品类名称", "品类", "cate_name", "cate_name_label", "category_name", "category_name_label"))).strip(),
                "机型id": re.sub(r"^(\d+)\.0+$", r"\1", str(first(raw, ("机型id", "机型ID", "型号ID", "model_id", "model_id_col", "modelId"))).strip()),
                "机型名称": str(first(raw, ("机型名称", "型号名称", "型号", "model_name", "model_name_label", "modelName"))).strip(),
                "核心属性（估价）": str(first(raw, ("核心属性（估价）", "核心属性_估价", "ev_param_name"))).strip(),
                "成色等级（估价）": str(first(raw, ("成色等级（估价）", "成色等级_估价", "ev_grade_name"))).strip(),
                "品类名称.1": str(first(raw, ("品类名称.1", "品类名称", "品类", "cate_name", "cate_name_label", "category_name", "category_name_label"))).strip(),
                "机型id.1": re.sub(r"^(\d+)\.0+$", r"\1", str(first(raw, ("机型id.1", "机型ID.1", "机型id", "机型ID", "model_id", "model_id_col", "modelId"))).strip()),
                "核心属性（质检）": str(first(raw, ("核心属性（质检）", "核心属性_质检", "qc_param_name"))).strip(),
                "成色等级（质检）": str(first(raw, ("成色等级（质检）", "成色等级_质检", "qc_grade_name"))).strip(),
                "履约方式（只取线上流程）": str(first(raw, ("履约方式（只取线上流程）", "履约方式", "order_source_name", "fulfillmentMethod", "fulfill_type", "fulfillment_type"))).strip(),
            })
        days = to_num(first(raw, ("day_cnt", "已收到天数", "daysReceived"))) or info["day_cnt"]
        base["day_cnt"] = str(_number_string(days))
        for header in METRIC_HEADERS:
            value = first(raw, METRIC_ALIASES.get(header, (header,)))
            base[header] = "" if value == "" else str(value).strip()
        if "category" in script and not base.get("品类名称"):
            continue
        if "model" in script and not base.get("机型名称"):
            continue
        yield base


def headers_for(script: str) -> list[str]:
    if script == "sqldau":
        return ["week_start_date", "day_cnt", "APP日均DAU", "回收入口UV"]
    if script.startswith("category_fulfill"):
        return ["week_start_date", "品类名称", "履约方式（只取线上流程）", "day_cnt", *METRIC_HEADERS[2:]]
    if script.startswith("category"):
        return ["week_start_date", "品类名称", "day_cnt", *METRIC_HEADERS]
    return ["week_start_date", "品类名称", "机型id", "机型名称", "day_cnt", *METRIC_HEADERS,
            *MODEL_DETAIL_HEADERS[:2], "品类名称.1", "机型id.1", *MODEL_DETAIL_HEADERS[2:]]


def script_raw_file(unpacked: Path, script: str, run_dt: str) -> Path | None:
    raw_dir = unpacked / "raw"
    exact = raw_dir / f"{script}_{run_dt}.csv"
    if exact.exists():
        return exact
    if not raw_dir.exists():
        return None
    for path in sorted(raw_dir.iterdir()):
        if path.name == f"{script}.csv" or (path.name.startswith(f"{script}_") and path.suffix == ".csv"):
            return path
    return None


def known_gap_for_empty_raw(script: str) -> str:
    return f"{script}_empty" if script in {"category_fulfill_daily_avg", "category_fulfill_summary"} else ""


def materialize_imports(unpacked: Path, imports_dir: Path, run_dt: str, active_known_gaps: set[str],
                        scripts: Iterable[str] = RAW_SCRIPTS) -> dict[str, Any]:
    ensure_dir(imports_dir)
    stats: dict[str, Any] = {}
    for script in scripts:
        path = script_raw_file(unpacked, script, run_dt)
        if path is None:
            raise RuntimeError(f"missing raw csv for {script}")
        if script not in MATERIALIZE_SCRIPTS:
            stats[script] = {
                "raw_file": rel(unpacked, path), "raw_rows": csv_data_row_count(path), "import_rows": 0,
                "headers": headers_for(script), "months": [], "csv_repair": {"fixed_rows": 0, "bad_rows": 0},
                "materialized": False, "skip_reason": "unused_by_dashboard_cache",
            }
            continue
        _, rows, repairs = iter_csv_file(path, repair_model_name_commas=script.startswith("model"))
        handles: dict[str, Any] = {}
        writers: dict[str, csv.DictWriter] = {}
        months: set[str] = set()
        row_count = 0
        try:
            for row in canonical_import_rows(script, rows, run_dt, repairs):
                row_count += 1
                month = row["week_start_date"][:7] or "unknown"
                months.add(month)
                if month not in writers:
                    target = imports_dir / f"{script}_{month}.csv"
                    handle = target.open("w", encoding="utf-8", newline="")
                    handles[month] = handle
                    writer = csv.DictWriter(handle, fieldnames=headers_for(script), extrasaction="ignore", lineterminator="\n")
                    writer.writeheader()
                    writers[month] = writer
                writers[month].writerow({header: csv_escape(row.get(header, "")) for header in headers_for(script)})
        finally:
            for handle in handles.values():
                handle.close()
        if not row_count:
            gap = known_gap_for_empty_raw(script)
            if gap and gap in active_known_gaps:
                stats[script] = {"raw_file": rel(unpacked, path), "raw_rows": csv_data_row_count(path), "import_rows": 0,
                                 "headers": headers_for(script), "months": [], "csv_repair": repairs, "known_gap": gap}
                continue
            raise RuntimeError(f"raw csv {script} has no valid rows after normalization")
        stats[script] = {"raw_file": rel(unpacked, path), "raw_rows": csv_data_row_count(path), "import_rows": row_count,
                         "headers": headers_for(script), "months": sorted(months), "csv_repair": repairs}
    return {"stats": stats}


def rows_from_import_files(imports_dir: Path, prefix: str) -> Iterator[dict[str, str]]:
    if not imports_dir.exists():
        return
    for path in sorted(imports_dir.glob(f"{prefix}_*.csv")):
        _, rows, _ = iter_csv_file(path)
        yield from rows


def month_of(row: dict[str, Any]) -> str:
    return str(row.get("week_start_date") or "")[:7] or "unknown"


def write_rows_by_month(imports_dir: Path, prefix: str, rows: list[dict[str, Any]]) -> None:
    for path in imports_dir.glob(f"{prefix}_*.csv"):
        path.unlink()
    partitions: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        partitions[month_of(row)].append(row)
    for month, values in partitions.items():
        write_csv(imports_dir / f"{prefix}_{month}.csv", headers_for(prefix), values)


def latest_weeks_from_rows(rows: Iterable[dict[str, Any]]) -> list[str]:
    return sorted({date_to_iso_week(row.get("week_start_date", "")) for row in rows if date_to_iso_week(row.get("week_start_date", ""))})[-KEEP_WEEKS:]


def copy_dir_contents(source: Path, target: Path) -> None:
    if not source.exists():
        return
    ensure_dir(target)
    for item in source.iterdir():
        destination = target / item.name
        if item.is_dir():
            shutil.copytree(item, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(item, destination)


def unzip(path: Path, target: Path) -> None:
    ensure_dir(target)
    with zipfile.ZipFile(path) as archive:
        archive.extractall(target)


def zip_dir(source: Path, target: Path, entries: Iterable[str]) -> None:
    ensure_dir(target.parent)
    if target.exists():
        target.unlink()
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            root = source / entry if entry != "." else source
            if root.is_file():
                archive.write(root, root.relative_to(source).as_posix())
            elif root.exists():
                for path in root.rglob("*"):
                    if path.is_file():
                        archive.write(path, path.relative_to(source).as_posix())


def promote_imports(current: Path, previous_cache: Path | None, work_dir: Path, output: Path,
                    scripts: Iterable[str] = RAW_SCRIPTS) -> dict[str, Any]:
    ensure_dir(output)
    previous_dir = work_dir / "prev_processed"
    if previous_cache and previous_cache.exists():
        unzip(previous_cache, previous_dir)
        copy_dir_contents(previous_dir / "imports", output)
    report: dict[str, Any] = {"previous_cache": str(previous_cache) if previous_cache else "", "scripts": {}}
    active_scripts = set(scripts)
    for prefix in RAW_SCRIPTS:
        if prefix not in active_scripts:
            for path in output.glob(f"{prefix}_*.csv"):
                path.unlink()
            report["scripts"][prefix] = {"excluded_by_scope": True, "output_rows": 0}
            continue
        previous_rows = list(rows_from_import_files(output, prefix))
        current_rows = list(rows_from_import_files(current, prefix))
        current_partitions = {row.get("week_start_date") for row in current_rows if row.get("week_start_date")}
        merged = [row for row in previous_rows if row.get("week_start_date") not in current_partitions] + current_rows
        keep_weeks = set(latest_weeks_from_rows(merged))
        kept = [row for row in merged if date_to_iso_week(row.get("week_start_date", "")) in keep_weeks]
        write_rows_by_month(output, prefix, kept)
        report["scripts"][prefix] = {"previous_rows": len(previous_rows), "current_rows": len(current_rows),
                                     "promoted_partitions": sorted(current_partitions), "output_rows": len(kept),
                                     "keep_weeks": sorted(keep_weeks)}
    return report


def metric_sources_from_headers(headers: list[str]) -> dict[str, str]:
    wanted = {"jkuv": "机况uv", "evaUv": "估价uv", "orderUv": "下单uv", "orderCnt": "下单量",
              "shipCnt": "发货量", "signCnt": "签收量", "qcCnt": "质检量", "dealCnt": "成交量",
              "returnCnt": "退回量", "gmv": "成交gmv"}
    normalized = {normalize_header(header): header for header in headers}
    result = {}
    for key, header in wanted.items():
        result[key] = normalized.get(normalize_header(header), header)
    return result


def compute_rates(row: dict[str, Any]) -> dict[str, float]:
    def div(a: Any, b: Any) -> float:
        denominator = to_num(b)
        return to_num(a) / denominator if denominator > 0 else 0.0
    return {"evaRate": div(row.get("evaUv"), row.get("jkuv")), "orderRate": div(row.get("orderUv"), row.get("evaUv")),
            "shipRate": div(row.get("shipCnt"), row.get("orderCnt")), "signRate": div(row.get("signCnt"), row.get("shipCnt")),
            "qcRate": div(row.get("qcCnt"), row.get("signCnt")), "dealRate": div(row.get("dealCnt"), row.get("qcCnt")),
            "returnRate": div(row.get("returnCnt"), row.get("qcCnt"))}


def normalize_metric_row(row: dict[str, Any], source_headers: list[str], run_dt: str) -> dict[str, Any]:
    info = rolling_info(str(row.get("week_start_date", "")), run_dt)
    days = to_num(row.get("day_cnt") or row.get("daysReceived")) or info["day_cnt"]
    output: dict[str, Any] = {"week": info["week"], "startDate": row.get("week_start_date", ""), "endDate": info["endDate"],
                              "daysReceived": _number_string(days), "rollingStatus": info["rolling_status"], "sourceRunDt": run_dt}
    source_map = metric_sources_from_headers(source_headers)
    source_by_key = {"jkuv": "机况uv", "evaUv": "估价uv", "orderUv": "下单uv", "orderCnt": "下单量", "shipCnt": "发货量",
                     "signCnt": "签收量", "qcCnt": "质检量", "dealCnt": "成交量", "returnCnt": "退回量", "gmv": "成交gmv"}
    for key in CACHE_METRICS:
        value = to_num(row.get(source_by_key[key]))
        if days > 1 and not explicit_daily_average_header(source_map[key]):
            value /= days
        output[key] = _number_string(value)
    output["avgPrice"] = output["gmv"] / output["dealCnt"] if output["dealCnt"] > 0 else 0
    output["rates"] = compute_rates(output)
    return output


def merge_rows_by_key(rows: Iterable[dict[str, Any]], key_fn) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = key_fn(row)
        if not key:
            continue
        if key not in merged:
            merged[key] = dict(row)
            continue
        current = merged[key]
        for metric in CACHE_METRICS:
            current[metric] = _number_string(to_num(current.get(metric)) + to_num(row.get(metric)))
        current["daysReceived"] = max(to_num(current.get("daysReceived")), to_num(row.get("daysReceived")))
        current["avgPrice"] = current["gmv"] / current["dealCnt"] if current["dealCnt"] > 0 else 0
        current["rates"] = compute_rates(current)
    return list(merged.values())


def snapshot_candidate_dirs(snapshot_dir: Path) -> list[Path]:
    candidates = [snapshot_dir, Path(__file__).resolve().parents[1] / "references" / "server-snapshot",
                  Path(__file__).resolve().parents[3] / "model-tag-monitor" / "data"]
    result: list[Path] = []
    for candidate in candidates:
        candidate = candidate.resolve()
        if candidate.exists() and candidate not in result:
            result.append(candidate)
    return result


def first_existing_file(dirs: Iterable[Path], name: str) -> Path | None:
    for directory in dirs:
        path = directory / name
        if path.exists():
            return path
    return None


def read_taxonomy(snapshot_dir: Path, previous_cache_dir: Path | None, warnings: list[str]) -> dict[str, Any]:
    dirs = snapshot_candidate_dirs(snapshot_dir)
    csv_file = first_existing_file(dirs, "category_taxonomy.csv")
    if csv_file:
        _, rows, _ = parse_csv_file(csv_file)
        taxonomy_rows = [{"category": text_value(first(row, ("品类名称", "三级品类", "品类", "category"))),
                          "tier": text_value(first(row, ("阶段", "分层", "tier"))),
                          "board": text_value(first(row, ("二级板块", "二级类目", "board"))),
                          "status": text_value(first(row, ("业务状态", "状态", "status"))) or "在售",
                          "confidence": text_value(first(row, ("归类置信度", "置信度", "confidence"))),
                          "lastWeekGmv": to_num(first(row, ("最新周GMV(元)", "lastWeekGmv")))}
                         for row in rows if text_value(first(row, ("品类名称", "三级品类", "品类", "category")))]
        return {"syncedAt": now_iso(), "version": "1.5.5-zloop", "source": {"type": "snapshot_csv", "file": str(csv_file.resolve())}, "rows": taxonomy_rows}
    json_file = first_existing_file(dirs, "category-taxonomy.json")
    if json_file:
        value = read_json(json_file, {})
        value["source"] = {**(value.get("source") or {}), "fallback": "snapshot_json", "file": str(json_file.resolve())}
        return value
    if previous_cache_dir:
        previous = previous_cache_dir / "cache" / "category-taxonomy.json"
        if previous.exists():
            value = read_json(previous, {})
            value["source"] = {**(value.get("source") or {}), "fallback": "previous_processed_cache"}
            return value
    warnings.append("taxonomy_snapshot_missing")
    return {"syncedAt": now_iso(), "version": "1.5.5-zloop", "source": {"type": "empty"}, "rows": []}


def normalize_category_mapping_rows(value: Any) -> list[dict[str, str]]:
    if isinstance(value, list):
        raw_rows = value
    elif isinstance(value, dict):
        raw_rows = value.get("records") or value.get("rows") or value.get("items") or []
    else:
        raw_rows = []
    result = []
    for record in raw_rows:
        row = record.get("fields", record) if isinstance(record, dict) else {}
        category = text_value(first(row, ("三级品类", "品类名称", "品类", "category")))
        if category:
            result.append({"category": category, "tier": text_value(first(row, ("阶段", "分层", "tier", "stage"))),
                           "board": text_value(first(row, ("二级板块", "二级类目", "board", "secondaryCategory"))),
                           "status": text_value(first(row, ("业务状态", "状态", "status"))) or "在售",
                           "confidence": text_value(first(row, ("归类置信度", "置信度", "confidence"))),
                           "remark": text_value(first(row, ("备注", "remark", "note")))})
    return result


def read_category_mapping_file(path: Path | None) -> dict[str, Any] | None:
    if not path or not path.exists():
        return None
    if path.suffix.lower() == ".csv":
        _, raw_rows, _ = parse_csv_file(path)
        rows = normalize_category_mapping_rows(raw_rows)
    else:
        rows = normalize_category_mapping_rows(read_json(path, {}))
    return {"contract_version": CATEGORY_MAPPING_CONTRACT_VERSION, "syncedAt": now_iso(),
            "version": "feishu-base-current-or-snapshot",
            "source": {"type": "feishu_base_mapping_file", "base_token": CATEGORY_MAPPING_BASE_TOKEN,
                       "table": CATEGORY_MAPPING_TABLE, "file": str(path.resolve()), "sha256": sha256_file(path)},
            "rows": rows}


def resolve_category_mapping(category_mapping_file: Path | None, snapshot_dir: Path, previous_cache_dir: Path | None,
                             warnings: list[str], known_gaps: list[str]) -> dict[str, Any]:
    explicit = read_category_mapping_file(category_mapping_file)
    if explicit:
        return explicit
    dirs = snapshot_candidate_dirs(snapshot_dir)
    snapshot_json = first_existing_file(dirs, "category-mapping.json") or first_existing_file(dirs, "category-taxonomy.json")
    snapshot_csv = first_existing_file(dirs, "category_mapping.csv") or first_existing_file(dirs, "category_taxonomy.csv")
    snapshot = read_category_mapping_file(snapshot_json or snapshot_csv)
    if snapshot:
        snapshot["source"]["type"] = "package_category_taxonomy_snapshot_json" if snapshot_json and snapshot_json.name == "category-taxonomy.json" else ("feishu_base_mapping_snapshot_json" if snapshot_json else "feishu_base_mapping_snapshot_csv")
        warnings.append("category_mapping_feishu_read_failed_used_snapshot")
        known_gaps.append("category_mapping_source_not_realtime")
        return snapshot
    if previous_cache_dir:
        previous = read_category_mapping_file(previous_cache_dir / "cache" / "category-mapping.json")
        if previous:
            previous["source"]["type"] = "previous_processed_category_mapping_snapshot"
            warnings.append("category_mapping_feishu_read_failed_used_previous_snapshot")
            known_gaps.append("category_mapping_source_not_realtime")
            return previous
    warnings.append("category_mapping_missing")
    known_gaps.append("category_mapping_missing")
    return {"contract_version": CATEGORY_MAPPING_CONTRACT_VERSION, "syncedAt": now_iso(), "version": "empty",
            "source": {"type": "empty", "base_token": CATEGORY_MAPPING_BASE_TOKEN, "table": CATEGORY_MAPPING_TABLE}, "rows": []}


def category_mapping_manifest(mapping: dict[str, Any], category_rows: list[dict[str, Any]], warnings: list[str], known_gaps: list[str]) -> dict[str, Any]:
    rows = mapping.get("rows") or []
    categories = sorted({row.get("品类名称") for row in category_rows if row.get("品类名称")})
    by_category = {row.get("category"): row for row in rows}
    unmatched = [category for category in categories if category not in by_category]
    pending = [row["category"] for row in rows if row.get("tier") == "待归类" or row.get("confidence") == "待你确认"]
    offline = [row["category"] for row in rows if row.get("status") == "已下线"]
    self_operated = [row["category"] for row in rows if row.get("tier") == "自营(非聚合)"]
    if unmatched:
        warnings.append("category_mapping_unmatched_categories")
        known_gaps.append("category_mapping_unmatched_categories")
    if pending:
        warnings.append("category_mapping_pending_confirmation")
    tiers = {tier: sum(1 for row in rows if row.get("tier") == tier) for tier in ("发展", "孵化", "种子", "待归类")}
    tiers["自营(非聚合)"] = len(self_operated)
    return {"contract_version": CATEGORY_MAPPING_CONTRACT_VERSION, "generated_at": now_iso(), "source": mapping.get("source") or {},
            "source_synced_at": mapping.get("syncedAt", ""), "source_sha256": sha256_json(rows), "record_count": len(rows),
            "stats": {"categories_in_data": len(categories), "unmatched_categories": len(unmatched), "pending_categories": len(pending),
                      "offline_categories": len(offline), "self_operated_non_aggregate": len(self_operated), "tiers": tiers},
            "unmatched_categories": unmatched, "pending_categories": pending, "offline_categories": offline,
            "self_operated_categories": self_operated}



def order_chain_integrity_for_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    if not rows:
        return {"ok": True, "row_count": 0, "latest_week": "", "uv_total": 0.0, "order_chain_total": 0.0, "totals": {}}
    weeks = sorted({str(row.get("week") or "") for row in rows if isinstance(row, dict) and row.get("week")})
    latest_week = weeks[-1] if weeks else ""
    latest_rows = [row for row in rows if isinstance(row, dict) and (not latest_week or str(row.get("week") or "") == latest_week)]
    totals = {key: 0.0 for key in (*UV_METRICS, *ORDER_CHAIN_METRICS)}
    for row in latest_rows:
        for key in totals:
            totals[key] += to_num(row.get(key))
    uv_total = sum(totals[key] for key in UV_METRICS)
    order_chain_total = sum(totals[key] for key in ORDER_CHAIN_METRICS)
    ok = not (len(latest_rows) > 0 and uv_total > 0 and order_chain_total == 0)
    result = {
        "ok": ok,
        "row_count": len(latest_rows),
        "latest_week": latest_week,
        "uv_total": uv_total,
        "order_chain_total": order_chain_total,
        "totals": totals,
    }
    if not ok:
        result.update({
            "code": ORDER_CHAIN_EMPTY_CODE,
            "message": "Latest category cache has non-zero UV but all order/deal/GMV metrics are zero; likely an early run before order partition readiness.",
        })
    return result


def model_cache_limit() -> int:
    try:
        value = int(float(os.environ.get("AIWAN_MODEL_CACHE_TOP_N_PER_CATEGORY_WEEK", DEFAULT_MODEL_CACHE_TOP_N_PER_CATEGORY_WEEK)))
        return value if value > 0 else DEFAULT_MODEL_CACHE_TOP_N_PER_CATEGORY_WEEK
    except ValueError:
        return DEFAULT_MODEL_CACHE_TOP_N_PER_CATEGORY_WEEK


def limit_model_rows_for_cache(rows: list[dict[str, Any]], warnings: list[str]) -> list[dict[str, Any]]:
    limit = model_cache_limit()
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[(str(row.get("week", "")), str(row.get("category", "")))].append(row)
    output: list[dict[str, Any]] = []
    dropped = 0
    for group in groups.values():
        group.sort(key=lambda row: (-to_num(row.get("gmv")), -to_num(row.get("dealCnt")), -to_num(row.get("orderUv"))))
        output.extend(group[:limit])
        dropped += max(len(group) - limit, 0)
    if dropped:
        warnings.append(f"model_cache_topn_applied: top {limit} per week/category, dropped {dropped} low-rank model rows")
    return output


def build_caches(imports_dir: Path, cache_dir: Path, run_dt: str, snapshot_dir: Path,
                 previous_cache_dir: Path | None, warnings: list[str], known_gaps: list[str],
                 category_mapping_file: Path | None, sql_scope: str = "all",
                 scripts: Iterable[str] = RAW_SCRIPTS) -> dict[str, Any]:
    ensure_dir(cache_dir)
    mapping = resolve_category_mapping(category_mapping_file, snapshot_dir, previous_cache_dir, warnings, known_gaps)
    taxonomy = ({"syncedAt": mapping.get("syncedAt"), "version": mapping.get("version"), "source": mapping.get("source"), "rows": mapping.get("rows") or []}
                if mapping.get("rows") else read_taxonomy(snapshot_dir, previous_cache_dir, warnings))
    taxonomy_rows = taxonomy.get("rows") or []
    self_categories = {row.get("category") for row in taxonomy_rows if row.get("tier") == "自营(非聚合)"}
    offline_categories = {row.get("category") for row in taxonomy_rows if row.get("status") == "已下线"}

    category_raw = list(rows_from_import_files(imports_dir, "category_daily_avg"))
    category_map = category_mapping_manifest({**mapping, "rows": taxonomy_rows}, category_raw, warnings, known_gaps)
    category_rows = [{"category": row.get("品类名称"), **normalize_metric_row(row, headers_for("category_daily_avg"), run_dt)}
                     for row in category_raw if row.get("品类名称") and row.get("品类名称") not in self_categories]
    latest_week = sorted({row.get("week") for row in category_rows if row.get("week")})[-1] if category_rows else ""
    category_rows = [row for row in category_rows if not (row.get("week") == latest_week and row.get("category") in offline_categories)]
    category_rows = merge_rows_by_key(category_rows, lambda row: f"{row.get('week')}\x1f{row.get('category')}")
    category_weeks = sorted({row.get("week") for row in category_rows if row.get("week")})
    categories = sorted({row.get("category") for row in category_rows if row.get("category")})
    category_cache = {"syncedAt": now_iso(), "version": "1.5.5-zloop",
                      "source": {"dir": str(imports_dir), "prefix": "category_daily_avg_", "grain": "daily_slice_category_dedup_daily_avg", "evaUv": "daily-slice category-level deduplicated UV sum"},
                      "weeks": category_weeks, "categories": categories, "rows": category_rows}

    fulfill_raw = list(rows_from_import_files(imports_dir, "category_fulfill_daily_avg"))
    fulfill_rows = [{"category": row.get("品类名称"), "fulfillmentMethod": row.get("履约方式（只取线上流程）"),
                     **normalize_metric_row(row, headers_for("category_fulfill_daily_avg"), run_dt)}
                    for row in fulfill_raw if row.get("品类名称") and row.get("品类名称") not in self_categories and not (row.get("week") == latest_week and row.get("品类名称") in offline_categories)]
    fulfill_rows = merge_rows_by_key(fulfill_rows, lambda row: f"{row.get('week')}\x1f{row.get('category')}\x1f{row.get('fulfillmentMethod')}")
    fulfill_cache = {"syncedAt": now_iso(), "version": "1.5.5-zloop", "source": {"dir": str(imports_dir), "prefix": "category_fulfill_daily_avg_", "grain": "category_fulfillment_daily_avg"},
                     "weeks": sorted({row.get("week") for row in fulfill_rows if row.get("week")}), "categories": categories, "rows": fulfill_rows}

    model_included = "model_daily_avg" in set(scripts)
    model_raw = list(rows_from_import_files(imports_dir, "model_daily_avg")) if model_included else []
    model_rows = [{"category": row.get("品类名称"), "modelId": re.sub(r"^(\d+)\.0+$", r"\1", str(row.get("机型id") or "")),
                   "modelName": row.get("机型名称"), "coreEval": row.get("核心属性（估价）") or "", "gradeEval": row.get("成色等级（估价）") or "",
                   "coreQc": row.get("核心属性（质检）") or "", "gradeQc": row.get("成色等级（质检）") or "", "fulfillmentMethod": row.get("履约方式（只取线上流程）") or "",
                   **normalize_metric_row(row, headers_for("model_daily_avg"), run_dt)}
                  for row in model_raw if row.get("品类名称") and row.get("机型名称") and row.get("品类名称") not in self_categories and not (row.get("week") == latest_week and row.get("品类名称") in offline_categories)]
    model_rows = merge_rows_by_key(model_rows, lambda row: f"{row.get('week')}\x1f{row.get('category')}\x1f{row.get('modelId') or 'name:' + str(row.get('modelName'))}\x1f{row.get('modelName')}")
    model_rows = limit_model_rows_for_cache(model_rows, warnings)
    model_cache = ({"syncedAt": now_iso(), "version": "1.5.5-zloop", "source": {"dir": str(imports_dir), "prefix": "model_daily_avg_", "grain": "model_main_daily_avg"},
                    "categories": sorted({row.get("category") for row in model_rows if row.get("category")}), "weeks": sorted({row.get("week") for row in model_rows if row.get("week")}), "rows": model_rows}
                   if model_included else
                   {"syncedAt": now_iso(), "version": "1.5.5-zloop", "status": "disabled", "sql_scope": sql_scope,
                    "source": {"status": "disabled", "sql_scope": sql_scope, "reason": "model_sql_excluded_from_base_scope"},
                    "categories": [], "weeks": [], "rows": []})

    board_rows = []
    for row in rows_from_import_files(imports_dir, "sqldau"):
        start = str(first(row, ("week_start_date", "开始日期", "周开始"))).strip()
        week = str(first(row, ("week", "统计周", "周次"))).strip() or date_to_iso_week(start)
        if not week:
            continue
        board_rows.append({
            "week": week,
            "startDate": start,
            "dayCnt": _number_string(to_num(first(row, ("day_cnt", "daysReceived", "已收到天数")))),
            "dau": _number_string(to_num(first(row, ("APP日均DAU", "APP日均 DAU", "avg_dau", "appDau", "dau")))),
            "entryUv": _number_string(to_num(first(row, ("回收入口UV", "回收入口 UV", "avg_recycle_entrance_uv", "recycleEntranceUv", "entryUv")))),
        })
    board_rows = list({row["week"]: row for row in board_rows}.values())
    board_rows.sort(key=lambda row: row["week"])
    target_week = category_weeks[-1] if category_weeks else ""
    target_board = next((row for row in board_rows if row["week"] == target_week), None)
    if target_week and target_board is None:
        raise RuntimeError(f"DATA_INTEGRITY_BOARD_METRICS_TARGET_WEEK_MISSING: sqldau missing {target_week}")
    if target_board is not None:
        for field in ("dau", "entryUv"):
            if to_num(target_board.get(field)) <= 0:
                raise RuntimeError(f"DATA_INTEGRITY_BOARD_METRICS_INVALID: sqldau {target_week}.{field} must be positive")
    board_cache = {
        "syncedAt": now_iso(),
        "version": "1.6.52-zloop",
        "source": {"script": "sqldau", "grain": "week_daily_average", "targetWeeks": category_weeks},
        "weeks": [row["week"] for row in board_rows],
        "rows": board_rows,
    }

    for name, value in (("category-taxonomy.json", taxonomy), ("category-mapping.json", {**mapping, "rows": taxonomy_rows}),
                        ("category-mapping-manifest.json", category_map), ("category-cache.json", category_cache),
                        ("category-fulfill-cache.json", fulfill_cache), ("cache.json", model_cache), ("model-cache.json", model_cache),
                        ("board-metrics.json", board_cache)):
        write_json(cache_dir / name, value)
    return {"taxonomy": taxonomy, "categoryMapping": category_map, "categoryCache": category_cache,
            "fulfillCache": fulfill_cache, "modelCache": model_cache, "boardCache": board_cache}


def normalize_tags(tags: Any) -> dict[str, Any]:
    output = {}
    for key, value in (tags or {}).items() if isinstance(tags, dict) else []:
        if "||" not in str(key):
            continue
        if isinstance(value, list):
            output[key] = {"dimensions": {}, "tags": [str(item) for item in value], "note": ""}
        else:
            value = value if isinstance(value, dict) else {}
            output[key] = {"dimensions": value.get("dimensions") or {}, "tags": [str(item) for item in value.get("tags", [])] if isinstance(value.get("tags"), list) else [], "note": str(value.get("note") or "")}
    return output


def normalize_vocab(value: Any) -> dict[str, Any]:
    output = {**DEFAULT_VOCAB, **(value if isinstance(value, dict) else {})}
    output["custom"] = (value or {}).get("custom") or {} if isinstance(value, dict) else {}
    return output


def build_tag_artifacts(snapshot_dir: Path, cache_dir: Path, artifact_dir: Path, run_dt: str, run_id: str,
                        warnings: list[str], known_gaps: list[str]) -> dict[str, Any]:
    dirs = snapshot_candidate_dirs(snapshot_dir)
    tags_file = first_existing_file(dirs, "tags.json")
    vocab_file = first_existing_file(dirs, "tag-vocab.json")
    source_dir = (tags_file or vocab_file or (dirs[0] / "rules.json" if dirs else artifact_dir)).parent
    tags = normalize_tags(read_json(tags_file, {}) if tags_file else {})
    vocab = normalize_vocab(read_json(vocab_file, DEFAULT_VOCAB) if vocab_file else DEFAULT_VOCAB)
    if tags_file is None:
        warnings.append("tag_snapshot_missing"); known_gaps.append("tag_snapshot_missing")
    if vocab_file is None:
        warnings.append("tag_vocab_missing_used_default")
    entries = []
    for key, record in tags.items():
        category, _, model = str(key).partition("||")
        entries.append({"key": key, "category": category, "model_name": model, "dimensions": record.get("dimensions") or {}, "tags": record.get("tags") or [], "note": record.get("note") or ""})
    categories = sorted({entry["category"] for entry in entries})
    generated = now_iso()
    snapshot_base = {"schema_version": "model_tag_snapshot/v1", "artifact_type": "model_tag_snapshot", "run_id": run_id, "run_dt": run_dt, "generated_at": generated,
                     "source_of_truth": "model-tag-monitor-server-front-end-tags", "source": {"mode": "file" if tags_file else "default_empty", "data_dir": str(source_dir)},
                     "stats": {"tagged_model_count": len(entries), "category_count": len(categories), "categories": categories,
                               "dimension_assignment_count": sum(len(entry["dimensions"]) for entry in entries), "custom_dimension_count": len(vocab.get("custom") or {})},
                     "vocab": vocab, "dimension_catalog": {"core": vocab.get("core"), "lifecycle": vocab.get("lifecycle"), "price": vocab.get("price"), "custom": vocab.get("custom")},
                     "rules": read_json(source_dir / "rules.json", {}), "tags": tags, "entries": entries}
    snapshot = {**snapshot_base, "sha256": sha256_json(snapshot_base)}
    enrichment = {}
    for entry in entries:
        dims = entry["dimensions"]
        enrichment[entry["key"]] = {"category": entry["category"], "model_name": entry["model_name"], "core": dims.get("core", ""), "lifecycle": dims.get("lifecycle", ""), "price": dims.get("price", ""),
                                     "custom_dimensions": {key: value for key, value in dims.items() if key not in {"core", "lifecycle", "price"}}, "all_dimensions": dims, "tags": entry["tags"], "note": entry["note"]}
    knowledge_base = {"schema_version": "model_tag_knowledge/v1", "artifact_type": "model_tag_knowledge", "run_id": run_id, "run_dt": run_dt, "generated_at": generated,
                      "source_snapshot_sha256": snapshot["sha256"], "rules_summary": {}, "dimension_catalog": snapshot["dimension_catalog"],
                      "category_summaries": [{"category": category, "tagged_model_count": sum(1 for entry in entries if entry["category"] == category)} for category in categories],
                      "model_enrichment": enrichment, "feishu_knowledge_summary": {"write_mode": "summary_only_not_source_of_truth", "markdown": f"# AI 小万机型标签分层摘要（{run_dt}）\n\n- Tagged models：{len(entries)}\n- Categories：{len(categories)}\n"},
                      "consumer_contract": {"join_key": "category||model_name", "missing_tag_policy": "treat_as_未打标_and_do_not_infer_core/lifecycle/price"}}
    knowledge = {**knowledge_base, "sha256": sha256_json(knowledge_base)}
    ensure_dir(artifact_dir)
    write_json(artifact_dir / f"model_tag_snapshot_{run_dt}.json", snapshot)
    write_json(artifact_dir / f"model_tag_knowledge_{run_dt}.json", knowledge)
    (artifact_dir / f"model_tag_feishu_summary_{run_dt}.md").write_text(knowledge["feishu_knowledge_summary"]["markdown"] + "\n", encoding="utf-8")
    write_json(cache_dir / "tags.json", tags); write_json(cache_dir / "tag-vocab.json", vocab)
    manifest = {"schema_version": "tag_snapshot_manifest/v1", "run_dt": run_dt, "generated_at": now_iso(), "source": snapshot["source"],
                "tags_sha256": sha256_json(tags), "tag_vocab_sha256": sha256_json(vocab), "tagged_model_count": len(entries), "category_count": len(categories),
                "fallback": tags_file is None, "snapshot": f"model_tag_snapshot_{run_dt}.json", "snapshot_sha256": snapshot["sha256"],
                "knowledge": f"model_tag_knowledge_{run_dt}.json", "knowledge_sha256": knowledge["sha256"]}
    tag_warnings = list(dict.fromkeys(warning for warning in warnings if re.search(r"tag|model_tag|feishu", str(warning), re.I)))
    tag_gaps = list(dict.fromkeys(gap for gap in known_gaps if re.search(r"tag|model_tag|feishu", str(gap), re.I)))
    if not enrichment:
        tag_gaps.append("model_tag_knowledge_empty")
    sync_base = {"schema_version": "model_tag_sync_manifest/v1", "artifact_type": "model_tag_sync_manifest", "stage": "process",
                 "status": "warn" if tag_warnings or tag_gaps else "success", "run_id": run_id, "run_dt": run_dt, "generated_at": manifest["generated_at"],
                 "model_tag_snapshot": manifest["snapshot"], "model_tag_knowledge": manifest["knowledge"], "model_tag_feishu_summary": f"model_tag_feishu_summary_{run_dt}.md",
                 "model_tag_snapshot_sha256": snapshot["sha256"], "model_tag_knowledge_sha256": knowledge["sha256"], "model_tag_source": snapshot["source_of_truth"],
                 "model_tag_stats": {"tagged_model_count": len(entries), "category_count": len(categories), "dimension_assignment_count": snapshot["stats"]["dimension_assignment_count"], "custom_dimension_count": snapshot["stats"]["custom_dimension_count"]},
                 "source": snapshot["source"], "feishu_sync": {"enabled": False, "status": "not_configured", "write_mode": "summary_only_not_source_of_truth"}, "warnings": tag_warnings, "known_gaps": tag_gaps}
    sync_manifest = {**sync_base, "sha256": sha256_json(sync_base)}
    write_json(cache_dir / "tag_snapshot_manifest.json", manifest)
    write_json(artifact_dir / f"model_tag_sync_manifest_{run_dt}.json", sync_manifest)
    return {"snapshot": snapshot, "knowledge": knowledge, "manifest": manifest, "syncManifest": sync_manifest}


def build_rolling_status(caches: dict[str, Any]) -> dict[str, Any]:
    weeks = caches["categoryCache"].get("weeks") or []
    by_week = {row.get("week"): row.get("rollingStatus") for row in caches["categoryCache"].get("rows") or []}
    return {"generated_at": now_iso(), "weeks": weeks, "rolling_week": next((week for week in weeks if by_week.get(week) == "rolling"), ""),
            "final_weeks": [week for week in weeks if by_week.get(week) != "rolling"], "rolling_status_by_week": by_week}


def build_metric_baseline(rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        grouped[str(row.get("category", ""))].append(row)
    result = {}
    for category, category_rows in grouped.items():
        ordered = sorted(category_rows, key=lambda row: str(row.get("week", "")))
        previous = ordered[-4:-1]
        if not previous:
            continue
        result[category] = {metric: sum(to_num(row.get(metric)) for row in previous) / len(previous) for metric in ("gmv", "dealCnt", "orderCnt", "evaUv")}
    return result


def build_analysis_history(caches: dict[str, Any], tags: dict[str, Any], quality_summary: dict[str, Any], known_gaps: list[str],
                           run_dt: str, run_id: str) -> dict[str, Any]:
    category_rows = caches["categoryCache"].get("rows") or []
    weeks = caches["categoryCache"].get("weeks") or []
    model_top: list[dict[str, Any]] = []
    enrichment = tags["knowledge"].get("model_enrichment") or {}
    for week in weeks[-KEEP_WEEKS:]:
        models = sorted((row for row in caches["modelCache"].get("rows") or [] if row.get("week") == week), key=lambda row: -to_num(row.get("gmv")))[:50]
        for row in models:
            model_top.append({"week": week, "category": row.get("category"), "model_name": row.get("modelName"), "model_id": row.get("modelId"),
                              "gmv": row.get("gmv"), "dealCnt": row.get("dealCnt"), "orderCnt": row.get("orderCnt"),
                              "tags": (enrichment.get(f"{row.get('category')}||{row.get('modelName')}") or {}).get("tags") or []})
    return {"contract_version": "ai-wan-v1.5.5-analysis-history", "run_id": run_id, "run_dt": run_dt, "generated_at": now_iso(),
            "history_weeks": KEEP_WEEKS, "history_weeks_available": len(weeks), "latest_week": weeks[-1] if weeks else "",
            "rolling_status": build_rolling_status(caches), "category_history": category_rows, "category_fulfill_history": caches["fulfillCache"].get("rows") or [],
            "model_topn_history": model_top, "model_detail_contributor_candidates": model_top[:200], "metric_baseline": build_metric_baseline(category_rows),
            "tag_dimensions_summary": {"tagged_model_count": tags["snapshot"]["stats"]["tagged_model_count"], "category_count": tags["snapshot"]["stats"]["category_count"]},
            "known_gaps": known_gaps, "quality_summary": quality_summary}


def compare_wtd(category_rows: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in category_rows:
        grouped[str(row.get("category", ""))].append(row)
    warnings: list[str] = []
    errors: list[str] = []
    comparisons: list[dict[str, Any]] = []
    for category, rows in grouped.items():
        ordered = sorted(rows, key=lambda row: str(row.get("week", "")))
        if len(ordered) < 2:
            continue
        current, previous = ordered[-1], ordered[-2]
        for metric in ("gmv", "dealCnt", "orderCnt", "evaUv"):
            baseline = to_num(previous.get(metric))
            if baseline <= 0:
                continue
            ratio = to_num(current.get(metric)) / baseline
            low_volume = baseline < LOW_VOLUME_BASELINE_THRESHOLDS[metric]
            comparisons.append({"category": category, "metric": metric, "current": current.get(metric), "baseline": previous.get(metric), "ratio": ratio, "low_volume_baseline": low_volume})
            if to_num(current.get("daysReceived")) >= to_num(previous.get("daysReceived")) and ratio < 0.5:
                message = f"{category} {metric} WTD ratio {ratio:.3f} < 0.5"
                warnings.append(f"{message} (business_fluctuation_warn_only, low_volume_baseline={_number_string(baseline) if low_volume else 'false'})")
            elif to_num(current.get("daysReceived")) >= to_num(previous.get("daysReceived")) and ratio < 0.8:
                warnings.append(f"{category} {metric} WTD ratio {ratio:.3f} < 0.8")
    return {"comparisons": comparisons, "warnings": warnings, "errors": errors, "low_volume_baseline_thresholds": LOW_VOLUME_BASELINE_THRESHOLDS}


def write_server_bundle(server_dir: Path, caches: dict[str, Any], rolling_status: dict[str, Any], cache_dir: Path, run_dt: str, run_id: str) -> None:
    ensure_dir(server_dir)
    for name in ("cache.json", "model-cache.json", "category-cache.json", "category-fulfill-cache.json", "category-taxonomy.json", "category-mapping.json", "category-mapping-manifest.json", "board-metrics.json", "tags.json", "tag-vocab.json", "tag_snapshot_manifest.json"):
        source = cache_dir / name
        if source.exists():
            shutil.copy2(source, server_dir / name)
    write_json(server_dir / "rolling-status.json", rolling_status)
    write_json(server_dir / "dashboard-source-manifest.json", {"contract_version": CONTRACT_VERSION, "run_id": run_id, "run_dt": run_dt, "generated_at": now_iso(),
                                                                  "sources": {"processed_cache": f"processed_cache_{run_dt}.zip", "tag_snapshot": f"model_tag_snapshot_{run_dt}.json"},
                                                                  "cache_files": ["cache.json", "model-cache.json", "category-cache.json", "category-fulfill-cache.json", "category-taxonomy.json", "board-metrics.json", "tags.json", "tag-vocab.json"]})


def resolve_previous_processed_cache(input_dir: Path, out_dir: Path, explicit: Path | None) -> Path | None:
    if explicit and explicit.exists():
        return explicit
    for root in (input_dir, out_dir):
        active = root / "active_process_manifest.json"
        if active.exists():
            manifest = read_json(active, {})
            candidate = root / str(manifest.get("processed_cache") or "")
            if candidate.exists():
                return candidate
    return None


def validate_fetch(input_dir: Path, run_dt: str) -> dict[str, Any]:
    active_file = input_dir / "active_fetch_manifest.json"
    if not active_file.exists():
        raise RuntimeError(f"missing active_fetch_manifest.json in {input_dir}")
    active = read_json(active_file, {})
    if active.get("contract_version") and active.get("contract_version") != FETCH_CONTRACT_VERSION:
        raise RuntimeError(f"unexpected fetch contract_version={active.get('contract_version')}")
    if active.get("stage") != "fetch":
        raise RuntimeError("active_fetch_manifest.stage must be fetch")
    if active.get("status") not in {"success", "warn"}:
        raise RuntimeError("active_fetch_manifest.status must be success or warn")
    gaps = {str(value) for value in active.get("known_gaps") or []}
    allowed = {"category_fulfill_daily_avg_empty", "category_fulfill_summary_empty"}
    if active.get("status") == "warn" and not gaps or active.get("status") == "warn" and not gaps.issubset(allowed):
        raise RuntimeError("active_fetch_manifest.status warn has unsupported known gaps")
    if active.get("run_dt") != run_dt:
        raise RuntimeError(f"active_fetch_manifest.run_dt {active.get('run_dt')} != {run_dt}")
    raw_cache = input_dir / str(active.get("raw_cache") or f"raw_cache_{run_dt}.zip")
    if not raw_cache.exists():
        raise RuntimeError(f"missing raw_cache: {raw_cache}")
    actual = sha256_file(raw_cache)
    expected = active.get("raw_cache_sha256") or active.get("sha256")
    if expected and expected != actual:
        raise RuntimeError(f"raw_cache sha256 mismatch expected={expected} actual={actual}")
    return {"active": active, "rawCache": raw_cache, "actualSha": actual}


def resolve_fetch_scripts(active: dict[str, Any]) -> tuple[str, tuple[str, ...]]:
    sql_scope = str(active.get("sql_scope") or "all").strip().lower()
    if sql_scope not in {"all", "base"}:
        raise RuntimeError(f"active_fetch_manifest.sql_scope must be all or base, got {active.get('sql_scope')}")
    expected = BASE_SCRIPTS if sql_scope == "base" else RAW_SCRIPTS
    raw_scripts = active.get("scripts")
    scripts = tuple(str(script) for script in raw_scripts) if isinstance(raw_scripts, list) and raw_scripts else expected
    unknown = [script for script in scripts if script not in RAW_SCRIPTS]
    missing = [script for script in expected if script not in scripts]
    extra = [script for script in scripts if script not in expected]
    if len(set(scripts)) != len(scripts) or unknown or missing or extra:
        raise RuntimeError(
            f"active_fetch_manifest.scripts do not match sql_scope={sql_scope}; "
            f"missing={','.join(missing) or '<none>'}; extra={','.join(extra) or '<none>'}; "
            f"unknown={','.join(unknown) or '<none>'}"
        )
    return sql_scope, scripts


def _validate_script_metadata(name: str, value: Any, scripts: tuple[str, ...]) -> None:
    if value is None:
        return
    if not isinstance(value, list) or tuple(str(script) for script in value) != scripts:
        raise RuntimeError(f"{name} != active_fetch_manifest.scripts")


def validate_unpacked_raw(unpacked: Path, active: dict[str, Any], run_dt: str) -> dict[str, Any]:
    raw_manifest = read_json(unpacked / str(active.get("raw_manifest") or f"raw_manifest_{run_dt}.json"), {})
    sql_status = read_json(unpacked / str(active.get("sql_status") or f"sql_status_{run_dt}.json"), {})
    if raw_manifest.get("run_id") and raw_manifest.get("run_id") != active.get("run_id"):
        raise RuntimeError("raw_manifest.run_id does not match active_fetch_manifest.run_id")
    sql_scope, scripts = resolve_fetch_scripts(active)
    if raw_manifest.get("sql_scope") and raw_manifest.get("sql_scope") != sql_scope:
        raise RuntimeError("raw_manifest.sql_scope != active_fetch_manifest.sql_scope")
    if sql_status.get("sql_scope") and sql_status.get("sql_scope") != sql_scope:
        raise RuntimeError("sql_status.sql_scope != active_fetch_manifest.sql_scope")
    _validate_script_metadata("raw_manifest.scripts", raw_manifest.get("scripts"), scripts)
    _validate_script_metadata("sql_status.active_scripts", sql_status.get("active_scripts"), scripts)
    if isinstance(sql_status.get("scripts"), dict) and set(sql_status["scripts"]) != set(scripts):
        raise RuntimeError("sql_status.scripts keys != active_fetch_manifest.scripts")
    gaps = {str(value) for value in active.get("known_gaps") or []}
    for script in scripts:
        path = script_raw_file(unpacked, script, run_dt)
        if path is None:
            raise RuntimeError(f"missing raw/{script}_{run_dt}.csv")
        count = csv_data_row_count(path)
        if count <= 0 and known_gap_for_empty_raw(script) not in gaps:
            raise RuntimeError(f"raw {script} row_count=0")
    return {"raw_manifest": raw_manifest, "sql_status": sql_status, "sql_scope": sql_scope, "scripts": scripts}


def write_minimal_xlsx(path: Path, manifest: dict[str, Any]) -> None:
    with tempfile.TemporaryDirectory(prefix="ai-wan-xlsx-") as temp:
        root = Path(temp)
        ensure_dir(root / "_rels"); ensure_dir(root / "xl" / "_rels"); ensure_dir(root / "xl" / "worksheets")
        (root / "[Content_Types].xml").write_text('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>', encoding="utf-8")
        (root / "_rels" / ".rels").write_text('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>', encoding="utf-8")
        (root / "xl" / "workbook.xml").write_text('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="manifest" sheetId="1" r:id="rId1"/></sheets></workbook>', encoding="utf-8")
        (root / "xl" / "_rels" / "workbook.xml.rels").write_text('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>', encoding="utf-8")
        rows = [("field", "value"), ("run_id", manifest.get("run_id", "")), ("run_dt", manifest.get("run_dt", "")), ("history_weeks", manifest.get("history_weeks", "")), ("history_weeks_available", manifest.get("history_weeks_available", ""))]
        def xml_escape(value: Any) -> str:
            return str(value if value is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
        sheet = "".join(f'<row r="{index}">' + "".join(f'<c r="{chr(64 + col)}{index}" t="inlineStr"><is><t>{xml_escape(value)}</t></is></c>' for col, value in enumerate(row, 1)) + "</row>" for index, row in enumerate(rows, 1))
        (root / "xl" / "worksheets" / "sheet1.xml").write_text(f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{sheet}</sheetData></worksheet>', encoding="utf-8")
        zip_dir(root, path, ("[Content_Types].xml", "_rels", "xl"))


def write_failure(out_dir: Path, run_dt: str, run_id: str, errors: list[str], upstream: dict[str, Any] | None = None) -> dict[str, Any]:
    ensure_dir(out_dir)
    report = {"contract_version": "ai-wan-v1.5.5-quality", "run_id": run_id, "run_dt": run_dt, "generated_at": now_iso(), "quality_gates": "failed", "errors": errors, "warnings": [], "known_gaps": [], "upstream_fetch": upstream or {}}
    quality_file = out_dir / f"data_quality_report_{run_dt}.json"
    write_json(quality_file, report)
    manifest = {"contract_version": CONTRACT_VERSION, "stage": "process", "status": "failed", "run_id": run_id, "run_dt": run_dt, "upstream_stage": "fetch", "upstream_run_id": (upstream or {}).get("run_id", ""), "quality_gates": "failed", "errors": errors, "warnings": [], "known_gaps": [], "data_quality_report": quality_file.name, "data_quality_report_sha256": sha256_file(quality_file), "generated_at": now_iso()}
    write_json(out_dir / "active_process_manifest.json", manifest)
    return {"ok": False, "manifest": manifest, "report": report}


def process_raw_cache(*, run_dt: str, input_dir: str | Path = ".", out_dir: str | Path | None = None, snapshot_dir: str | Path | None = None,
                      previous_processed_cache: str | Path | None = None, category_mapping_file: str | Path | None = None,
                      run_id: str | None = None, keep_work_dir: bool = False) -> dict[str, Any]:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(run_dt or "")):
        raise ValueError(f"runDt must be YYYY-MM-DD, got {run_dt}")
    input_path = Path(input_dir).resolve()
    output_path = Path(out_dir or input_path).resolve()
    package_root = Path(__file__).resolve().parents[1]
    snapshot_path = Path(snapshot_dir).resolve() if snapshot_dir else package_root / "references" / "server-snapshot"
    process_id = run_id or f"process_{run_dt}_{os.urandom(4).hex()}"
    ensure_dir(output_path)
    try:
        fetch = validate_fetch(input_path, run_dt)
    except Exception as exc:
        return write_failure(output_path, run_dt, process_id, [str(exc)])

    work_path = Path(tempfile.mkdtemp(prefix=f"ai-wan-process-{run_dt}-"))
    warnings: list[str] = []
    known_gaps: list[str] = []
    try:
        for gap in (str(value) for value in fetch["active"].get("known_gaps") or []):
            if gap in {"category_fulfill_daily_avg_empty", "category_fulfill_summary_empty"}:
                warnings.append(gap); known_gaps.append(gap)
        unpacked = work_path / "raw_cache"
        unzip(fetch["rawCache"], unpacked)
        upstream = validate_unpacked_raw(unpacked, fetch["active"], run_dt)
        staging = work_path / "staging_imports"
        import_build = materialize_imports(unpacked, staging, run_dt, {str(value) for value in fetch["active"].get("known_gaps") or []}, upstream["scripts"])
        previous = resolve_previous_processed_cache(input_path, output_path, Path(previous_processed_cache).resolve() if previous_processed_cache else None)
        previous_cache_dir = work_path / "prev_processed" if previous else None
        processed_root = work_path / "processed_cache_root"
        processed_imports = processed_root / "imports"
        promote_report = promote_imports(staging, previous, work_path, processed_imports, upstream["scripts"])
        cache_dir = processed_root / "cache"
        caches = build_caches(processed_imports, cache_dir, run_dt, snapshot_path, previous_cache_dir, warnings, known_gaps, Path(category_mapping_file).resolve() if category_mapping_file else None, upstream["sql_scope"], upstream["scripts"])
        tags = build_tag_artifacts(snapshot_path, cache_dir, output_path, run_dt, process_id, warnings, known_gaps)
        rolling_status = build_rolling_status(caches)
        history_available = len(caches["categoryCache"].get("weeks") or [])
        if history_available < MIN_HISTORY_WEEKS_FOR_TREND:
            warnings.append("history_insufficient"); known_gaps.append("history_insufficient_analyze_scope_wow_only")
        wtd = compare_wtd(caches["categoryCache"].get("rows") or [])
        warnings.extend(wtd["warnings"])
        integrity = order_chain_integrity_for_rows(caches["categoryCache"].get("rows") or [])
        integrity_errors = [] if integrity.get("ok") else [integrity]
        if integrity_errors:
            warnings.append(ORDER_CHAIN_EMPTY_CODE)
            known_gaps.append(ORDER_CHAIN_EMPTY_CODE)
        wtd_business_warnings = list(wtd["errors"])
        if wtd_business_warnings:
            warnings.extend(wtd_business_warnings)
        quality_errors = [*integrity_errors]
        quality_gate = "failed" if quality_errors else ("warn" if warnings or known_gaps else "pass")
        quality_summary = {"quality_gates": quality_gate, "warnings": list(warnings), "known_gaps": list(known_gaps), "wtd_quality_errors": len(wtd["errors"]), "wtd_business_warnings": len(wtd_business_warnings), "data_integrity_errors": len(integrity_errors)}
        analysis_history = build_analysis_history(caches, tags, quality_summary, known_gaps, run_dt, process_id)
        analysis_history_file = output_path / f"analysis_history_{run_dt}.json"; write_json(analysis_history_file, analysis_history)
        manifest_file = output_path / f"manifest_{run_dt}.json"
        manifest = {"contract_version": CONTRACT_VERSION, "run_id": process_id, "run_dt": run_dt, "generated_at": now_iso(), "sql_scope": upstream["sql_scope"], "scripts": list(upstream["scripts"]), "model_enrichment_status": caches["modelCache"].get("status") or "ready", "upstream_fetch_manifest": fetch["active"], "raw_manifest": upstream["raw_manifest"], "sql_status": upstream["sql_status"],
                    "imports": import_build["stats"], "promote": promote_report, "rolling_status": rolling_status, "history_weeks": KEEP_WEEKS, "history_weeks_available": history_available, "dashboard_window_weeks": DASHBOARD_WINDOW_WEEKS}
        write_json(manifest_file, manifest)
        state_dir = processed_root / "state"; ensure_dir(processed_imports / "manifests"); ensure_dir(state_dir)
        write_json(processed_imports / "active.json", {"run_id": process_id, "run_dt": run_dt, "manifest": f"manifests/manifest_{run_dt}.json"})
        shutil.copy2(manifest_file, processed_imports / "manifests" / f"manifest_{run_dt}.json")
        write_json(state_dir / "rolling-status.json", rolling_status); write_json(state_dir / "history-index.json", {"generated_at": now_iso(), "keep_weeks": KEEP_WEEKS, "weeks": caches["categoryCache"].get("weeks") or [], "rolling_week": rolling_status["rolling_week"], "final_weeks": rolling_status["final_weeks"]})
        shutil.copy2(cache_dir / "tag_snapshot_manifest.json", state_dir / "tag_snapshot_manifest.json")
        shutil.copy2(cache_dir / "category-mapping-manifest.json", state_dir / "category_mapping_manifest.json")
        shutil.copy2(cache_dir / "category-mapping-manifest.json", output_path / "category_mapping_manifest.json")
        quality_report = {"contract_version": "ai-wan-v1.5.5-quality", "run_id": process_id, "run_dt": run_dt, "generated_at": now_iso(), "quality_gates": quality_gate,
                          "upstream_fetch": {"run_id": fetch["active"].get("run_id", ""), "raw_cache": fetch["rawCache"].name, "raw_cache_sha256": fetch["actualSha"], "validated": True},
                          "raw_imports": import_build["stats"], "day_cnt": {"rolling_week": rolling_status["rolling_week"], "final_weeks": rolling_status["final_weeks"]},
                          "csv_repair": {key: value.get("csv_repair") for key, value in import_build["stats"].items()}, "wtd_quality": wtd, "data_integrity": integrity,
                          "keep_weeks": {"configured": KEEP_WEEKS, "history_weeks_available": history_available, "weeks": caches["categoryCache"].get("weeks") or []},
                          "taxonomy": {"rows": len(caches["taxonomy"].get("rows") or []), "self_operated_filtered": sum(1 for row in caches["taxonomy"].get("rows") or [] if row.get("tier") == "自营(非聚合)")},
                          "category_mapping_manifest": caches["categoryMapping"], "tag_snapshot": tags["manifest"], "board_metrics": {"rows": len(caches["boardCache"].get("rows") or []), "source": "sqldau", "gap": False},
                          "warnings": warnings, "errors": quality_errors, "known_gaps": known_gaps}
        quality_file = output_path / f"data_quality_report_{run_dt}.json"; write_json(quality_file, quality_report); shutil.copy2(quality_file, state_dir / quality_file.name)
        server_root = work_path / "server_cache_bundle_root"; write_server_bundle(server_root, caches, rolling_status, cache_dir, run_dt, process_id)
        imports_zip = output_path / f"imports_{run_dt}.zip"; zip_dir(processed_imports, imports_zip, (".",))
        processed_zip = output_path / f"processed_cache_{run_dt}.zip"; zip_dir(processed_root, processed_zip, ("imports", "cache", "state"))
        server_zip = output_path / f"server_cache_bundle_{run_dt}.zip"; zip_dir(server_root, server_zip, (".",))
        xlsx_file = output_path / f"AI小万_聚合回收经营分析_{run_dt}.xlsx"; write_minimal_xlsx(xlsx_file, manifest)
        hashes = {"imports_zip": sha256_file(imports_zip), "excel": sha256_file(xlsx_file), "manifest": sha256_file(manifest_file), "processed_cache": sha256_file(processed_zip), "server_cache_bundle": sha256_file(server_zip), "analysis_history": sha256_file(analysis_history_file), "data_quality_report": sha256_file(quality_file), "category_mapping_manifest": sha256_file(cache_dir / "category-mapping-manifest.json"), "model_tag_snapshot": tags["snapshot"]["sha256"], "model_tag_knowledge": tags["knowledge"]["sha256"], "model_tag_sync_manifest": tags["syncManifest"]["sha256"]}
        active = {"contract_version": CONTRACT_VERSION, "stage": "process", "status": "failed" if quality_gate == "failed" else ("warn" if quality_gate == "warn" else "success"), "run_id": process_id, "run_dt": run_dt, "target_month": run_dt[:7], "sql_scope": upstream["sql_scope"], "scripts": list(upstream["scripts"]), "model_enrichment_status": caches["modelCache"].get("status") or "ready", "upstream_stage": "fetch", "upstream_run_id": fetch["active"].get("run_id", ""), "upstream_raw_cache": fetch["rawCache"].name, "upstream_raw_cache_sha256": fetch["actualSha"], "history_weeks": KEEP_WEEKS, "history_weeks_available": history_available, "min_history_weeks_for_trend": MIN_HISTORY_WEEKS_FOR_TREND, "analysis_scope_hint": "wow_only" if history_available < MIN_HISTORY_WEEKS_FOR_TREND else "trend_10w", "dashboard_window_weeks": DASHBOARD_WINDOW_WEEKS, "rolling_week": rolling_status["rolling_week"], "final_weeks": rolling_status["final_weeks"], "imports_zip": imports_zip.name, "imports_zip_sha256": hashes["imports_zip"], "excel": xlsx_file.name, "excel_sha256": hashes["excel"], "manifest": manifest_file.name, "manifest_sha256": hashes["manifest"], "processed_cache": processed_zip.name, "processed_cache_sha256": hashes["processed_cache"], "server_cache_bundle": server_zip.name, "server_cache_bundle_sha256": hashes["server_cache_bundle"], "analysis_history": analysis_history_file.name, "analysis_history_sha256": hashes["analysis_history"], "data_quality_report": quality_file.name, "data_quality_report_sha256": hashes["data_quality_report"], "category_mapping_manifest": "category_mapping_manifest.json", "category_mapping_manifest_sha256": hashes["category_mapping_manifest"], "category_mapping_source": caches["categoryMapping"].get("source") or {}, "category_mapping_stats": caches["categoryMapping"].get("stats") or {}, "model_tag_snapshot": f"model_tag_snapshot_{run_dt}.json", "model_tag_snapshot_sha256": hashes["model_tag_snapshot"], "model_tag_knowledge": f"model_tag_knowledge_{run_dt}.json", "model_tag_knowledge_sha256": hashes["model_tag_knowledge"], "model_tag_sync_manifest": f"model_tag_sync_manifest_{run_dt}.json", "model_tag_sync_manifest_sha256": hashes["model_tag_sync_manifest"], "model_tag_source": "model-tag-monitor-server-front-end-tags", "model_tag_stats": {"tagged_model_count": tags["snapshot"]["stats"]["tagged_model_count"], "category_count": tags["snapshot"]["stats"]["category_count"]}, "model_tag_feishu_sync": tags["syncManifest"]["feishu_sync"], "feishu_sync": tags["syncManifest"]["feishu_sync"], "model_tag_sync_status": tags["syncManifest"]["status"], "artifact_hashes": hashes, "quality_gates": quality_gate, "warnings": warnings, "known_gaps": known_gaps, "generated_at": now_iso()}
        write_json(output_path / "active_process_manifest.json", active)
        result = {"ok": quality_gate != "failed", "manifest": active, "report": quality_report, "outDir": str(output_path)}
        return result
    except Exception as exc:
        return write_failure(output_path, run_dt, process_id, [f"{type(exc).__name__}: {exc}"], {"run_id": fetch["active"].get("run_id", ""), "raw_cache": fetch["rawCache"].name, "raw_cache_sha256": fetch["actualSha"]})
    finally:
        if not keep_work_dir:
            shutil.rmtree(work_path, ignore_errors=True)

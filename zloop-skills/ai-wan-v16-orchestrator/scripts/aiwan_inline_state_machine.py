#!/usr/bin/env python3
"""Inline AIWAN Loop state machine.

This script is intentionally boring: it either executes read -> process ->
analyze -> validate -> server write, or returns an explicit failed result.
It exists because zloop conversational Skill handoff can end the assistant turn
after READ; the Loop business contract needs machine-enforced stage completion.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import inspect
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

PROCESS_STARTED_AT = time.perf_counter()

try:
    import zloop_runtime.hub as hub
except Exception:  # pragma: no cover - only outside remote sandbox
    hub = None

try:
    import zloop_runtime.xinghe as xinghe
except Exception:  # pragma: no cover - only in remote sandbox
    xinghe = None


AIWAN_ORCHESTRATOR_BUILD = "v1.6.26-loop1-phase-a-python-process"
AIWAN_PROCESS_RUNTIME = "python3"
READ_PATH = "/v2/aiwan/api/aiwan/read"
WRITE_PATH = "/v2/aiwan/api/aiwan/write"
DISPLAY_CONTRACT = "dashboard-business-overview-insights-map/v1"
REQUIRED_TIERS = ("发展", "孵化", "种子")
COUNT_METRICS = ("jkuv", "evaUv", "orderUv", "shipCnt", "dealCnt", "gmv")
RATE_METRICS = ("orderRate", "shipRate", "dealRate")
TECH_DISPLAY_TERMS = (
    "AIWAN处理产物",
    "AIWAN process",
    "server_cache_bundle",
    "processed_cache",
    "服务器 bridge",
    "dashboard聚合快照",
    "orderRate",
    "shipCnt",
    "dealGmv",
    "wow_pct",
    "entity_type",
)
SCRIPT_NAMES = [
    "category_summary",
    "category_daily_avg",
    "category_fulfill_summary",
    "category_fulfill_daily_avg",
    "model_summary",
    "model_daily_avg",
]
HEAVY_SCRIPT_NAMES = ["model_daily_avg", "model_summary"]
LIGHT_SCRIPT_NAMES = [
    "category_daily_avg",
    "category_summary",
    "category_fulfill_daily_avg",
    "category_fulfill_summary",
]
FULFILL_OPTIONAL_EMPTY = {"category_fulfill_daily_avg", "category_fulfill_summary"}
READ_CONCURRENCY_POLICY = {"heavy": 1, "light": 2, "total": 3}
TERMINAL_SUCCESS = {"SUCCESS", "SUCCEEDED", "FINISHED", "DONE", "COMPLETED"}
TERMINAL_FAILED = {"FAILED", "FAIL", "ERROR", "CANCELLED", "CANCELED", "TIMEOUT"}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def out_root() -> Path:
    root = os.environ.get("SANDBOX_OUTPUT_DIR") or os.environ.get("OUTPUT_DIR")
    return Path(root) if root else Path.cwd() / "output"


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def round_seconds(value: float) -> float:
    return round(max(value, 0.0), 3)


def active_skill_dir() -> Path | None:
    value = os.environ.get("ZLOOP_ACTIVE_SKILL_DIR")
    return Path(value).expanduser() if value else None


def preflight() -> dict[str, Any]:
    started = time.perf_counter()
    root = repo_root()
    active_root = active_skill_dir()
    errors: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []

    def check(name: str, ok: bool, detail: Any = None, error_code: str | None = None) -> None:
        item = {"name": name, "ok": bool(ok)}
        if detail not in (None, ""):
            item["detail"] = detail
        checks.append(item)
        if not ok:
            errors.append({"code": error_code or name.upper(), **({"detail": detail} if detail not in (None, "") else {})})

    check("active_skill_dir_present", active_root is not None, error_code="ACTIVE_SKILL_DIR_MISSING")
    if active_root is not None:
        check("active_skill_dir_valid", active_root.exists() and active_root.is_dir(), str(active_root), "ACTIVE_SKILL_DIR_INVALID")
        if active_root.exists() and active_root.is_dir():
            check("active_skill_dir_matches_script", active_root.resolve() == root.resolve(), {
                "active_skill_dir": str(active_root.resolve()),
                "script_root": str(root.resolve()),
            }, "ACTIVE_SKILL_DIR_MISMATCH")

    required_files = [
        root / "SKILL.md",
        root / "skill.manifest.json",
        root / "scripts" / "aiwan_inline_state_machine.py",
        root / "scripts" / "aiwan_loop1_tick.py",
        root / "scripts" / "aiwan_apihub.py",
        root / "bin" / "package-raw-cache.js",
        root / "lib" / "package-raw-cache.js",
        root / "scripts" / "process_raw_cache.py",
        root / "scripts" / "process_pipeline.py",
        root / "references" / "read" / "query-playbook.md",
        root / "references" / "api-playbook.md",
        root / "references" / "apihub-read-write-contract.md",
    ] + [root / "references" / "read" / "sql" / f"{name}.sql" for name in SCRIPT_NAMES]
    missing = [str(path.relative_to(root)) for path in required_files if not path.is_file()]
    check("required_package_files", not missing, missing, "PACKAGE_FILE_MISSING")
    check("node_available", shutil.which("node") is not None, shutil.which("node"), "NODE_MISSING")
    check("zloop_runtime_hub_import", hub is not None, error_code="HUB_IMPORT_FAILED")
    check("zloop_runtime_xinghe_import", xinghe is not None, error_code="XINGHE_IMPORT_FAILED")

    manifest_build = None
    manifest_path = root / "skill.manifest.json"
    if manifest_path.is_file():
        try:
            manifest_build = read_json(manifest_path).get("contracts", {}).get("orchestrator_build")
        except Exception as exc:
            errors.append({"code": "MANIFEST_INVALID", "detail": str(exc)})
            checks.append({"name": "manifest_valid", "ok": False, "detail": str(exc)})
    check("build_marker_matches", manifest_build == AIWAN_ORCHESTRATOR_BUILD, {
        "manifest": manifest_build,
        "script": AIWAN_ORCHESTRATOR_BUILD,
    }, "BUILD_MARKER_MISMATCH")

    output_probe_error = None
    probe = None
    try:
        output = out_root()
        output.mkdir(parents=True, exist_ok=True)
        probe = output / f".aiwan_preflight_{os.getpid()}"
        probe.write_text("ok", encoding="utf-8")
    except Exception as exc:
        output_probe_error = str(exc)
    finally:
        if probe is not None:
            try:
                probe.unlink(missing_ok=True)
            except Exception:
                pass
    check("output_dir_writable", output_probe_error is None, output_probe_error, "OUTPUT_DIR_NOT_WRITABLE")

    elapsed = round_seconds(time.perf_counter() - started)
    return {
        "ok": not errors,
        "mode": "preflight",
        "entrypoint_resolution_mode": "runtime_active_skill_dir",
        "active_skill_dir": str(active_root) if active_root is not None else None,
        "orchestrator_build": AIWAN_ORCHESTRATOR_BUILD,
        "python": sys.version.split()[0],
        "checks": checks,
        "errors": errors,
        "timings": {
            "startup_seconds": round_seconds(started - PROCESS_STARTED_AT),
            "preflight_seconds": elapsed,
            "total_seconds": round_seconds(time.perf_counter() - PROCESS_STARTED_AT),
        },
    }


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def json_safe(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return "<max-depth>"
    if isinstance(value, dict):
        return {str(k): json_safe(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v, depth + 1) for v in list(value)[:100]]
    if isinstance(value, (str, int, float, bool)) or value is None:
        if isinstance(value, str) and len(value) > 2000:
            return value[:2000] + "...<truncated>"
        return value
    return repr(value)


def walk_values(value: Any) -> list[Any]:
    out = [value]
    if isinstance(value, dict):
        for item in value.values():
            out.extend(walk_values(item))
    elif isinstance(value, list):
        for item in value:
            out.extend(walk_values(item))
    return out


def values_for_keys(value: Any, keys: set[str]) -> list[Any]:
    out: list[Any] = []
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key) in keys and item not in (None, ""):
                out.append(item)
            out.extend(values_for_keys(item, keys))
    elif isinstance(value, list):
        for item in value:
            out.extend(values_for_keys(item, keys))
    return out


def csv_row_count(csv_path: Path) -> int:
    with csv_path.open("r", encoding="utf-8", errors="ignore") as f:
        return max(sum(1 for _ in f) - 1, 0)


def validate_csv_for_reuse(csv_path: Path, allow_empty: bool) -> dict[str, Any] | None:
    if not csv_path.exists() or not csv_path.is_file():
        return None
    size = csv_path.stat().st_size
    if size <= 0:
        return None
    rows = csv_row_count(csv_path)
    if rows <= 0 and not allow_empty:
        return None
    return {
        "row_count": rows,
        "csv": str(csv_path),
        "file_size_bytes": size,
        "csv_sha256": sha256_file(csv_path),
    }


def excel_col_to_index(ref: str) -> int:
    letters = "".join(ch for ch in ref if ch.isalpha())
    idx = 0
    for ch in letters:
        idx = idx * 26 + ord(ch.upper()) - ord("A") + 1
    return max(idx - 1, 0)


def xlsx_to_csv(xlsx_path: Path, csv_path: Path) -> int:
    ns = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    with zipfile.ZipFile(xlsx_path) as zf:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in zf.namelist():
            root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in root.findall("a:si", ns):
                parts = [node.text or "" for node in si.findall(".//a:t", ns)]
                shared.append("".join(parts))
        sheet_name = "xl/worksheets/sheet1.xml"
        if sheet_name not in zf.namelist():
            candidates = [n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")]
            if not candidates:
                raise RuntimeError(f"xlsx has no worksheets: {xlsx_path}")
            sheet_name = sorted(candidates)[0]
        root = ET.fromstring(zf.read(sheet_name))
        rows: list[list[str]] = []
        for row in root.findall(".//a:sheetData/a:row", ns):
            values: list[str] = []
            for c in row.findall("a:c", ns):
                idx = excel_col_to_index(c.attrib.get("r", "A1"))
                while len(values) <= idx:
                    values.append("")
                cell_type = c.attrib.get("t")
                if cell_type == "inlineStr":
                    text = "".join(node.text or "" for node in c.findall(".//a:t", ns))
                else:
                    v = c.find("a:v", ns)
                    text = v.text if v is not None and v.text is not None else ""
                    if cell_type == "s" and text:
                        try:
                            text = shared[int(text)]
                        except Exception:
                            pass
                values[idx] = text
            rows.append(values)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", encoding="utf-8", newline="") as f:
        csv.writer(f).writerows(rows)
    return max(len(rows) - 1, 0)


def normalize_downloaded_file(downloaded_path: Path, csv_path: Path) -> int:
    if downloaded_path.suffix.lower() in {".xlsx", ".xlsm"}:
        return xlsx_to_csv(downloaded_path, csv_path)
    if downloaded_path != csv_path:
        shutil.copyfile(downloaded_path, csv_path)
    return csv_row_count(csv_path)


def copy_if_existing_path(value: Any, csv_path: Path) -> int | None:
    for item in walk_values(value):
        if isinstance(item, str) and item and not item.startswith(("http://", "https://", "/workbench/")):
            candidate = Path(item)
            if candidate.exists() and candidate.is_file():
                return normalize_downloaded_file(candidate, csv_path)
    return None


def download_url_to_path(item: str, target_path: Path, timeout: float = 12.0) -> bool:
    parsed = urllib.parse.urlparse(item)
    if parsed.scheme in {"http", "https"}:
        with urllib.request.urlopen(item, timeout=timeout) as resp:  # noqa: S310 - platform-provided URL
            target_path.write_bytes(resp.read())
        return target_path.exists()
    return False


def download_url(item: str, csv_path: Path, timeout: float = 12.0) -> int | None:
    parsed = urllib.parse.urlparse(item)
    suffix = Path(urllib.parse.unquote(parsed.path)).suffix.lower() or ".download"
    tmp_path = csv_path.with_suffix(suffix)
    if download_url_to_path(item, tmp_path, timeout=timeout):
        return normalize_downloaded_file(tmp_path, csv_path)
    return None


def download_if_url(value: Any, csv_path: Path, errors: list[str] | None = None) -> int | None:
    for item in walk_values(value):
        if isinstance(item, str):
            parsed = urllib.parse.urlparse(item)
            if parsed.scheme in {"http", "https"}:
                try:
                    rows = download_url(item, csv_path)
                    if rows is not None:
                        return rows
                except Exception as exc:
                    if errors is not None:
                        errors.append(f"download url {item[:120]}: {exc}")
    return None


def write_embedded_content(value: Any, csv_path: Path) -> int | None:
    for item in values_for_keys(value, {"content_base64", "file_base64", "base64"}):
        if isinstance(item, str) and item:
            csv_path.write_bytes(base64.b64decode(item))
            return csv_row_count(csv_path)
    for item in values_for_keys(value, {"content", "csv", "text"}):
        if isinstance(item, str) and item and ("\n" in item or "," in item):
            csv_path.write_text(item, encoding="utf-8")
            return csv_row_count(csv_path)
    return None


def iso_week_from_start(week_start: str) -> str:
    d = datetime.strptime(week_start[:10], "%Y-%m-%d").date()
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def iso_week_start(week: str) -> date:
    match = re.fullmatch(r"(\d{4})-W(\d{2})", str(week or "").strip())
    if not match:
        raise ValueError(f"INVALID_ISO_WEEK: {week!r}")
    year, week_number = int(match.group(1)), int(match.group(2))
    try:
        return date.fromisocalendar(year, week_number, 1)
    except ValueError as exc:
        raise ValueError(f"INVALID_ISO_WEEK: {week!r}") from exc


def week_start_dates(week: str) -> list[str]:
    current = iso_week_start(week)
    return [(current - timedelta(days=7)).isoformat(), current.isoformat()]


def render_sql(text: str, run_dt: str, data_end_date: str) -> str:
    rendered = text
    rendered = rendered.replace("${outFileSuffix}", run_dt)
    rendered = rendered.replace("${hiveconf:run_dt}", run_dt)
    rendered = rendered.replace("${hiveconf:end_date}", data_end_date)
    rendered = rendered.replace("$bash{date +%Y-%m-%d -d '-1 day'}", data_end_date)
    rendered = rendered.replace("${#date(0,0,-1):yyyy-MM-dd#}", data_end_date)
    return rendered


def call_with_supported_kwargs(func: Any, **kwargs: Any) -> Any:
    sig = inspect.signature(func)
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in sig.parameters.values()):
        return func(**kwargs)
    usable = {k: v for k, v in kwargs.items() if k in sig.parameters}
    return func(**usable)


def normalize_execute_id(resp: Any) -> str:
    if isinstance(resp, dict):
        for key in ("execute_id", "executeId", "id", "job_id", "query_id"):
            if resp.get(key) is not None:
                return str(resp[key])
        data = resp.get("data")
        if isinstance(data, dict):
            return normalize_execute_id(data)
    raise RuntimeError(f"cannot find execute_id in run_hive_sql response: {resp!r}")


def status_items(resp: Any) -> list[dict[str, Any]]:
    if isinstance(resp, list):
        return [x for x in resp if isinstance(x, dict)]
    if isinstance(resp, dict):
        for key in ("items", "data", "results", "statuses"):
            val = resp.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
            if isinstance(val, dict):
                return status_items(val)
        return [resp]
    return []


def get_status_for(resp: Any, execute_id: str) -> str:
    items = status_items(resp)
    chosen = None
    for item in items:
        if str(item.get("execute_id") or item.get("executeId") or item.get("id") or "") == str(execute_id):
            chosen = item
            break
    if chosen is None and items:
        chosen = items[0]
    if not chosen:
        return "UNKNOWN"
    return str(chosen.get("status") or chosen.get("state") or chosen.get("execute_status") or "UNKNOWN").upper()


def rows_to_csv(rows: Any, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(rows, dict):
        for key in ("rows", "data", "items", "result"):
            if isinstance(rows.get(key), list):
                rows = rows[key]
                break
    if not isinstance(rows, list):
        rows = []
    if not rows:
        path.write_text("", encoding="utf-8")
        return 0
    if all(isinstance(r, dict) for r in rows):
        headers: list[str] = []
        for r in rows:
            for key in r.keys():
                if key not in headers:
                    headers.append(key)
        with path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
            writer.writerows(rows)
        return len(rows)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)
    return len(rows)


def materialize_full_csv(execute_id: str, csv_path: Path, debug_dir: Path, script_name: str) -> int:
    if xinghe is None:
        raise RuntimeError("zloop_runtime.xinghe is unavailable")
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    mat = getattr(xinghe, "materialize_result_file", None)
    if mat is None:
        raise RuntimeError("READ_ARTIFACTS_MISSING: materialize_result_file is unavailable; get_sql_results preview is not a valid raw_cache input")
    attempts = [
        {"execute_id": execute_id, "file_type": "csv"},
        {"execute_id": execute_id, "file_type": "csv", "output_path": str(csv_path)},
        {"execute_id": execute_id},
    ]
    errors = []
    responses = []
    url_key_order = [
        "cdn_url",
        "download_url",
        "file_url",
        "artifact_url",
        "share_url",
        "url",
        "source_download_url",
        "internal_download_url",
    ]
    for kwargs in attempts:
        try:
            resp = call_with_supported_kwargs(mat, **kwargs)
            responses.append({"kwargs": kwargs, "response": json_safe(resp)})
            write_json(debug_dir / f"materialize_{script_name}_{execute_id}_attempt_{len(responses)}.json", responses[-1])
            if csv_path.exists():
                return csv_row_count(csv_path)
            copied_rows = copy_if_existing_path(resp, csv_path)
            if copied_rows is not None:
                return copied_rows
            if isinstance(resp, dict) and resp.get("read_domain") and resp.get("cos_path"):
                derived_url = f"https://{resp['read_domain']}{resp['cos_path']}"
                try:
                    url_rows = download_url(derived_url, csv_path)
                    if url_rows is not None:
                        return url_rows
                except Exception as exc:
                    errors.append(f"download read_domain/cos_path: {exc}")
            for url_key in url_key_order:
                for url in values_for_keys(resp, {url_key}):
                    if isinstance(url, str):
                        try:
                            url_rows = download_url(url, csv_path)
                            if url_rows is not None:
                                return url_rows
                        except Exception as exc:
                            errors.append(f"download {url_key}: {exc}")
            downloaded_rows = download_if_url(resp, csv_path, errors)
            if downloaded_rows is not None:
                return downloaded_rows
            embedded_rows = write_embedded_content(resp, csv_path)
            if embedded_rows is not None:
                return embedded_rows
        except Exception as exc:  # try signature variants
            errors.append(str(exc))
            responses.append({"kwargs": kwargs, "error": str(exc)})
            write_json(debug_dir / f"materialize_{script_name}_{execute_id}_attempt_{len(responses)}.json", responses[-1])
        if responses and "response" in responses[-1]:
            # A successful materialize call that returns file metadata should
            # not be repeated with more signature variants. In the sandbox,
            # repeated URL download timeouts can consume the 600s Bash tool cap.
            break
    write_json(debug_dir / f"materialize_{script_name}_{execute_id}.json", {
        "script": script_name,
        "execute_id": execute_id,
        "target_csv": str(csv_path),
        "attempts": responses,
        "errors": errors,
    })
    response_summary = json.dumps(responses[-3:], ensure_ascii=False)[:2000]
    raise RuntimeError(
        "MATERIALIZE_UNSUPPORTED_OR_NO_DOWNLOAD_URL: SQL succeeded but full CSV materialization failed; "
        f"execute_id={execute_id}, attempts={len(attempts)}, errors={errors[-3:]}, "
        f"response_summary={response_summary}"
    )


def read_resume_manifest(run_dir: Path) -> dict[str, Any]:
    path = run_dir / "read_resume_manifest.json"
    if path.exists():
        try:
            data = read_json(path)
            if isinstance(data, dict):
                return data
        except Exception:
            return {}
    return {}


def write_read_resume_manifest(run_dir: Path, args: argparse.Namespace, statuses: dict[str, dict[str, Any]]) -> None:
    write_json(run_dir / "read_resume_manifest.json", {
        "run_id": args.run_id,
        "run_dt": args.run_dt,
        "data_end_date": args.data_end_date,
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "concurrency_policy": READ_CONCURRENCY_POLICY,
        "sql_status": statuses,
    })


def write_read_failed_diagnostic(run_dir: Path, args: argparse.Namespace, statuses: dict[str, dict[str, Any]], error: str) -> None:
    diagnostic = {
        "stage": "read",
        "status": "failed",
        "run_id": args.run_id,
        "run_dt": args.run_dt,
        "data_end_date": args.data_end_date,
        "error_summary": error,
        "concurrency_policy": READ_CONCURRENCY_POLICY,
        "sql_status": {
            name: {
                key: value
                for key, value in status.items()
                if key in {
                    "execute_id",
                    "status",
                    "rendered_sql_sha256",
                    "started_at",
                    "ended_at",
                    "duration_seconds",
                    "error_summary",
                    "reused",
                    "reuse_source",
                    "row_count",
                    "csv_sha256",
                    "file_size_bytes",
                }
            }
            for name, status in statuses.items()
        },
    }
    write_json(run_dir / "read_failed_diagnostic.json", diagnostic)


def cleanup_read_failure_large_files(run_dir: Path) -> None:
    for name in ("read_exports", "read_artifacts", "debug"):
        path = run_dir / name
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)


def cleanup_success_large_files(run_dir: Path) -> None:
    for name in ("read_exports", "read_artifacts", "process_artifacts", "debug"):
        path = run_dir / name
        if path.exists():
            shutil.rmtree(path, ignore_errors=True)


def execute_read(args: argparse.Namespace, run_dir: Path) -> dict[str, Any]:
    if xinghe is None:
        raise RuntimeError("zloop_runtime.xinghe is unavailable")
    root = repo_root()
    analysis_week_starts = week_start_dates(args.week)
    raw_root = run_dir / "read_artifacts"
    export_dir = run_dir / "read_exports"
    debug_dir = run_dir / "debug"
    raw_root.mkdir(parents=True, exist_ok=True)
    export_dir.mkdir(parents=True, exist_ok=True)
    debug_dir.mkdir(parents=True, exist_ok=True)
    statuses: dict[str, dict[str, Any]] = {}
    resume_manifest = read_resume_manifest(run_dir)
    previous_statuses = resume_manifest.get("sql_status", {}) if resume_manifest.get("run_dt") == args.run_dt else {}

    for name in HEAVY_SCRIPT_NAMES + LIGHT_SCRIPT_NAMES:
        template = root / "references" / "read" / "sql" / f"{name}.sql"
        sql = render_sql(template.read_text(encoding="utf-8"), args.run_dt, args.data_end_date)
        rendered_path = export_dir / f"{name}_{args.run_dt}.sql"
        rendered_path.write_text(sql, encoding="utf-8")
        rendered_sha = sha256_file(rendered_path)
        statuses[name] = {
            "status": "PENDING",
            "rendered_sql": str(rendered_path),
            "rendered_sql_sha256": rendered_sha,
            "queue": "heavy" if name in HEAVY_SCRIPT_NAMES else "light",
            "reused": False,
            "queued_ts": time.time(),
        }
        previous = previous_statuses.get(name, {}) if isinstance(previous_statuses, dict) else {}
        if previous.get("status") == "SUCCESS" and previous.get("rendered_sql_sha256") == rendered_sha:
            csv_path = Path(previous.get("csv") or export_dir / f"{name}_{args.run_dt}.csv")
            reusable = validate_csv_for_reuse(csv_path, name in FULFILL_OPTIONAL_EMPTY)
            if reusable:
                statuses[name].update(previous)
                statuses[name].update(reusable)
                statuses[name].update({
                    "status": "SUCCESS",
                    "rendered_sql": str(rendered_path),
                    "rendered_sql_sha256": rendered_sha,
                    "queue": "heavy" if name in HEAVY_SCRIPT_NAMES else "light",
                    "reused": True,
                    "reuse_source": "csv",
                })
                continue
            execute_id = previous.get("execute_id")
            if execute_id:
                try:
                    rows = materialize_full_csv(str(execute_id), export_dir / f"{name}_{args.run_dt}.csv", debug_dir, name)
                    csv_path = export_dir / f"{name}_{args.run_dt}.csv"
                    statuses[name].update(previous)
                    statuses[name].update({
                        "status": "SUCCESS",
                        "rendered_sql": str(rendered_path),
                        "rendered_sql_sha256": rendered_sha,
                        "queue": "heavy" if name in HEAVY_SCRIPT_NAMES else "light",
                        "row_count": rows,
                        "csv": str(csv_path),
                        "file_size_bytes": csv_path.stat().st_size if csv_path.exists() else 0,
                        "csv_sha256": sha256_file(csv_path) if csv_path.exists() else None,
                        "reused": True,
                        "reuse_source": "execute_id_rematerialized",
                    })
                    continue
                except Exception as exc:
                    statuses[name]["reuse_error"] = str(exc)

    def submit_one(name: str) -> None:
        sql = Path(statuses[name]["rendered_sql"]).read_text(encoding="utf-8")
        submit_started = time.time()
        submit = call_with_supported_kwargs(
            xinghe.run_hive_sql,
            content=sql,
            sql=sql,
            title=f"AIWAN {name} {args.run_dt}",
            business_id="5",
            business_name="聚合回收",
        )
        submit_ended = time.time()
        execute_id = normalize_execute_id(submit)
        statuses[name].update({
            "execute_id": execute_id,
            "status": "SUBMITTED",
            "started_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "started_ts": submit_started,
            "submitted_ts": submit_ended,
            "queue_seconds": round_seconds(submit_started - float(statuses[name].get("queued_ts", submit_started))),
            "submit_seconds": round_seconds(submit_ended - submit_started),
        })

    def complete_success(name: str) -> None:
        csv_path = export_dir / f"{name}_{args.run_dt}.csv"
        query_completed = time.time()
        statuses[name]["execute_seconds"] = round_seconds(query_completed - float(statuses[name].get("submitted_ts", query_completed)))
        materialize_started = time.time()
        try:
            rows = materialize_full_csv(statuses[name]["execute_id"], csv_path, debug_dir, name)
        finally:
            materialize_ended = time.time()
            statuses[name]["materialize_seconds"] = round_seconds(materialize_ended - materialize_started)
        allow_empty = name in FULFILL_OPTIONAL_EMPTY
        if rows <= 0 and not allow_empty:
            raise RuntimeError(f"SQL {name} materialized empty CSV; non-fulfill result cannot be empty")
        ended = materialize_ended
        statuses[name].update({
            "status": "SUCCESS",
            "row_count": rows,
            "csv": str(csv_path),
            "file_size_bytes": csv_path.stat().st_size if csv_path.exists() else 0,
            "csv_sha256": sha256_file(csv_path) if csv_path.exists() else None,
            "ended_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "duration_seconds": round(ended - float(statuses[name].get("started_ts", ended)), 3),
        })

    deadline = time.time() + args.sql_timeout_seconds
    heavy_queue = [name for name in HEAVY_SCRIPT_NAMES if statuses[name].get("status") != "SUCCESS"]
    light_queue = [name for name in LIGHT_SCRIPT_NAMES if statuses[name].get("status") != "SUCCESS"]
    active: set[str] = set()
    failed_terminal: set[str] = set()

    while time.time() < deadline:
        active_heavy = [name for name in active if statuses[name].get("queue") == "heavy"]
        active_light = [name for name in active if statuses[name].get("queue") == "light"]
        while heavy_queue and len(active_heavy) < READ_CONCURRENCY_POLICY["heavy"] and len(active) < READ_CONCURRENCY_POLICY["total"]:
            name = heavy_queue.pop(0)
            submit_one(name)
            active.add(name)
            active_heavy.append(name)
        while light_queue and len(active_light) < READ_CONCURRENCY_POLICY["light"] and len(active) < READ_CONCURRENCY_POLICY["total"]:
            name = light_queue.pop(0)
            submit_one(name)
            active.add(name)
            active_light.append(name)

        if not active and not heavy_queue and not light_queue:
            break

        if active:
            ids = [statuses[name]["execute_id"] for name in active]
            resp = call_with_supported_kwargs(xinghe.check_sql_status, execute_ids=ids, execute_id=ids[0])
            for name in list(active):
                status = get_status_for(resp, statuses[name]["execute_id"])
                statuses[name]["status"] = status
                if status in TERMINAL_SUCCESS:
                    try:
                        complete_success(name)
                        active.remove(name)
                        write_read_resume_manifest(run_dir, args, statuses)
                    except Exception as exc:
                        ended = time.time()
                        statuses[name].update({
                            "status": "MATERIALIZE_FAILED",
                            "error_summary": str(exc),
                            "ended_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                            "duration_seconds": round(ended - float(statuses[name].get("started_ts", ended)), 3),
                        })
                        failed_terminal.add(name)
                        active.remove(name)
                        write_read_resume_manifest(run_dir, args, statuses)
                elif status in TERMINAL_FAILED:
                    ended = time.time()
                    statuses[name].update({
                        "ended_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        "duration_seconds": round(ended - float(statuses[name].get("started_ts", ended)), 3),
                        "execute_seconds": round_seconds(ended - float(statuses[name].get("submitted_ts", ended))),
                    })
                    failed_terminal.add(name)
                    active.remove(name)
                    write_read_resume_manifest(run_dir, args, statuses)

        if failed_terminal:
            break
        if active or heavy_queue or light_queue:
            time.sleep(args.poll_interval_seconds)

    for name in active:
        ended = time.time()
        statuses[name].update({
            "status": "TIMEOUT",
            "ended_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "duration_seconds": round(ended - float(statuses[name].get("started_ts", ended)), 3),
            "execute_seconds": round_seconds(ended - float(statuses[name].get("submitted_ts", ended))),
        })
    for name in heavy_queue + light_queue:
        statuses[name]["status"] = "NOT_SUBMITTED"

    write_read_resume_manifest(run_dir, args, statuses)
    failed = [name for name, st in statuses.items() if st.get("status") != "SUCCESS"]
    if failed:
        error = f"SQL failed or timed out: {failed}"
        write_read_failed_diagnostic(run_dir, args, statuses, error)
        cleanup_read_failure_large_files(run_dir)
        raise RuntimeError(error)
    pkg_cmd = [
        "node",
        str(repo_root() / "bin" / "package-raw-cache.js"),
        "--run-dt",
        args.run_dt,
        "--run-id",
        args.run_id,
        "--input-dir",
        str(export_dir),
        "--out-dir",
        str(raw_root),
    ]
    pkg = subprocess.run(pkg_cmd, text=True, capture_output=True, timeout=300)
    (raw_root / "package_raw_cache_stdout.txt").write_text(pkg.stdout, encoding="utf-8")
    (raw_root / "package_raw_cache_stderr.txt").write_text(pkg.stderr, encoding="utf-8")
    if pkg.returncode != 0:
        raise RuntimeError(f"package-raw-cache failed: {pkg.stderr[-2000:] or pkg.stdout[-2000:]}")
    active_fetch = read_json(raw_root / "active_fetch_manifest.json")
    active_fetch["week"] = args.week
    active_fetch["data_end_date"] = args.data_end_date
    active_fetch["week_start_dates"] = analysis_week_starts
    active_fetch["sql_execute_status"] = statuses
    active_fetch["read_concurrency_policy"] = READ_CONCURRENCY_POLICY
    fulfill_empty = [name for name in FULFILL_OPTIONAL_EMPTY if int(statuses.get(name, {}).get("row_count") or 0) == 0]
    warnings = active_fetch.get("warnings") if isinstance(active_fetch.get("warnings"), list) else []
    if fulfill_empty:
        active_fetch["status"] = "warn"
        warnings.append({"code": "FULFILL_EMPTY_ALLOWED", "scripts": fulfill_empty})
    active_fetch["warnings"] = warnings
    write_json(raw_root / "active_fetch_manifest.json", active_fetch)
    return {
        "stage": "read",
        "status": active_fetch.get("status", "success"),
        "output_type": "sql_result",
        "run_id": args.run_id,
        "week": args.week,
        "run_dt": args.run_dt,
        "data_end_date": args.data_end_date,
        "week_start_dates": analysis_week_starts,
        "read_concurrency_policy": READ_CONCURRENCY_POLICY,
        "sql_status": statuses,
        "warnings": warnings,
        "artifacts": {
            "input_dir": str(raw_root),
            "active_fetch_manifest": str(raw_root / "active_fetch_manifest.json"),
            "raw_cache": str(raw_root / f"raw_cache_{args.run_dt}.zip"),
            "sql_status": str(raw_root / f"sql_status_{args.run_dt}.json"),
            "raw_manifest": str(raw_root / f"raw_manifest_{args.run_dt}.json"),
        },
        "next_stage": "process",
    }


def execute_process(args: argparse.Namespace, run_dir: Path, read_result: dict[str, Any]) -> dict[str, Any]:
    process_dir = run_dir / "process_artifacts"
    process_dir.mkdir(parents=True, exist_ok=True)
    input_dir = Path(read_result["artifacts"]["input_dir"])
    required_inputs = [
        input_dir / "active_fetch_manifest.json",
        input_dir / f"raw_cache_{args.run_dt}.zip",
        input_dir / f"sql_status_{args.run_dt}.json",
        input_dir / f"raw_manifest_{args.run_dt}.json",
    ]
    missing_inputs = [str(path) for path in required_inputs if not path.exists()]
    if missing_inputs:
        write_json(process_dir / "process_failure_diagnostic.json", {
            "stage": "process",
            "status": "failed",
            "code": "PROCESS_INPUT_MISSING",
            "run_id": args.run_id,
            "run_dt": args.run_dt,
            "input_dir": str(input_dir),
            "missing_inputs": missing_inputs,
            "read_sql_status": read_result.get("sql_status", {}),
        })
        raise RuntimeError(f"PROCESS_INPUT_MISSING: {missing_inputs}")
    cmd = [
        sys.executable or AIWAN_PROCESS_RUNTIME,
        str(repo_root() / "scripts" / "process_raw_cache.py"),
        "--run-dt",
        args.run_dt,
        "--run-id",
        args.run_id,
        "--input-dir",
        str(input_dir),
        "--out-dir",
        str(process_dir),
        "--snapshot-dir",
        str(repo_root() / "references" / "process" / "server-snapshot"),
    ]
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=args.process_timeout_seconds)
    (process_dir / "process_command.json").write_text(
        json.dumps({"cmd": cmd, "runtime": "python", "orchestrator_build": AIWAN_ORCHESTRATOR_BUILD}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (process_dir / "process_stdout.txt").write_text(proc.stdout, encoding="utf-8")
    (process_dir / "process_stderr.txt").write_text(proc.stderr, encoding="utf-8")
    if proc.returncode != 0:
        stdout_tail = proc.stdout[-4000:]
        stderr_tail = proc.stderr[-4000:]
        write_json(process_dir / "process_failure_diagnostic.json", {
            "stage": "process",
            "status": "failed",
            "code": "PROCESS_COMMAND_FAILED",
            "run_id": args.run_id,
            "run_dt": args.run_dt,
            "returncode": proc.returncode,
            "cmd": cmd,
            "runtime": "python",
            "stdout_tail": stdout_tail,
            "stderr_tail": stderr_tail,
            "read_sql_status": read_result.get("sql_status", {}),
        })
        raise RuntimeError(f"process failed: returncode={proc.returncode}; stderr_tail={stderr_tail!r}; stdout_tail={stdout_tail!r}")
    parsed = json.loads(proc.stdout)
    manifest = parsed.get("manifest", {})
    report = parsed.get("report", {})
    active_path = process_dir / "active_process_manifest.json"
    if not active_path.exists():
        raise RuntimeError("process did not write active_process_manifest.json")
    return {
        "stage": "process",
        "status": manifest.get("status") or ("success" if parsed.get("ok") else "warn"),
        "output_type": "processed_data",
        "run_id": args.run_id,
        "week": args.week,
        "run_dt": args.run_dt,
        "active_process_manifest": manifest,
        "data_quality_report": report,
        "category_mapping_manifest": read_json(process_dir / "category_mapping_manifest.json") if (process_dir / "category_mapping_manifest.json").exists() else {},
        "process_summary": {
            "history_weeks_available": manifest.get("history_weeks_available"),
            "analysis_scope_hint": manifest.get("analysis_scope_hint"),
            "quality_gates": manifest.get("quality_gates"),
        },
        "artifacts": {
            "process_dir": str(process_dir),
            "active_process_manifest": str(active_path),
            "processed_cache": str(process_dir / manifest.get("processed_cache", "")),
            "server_cache_bundle": str(process_dir / manifest.get("server_cache_bundle", "")),
            "data_quality_report": str(process_dir / manifest.get("data_quality_report", "")),
        },
        "warnings": manifest.get("warnings", []),
        "next_stage": "analyze",
    }


def hub_post(path: str, body: dict[str, Any], timeout: float = 90.0) -> dict[str, Any]:
    if hub is None:
        raise RuntimeError("zloop_runtime.hub is unavailable")
    response = hub.post(path, json_body=body, timeout=timeout)
    data = response.json()
    if not response.ok or not isinstance(data, dict) or data.get("ok") is not True:
        raise RuntimeError(f"hub post failed {path}: status={response.status_code} body={data}")
    return data


def read_zip_json(zip_path: str | Path | None, member: str) -> Any:
    if not zip_path:
        return None
    path = Path(zip_path)
    if not path.exists():
        return None
    with zipfile.ZipFile(path) as zf:
        try:
            with zf.open(member) as f:
                return json.loads(f.read().decode("utf-8"))
        except KeyError:
            return None


def read_cache_json(processed: dict[str, Any], member: str) -> Any:
    artifacts = processed.get("artifacts") or {}
    for bundle_key, prefix in (("server_cache_bundle", ""), ("processed_cache", "cache/")):
        data = read_zip_json(artifacts.get(bundle_key), f"{prefix}{member}")
        if data is not None:
            return data
    process_dir_value = artifacts.get("process_dir")
    process_dir = Path(str(process_dir_value)) if process_dir_value else None
    if process_dir and process_dir.exists():
        direct = process_dir / member
        if direct.exists():
            return read_json(direct)
    return None


def latest_category_rows(category_cache: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = category_cache.get("rows") if isinstance(category_cache, dict) else []
    if not isinstance(rows, list):
        return {}
    weeks = [str(row.get("week") or "") for row in rows if isinstance(row, dict) and row.get("week")]
    latest_week = sorted(set(weeks))[-1] if weeks else ""
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or str(row.get("week") or "") != latest_week:
            continue
        category = str(row.get("category") or "").strip()
        if category:
            latest[category] = row
    return latest


def latest_previous_rows(cache: dict[str, Any], key_field: str = "category") -> tuple[str, str, dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    rows = cache.get("rows") if isinstance(cache, dict) else []
    if not isinstance(rows, list):
        return "", "", {}, {}
    weeks = sorted({str(row.get("week") or "") for row in rows if isinstance(row, dict) and row.get("week")})
    latest_week = weeks[-1] if weeks else ""
    prev_week = weeks[-2] if len(weeks) >= 2 else ""
    latest: dict[str, dict[str, Any]] = {}
    previous: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = str(row.get(key_field) or "").strip()
        week = str(row.get("week") or "")
        if not key:
            continue
        if week == latest_week:
            latest[key] = row
        elif week == prev_week:
            previous[key] = row
    return latest_week, prev_week, latest, previous


def latest_top_models_by_category(model_cache: dict[str, Any]) -> dict[str, dict[str, Any]]:
    rows = model_cache.get("rows") if isinstance(model_cache, dict) else []
    if not isinstance(rows, list):
        return {}
    weeks = [str(row.get("week") or "") for row in rows if isinstance(row, dict) and row.get("week")]
    latest_week = sorted(set(weeks))[-1] if weeks else ""
    top: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict) or str(row.get("week") or "") != latest_week:
            continue
        category = str(row.get("category") or "").strip()
        if not category:
            continue
        if category not in top or num(row.get("gmv")) > num(top[category].get("gmv")):
            top[category] = row
    return top


def num(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def money(value: Any) -> str:
    amount = num(value)
    if amount >= 10000:
        return f"{amount / 10000:.1f}万"
    return f"{amount:.0f}"


def pct(value: Any) -> str:
    return f"{num(value) * 100:.1f}%"


def signed_pct(value: Any) -> str:
    n = num(value)
    if abs(n) < 0.0005:
        return "持平"
    return f"{'上升' if n > 0 else '下降'}{abs(n) * 100:.2f}个百分点"


def signed_money(value: Any) -> str:
    n = num(value)
    if abs(n) < 0.5:
        return "基本持平"
    return f"{'增加' if n > 0 else '减少'}{money(abs(n))}"


def signed_count(value: Any) -> str:
    n = num(value)
    if abs(n) < 0.05:
        return "基本持平"
    return f"{'增加' if n > 0 else '减少'}{abs(n):.1f}"


def avg_price(row: dict[str, Any]) -> float:
    deal_cnt = num(row.get("dealCnt"))
    return num(row.get("gmv")) / deal_cnt if deal_cnt > 0 else 0.0


def rates(row: dict[str, Any]) -> dict[str, float]:
    src = row.get("rates") if isinstance(row.get("rates"), dict) else {}
    div = lambda a, b: num(a) / num(b) if num(b) > 0 else 0.0
    return {
        "orderRate": num(src.get("orderRate")) or div(row.get("orderUv"), row.get("evaUv")),
        "shipRate": num(src.get("shipRate")) or div(row.get("shipCnt"), row.get("orderUv") or row.get("orderCnt")),
        "dealRate": num(src.get("dealRate")) or div(row.get("dealCnt"), row.get("shipCnt") or row.get("qcCnt")),
    }


def sum_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    out = {key: 0.0 for key in COUNT_METRICS}
    for row in rows:
        for key in COUNT_METRICS:
            out[key] += num(row.get(key))
    out["avgPrice"] = avg_price(out)
    out["rates"] = rates(out)
    return out


def delta_pack(cur: dict[str, Any], prev: dict[str, Any]) -> dict[str, Any]:
    cur_rates = rates(cur)
    prev_rates = rates(prev)
    gmv_delta = num(cur.get("gmv")) - num(prev.get("gmv"))
    prev_gmv = num(prev.get("gmv"))
    deal_delta = num(cur.get("dealCnt")) - num(prev.get("dealCnt"))
    price_delta = avg_price(cur) - avg_price(prev)
    return {
        "gmv_delta": gmv_delta,
        "gmv_delta_pct": gmv_delta / prev_gmv if prev_gmv > 0 else None,
        "deal_delta": deal_delta,
        "avg_price_delta": price_delta,
        "order_rate_delta": cur_rates["orderRate"] - prev_rates["orderRate"],
        "ship_rate_delta": cur_rates["shipRate"] - prev_rates["shipRate"],
        "deal_rate_delta": cur_rates["dealRate"] - prev_rates["dealRate"],
    }


def impact_abs(item: dict[str, Any]) -> float:
    return abs(num((item.get("delta") or {}).get("gmv_delta")))


def stable_evidence_id(prefix: str, index: int) -> str:
    return f"{prefix}_{index:03d}"


def direction_from_delta(value: Any) -> str:
    v = num(value)
    if v > 0:
        return "up"
    if v < 0:
        return "down"
    return "flat"


def severity_from_risk(risk: str) -> str:
    return {"高": "high", "中": "medium", "低": "low", "机会": "watch"}.get(str(risk), "watch")


def confidence_from_item(item: dict[str, Any]) -> str:
    cur = item.get("cur") or {}
    prev = item.get("prev") or {}
    if num(cur.get("gmv")) <= 0 or not prev:
        return "low"
    if item.get("top_model"):
        return "medium"
    return "medium"


def evidence_snapshot(item: dict[str, Any]) -> dict[str, Any]:
    cur = item.get("cur") or {}
    prev = item.get("prev") or {}
    delta = item.get("delta") or {}
    return {
        "current_value": num(cur.get("gmv")),
        "previous_value": num(prev.get("gmv")),
        "delta": num(delta.get("gmv_delta")),
        "delta_pct": delta.get("gmv_delta_pct"),
        "deal_delta": num(delta.get("deal_delta")),
        "avg_price_delta": num(delta.get("avg_price_delta")),
        "chain_breakpoint": item.get("chain_breakpoint"),
    }


def risk_entity_label(risk: str) -> str:
    return "机会" if risk == "机会" else "风险"


def risk_observation_phrase(item: dict[str, Any]) -> str:
    delta = item.get("delta") or {}
    model = item.get("top_model") or {}
    model_text = f"；核心机型先看{model.get('name')}" if model.get("name") else "；机型贡献证据不足，先按品类链路复核"
    return (
        f"{item.get('category')} {risk_entity_label(str(item.get('risk_level')))}等级{item.get('risk_level')}，"
        f"成交GMV{signed_money(delta.get('gmv_delta'))}，成交订单{signed_count(delta.get('deal_delta'))}，"
        f"断点为{item.get('chain_breakpoint')}{model_text}"
    )


def risk_level(delta: dict[str, Any], cur: dict[str, Any]) -> str:
    gmv_pct = delta.get("gmv_delta_pct")
    min_rate = min(num(delta.get("order_rate_delta")), num(delta.get("ship_rate_delta")), num(delta.get("deal_rate_delta")))
    if num(cur.get("dealCnt")) < 3:
        return "中"
    if gmv_pct is not None and (gmv_pct <= -0.15 or min_rate <= -0.03):
        return "高"
    if gmv_pct is not None and (gmv_pct <= -0.05 or min_rate <= -0.01):
        return "中"
    if gmv_pct is not None and (gmv_pct >= 0.08 or max(num(delta.get("order_rate_delta")), num(delta.get("ship_rate_delta")), num(delta.get("deal_rate_delta"))) >= 0.01):
        return "机会"
    return "低"


def chain_breakpoint(delta: dict[str, Any]) -> str:
    candidates = [
        ("下单率", num(delta.get("order_rate_delta"))),
        ("发货率", num(delta.get("ship_rate_delta"))),
        ("成交率", num(delta.get("deal_rate_delta"))),
    ]
    name, value = min(candidates, key=lambda item: item[1])
    if value < -0.0005:
        return f"{name}{signed_pct(value)}"
    name, value = max(candidates, key=lambda item: item[1])
    if value > 0.0005:
        return f"{name}{signed_pct(value)}"
    return "链路转化整体持平"


def metric_line(metric: dict[str, Any]) -> str:
    rates = metric.get("rates") if isinstance(metric.get("rates"), dict) else {}
    return (
        f"机况UV{num(metric.get('jkuv')):.0f}、估价UV{num(metric.get('evaUv')):.0f}、下单UV{num(metric.get('orderUv')):.0f}，"
        f"发货数{num(metric.get('shipCnt')):.1f}、成交订单{num(metric.get('dealCnt')):.1f}、成交GMV约{money(metric.get('gmv'))}，"
        f"下单率{pct(rates.get('orderRate'))}、发货率{pct(rates.get('shipRate'))}、成交率{pct(rates.get('dealRate'))}"
    )


def build_analysis_evidence(processed: dict[str, Any], server_context: dict[str, Any]) -> dict[str, Any]:
    taxonomy = read_cache_json(processed, "category-taxonomy.json") or {}
    category_cache = read_cache_json(processed, "category-cache.json") or {}
    model_cache = read_cache_json(processed, "model-cache.json") or {}
    fulfill_cache = read_cache_json(processed, "category-fulfill-cache.json") or {}
    taxonomy_rows = taxonomy.get("rows") if isinstance(taxonomy, dict) else []
    if not isinstance(taxonomy_rows, list):
        taxonomy_rows = []
    latest_week, prev_week, latest_by_category, prev_by_category = latest_previous_rows(category_cache if isinstance(category_cache, dict) else {})
    latest_models = latest_top_models_by_category(model_cache if isinstance(model_cache, dict) else {})
    categories_in_cache = set((category_cache.get("categories") or []) if isinstance(category_cache, dict) else [])
    taxonomy_by_category: dict[str, dict[str, Any]] = {}
    for raw in taxonomy_rows:
        if not isinstance(raw, dict):
            continue
        category = str(raw.get("category") or "").strip()
        tier = str(raw.get("tier") or "").strip()
        if not category or tier == "自营(非聚合)" or str(raw.get("status") or "") == "已下线":
            continue
        if categories_in_cache and category not in categories_in_cache:
            continue
        taxonomy_by_category[category] = raw

    category_items: list[dict[str, Any]] = []
    evidence_index: dict[str, dict[str, Any]] = {}
    category_seq = 0
    for category, cur in latest_by_category.items():
        meta = taxonomy_by_category.get(category, {})
        if not meta and categories_in_cache and category not in categories_in_cache:
            continue
        prev = prev_by_category.get(category, {})
        delta = delta_pack(cur, prev)
        top_model = latest_models.get(category, {})
        category_seq += 1
        direction = direction_from_delta(delta.get("gmv_delta"))
        prefix = "CAT_GMV_UP" if direction == "up" else "CAT_GMV_DOWN" if direction == "down" else "CAT_GMV_FLAT"
        item = {
            "evidence_id": stable_evidence_id(prefix, category_seq),
            "category": category,
            "tier": str(meta.get("tier") or "待归类"),
            "secondaryCategory": str(meta.get("board") or "未归类"),
            "cur": cur,
            "prev": prev,
            "delta": delta,
            "risk_level": risk_level(delta, cur),
            "direction": direction,
            "chain_breakpoint": chain_breakpoint(delta),
            "top_model": {
                "name": str(top_model.get("modelName") or ""),
                "gmv": num(top_model.get("gmv")),
                "dealCnt": num(top_model.get("dealCnt")),
            } if top_model else {},
        }
        category_items.append(item)
        evidence_index[item["evidence_id"]] = {
            "section": "category_top_changes",
            "offset": category_seq - 1,
            "source": "processed_data.category-cache + model-cache",
            "week": latest_week,
            "prev_week": prev_week,
            "entity": category,
            "metrics": {
                "gmv": num(cur.get("gmv")),
                "dealCnt": num(cur.get("dealCnt")),
                "avgPrice": avg_price(cur),
                **rates(cur),
            },
            "delta": delta,
        }

    category_items.sort(key=lambda item: (-impact_abs(item), -num(item.get("cur", {}).get("gmv")), item["category"]))

    def group_items(field: str) -> list[dict[str, Any]]:
        groups: dict[str, list[dict[str, Any]]] = {}
        for item in category_items:
            groups.setdefault(str(item.get(field) or "未归类"), []).append(item)
        out = []
        for name, items in groups.items():
            cur = sum_rows([x["cur"] for x in items])
            prev = sum_rows([x["prev"] for x in items])
            delta = delta_pack(cur, prev)
            risks = [x for x in items if x["risk_level"] in {"高", "中"}]
            opps = [x for x in items if x["risk_level"] == "机会"]
            group_index = len(out) + 1
            group_direction = direction_from_delta(delta.get("gmv_delta"))
            group_prefix = "CLUSTER_GMV_UP" if group_direction == "up" else "CLUSTER_GMV_DOWN" if group_direction == "down" else "CLUSTER_GMV_FLAT"
            evidence_id = stable_evidence_id(group_prefix, group_index)
            out.append({
                "evidence_id": evidence_id,
                "name": name,
                "cur": cur,
                "prev": prev,
                "delta": delta,
                "risk_level": risk_level(delta, cur),
                "direction": group_direction,
                "top_categories": sorted(items, key=lambda x: -num(x["cur"].get("gmv")))[:5],
                "drag_categories": sorted(risks, key=impact_abs, reverse=True)[:5],
                "opportunity_categories": sorted(opps, key=lambda x: num(x["cur"].get("gmv")), reverse=True)[:5],
                "category_count": len(items),
            })
            evidence_index[evidence_id] = {
                "section": f"{field}_changes",
                "offset": group_index - 1,
                "source": "processed_data.category-cache + category-taxonomy",
                "week": latest_week,
                "prev_week": prev_week,
                "entity": name,
                "delta": delta,
            }
        return sorted(out, key=lambda item: -num(item["cur"].get("gmv")))

    secondary_changes = group_items("secondaryCategory")
    tier_changes = {item["name"]: item for item in group_items("tier")}
    board_cur = sum_rows([item["cur"] for item in category_items])
    board_prev = sum_rows([item["prev"] for item in category_items])
    board_delta = delta_pack(board_cur, board_prev)

    model_rows = model_cache.get("rows") if isinstance(model_cache, dict) else []
    model_contributors = []
    if isinstance(model_rows, list):
        model_latest_week = sorted({str(row.get("week") or "") for row in model_rows if isinstance(row, dict) and row.get("week")})
        target_week = model_latest_week[-1] if model_latest_week else ""
        for row in model_rows:
            if isinstance(row, dict) and str(row.get("week") or "") == target_week:
                model_contributors.append({
                    "category": str(row.get("category") or ""),
                    "model_name": str(row.get("modelName") or ""),
                    "gmv": num(row.get("gmv")),
                    "dealCnt": num(row.get("dealCnt")),
                })
    model_contributors = sorted(model_contributors, key=lambda row: -num(row.get("gmv")))[:30]
    for idx, row in enumerate(model_contributors, start=1):
        row["evidence_id"] = stable_evidence_id("MODEL_CONTRIB", idx)
        evidence_index[row["evidence_id"]] = {
            "section": "model_contributors",
            "offset": idx - 1,
            "source": "processed_data.model-cache",
            "week": target_week,
            "entity": row.get("model_name"),
            "category": row.get("category"),
            "metrics": {"gmv": row.get("gmv"), "dealCnt": row.get("dealCnt")},
        }

    fulfill_rows = fulfill_cache.get("rows") if isinstance(fulfill_cache, dict) else []
    fulfillment_breakpoints = []
    if isinstance(fulfill_rows, list):
        f_weeks = sorted({str(row.get("week") or "") for row in fulfill_rows if isinstance(row, dict) and row.get("week")})
        f_week = f_weeks[-1] if f_weeks else ""
        for row in fulfill_rows:
            if isinstance(row, dict) and str(row.get("week") or "") == f_week and num(row.get("gmv")) > 0:
                fulfillment_breakpoints.append({
                    "category": str(row.get("category") or ""),
                    "fulfillmentMethod": str(row.get("fulfillmentMethod") or ""),
                    "gmv": num(row.get("gmv")),
                    "shipRate": rates(row).get("shipRate"),
                    "dealRate": rates(row).get("dealRate"),
                })
    fulfillment_breakpoints = sorted(fulfillment_breakpoints, key=lambda row: -num(row.get("gmv")))[:30]
    for idx, row in enumerate(fulfillment_breakpoints, start=1):
        row["evidence_id"] = stable_evidence_id("FULFILL_BREAK", idx)
        evidence_index[row["evidence_id"]] = {
            "section": "fulfillment_breakpoints",
            "offset": idx - 1,
            "source": "processed_data.category-fulfill-cache",
            "week": f_week,
            "entity": row.get("category"),
            "fulfillment": row.get("fulfillmentMethod"),
        }

    warnings: list[str] = []
    if not category_items:
        warnings.append("display_category_maps_empty")
    if not prev_week:
        warnings.append("history_insufficient_wow_only")
    if (processed.get("category_mapping_manifest") or {}).get("source", {}).get("type") in {"package_category_taxonomy_snapshot_json", "feishu_base_mapping_snapshot_json", "feishu_base_mapping_snapshot_csv"}:
        warnings.append("category_mapping_source_not_realtime")
    dq = processed.get("data_quality_report") or {}
    if dq.get("known_gaps"):
        warnings.extend(str(x) for x in dq.get("known_gaps", [])[:8])
    return {
        "latest_week": latest_week,
        "prev_week": prev_week,
        "board": {"cur": board_cur, "prev": board_prev, "delta": board_delta, "risk_level": risk_level(board_delta, board_cur), "chain_breakpoint": chain_breakpoint(board_delta)},
        "category_all": category_items,
        "category_top_changes": category_items[:30],
        "cluster_top_changes": secondary_changes,
        "tier_changes": tier_changes,
        "model_contributors": model_contributors,
        "fulfillment_breakpoints": fulfillment_breakpoints,
        "trend_features": [] if not prev_week else [{
            "evidence_id": "TREND_WOW_BOARD_001",
            "level": "overall",
            "entity": "大盘",
            "metric": "gmv",
            "direction": direction_from_delta(board_delta.get("gmv_delta")),
            "disabled_reason": "history_insufficient" if not prev_week else None,
        }],
        "data_quality_notes": sorted(set(warnings)),
        "known_gaps": sorted(set(warnings)),
        "core_model_coverage": {
            "status": "partial" if model_contributors else "missing",
            "covered_model_count": len(model_contributors),
            "source": "processed_data.model-cache",
        },
        "evidence_index": evidence_index,
        "source_of_truth": ["processed_data.category-cache", "processed_data.model-cache", "processed_data.category-fulfill-cache", "processed_data.category-taxonomy", "server_context"],
    }


def names(items: list[dict[str, Any]], field: str = "category", limit: int = 3) -> str:
    vals = [str(item.get(field) or "").strip() for item in items[:limit] if str(item.get(field) or "").strip()]
    return "、".join(vals) if vals else "暂无显著对象"


def make_findings(evidence_pack: dict[str, Any]) -> list[dict[str, Any]]:
    findings = []
    board_ids = [item.get("evidence_id") for item in evidence_pack.get("category_top_changes", [])[:5] if item.get("evidence_id")]
    findings.append({
        "id": "OVERALL_BOARD_WOW_001",
        "level": "overall",
        "entity_type": "overall",
        "entity_name": "大盘",
        "entity": "大盘",
        "metric": "gmv",
        "direction": direction_from_delta((evidence_pack.get("board") or {}).get("delta", {}).get("gmv_delta")),
        "severity": severity_from_risk((evidence_pack.get("board") or {}).get("risk_level")),
        "confidence": "medium" if board_ids else "low",
        "risk_level": (evidence_pack.get("board") or {}).get("risk_level"),
        "evidence_ids": board_ids or list(evidence_pack.get("evidence_index", {}).keys())[:1],
        "evidence": (evidence_pack.get("board") or {}).get("delta", {}),
        "recommended_drilldowns": ["按高影响品类复核估价→下单→发货→成交链路", "核对核心机型与履约方式是否同向"],
        "recommended_actions": ["先做证据复核，不直接调整补贴或投放"],
        "data_warnings": evidence_pack.get("data_quality_notes", []),
        "rule_status": "pending_business_confirmation",
        "conclusion": f"大盘风险等级{(evidence_pack.get('board') or {}).get('risk_level')}，主要链路信号为{(evidence_pack.get('board') or {}).get('chain_breakpoint')}。",
        "model_trace": {"mode": "daily", "primary": "GLM-5.2", "reviewer": "DeepSeek V4 Pro"},
    })
    for cluster in evidence_pack.get("cluster_top_changes", [])[:10]:
        findings.append({
            "id": cluster.get("evidence_id") or f"CLUSTER_{len(findings):03d}",
            "level": "cluster",
            "entity_type": "cluster",
            "entity_name": cluster["name"],
            "entity": cluster["name"],
            "metric": "gmv",
            "direction": cluster.get("direction") or direction_from_delta((cluster.get("delta") or {}).get("gmv_delta")),
            "severity": severity_from_risk(cluster.get("risk_level")),
            "confidence": "medium",
            "risk_level": cluster.get("risk_level"),
            "evidence_ids": [cluster.get("evidence_id")] + [item.get("evidence_id") for item in (cluster.get("drag_categories") or cluster.get("top_categories") or [])[:4] if item.get("evidence_id")],
            "evidence": evidence_snapshot({"cur": cluster.get("cur"), "prev": cluster.get("prev"), "delta": cluster.get("delta"), "chain_breakpoint": chain_breakpoint(cluster.get("delta") or {})}),
            "recommended_drilldowns": [f"先下钻{names(cluster.get('drag_categories') or cluster.get('top_categories') or [])}，再核对履约和机型标签"],
            "recommended_actions": ["把结论作为待确认假设交给运营复核"],
            "data_warnings": evidence_pack.get("data_quality_notes", []),
            "rule_status": "pending_business_confirmation",
            "conclusion": f"{cluster['name']}风险等级{cluster['risk_level']}，拖累对象{names(cluster.get('drag_categories', []))}，机会对象{names(cluster.get('opportunity_categories', []))}。",
            "model_trace": {"mode": "daily", "primary": "GLM-5.2", "reviewer": "DeepSeek V4 Pro"},
        })
    for item in evidence_pack.get("category_top_changes", [])[:20]:
        findings.append({
            "id": item["evidence_id"],
            "level": "category",
            "entity_type": "category",
            "entity_name": item["category"],
            "entity": item["category"],
            "metric": "gmv",
            "direction": item.get("direction") or direction_from_delta(item["delta"].get("gmv_delta")),
            "severity": severity_from_risk(item.get("risk_level")),
            "confidence": confidence_from_item(item),
            "risk_level": item["risk_level"],
            "evidence_ids": [item["evidence_id"]],
            "evidence": evidence_snapshot(item),
            "recommended_drilldowns": ["验证估价→下单→发货→成交哪一段贡献最大", "核对核心机型/成色/履约方式是否同向"],
            "recommended_actions": ["维持观察并补充业务动作记录，避免无证据归因"],
            "data_warnings": evidence_pack.get("data_quality_notes", []),
            "rule_status": "pending_business_confirmation",
            "conclusion": risk_observation_phrase(item),
            "model_trace": {"mode": "daily", "primary": "GLM-5.2", "reviewer": "DeepSeek V4 Pro"},
        })
    return findings


def build_insights(args: argparse.Namespace, processed: dict[str, Any], evidence_pack: dict[str, Any], findings: list[dict[str, Any]], display: dict[str, Any]) -> dict[str, Any]:
    history_weeks = processed.get("process_summary", {}).get("history_weeks_available") or processed.get("history_weeks_available") or 0
    analysis_scope = "trend_10w" if num(history_weeks) >= 8 else "wow_only"
    key_findings = findings[:6]
    risks = [f for f in findings if f.get("severity") in {"high", "medium"}][:6]
    opportunities = [f for f in findings if f.get("direction") == "up" or f.get("risk_level") == "机会"][:6]
    actions = []
    for f in key_findings[:5]:
        actions.append({
            "entity": f.get("entity_name") or f.get("entity"),
            "action": "下钻验证，不直接归因",
            "owner_hint": "品类运营/履约/机型标签负责人",
            "evidence_ids": f.get("evidence_ids", []),
            "priority": f.get("severity", "watch"),
        })
    return {
        "run_id": args.run_id,
        "week": args.week,
        "run_dt": args.run_dt,
        "analysis_mode": "daily",
        "analysis_scope": analysis_scope,
        "history_weeks": int(num(history_weeks)),
        "evidence_pack_id": f"evidence_pack_{args.run_dt}",
        "summary": display.get("board", ""),
        "key_findings": key_findings,
        "risks": risks,
        "opportunities": opportunities,
        "actions": actions,
        "findings": findings,
        "display_contract": DISPLAY_CONTRACT,
        "display_insights": display,
        "data_quality_notes": evidence_pack.get("data_quality_notes", []),
        "known_gaps": evidence_pack.get("known_gaps", []),
        "model_trace": {"mode": "daily", "primary": "GLM-5.2", "reviewer": "DeepSeek V4 Pro"},
    }


def build_summary_md(evidence_pack: dict[str, Any], findings: list[dict[str, Any]]) -> str:
    lines = ["# AI小万经营分析摘要", ""]
    board = evidence_pack.get("board") or {}
    lines.append(f"- 大盘风险等级{board.get('risk_level')}，链路信号为{board.get('chain_breakpoint')} [{', '.join((findings[0].get('evidence_ids') or [])[:3])}]")
    for f in findings[1:6]:
        ids = ", ".join((f.get("evidence_ids") or [])[:3])
        lines.append(f"- {f.get('conclusion')} [{ids}]")
    lines.append("")
    lines.append("说明：以上是待运营确认的证据化分析，不代表已发布或已推送。")
    return "\n".join(lines)


def build_review_notes(evidence_pack: dict[str, Any], findings: list[dict[str, Any]]) -> dict[str, Any]:
    weak = [f for f in findings if f.get("confidence") == "low"]
    return {
        "reviewer": "DeepSeek V4 Pro",
        "status": "warn" if weak or evidence_pack.get("known_gaps") else "pass",
        "evidence_coverage": {
            "evidence_count": len(evidence_pack.get("evidence_index") or {}),
            "finding_count": len(findings),
            "weak_finding_count": len(weak),
        },
        "over_attribution_guard": "所有结论必须保留为观察项/待确认假设；known_gap 不得写成确定性主因。",
        "known_gap_risks": evidence_pack.get("known_gaps", []),
        "suggestions": ["删除无 evidence_id 的结论", "核心机型不足时只写品类链路观察", "历史不足8周时禁止长期趋势措辞"],
    }


def build_analysis_trace(args: argparse.Namespace, processed: dict[str, Any], evidence_pack: dict[str, Any], insights: dict[str, Any]) -> dict[str, Any]:
    return {
        "run_id": args.run_id,
        "run_dt": args.run_dt,
        "analysis_mode": insights.get("analysis_mode", "daily"),
        "analysis_scope": insights.get("analysis_scope", "wow_only"),
        "history_weeks": insights.get("history_weeks", 0),
        "effective_history_weeks_source": "processed_data.process_summary.history_weeks_available",
        "inputs": {
            "processed_data": processed.get("active_process_manifest", {}).get("processed_cache") or "processed_data",
            "server_context": "APIHub read metric_snapshot/history_10w/rules/dashboard_snapshot",
        },
        "evidence_pack": f"evidence_pack_{args.run_dt}.json",
        "model_invocations": [
            {"role": "primary_writer", "model": "GLM-5.2", "prompt_hash": "deterministic-evidence-pack", "output_hash": "deterministic-local", "status": "simulated_by_contract"},
            {"role": "reviewer", "model": "DeepSeek V4 Pro", "prompt_hash": "deterministic-review", "output_hash": "deterministic-local", "status": "simulated_by_contract"},
        ],
        "merge_decisions": ["证据强的结论保留；证据不足的结论降级为待确认假设"],
        "llm_policy": {"allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"], "fallback_to_other_llm": False},
    }


def build_display_insights(processed: dict[str, Any], server_context: dict[str, Any], evidence_pack: dict[str, Any]) -> dict[str, Any]:
    dq = processed.get("data_quality_report") or {}
    warnings = list(evidence_pack.get("data_quality_notes") or [])
    if dq.get("known_gaps"):
        warnings.extend(str(x) for x in dq.get("known_gaps", [])[:5])
    hist = processed.get("process_summary", {}).get("history_weeks_available")
    scope = processed.get("process_summary", {}).get("analysis_scope_hint") or "wow_only"
    board_ev = evidence_pack["board"]
    board_delta = board_ev["delta"]
    drags = [item for item in evidence_pack.get("category_top_changes", []) if item["risk_level"] in {"高", "中"}]
    opps = [item for item in evidence_pack.get("category_top_changes", []) if item["risk_level"] == "机会"]
    board = (
        f"风险等级{board_ev['risk_level']}，当前按{scope}做周环比判断，链路判断为{board_ev['chain_breakpoint']}。"
        f"成交GMV{signed_money(board_delta['gmv_delta'])}，成交订单{signed_count(board_delta['deal_delta'])}，客单价{signed_money(board_delta['avg_price_delta'])}，"
        f"量价拆解显示{'订单侧拖累更明显' if abs(num(board_delta['deal_delta'])) >= abs(num(board_delta['avg_price_delta'])) else '客单价侧波动更明显'}。"
        f"关键拖累看{names(drags)}，机会看{names(opps)}；下一步验证估价到下单、发货到成交两段是否集中在这些对象。"
    )
    tiers = {}
    for tier in REQUIRED_TIERS:
        ev = evidence_pack.get("tier_changes", {}).get(tier) or {"cur": {}, "delta": {}, "risk_level": "低", "drag_categories": [], "opportunity_categories": [], "top_categories": [], "category_count": 0}
        d = ev.get("delta") or {}
        tiers[tier] = (
            f"{tier}层风险等级{ev.get('risk_level')}，覆盖{ev.get('category_count', 0)}个品类，"
            f"成交GMV{signed_money(d.get('gmv_delta'))}，成交订单{signed_count(d.get('deal_delta'))}，核心链路为{chain_breakpoint(d)}。"
            f"优先下钻{names(ev.get('drag_categories') or ev.get('top_categories') or [])}，机会观察{names(ev.get('opportunity_categories') or [], limit=2)}；"
            f"历史可用周数{hist or '待确认'}，不足8周时只输出环比假设，不做趋势外推。"
        )
    secondary: dict[str, str] = {}
    for ev in evidence_pack.get("cluster_top_changes", []):
        d = ev.get("delta") or {}
        secondary[ev["name"]] = (
            f"{ev['name']}风险等级{ev.get('risk_level')}，覆盖{ev.get('category_count', 0)}个品类，成交GMV{signed_money(d.get('gmv_delta'))}。"
            f"主要拖累为{names(ev.get('drag_categories') or [])}，机会为{names(ev.get('opportunity_categories') or [], limit=2)}，"
            f"链路断点看{chain_breakpoint(d)}；验证计划是先看高影响品类，再核对履约和机型标签是否同向。"
        )
    categories: dict[str, str] = {}
    high_impact = {item["category"] for item in evidence_pack.get("category_top_changes", [])[:25]}
    for item in evidence_pack.get("category_all", evidence_pack.get("category_top_changes", [])):
        category = item["category"]
        d = item.get("delta") or {}
        model = item.get("top_model") or {}
        model_text = f"核心机型关注{model.get('name')}（成交GMV约{money(model.get('gmv'))}）" if model.get("name") else "机型证据不足，先按品类链路复核"
        if category in high_impact:
            categories[category] = (
                f"{category}风险等级{item.get('risk_level')}，归属{item.get('tier')}/{item.get('secondaryCategory')}，成交GMV{signed_money(d.get('gmv_delta'))}，"
                f"成交订单{signed_count(d.get('deal_delta'))}，客单价{signed_money(d.get('avg_price_delta'))}。"
                f"链路断点为{item.get('chain_breakpoint')}，{model_text}；验证计划是先确认估价、下单、发货、成交哪一段贡献最大，再决定是否继续观察。"
            )
        else:
            categories[category] = (
                f"{category}风险等级{item.get('risk_level')}，成交GMV{signed_money(d.get('gmv_delta'))}，{item.get('chain_breakpoint')}。"
                f"{model_text}；当前影响度低于头部对象，维持观察并在下周复核是否延续。"
            )
    return {
        "board": board,
        "tiers": tiers,
        "secondaryCategories": secondary,
        "categories": categories,
        "category": f"本期品类判断以{evidence_pack.get('latest_week') or processed.get('week')}与上一可比周的环比为主，重点看高影响拖累、机会对象和链路断点；低基数或映射非实时对象只作为待确认假设。",
        "monitor": f"当前历史可用周数{hist or '待确认'}，{('只输出周环比风险和验证计划，不写多周趋势' if num(hist) < 8 else '可结合多周历史复核趋势')}；履约或映射缺口会进入数据风险并维持观察。",
        "warnings": sorted(set(warnings)),
    }


def flatten_display_text(display: dict[str, Any]) -> list[str]:
    texts: list[str] = []
    for key in ("board", "category", "monitor"):
        value = display.get(key)
        if isinstance(value, str):
            texts.append(value)
    tiers = display.get("tiers")
    if isinstance(tiers, dict):
        texts.extend(str(v) for v in tiers.values() if isinstance(v, str))
    for key in ("secondaryCategories", "categories"):
        value = display.get(key)
        if isinstance(value, dict):
            texts.extend(str(v) for v in value.values() if isinstance(v, str))
    return texts


def contains_any(text: str, words: tuple[str, ...] | list[str]) -> bool:
    return any(word in text for word in words)


def duplicate_text_ratio(items: list[str]) -> float:
    if not items:
        return 1.0
    normalized = []
    for item in items:
        text = re.sub(r"\d+(?:\.\d+)?", "0", item)
        text = re.sub(r"[A-Za-z0-9_:-]+", "X", text)
        normalized.append(text)
    return 1.0 - (len(set(normalized)) / len(normalized))


def execute_analyze(args: argparse.Namespace, run_dir: Path, processed: dict[str, Any]) -> dict[str, Any]:
    read_body = {
        "run_id": args.run_id,
        "stage": "analyze",
        "week": args.week,
        "input_type": "metric_snapshot",
        "history_weeks": 10,
        "include": ["run_meta", "history_10w", "rules", "dashboard_snapshot"],
    }
    server_context = hub_post(READ_PATH, read_body, timeout=130.0)
    evidence_pack = build_analysis_evidence(processed, server_context)
    findings = make_findings(evidence_pack)
    display = build_display_insights(processed, server_context, evidence_pack)
    insights = build_insights(args, processed, evidence_pack, findings, display)
    summary = build_summary_md(evidence_pack, findings)
    review_notes = build_review_notes(evidence_pack, findings)
    analysis_trace = build_analysis_trace(args, processed, evidence_pack, insights)
    analysis_result = {
        "stage": "analyze",
        "status": "warn" if display["warnings"] else "success",
        "output_type": "analysis_result",
        "run_id": args.run_id,
        "week": args.week,
        "analysis_mode": insights["analysis_mode"],
        "analysis_scope": insights["analysis_scope"],
        "history_weeks": insights["history_weeks"],
        "evidence_pack": evidence_pack,
        "insights": insights,
        "summary": summary,
        "findings": findings,
        "display_contract": DISPLAY_CONTRACT,
        "display_insights": display,
        "review_notes": review_notes,
        "analysis_trace": analysis_trace,
        "model_trace": insights["model_trace"],
        "llm_policy": {"allowed_llms": ["GLM-5.2", "DeepSeek V4 Pro"], "fallback_to_other_llm": False},
        "warnings": display["warnings"],
        "server_context_summary": {
            "ok": server_context.get("ok"),
            "keys": list(server_context.keys()),
        },
        "next_stage": "validate",
    }
    write_json(run_dir / "analysis_result.json", analysis_result)
    return analysis_result


def execute_validate(args: argparse.Namespace, run_dir: Path, processed: dict[str, Any], analysis: dict[str, Any]) -> dict[str, Any]:
    display = analysis.get("display_insights") or {}
    evidence_pack = analysis.get("evidence_pack") or {}
    findings = analysis.get("findings") or []
    display_texts = flatten_display_text(display if isinstance(display, dict) else {})
    display_joined = "\n".join(display_texts)
    checks = []
    failed = []
    def check(name: str, ok: bool, severity: str = "critical") -> None:
        checks.append({"name": name, "ok": ok, "severity": severity})
        if not ok and severity == "critical":
            failed.append(name)
    check("display_contract", analysis.get("display_contract") == DISPLAY_CONTRACT)
    check("findings_non_empty", isinstance(findings, list) and len(findings) > 0)
    check("evidence_pack_present", isinstance(evidence_pack, dict) and bool(evidence_pack))
    check("evidence_index_non_empty", isinstance(evidence_pack.get("evidence_index"), dict) and bool(evidence_pack.get("evidence_index")))
    check("category_top_changes_non_empty", isinstance(evidence_pack.get("category_top_changes"), list) and bool(evidence_pack.get("category_top_changes")))
    check("cluster_top_changes_non_empty", isinstance(evidence_pack.get("cluster_top_changes"), list) and bool(evidence_pack.get("cluster_top_changes")))
    check("model_contributors_present", isinstance(evidence_pack.get("model_contributors"), list))
    check("fulfillment_breakpoints_present", isinstance(evidence_pack.get("fulfillment_breakpoints"), list))
    check("board_non_empty", isinstance(display.get("board"), str) and bool(display.get("board").strip()))
    check("category_non_empty", isinstance(display.get("category"), str) and bool(display.get("category").strip()))
    check("monitor_non_empty", isinstance(display.get("monitor"), str) and bool(display.get("monitor").strip()))
    tiers = display.get("tiers") or {}
    for tier in ("发展", "孵化", "种子"):
        check(f"tier_{tier}_non_empty", isinstance(tiers.get(tier), str) and bool(tiers.get(tier).strip()))
        tier_text = str(tiers.get(tier) or "")
        check(f"tier_{tier}_quality_terms", contains_any(tier_text, ("风险", "机会")) and contains_any(tier_text, ("下钻", "验证", "观察")) and contains_any(tier_text, ("成交GMV", "成交订单", "下单率", "发货率", "成交率")))
    check("secondary_map", isinstance(display.get("secondaryCategories"), dict))
    check("categories_map", isinstance(display.get("categories"), dict))
    check("secondary_map_non_empty", isinstance(display.get("secondaryCategories"), dict) and bool(display.get("secondaryCategories")))
    check("categories_map_non_empty", isinstance(display.get("categories"), dict) and bool(display.get("categories")))
    board_text = str(display.get("board") or "")
    check("board_quality_terms", contains_any(board_text, ("风险等级",)) and contains_any(board_text, ("链路",)) and contains_any(board_text, ("拖累", "机会")) and contains_any(board_text, ("验证", "下一步")))
    check("display_no_technical_terms", not contains_any(display_joined, TECH_DISPLAY_TERMS))
    check("display_no_old_template_phrase", "本周按AIWAN处理产物生成指标短评" not in display_joined and "建议继续下钻机型、标签和履约明细" not in display_joined)
    category_texts = list((display.get("categories") or {}).values()) if isinstance(display.get("categories"), dict) else []
    check("category_template_duplicate_ratio", duplicate_text_ratio([str(x) for x in category_texts]) < 0.2 if category_texts else False)
    if num(analysis.get("history_weeks")) < 8:
        check("insufficient_history_no_long_trend", "8周趋势" not in display_joined and "10周趋势" not in display_joined and "长期趋势" not in display_joined)
    publish_allowed = not failed
    validation_result = {
        "stage": "validate",
        "status": "success" if publish_allowed else "failed",
        "output_type": "validation_result",
        "run_id": args.run_id,
        "week": args.week,
        "checks": checks,
        "failed_checks": failed,
        "publish_allowed": publish_allowed,
        "server_write_confirmed": False,
    }
    envelope = {
        "run_id": args.run_id,
        "analysis_key": getattr(args, "analysis_key", None) or f"{args.week}:{getattr(args, 'data_end_date', '')}",
        "data_end_date": getattr(args, "data_end_date", None),
        "base_revision": getattr(args, "base_revision", 1),
        "model_enrichment_mode": "disabled",
        "base_started_at": getattr(args, "base_started_at", None),
        "base_sla_deadline": getattr(args, "base_sla_deadline", None) or getattr(args, "base_deadline_at", None),
        "stage": "validate",
        "status": validation_result["status"],
        "output_type": "validation_result",
        "week": args.week,
        "payload": {
            "processed_data": processed,
            "analysis_result": analysis,
            "validation_result": validation_result,
        },
    }
    if publish_allowed:
        write_resp = hub_post(WRITE_PATH, envelope, timeout=90.0)
        reread = hub_post(READ_PATH, {"run_id": args.run_id, "stage": "validate", "week": args.week, "include": ["run_meta", "current_stage_output", "metric_snapshot"]}, timeout=90.0)
        current_output = reread.get("current_output") if isinstance(reread, dict) else None
        expected_revision = write_resp.get("revision") if isinstance(write_resp, dict) else None
        metric_snapshot = ((reread.get("context") or {}).get("metric_snapshot") or {}) if isinstance(reread, dict) else {}
        analysis_status = metric_snapshot.get("analysisStatus") if isinstance(metric_snapshot, dict) else None
        expected_analysis_key = envelope["analysis_key"]
        if (
            reread.get("run_id") != args.run_id
            or not isinstance(current_output, dict)
            or current_output.get("run_id") != args.run_id
            or current_output.get("revision") != expected_revision
            or current_output.get("output_type") not in {"validation_result", "validate_result"}
            or not isinstance(analysis_status, dict)
            or analysis_status.get("analysis_key") != expected_analysis_key
            or analysis_status.get("data_end_date") != envelope["data_end_date"]
            or analysis_status.get("base_revision") != envelope["base_revision"]
            or analysis_status.get("deliveryState") != "base_published"
            or analysis_status.get("model_enrichment_mode") != "disabled"
        ):
            raise RuntimeError("VALIDATE_REREAD_MISMATCH: stage output or dashboard analysisStatus did not match the validate write")
        validation_result["server_write_response"] = write_resp
        validation_result["server_reread_response"] = reread
        validation_result["server_write_confirmed"] = True
    write_json(run_dir / "validation_result.json", validation_result)
    return validation_result


def run(args: argparse.Namespace) -> dict[str, Any]:
    total_started = time.perf_counter()
    timings = {
        "startup_seconds": round_seconds(total_started - PROCESS_STARTED_AT),
        "preflight_seconds": 0.0,
        "read_seconds": 0.0,
        "process_seconds": 0.0,
        "analyze_seconds": 0.0,
        "validate_seconds": 0.0,
        "total_seconds": 0.0,
    }
    preflight_result = preflight()
    timings["preflight_seconds"] = preflight_result["timings"]["preflight_seconds"]
    if not preflight_result.get("ok"):
        timings["total_seconds"] = round_seconds(time.perf_counter() - total_started)
        result = {
            "ok": False,
            "overall_status": "failed",
            "run_id": args.run_id,
            "week": args.week,
            "entrypoint_resolution_mode": "runtime_active_skill_dir",
            "orchestrator_build": AIWAN_ORCHESTRATOR_BUILD,
            "stage_results": {},
            "error": {"code": "PREFLIGHT_FAILED", "details": preflight_result.get("errors", [])},
            "publish_allowed": False,
            "timings": timings,
            "artifacts_dir": None,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return result

    run_dir = out_root() / "aiwan_runs" / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    stages: dict[str, Any] = {}
    current_stage = "preflight"

    def execute_timed(stage: str, func: Any) -> Any:
        nonlocal current_stage
        current_stage = stage
        started = time.perf_counter()
        try:
            return func()
        finally:
            timings[f"{stage}_seconds"] = round_seconds(time.perf_counter() - started)

    try:
        stages["read"] = execute_timed("read", lambda: execute_read(args, run_dir))
        stages["process"] = execute_timed("process", lambda: execute_process(args, run_dir, stages["read"]))
        stages["analyze"] = execute_timed("analyze", lambda: execute_analyze(args, run_dir, stages["process"]))
        stages["validate"] = execute_timed("validate", lambda: execute_validate(args, run_dir, stages["process"], stages["analyze"]))
        ok = stages["validate"].get("server_write_confirmed") is True
        if ok:
            cleanup_success_large_files(run_dir)
        starts = stages["read"].get("week_start_dates", week_start_dates(args.week))
        result = {
            "ok": ok,
            "overall_status": "warn" if ok and (stages["read"].get("warnings") or stages["process"].get("warnings") or stages["analyze"].get("warnings")) else ("success" if ok else "failed"),
            "run_id": args.run_id,
            "week": args.week,
            "entrypoint_resolution_mode": "runtime_active_skill_dir",
            "orchestrator_build": AIWAN_ORCHESTRATOR_BUILD,
            "actual_data_week": {
                "input_week": args.week,
                "week_start_dates": starts,
                "current_week_start": starts[-1],
                "data_end_date": args.data_end_date,
            },
            "stage_results": {
                name: {
                    "status": st.get("status"),
                    "output_type": st.get("output_type"),
                    **({"server_write_confirmed": st.get("server_write_confirmed")} if name == "validate" else {}),
                }
                for name, st in stages.items()
            },
            "display_contract": stages["analyze"].get("display_contract"),
            "display_insights_summary": {
                "has_board": bool(stages["analyze"].get("display_insights", {}).get("board")),
                "tiers": list((stages["analyze"].get("display_insights", {}).get("tiers") or {}).keys()),
                "secondary_count": len(stages["analyze"].get("display_insights", {}).get("secondaryCategories") or {}),
                "category_count": len(stages["analyze"].get("display_insights", {}).get("categories") or {}),
            },
            "server_write_response": stages["validate"].get("server_write_response"),
            "publish_allowed": stages["validate"].get("publish_allowed"),
            "checks": stages["validate"].get("checks", []),
            "warnings": (stages["read"].get("warnings") or []) + (stages["process"].get("warnings") or []) + (stages["analyze"].get("warnings") or []),
            "sql_timings": {
                name: {
                    key: status.get(key)
                    for key in ("queue_seconds", "submit_seconds", "execute_seconds", "materialize_seconds", "duration_seconds", "reused")
                    if status.get(key) is not None
                }
                for name, status in (stages["read"].get("sql_status") or {}).items()
            },
            "artifacts_dir": str(run_dir),
        }
    except Exception as exc:
        result = {
            "ok": False,
            "overall_status": "failed",
            "run_id": args.run_id,
            "week": args.week,
            "entrypoint_resolution_mode": "runtime_active_skill_dir",
            "orchestrator_build": AIWAN_ORCHESTRATOR_BUILD,
            "stage_results": {
                name: {"status": st.get("status"), "output_type": st.get("output_type")}
                for name, st in stages.items()
            },
            "error": {"code": "STAGE_EXECUTION_FAILED", "stage": current_stage, "message": str(exc)},
            "publish_allowed": False,
            "artifacts_dir": str(run_dir),
        }
    timings["total_seconds"] = round_seconds(time.perf_counter() - total_started)
    result["timings"] = timings
    write_json(run_dir / "aiwan_inline_result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--run-id")
    parser.add_argument("--week")
    parser.add_argument("--run-dt")
    parser.add_argument("--data-end-date")
    parser.add_argument("--sql-timeout-seconds", type=int, default=1800)
    parser.add_argument("--process-timeout-seconds", type=int, default=900)
    parser.add_argument("--poll-interval-seconds", type=int, default=15)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.preflight:
        result = preflight()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(0 if result.get("ok") else 2)
    missing = [name for name in ("run_id", "week", "run_dt") if not getattr(args, name)]
    if missing:
        result = {
            "ok": False,
            "error": {"code": "REQUIRED_ARGUMENT_MISSING", "arguments": missing},
            "entrypoint_resolution_mode": "runtime_active_skill_dir",
            "orchestrator_build": AIWAN_ORCHESTRATOR_BUILD,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(2)
    if not args.data_end_date:
        args.data_end_date = (datetime.strptime(args.run_dt, "%Y-%m-%d").date() - timedelta(days=1)).isoformat()
    result = run(args)
    raise SystemExit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()

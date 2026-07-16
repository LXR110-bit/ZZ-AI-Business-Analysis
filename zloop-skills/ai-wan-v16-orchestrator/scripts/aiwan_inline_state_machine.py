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

import zloop_runtime.hub as hub

try:
    import zloop_runtime.xinghe as xinghe
except Exception:  # pragma: no cover - only in remote sandbox
    xinghe = None


READ_PATH = "/v2/aiwan/api/aiwan/read"
WRITE_PATH = "/v2/aiwan/api/aiwan/write"
DISPLAY_CONTRACT = "dashboard-business-overview-insights-map/v1"
SCRIPT_NAMES = [
    "category_summary",
    "category_daily_avg",
    "category_fulfill_summary",
    "category_fulfill_daily_avg",
    "model_summary",
    "model_daily_avg",
]
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
    if item.startswith("/"):
        response = hub.get(item, timeout=180.0)
        content = getattr(response, "content", None)
        if content is None and hasattr(response, "text"):
            content = response.text.encode("utf-8")
        if content is not None:
            target_path.write_bytes(content)
            return True
        return False
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
            if parsed.scheme in {"http", "https"} or item.startswith("/"):
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


def download_by_file_id(value: Any, csv_path: Path, errors: list[str]) -> int | None:
    for item in values_for_keys(value, {"file_id", "artifact_file_id", "artifact_id", "id"}):
        if not isinstance(item, (str, int)):
            continue
        for url in (
            f"/workbench/api/v1/artifact-files/{item}/{csv_path.name}",
            f"/workbench/api/v1/artifact-files/{item}",
        ):
            try:
                rows = download_url(url, csv_path)
                if rows is not None:
                    return rows
            except Exception as exc:
                errors.append(f"download file id {item} via {url}: {exc}")
    return None


def iso_week_from_start(week_start: str) -> str:
    d = datetime.strptime(week_start[:10], "%Y-%m-%d").date()
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


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
            id_rows = download_by_file_id(resp, csv_path, errors)
            if id_rows is not None:
                return id_rows
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


def execute_read(args: argparse.Namespace, run_dir: Path) -> dict[str, Any]:
    if xinghe is None:
        raise RuntimeError("zloop_runtime.xinghe is unavailable")
    root = repo_root()
    raw_root = run_dir / "read_artifacts"
    export_dir = run_dir / "read_exports"
    debug_dir = run_dir / "debug"
    raw_root.mkdir(parents=True, exist_ok=True)
    export_dir.mkdir(parents=True, exist_ok=True)
    debug_dir.mkdir(parents=True, exist_ok=True)
    statuses: dict[str, dict[str, Any]] = {}
    for name in SCRIPT_NAMES:
        template = root / "references" / "read" / "sql" / f"{name}.sql"
        sql = render_sql(template.read_text(encoding="utf-8"), args.run_dt, args.data_end_date)
        rendered_path = export_dir / f"{name}_{args.run_dt}.sql"
        rendered_path.write_text(sql, encoding="utf-8")
        submit = call_with_supported_kwargs(
            xinghe.run_hive_sql,
            content=sql,
            sql=sql,
            title=f"AIWAN {name} {args.run_dt}",
            business_id="5",
            business_name="聚合回收",
        )
        execute_id = normalize_execute_id(submit)
        statuses[name] = {
            "execute_id": execute_id,
            "status": "SUBMITTED",
            "rendered_sql": str(rendered_path),
            "rendered_sql_sha256": sha256_file(rendered_path),
        }
    deadline = time.time() + args.sql_timeout_seconds
    pending = set(statuses.keys())
    while pending and time.time() < deadline:
        ids = [statuses[name]["execute_id"] for name in pending]
        resp = call_with_supported_kwargs(xinghe.check_sql_status, execute_ids=ids, execute_id=ids[0])
        for name in list(pending):
            status = get_status_for(resp, statuses[name]["execute_id"])
            statuses[name]["status"] = status
            if status in TERMINAL_SUCCESS:
                csv_path = export_dir / f"{name}_{args.run_dt}.csv"
                rows = materialize_full_csv(statuses[name]["execute_id"], csv_path, debug_dir, name)
                statuses[name].update({
                    "status": "SUCCESS",
                    "row_count": rows,
                    "csv": str(csv_path),
                    "file_size_bytes": csv_path.stat().st_size if csv_path.exists() else 0,
                    "csv_sha256": sha256_file(csv_path) if csv_path.exists() else None,
                })
                pending.remove(name)
            elif status in TERMINAL_FAILED:
                pending.remove(name)
        if pending:
            time.sleep(args.poll_interval_seconds)
    if pending:
        for name in pending:
            statuses[name]["status"] = "TIMEOUT"
    failed = [name for name, st in statuses.items() if st.get("status") != "SUCCESS"]
    if failed:
        raise RuntimeError(f"SQL failed or timed out: {failed}")
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
    active_fetch["week_start_dates"] = ["2026-07-06", "2026-07-13"]
    active_fetch["sql_execute_status"] = statuses
    write_json(raw_root / "active_fetch_manifest.json", active_fetch)
    return {
        "stage": "read",
        "status": active_fetch.get("status", "success"),
        "output_type": "sql_result",
        "run_id": args.run_id,
        "week": args.week,
        "run_dt": args.run_dt,
        "data_end_date": args.data_end_date,
        "week_start_dates": ["2026-07-06", "2026-07-13"],
        "sql_status": statuses,
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
    node_old_space_mb = os.environ.get("AIWAN_PROCESS_NODE_OLD_SPACE_MB", "8192")
    cmd = [
        "node",
        f"--max-old-space-size={node_old_space_mb}",
        str(repo_root() / "bin" / "process-raw-cache.js"),
        "--run-dt",
        args.run_dt,
        "--run-id",
        args.run_id,
        "--input-dir",
        read_result["artifacts"]["input_dir"],
        "--out-dir",
        str(process_dir),
        "--snapshot-dir",
        str(repo_root() / "references" / "process" / "server-snapshot"),
    ]
    proc = subprocess.run(cmd, text=True, capture_output=True, timeout=args.process_timeout_seconds)
    (process_dir / "process_command.json").write_text(
        json.dumps({"cmd": cmd, "node_old_space_mb": node_old_space_mb}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (process_dir / "process_stdout.txt").write_text(proc.stdout, encoding="utf-8")
    (process_dir / "process_stderr.txt").write_text(proc.stderr, encoding="utf-8")
    if proc.returncode != 0:
        raise RuntimeError(f"process failed: {proc.stderr[-2000:]}")
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


def metric_line(metric: dict[str, Any]) -> str:
    rates = metric.get("rates") if isinstance(metric.get("rates"), dict) else {}
    return (
        f"机况UV{num(metric.get('jkuv')):.0f}、估价UV{num(metric.get('evaUv')):.0f}、下单UV{num(metric.get('orderUv')):.0f}，"
        f"发货数{num(metric.get('shipCnt')):.1f}、成交订单{num(metric.get('dealCnt')):.1f}、成交GMV约{money(metric.get('gmv'))}，"
        f"下单率{pct(rates.get('orderRate'))}、发货率{pct(rates.get('shipRate'))}、成交率{pct(rates.get('dealRate'))}"
    )


def build_category_display_maps(processed: dict[str, Any]) -> tuple[dict[str, str], dict[str, str], list[str]]:
    taxonomy = read_cache_json(processed, "category-taxonomy.json") or {}
    category_cache = read_cache_json(processed, "category-cache.json") or {}
    model_cache = read_cache_json(processed, "model-cache.json") or {}
    taxonomy_rows = taxonomy.get("rows") if isinstance(taxonomy, dict) else []
    if not isinstance(taxonomy_rows, list):
        taxonomy_rows = []
    latest_by_category = latest_category_rows(category_cache if isinstance(category_cache, dict) else {})
    latest_models = latest_top_models_by_category(model_cache if isinstance(model_cache, dict) else {})
    categories_in_cache = set((category_cache.get("categories") or []) if isinstance(category_cache, dict) else [])
    usable_rows = []
    for raw in taxonomy_rows:
        if not isinstance(raw, dict):
            continue
        category = str(raw.get("category") or "").strip()
        tier = str(raw.get("tier") or "").strip()
        if not category or tier == "自营(非聚合)" or str(raw.get("status") or "") == "已下线":
            continue
        if categories_in_cache and category not in categories_in_cache:
            continue
        usable_rows.append(raw)

    board_groups: dict[str, list[dict[str, Any]]] = {}
    categories: dict[str, str] = {}
    tier_order = {"发展": 0, "孵化": 1, "种子": 2}
    usable_rows.sort(key=lambda r: (tier_order.get(str(r.get("tier") or ""), 9), -num(r.get("lastWeekGmv")), str(r.get("category") or "")))
    for row in usable_rows:
        category = str(row.get("category") or "").strip()
        board = str(row.get("board") or "未分组").strip() or "未分组"
        tier = str(row.get("tier") or "待归类").strip() or "待归类"
        metric = latest_by_category.get(category, {})
        board_groups.setdefault(board, []).append(row)
        top_model = latest_models.get(category, {})
        model_hint = ""
        if top_model:
            model_name = str(top_model.get("modelName") or "").strip()
            if model_name:
                model_hint = f"；机型观察优先看{model_name}，对应成交GMV约{money(top_model.get('gmv'))}、成交订单{num(top_model.get('dealCnt')):.1f}"
        if metric:
            categories[category] = (
                f"{category}当前归属{tier}层/{board}，本周按AIWAN处理产物生成指标短评；"
                f"{metric_line(metric)}{model_hint}。建议继续下钻机型、标签和履约明细，低基数波动先按数据风险观察。"
            )
        else:
            categories[category] = (
                f"{category}当前归属{tier}层/{board}，本轮只取得合法品类分层快照，未取得可稳定聚合的最新周指标。"
                "该对象保留在页面 map 中作为数据风险，后续需补齐品类指标后再判断归因。"
            )

    secondary: dict[str, str] = {}
    for board, rows in sorted(board_groups.items(), key=lambda item: (-sum(num(r.get("lastWeekGmv")) for r in item[1]), item[0])):
        tier_counts: dict[str, int] = {}
        gmv = 0.0
        active_metrics = 0
        for row in rows:
            tier = str(row.get("tier") or "待归类")
            tier_counts[tier] = tier_counts.get(tier, 0) + 1
            category = str(row.get("category") or "")
            metric = latest_by_category.get(category)
            if metric:
                active_metrics += 1
                gmv += num(metric.get("gmv"))
        tier_text = "、".join(f"{k}{v}个" for k, v in sorted(tier_counts.items(), key=lambda kv: (tier_order.get(kv[0], 9), kv[0])))
        metric_text = f"本周聚合成交GMV约{money(gmv)}，覆盖{active_metrics}个有指标品类" if active_metrics else "本轮仅有分层快照，缺少稳定最新周指标"
        secondary[board] = (
            f"{board}覆盖{len(rows)}个品类（{tier_text}），本条由AIWAN处理产物按二级板块聚合生成；"
            f"{metric_text}。建议优先查看贡献最高的品类和机型标签，映射或样本不足时维持观察。"
        )

    warnings: list[str] = []
    if not secondary or not categories:
        warnings.append("display_category_maps_empty")
    elif not latest_by_category:
        warnings.append("display_category_maps_snapshot_only")
    if (processed.get("category_mapping_manifest") or {}).get("source", {}).get("type") in {"package_category_taxonomy_snapshot_json", "feishu_base_mapping_snapshot_json", "feishu_base_mapping_snapshot_csv"}:
        warnings.append("category_mapping_source_not_realtime")
    return secondary, categories, warnings


def build_display_insights(processed: dict[str, Any], server_context: dict[str, Any]) -> dict[str, Any]:
    dq = processed.get("data_quality_report") or {}
    warnings = []
    if dq.get("known_gaps"):
        warnings.extend(str(x) for x in dq.get("known_gaps", [])[:5])
    hist = processed.get("process_summary", {}).get("history_weeks_available")
    scope = processed.get("process_summary", {}).get("analysis_scope_hint") or "wow_only"
    basis = f"当前数据截止到{processed.get('run_dt')}，按{scope}口径观察"
    board = f"{basis}，大盘需以机况UV、估价UV、下单UV、发货数、成交订单、成交GMV的链路变化为主线复核。履约维度若存在缺口，优先维持观察并下钻到品类与机型。"
    tiers = {
        "发展": f"发展层关注成交GMV与成交订单的周内贡献变化；当前历史可用周数为{hist or '待确认'}，若低于8周，仅做环比观察，不写长期趋势结论。",
        "孵化": "孵化层关注估价UV到下单UV的转化变化，重点观察下单率、发货率、成交率是否同步波动；低基数对象只作为数据风险保留。",
        "种子": "种子层关注机况UV与估价UV的早期信号，若成交订单不足，需要先确认样本量和品类映射，再判断是否继续跟踪。",
    }
    secondary, categories, map_warnings = build_category_display_maps(processed)
    warnings.extend(map_warnings)
    return {
        "board": board,
        "tiers": tiers,
        "secondaryCategories": secondary,
        "categories": categories,
        "category": "品类层以AIWAN process产物、server_cache_bundle和dashboard聚合快照为准；分层/品类短评会标明来源策略，未匹配或低置信度对象保留在 warnings 中观察。",
        "monitor": "本轮由 AIWAN v1.6 内联状态机生成，服务器 bridge 只发布 display_insights；二级类目和品类文案若来自dashboard聚合快照，会按聚合观察口径展示，不伪装为AI小万独立归因。",
        "warnings": warnings,
    }


def execute_analyze(args: argparse.Namespace, run_dir: Path, processed: dict[str, Any]) -> dict[str, Any]:
    read_body = {
        "run_id": args.run_id,
        "stage": "analyze",
        "week": args.week,
        "history_weeks": 10,
        "include": ["run_meta", "history_10w", "rules", "previous_stage_outputs", "dashboard_snapshot"],
    }
    server_context = hub_post(READ_PATH, read_body, timeout=130.0)
    display = build_display_insights(processed, server_context)
    analysis_result = {
        "stage": "analyze",
        "status": "warn" if display["warnings"] else "success",
        "output_type": "analysis_result",
        "run_id": args.run_id,
        "week": args.week,
        "analysis_scope": processed.get("process_summary", {}).get("analysis_scope_hint", "wow_only"),
        "history_weeks": processed.get("process_summary", {}).get("history_weeks_available"),
        "evidence_pack": {
            "data_quality_notes": display["warnings"],
            "source_of_truth": ["processed_data", "server_context"],
        },
        "findings": [],
        "display_contract": DISPLAY_CONTRACT,
        "display_insights": display,
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
    checks = []
    failed = []
    def check(name: str, ok: bool, severity: str = "critical") -> None:
        checks.append({"name": name, "ok": ok, "severity": severity})
        if not ok and severity == "critical":
            failed.append(name)
    check("display_contract", analysis.get("display_contract") == DISPLAY_CONTRACT)
    check("board_non_empty", isinstance(display.get("board"), str) and bool(display.get("board").strip()))
    check("category_non_empty", isinstance(display.get("category"), str) and bool(display.get("category").strip()))
    check("monitor_non_empty", isinstance(display.get("monitor"), str) and bool(display.get("monitor").strip()))
    tiers = display.get("tiers") or {}
    for tier in ("发展", "孵化", "种子"):
        check(f"tier_{tier}_non_empty", isinstance(tiers.get(tier), str) and bool(tiers.get(tier).strip()))
    check("secondary_map", isinstance(display.get("secondaryCategories"), dict))
    check("categories_map", isinstance(display.get("categories"), dict))
    check("secondary_map_non_empty", isinstance(display.get("secondaryCategories"), dict) and bool(display.get("secondaryCategories")))
    check("categories_map_non_empty", isinstance(display.get("categories"), dict) and bool(display.get("categories")))
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
        reread = hub_post(READ_PATH, {"run_id": args.run_id, "stage": "validate", "week": args.week, "include": ["run_meta", "previous_stage_outputs"]}, timeout=90.0)
        validation_result["server_write_response"] = write_resp
        validation_result["server_reread_response"] = reread
        validation_result["server_write_confirmed"] = True
    write_json(run_dir / "validation_result.json", validation_result)
    return validation_result


def run(args: argparse.Namespace) -> dict[str, Any]:
    run_dir = out_root() / "aiwan_runs" / args.run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    stages: dict[str, Any] = {}
    try:
        stages["read"] = execute_read(args, run_dir)
        stages["process"] = execute_process(args, run_dir, stages["read"])
        stages["analyze"] = execute_analyze(args, run_dir, stages["process"])
        stages["validate"] = execute_validate(args, run_dir, stages["process"], stages["analyze"])
        ok = stages["validate"].get("server_write_confirmed") is True
        result = {
            "ok": ok,
            "overall_status": "warn" if ok and (stages["read"].get("warnings") or stages["process"].get("warnings") or stages["analyze"].get("warnings")) else ("success" if ok else "failed"),
            "run_id": args.run_id,
            "week": args.week,
            "actual_data_week": {
                "input_week": args.week,
                "week_start_dates": stages["read"].get("week_start_dates", []),
                "current_week_start": "2026-07-13",
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
            "artifacts_dir": str(run_dir),
        }
    except Exception as exc:
        result = {
            "ok": False,
            "overall_status": "failed",
            "run_id": args.run_id,
            "week": args.week,
            "stage_results": {
                name: {"status": st.get("status"), "output_type": st.get("output_type")}
                for name, st in stages.items()
            },
            "error": str(exc),
            "publish_allowed": False,
            "artifacts_dir": str(run_dir),
        }
    write_json(run_dir / "aiwan_inline_result.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--week", required=True)
    parser.add_argument("--run-dt", required=True)
    parser.add_argument("--data-end-date")
    parser.add_argument("--sql-timeout-seconds", type=int, default=1800)
    parser.add_argument("--process-timeout-seconds", type=int, default=900)
    parser.add_argument("--poll-interval-seconds", type=int, default=15)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if not args.data_end_date:
        args.data_end_date = (datetime.strptime(args.run_dt, "%Y-%m-%d").date() - timedelta(days=1)).isoformat()
    result = run(args)
    raise SystemExit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()

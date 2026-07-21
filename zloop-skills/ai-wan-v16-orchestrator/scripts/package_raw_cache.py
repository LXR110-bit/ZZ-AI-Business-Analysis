#!/usr/bin/env python3
"""Package AIWAN raw SQL exports into the fetch artifact contract.

This is the Python replacement for the historical Node package-raw-cache
wrapper.  It is stdlib-only so the remote Skill package does not depend on a
Node runtime for the Loop read stage.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from process_pipeline import BASE_SCRIPTS, FETCH_CONTRACT_VERSION, RAW_SCRIPTS  # noqa: E402


OPTIONAL_EMPTY_SCRIPTS = {"category_fulfill_daily_avg", "category_fulfill_summary"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def write_json(path: Path, value: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def inspect_csv(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        try:
            headers = next(reader)
        except StopIteration:
            headers = []
            rows = 0
        else:
            rows = sum(1 for _ in reader)
    return {
        "row_count": rows,
        "column_count": len(headers),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def find_input_file(input_dir: Path, script: str, ext: str) -> Path | None:
    exact = input_dir / f"{script}.{ext}"
    if exact.exists():
        return exact
    hits = sorted(
        path for path in input_dir.iterdir()
        if path.is_file() and path.name.startswith(f"{script}_") and path.suffix == f".{ext}"
    )
    return hits[0] if hits else None


def resolve_script_scope(sql_scope: str | None = None, scripts: str | Iterable[str] | None = None) -> tuple[str, tuple[str, ...]]:
    scope = (sql_scope or "all").strip().lower()
    if scope not in {"all", "base"}:
        raise ValueError(f"sql_scope must be all or base, got {sql_scope}")

    if scripts is None:
        provided: list[str] = []
    elif isinstance(scripts, str):
        provided = [item.strip() for item in scripts.split(",") if item.strip()]
    else:
        provided = [str(item).strip() for item in scripts if str(item).strip()]

    active = tuple(provided or (BASE_SCRIPTS if scope == "base" else RAW_SCRIPTS))
    if len(set(active)) != len(active):
        raise ValueError(f"scripts contains duplicates: {','.join(active)}")

    expected = tuple(BASE_SCRIPTS if scope == "base" else RAW_SCRIPTS)
    unknown = [script for script in active if script not in RAW_SCRIPTS]
    missing = [script for script in expected if script not in active]
    extra = [script for script in active if script not in expected]
    if unknown or missing or extra:
        raise ValueError(
            f"scripts do not match sql_scope={scope}; "
            f"missing={','.join(missing) or '<none>'}; "
            f"extra={','.join(extra) or '<none>'}; "
            f"unknown={','.join(unknown) or '<none>'}"
        )
    return scope, active


def zip_dir(source_dir: Path, out_file: Path, entries: Iterable[str]) -> None:
    ensure_dir(out_file.parent)
    if out_file.exists():
        out_file.unlink()
    with zipfile.ZipFile(out_file, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            root = source_dir / entry
            if root.is_dir():
                for path in sorted(root.rglob("*")):
                    if path.is_file():
                        archive.write(path, path.relative_to(source_dir).as_posix())
            elif root.is_file():
                archive.write(root, root.relative_to(source_dir).as_posix())


def package_raw_cache(
    *,
    run_dt: str,
    input_dir: str | Path = ".",
    out_dir: str | Path | None = None,
    run_id: str | None = None,
    known_gaps: str | Iterable[str] | None = None,
    sql_scope: str | None = None,
    scripts: str | Iterable[str] | None = None,
    keep_work_dir: bool = False,
) -> dict[str, Any]:
    if not run_dt or not isinstance(run_dt, str) or not re.match(r"^\d{4}-\d{2}-\d{2}$", run_dt):
        raise ValueError(f"run_dt must be YYYY-MM-DD, got {run_dt}")

    input_path = Path(input_dir).resolve()
    output_path = Path(out_dir or input_path).resolve()
    fetch_id = run_id or f"fetch_{run_dt}_{secrets.token_hex(4)}"
    scope, active_scripts = resolve_script_scope(sql_scope, scripts)
    ensure_dir(output_path)
    work_dir = Path(tempfile.mkdtemp(prefix=f"ai-wan-fetch-{run_dt}-"))
    try:
        ensure_dir(work_dir / "raw")
        ensure_dir(work_dir / "sql")
        script_status: dict[str, Any] = {}
        raw_files: list[dict[str, Any]] = []

        for script in active_scripts:
            csv_file = find_input_file(input_path, script, "csv")
            if csv_file is None:
                raise FileNotFoundError(f"missing raw csv for {script} in {input_path}")
            sql_file = find_input_file(input_path, script, "sql")
            raw_rel = Path("raw") / f"{script}_{run_dt}.csv"
            sql_rel = Path("sql") / f"{script}_{run_dt}.sql"
            shutil.copyfile(csv_file, work_dir / raw_rel)
            sql_text = (
                sql_file.read_text(encoding="utf-8")
                if sql_file is not None
                else f"-- SQL text unavailable for {script}; packaged by package_raw_cache.py\n"
            )
            (work_dir / sql_rel).write_text(sql_text, encoding="utf-8")

            csv_info = inspect_csv(work_dir / raw_rel)
            empty_optional = csv_info["row_count"] == 0 and script in OPTIONAL_EMPTY_SCRIPTS
            status = "SUCCESS" if csv_info["row_count"] > 0 else ("WARN" if empty_optional else "FAILED")
            script_status[script] = {
                "execute_id": "",
                "status": status,
                "row_count": csv_info["row_count"],
                "column_count": csv_info["column_count"],
                "bytes": csv_info["bytes"],
                "sha256": csv_info["sha256"],
                "raw_csv": raw_rel.as_posix(),
                "rendered_sql": sql_rel.as_posix(),
                "rendered_sql_sha256": sha256_text(sql_text),
                "started_at": "",
                "finished_at": now_iso(),
                "error_summary": "" if status == "SUCCESS" else ("empty csv accepted as fulfillment known gap" if empty_optional else "empty csv"),
            }
            raw_files.append({"script": script, "path": raw_rel.as_posix(), **csv_info})

        values = list(script_status.values())
        status = "success" if all(item["status"] == "SUCCESS" for item in values) else (
            "failed" if any(item["status"] == "FAILED" for item in values) else "warn"
        )
        if known_gaps is None:
            gaps: list[str] = []
        elif isinstance(known_gaps, str):
            gaps = [item for item in known_gaps.split(",") if item]
        else:
            gaps = [str(item) for item in known_gaps if str(item)]
        for script, info in script_status.items():
            gap = f"{script}_empty"
            if info["status"] == "WARN" and gap not in gaps:
                gaps.append(gap)

        sql_status = {
            "contract_version": FETCH_CONTRACT_VERSION,
            "stage": "fetch",
            "run_id": fetch_id,
            "run_dt": run_dt,
            "sql_scope": scope,
            "active_scripts": list(active_scripts),
            "status": status,
            "scripts": script_status,
            "generated_at": now_iso(),
        }
        raw_manifest = {
            "contract_version": FETCH_CONTRACT_VERSION,
            "stage": "fetch",
            "run_id": fetch_id,
            "run_dt": run_dt,
            "target_month": run_dt[:7],
            "sql_scope": scope,
            "scripts": list(active_scripts),
            "raw_files": raw_files,
            "known_gaps": gaps,
            "generated_at": now_iso(),
        }

        write_json(work_dir / f"sql_status_{run_dt}.json", sql_status)
        write_json(work_dir / f"raw_manifest_{run_dt}.json", raw_manifest)
        write_json(output_path / f"sql_status_{run_dt}.json", sql_status)
        write_json(output_path / f"raw_manifest_{run_dt}.json", raw_manifest)

        raw_cache = output_path / f"raw_cache_{run_dt}.zip"
        zip_dir(work_dir, raw_cache, ("raw", "sql", f"sql_status_{run_dt}.json", f"raw_manifest_{run_dt}.json"))
        active = {
            "contract_version": FETCH_CONTRACT_VERSION,
            "stage": "fetch",
            "status": status,
            "run_id": fetch_id,
            "run_dt": run_dt,
            "target_month": run_dt[:7],
            "sql_scope": scope,
            "scripts": list(active_scripts),
            "raw_cache": raw_cache.name,
            "raw_cache_sha256": sha256_file(raw_cache),
            "sha256": sha256_file(raw_cache),
            "sql_status": f"sql_status_{run_dt}.json",
            "raw_manifest": f"raw_manifest_{run_dt}.json",
            "known_gaps": gaps,
            "generated_at": now_iso(),
        }
        write_json(output_path / "active_fetch_manifest.json", active)
        return {"ok": status in {"success", "warn"}, "active_manifest": active, "raw_cache": str(raw_cache), "sql_status": sql_status, "raw_manifest": raw_manifest}
    finally:
        if not keep_work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Package selected xinghe raw CSVs into raw_cache/sql_status/raw_manifest artifacts."
    )
    parser.add_argument("--run-dt", default=os.environ.get("RUN_DT"))
    parser.add_argument("--run-id", default=os.environ.get("RUN_ID"))
    parser.add_argument("--input-dir", default=os.environ.get("INPUT_DIR", "."))
    parser.add_argument("--out-dir", default=os.environ.get("OUT_DIR", "."))
    parser.add_argument("--known-gaps", default=os.environ.get("KNOWN_GAPS"))
    parser.add_argument("--sql-scope", default=os.environ.get("SQL_SCOPE"))
    parser.add_argument("--scripts", default=os.environ.get("SCRIPTS"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.run_dt:
        print("--run-dt is required", file=sys.stderr)
        return 2
    try:
        result = package_raw_cache(
            run_dt=args.run_dt,
            run_id=args.run_id,
            input_dir=args.input_dir,
            out_dir=args.out_dir,
            known_gaps=args.known_gaps,
            sql_scope=args.sql_scope,
            scripts=args.scripts,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    except Exception as exc:  # pragma: no cover - defensive CLI boundary
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

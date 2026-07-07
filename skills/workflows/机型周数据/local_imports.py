"""Local CSV sink for online weekly funnel imports."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

from .mail_sources import source_by_key


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _metric_sums(df: pd.DataFrame) -> dict[str, float]:
    sums: dict[str, float] = {}
    for col in df.columns:
        numeric = pd.to_numeric(df[col], errors="coerce")
        if numeric.notna().any():
            sums[str(col)] = float(numeric.fillna(0).sum())
    return sums


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _atomic_write_csv(df: pd.DataFrame, path: Path, tmp_dir: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tmp = tmp_dir / f"{path.name}.{os.getpid()}.tmp"
    df.to_csv(tmp, index=False, encoding="utf-8-sig")
    os.replace(tmp, path)


def write_local_imports(
    *,
    outputs: dict[str, pd.DataFrame],
    month: str,
    run_id: str,
    output_root: Path | str = Path("data/imports"),
    mail_metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = Path(output_root)
    tmp_dir = root / ".tmp" / run_id
    manifest_dir = root / "manifests"
    generated_at = _now_iso()
    manifest_outputs: dict[str, Any] = {}
    active_outputs: dict[str, str] = {}

    for source_key, df in outputs.items():
        source = source_by_key(source_key)
        filename = source.output_filename(month)
        output_path = root / filename
        _atomic_write_csv(df, output_path, tmp_dir)
        stat = output_path.stat()
        manifest_outputs[source_key] = {
            "path": str(output_path),
            "filename": filename,
            "row_count": int(len(df)),
            "column_count": int(len(df.columns)),
            "columns": [str(col) for col in df.columns],
            "metric_sums": _metric_sums(df),
            "sha256": _sha256(output_path),
            "bytes": int(stat.st_size),
            "role": source.role,
        }
        active_outputs[source_key] = str(output_path)

    try:
        tmp_dir.rmdir()
        (root / ".tmp").rmdir()
    except OSError:
        pass

    manifest_path = manifest_dir / f"{run_id}.json"
    manifest = {
        "schema_version": 1,
        "run_id": run_id,
        "generated_at": generated_at,
        "month": month,
        "mail_metadata": mail_metadata or {},
        "outputs": manifest_outputs,
        "validation_status": "pass",
    }
    _atomic_write_text(manifest_path, json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True))

    active = {
        "schema_version": 1,
        "run_id": run_id,
        "generated_at": generated_at,
        "outputs": active_outputs,
        "manifest": str(manifest_path),
    }
    _atomic_write_text(root / "active.json", json.dumps(active, ensure_ascii=False, indent=2, sort_keys=True))

    return {
        "status": "ok",
        "run_id": run_id,
        "month": month,
        "output_root": str(root),
        "manifest_path": str(manifest_path),
        "active_path": str(root / "active.json"),
        "outputs": manifest_outputs,
    }

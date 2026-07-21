#!/usr/bin/env python3
"""CLI for the Python AI 小万 PROCESS pipeline."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from process_pipeline import process_raw_cache  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Process AI 小万 raw cache without Node.js.")
    parser.add_argument("--run-dt", default=os.environ.get("RUN_DT"))
    parser.add_argument("--run-id", default=os.environ.get("RUN_ID"))
    parser.add_argument("--input-dir", default=os.environ.get("INPUT_DIR", "."))
    parser.add_argument("--out-dir", default=os.environ.get("OUT_DIR", "."))
    parser.add_argument("--snapshot-dir", default=os.environ.get("SNAPSHOT_DIR"))
    parser.add_argument("--previous-processed-cache", default=os.environ.get("PREVIOUS_PROCESSED_CACHE"))
    parser.add_argument("--category-mapping-file", default=os.environ.get("CATEGORY_MAPPING_FILE"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.run_dt:
        print("--run-dt is required", file=sys.stderr)
        return 2
    try:
        result = process_raw_cache(run_dt=args.run_dt, run_id=args.run_id, input_dir=args.input_dir, out_dir=args.out_dir,
                                   snapshot_dir=args.snapshot_dir, previous_processed_cache=args.previous_processed_cache,
                                   category_mapping_file=args.category_mapping_file)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    except Exception as exc:  # pragma: no cover - defensive CLI boundary
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

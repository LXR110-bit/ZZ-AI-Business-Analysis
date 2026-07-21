#!/usr/bin/env python3
"""AI小万 APIHub read/write client for zloop remote sandbox.

Only zloop_runtime.hub owns gateway routing and APIHub authentication. This
module uses only zloop_runtime.hub with registered relative API paths and never constructs auth headers or logs secrets.
"""

import argparse
import json
import sys
from typing import Any

import zloop_runtime.hub as hub

READ_PATH = "/v2/aiwan/api/aiwan/read"
WRITE_PATH = "/v2/aiwan/api/aiwan/write"
ALLOWED_STAGES = {"read", "process", "analyze", "validate"}
DEFAULT_INCLUDE = [
    "run_meta",
    "history_10w",
    "metric_snapshot",
    "candidate_anomalies",
    "rules",
    "previous_stage_outputs",
]


def _fail(code: str, message: str, *, details: Any = None, exit_code: int = 2) -> None:
    error = {"ok": False, "error": {"code": code, "message": message}}
    if details is not None:
        error["error"]["details"] = details
    print(json.dumps(error, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(exit_code)


def _decode_response(response: hub.HubResponse, operation: str) -> dict[str, Any]:
    if not response.ok:
        _fail(
            "APIHUB_HTTP_ERROR",
            f"{operation} returned non-2xx",
            details={"status_code": response.status_code},
            exit_code=3,
        )
    try:
        data = response.json()
    except Exception:
        _fail(
            "APIHUB_INVALID_JSON",
            f"{operation} returned a non-JSON response",
            details={"status_code": response.status_code},
            exit_code=3,
        )
    if not isinstance(data, dict):
        _fail("APIHUB_INVALID_ENVELOPE", f"{operation} response must be an object", exit_code=3)
    if data.get("ok") is not True:
        _fail(
            "APIHUB_BUSINESS_ERROR",
            f"{operation} returned ok=false",
            details={
                "missing_previous_stages": data.get("missing_previous_stages", []),
                "warnings": data.get("warnings", []),
            },
            exit_code=4,
        )
    return data


def read_context(args: argparse.Namespace) -> None:
    if args.stage not in ALLOWED_STAGES:
        _fail("INVALID_STAGE", f"unsupported stage: {args.stage}")
    include = [item.strip() for item in args.include.split(",") if item.strip()]
    body: dict[str, Any] = {
        "run_id": args.run_id,
        "stage": args.stage,
        "include": include or DEFAULT_INCLUDE,
        "history_weeks": args.history_weeks,
    }
    if args.week:
        body["week"] = args.week
    response = hub.post(
        READ_PATH,
        json_body=body,
        timeout=130.0,
    )
    print(json.dumps(_decode_response(response, "aiwan:run:read"), ensure_ascii=False))


def _load_write_envelope(args: argparse.Namespace) -> dict[str, Any]:
    if args.json:
        raw = args.json
    elif args.file:
        with open(args.file, "r", encoding="utf-8") as handle:
            raw = handle.read()
    else:
        raw = sys.stdin.read()
    try:
        body = json.loads(raw)
    except Exception:
        _fail("INVALID_WRITE_JSON", "write request must be valid JSON")
    if not isinstance(body, dict):
        _fail("INVALID_WRITE_ENVELOPE", "write request must be a JSON object")
    missing = [key for key in ("run_id", "stage", "status", "payload") if key not in body]
    if missing:
        _fail("MISSING_WRITE_FIELDS", "write request is missing required fields", details=missing)
    if body.get("stage") not in ALLOWED_STAGES:
        _fail("INVALID_STAGE", f"unsupported stage: {body.get('stage')}")
    return body


def write_checkpoint(args: argparse.Namespace) -> None:
    body = _load_write_envelope(args)
    response = hub.post(
        WRITE_PATH,
        json_body=body,
        timeout=70.0,
    )
    print(json.dumps(_decode_response(response, "aiwan:run:write"), ensure_ascii=False))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI小万 APIHub runtime client")
    sub = parser.add_subparsers(dest="command", required=True)

    read_parser = sub.add_parser("read")
    read_parser.add_argument("--run-id", required=True)
    read_parser.add_argument("--stage", required=True, choices=sorted(ALLOWED_STAGES))
    read_parser.add_argument("--week")
    read_parser.add_argument("--history-weeks", type=int, default=10)
    read_parser.add_argument("--include", default=",".join(DEFAULT_INCLUDE))
    read_parser.set_defaults(func=read_context)

    write_parser = sub.add_parser("write")
    source = write_parser.add_mutually_exclusive_group()
    source.add_argument("--json")
    source.add_argument("--file")
    write_parser.set_defaults(func=write_checkpoint)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

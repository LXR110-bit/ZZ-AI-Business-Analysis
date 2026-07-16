#!/usr/bin/env python3
"""AI小万 Analyze-stage APIHub read-only client for zloop remote sandbox.

Only zloop_runtime.hub owns gateway routing and APIHub authentication. This
module uses only zloop_runtime.hub with registered relative API paths and never
constructs auth headers, reads tokens, or writes server state.
"""

import argparse
import json
import sys
from typing import Any

import zloop_runtime.hub as hub

READ_PATH = "/v2/aiwan/api/aiwan/read"
ALLOWED_STAGES = {"analyze"}
DEFAULT_INCLUDE = [
    "run_meta",
    "history_10w",
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
        _fail("INVALID_STAGE", f"unsupported stage for this read-only analyze client: {args.stage}")
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI小万 Analyze APIHub read-only runtime client")
    sub = parser.add_subparsers(dest="command", required=True)

    read_parser = sub.add_parser("read")
    read_parser.add_argument("--run-id", required=True)
    read_parser.add_argument("--stage", required=True, choices=sorted(ALLOWED_STAGES))
    read_parser.add_argument("--week")
    read_parser.add_argument("--history-weeks", type=int, default=10)
    read_parser.add_argument("--include", default=",".join(DEFAULT_INCLUDE))
    read_parser.set_defaults(func=read_context)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

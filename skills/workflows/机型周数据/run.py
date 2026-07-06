"""编排入口: python -m skills.workflows.机型周数据 [--months 2026-06,2026-07] [--lookback-days 14] [--skip-notify]"""
from __future__ import annotations
import argparse, fcntl, json, os, sys
from datetime import datetime

from .pipeline import run_pipeline
from .notifier import notify


LOCK_PATH = "/tmp/机型周数据.pipeline.lock"


def _acquire_singleton_lock():
    """Prevent overlapping cron/manual pipeline runs on the same host."""
    fh = open(LOCK_PATH, "w")
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"another 机型周数据 pipeline is already running; lock={LOCK_PATH}", file=sys.stderr)
        fh.close()
        return None
    fh.write(f"pid={os.getpid()} acquired_at={datetime.now().isoformat()}\n")
    fh.flush()
    return fh


def main() -> int:
    ap = argparse.ArgumentParser(prog="机型周数据")
    ap.add_argument("--months", type=str, default=None, help="逗号分隔月份, 例 2026-06,2026-07. 默认全部数据涉及月")
    ap.add_argument("--lookback-days", type=int, default=14)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--skip-notify", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="skip 通知 (等同 --skip-notify)")
    args = ap.parse_args()

    months_set = None
    if args.months:
        months_set = {m.strip() for m in args.months.split(",") if m.strip()}

    lock_fh = _acquire_singleton_lock()
    if lock_fh is None:
        return 75
    try:
        result = run_pipeline(
            target_months=months_set,
            lookback_days=args.lookback_days,
            concurrency=args.concurrency,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))

        if result.get("status") in ("ok", "partial") and not (args.skip_notify or args.dry_run):
            notify(
                months=result["months"],
                zip_names=result["zips"],
                by_month_stats=result["by_month"],
            )
            print(f"notify sent (status={result.get('status')})", file=sys.stderr)

        return 0 if result.get("status") == "ok" else 1
    finally:
        try:
            fcntl.flock(lock_fh, fcntl.LOCK_UN)
        finally:
            lock_fh.close()


if __name__ == "__main__":
    sys.exit(main())

"""编排入口: python -m skills.workflows.机型周数据 [--months 2026-06,2026-07] [--lookback-days 14] [--skip-notify]"""
from __future__ import annotations
import argparse, fcntl, json, os, sys
from datetime import datetime
from pathlib import Path

from .pipeline import run_pipeline, run_local_imports_pipeline
from .base_migration import BASE_TARGETS_PATH, run_base_migration_pipeline
from .notifier import notify, notify_base_migration


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
    ap.add_argument("--dry-run", action="store_true", help="skip 通知 (等同 --skip-notify); Base migration 下不执行导入")
    ap.add_argument("--local-imports", action="store_true", help="线上主链路: 写 data/imports CSV + manifest, 不写飞书明细")
    ap.add_argument("--local-output-dir", type=str, default="data/imports", help="local imports 输出目录")
    ap.add_argument("--local-run-id", type=str, default=None, help="local imports run_id; 默认当前时间")
    ap.add_argument("--publish-base-index", action="store_true", help="local imports 后仅发布 Base 校验/索引记录; 不导入明细")
    ap.add_argument("--base-migration", action="store_true", help="生成飞书多维表格迁移包; 默认仅导出, 不写 Base")
    ap.add_argument("--base-import", action="store_true", help="与 --base-migration 搭配: 使用 drive +import --type bitable 导入并发布索引")
    ap.add_argument("--base-token", type=str, default=None, help="目标月度 Base token; 不传则按环境变量/标题解析或创建")
    ap.add_argument("--base-output-dir", type=str, default="/tmp/机型周数据_base_migration", help="Base 迁移包输出根目录")
    ap.add_argument("--base-run-id", type=str, default=None, help="Base 迁移 run_id; 默认当前时间")
    ap.add_argument("--base-as", type=str, default="user", choices=["user", "bot"], help="lark-cli 导入/索引写入身份")
    ap.add_argument("--base-name-prefix", type=str, default="机型周数据", help="月度 Base 标题前缀")
    ap.add_argument("--base-import-mode", type=str, default="auto", choices=["auto", "mapped", "monthly"], help="Base 导入模式: auto 优先使用目标映射, mapped 使用用户已建 Base, monthly 使用单月 Base")
    ap.add_argument("--base-target-map", type=str, default=str(BASE_TARGETS_PATH), help="用户已建 Base 目标映射 JSON; 默认读取 workflow 内置 base_targets.json 或 MODEL_WEEKLY_BASE_TARGET_MAP")
    ap.add_argument("--base-target-family", type=str, default="model", help="目标映射 family; 当前机型周数据默认 model")
    args = ap.parse_args()

    months_set = None
    if args.months:
        months_set = {m.strip() for m in args.months.split(",") if m.strip()}

    lock_fh = _acquire_singleton_lock()
    if lock_fh is None:
        return 75
    try:
        if args.local_imports:
            result = run_local_imports_pipeline(
                target_months=months_set,
                lookback_days=args.lookback_days,
                output_root=Path(args.local_output_dir),
                run_id=args.local_run_id,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
            return 0 if result.get("status") == "ok" else 1

        if args.base_migration:
            result = run_base_migration_pipeline(
                target_months=months_set,
                lookback_days=args.lookback_days,
                output_root=Path(args.base_output_dir),
                run_id=args.base_run_id,
                import_to_base=bool(args.base_import and not args.dry_run),
                base_token=args.base_token,
                as_identity=args.base_as,
                base_name_prefix=args.base_name_prefix,
                import_mode=args.base_import_mode,
                target_map_path=Path(args.base_target_map) if args.base_target_map else None,
                target_family=args.base_target_family,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
            if result.get("status") in ("ok", "partial") and not (args.skip_notify or args.dry_run):
                notify_base_migration(result)
                print(f"base migration notify sent (status={result.get('status')})", file=sys.stderr)
            return 0 if result.get("status") == "ok" else 1

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

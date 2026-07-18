#!/usr/bin/env python3
"""核心机型快照离线同步骨架（任务C，待业务提供飞书 sheet 后启用）。

沙箱内不直连飞书。用法：先把飞书「02_机型与标签」sheet 导出为 CSV/JSON，再喂给本脚本：

    python3 sync_core_models.py \
        --input exported_core_models.csv \
        --taxonomy references/process/server-snapshot/category-taxonomy.json \
        --out references/process/core-models.json \
        --version 1.0.0

流程：读入记录 → parse_feishu_core_model_rows 映射列 → validate_core_models_rows 按 §6.3
校验（model_id 合法/品类在 taxonomy/同 model_id 多行并标签/跨品类冲突拒绝）→ 写版本化快照 + 同步报告。

⚠️ 默认列映射（DEFAULT_FEISHU_COLUMN_MAP）仅为骨架，同步前必须核对 sheet 实际表头并按需
用 --column-map 覆盖；设计 §6.2 明确禁止静默猜测机型 ID。冲突/非法行进入报告，不静默丢弃。
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aiwan_core_models as cm  # noqa: E402


def _read_records(path: Path) -> list[dict]:
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data = data.get("rows") or data.get("records") or []
        return list(data)
    with path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _taxonomy_categories(path: Path) -> set[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = data.get("rows") if isinstance(data, dict) else []
    return {str(r.get("category") or "").strip() for r in (rows or []) if isinstance(r, dict) and r.get("category")}


def build_snapshot(records: list[dict], taxonomy: set[str], *, version: str, column_map: dict | None = None) -> dict:
    parsed = cm.parse_feishu_core_model_rows(records, column_map=column_map)
    normalized, report = cm.validate_core_models_rows(parsed, taxonomy)
    status = "ok" if normalized else "pending_business_sheet"
    return {
        "syncedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "version": version,
        "status": status,
        "source": {"sourceType": "feishu_offline_export", "worksheet": "02_机型与标签"},
        "sync_report": report,
        "rows": normalized,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="核心机型快照离线同步（骨架）")
    parser.add_argument("--input", required=True, help="离线导出的飞书 sheet（.csv 或 .json）")
    parser.add_argument("--taxonomy", required=True, help="category-taxonomy.json 路径（校验品类）")
    parser.add_argument("--out", required=True, help="输出 core-models.json 路径")
    parser.add_argument("--version", default="1.0.0", help="快照版本号")
    parser.add_argument("--column-map", default=None, help="列映射 JSON 文件（覆盖默认映射）")
    parser.add_argument("--dry-run", action="store_true", help="只打印报告不写文件")
    args = parser.parse_args()

    column_map = json.loads(Path(args.column_map).read_text(encoding="utf-8")) if args.column_map else None
    records = _read_records(Path(args.input))
    taxonomy = _taxonomy_categories(Path(args.taxonomy))
    snapshot = build_snapshot(records, taxonomy, version=args.version, column_map=column_map)

    report = snapshot["sync_report"]
    print(json.dumps({"status": snapshot["status"], "rows": len(snapshot["rows"]), "report": report}, ensure_ascii=False, indent=2))
    if report["conflicts"]:
        print("⚠️ 存在跨品类 model_id 冲突，已拒绝升级冲突行，请修正 sheet 后重跑。", file=sys.stderr)
    if args.dry_run:
        return 0
    Path(args.out).write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"written: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

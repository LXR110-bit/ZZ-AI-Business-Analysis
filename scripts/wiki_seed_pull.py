#!/usr/bin/env python3
"""wiki_seed_pull.py — 从飞书 base 拉所有记录，覆盖本地 JSON + 重写 _record_id_map.json。

飞书 base 是 source of truth，本脚本把那边的状态镜像回 git 仓库。

用法：
    python3 scripts/wiki_seed_pull.py                    # 拉全部 4 张表
    python3 scripts/wiki_seed_pull.py 04_definitions     # 只拉某表
    python3 scripts/wiki_seed_pull.py 03_dim_values 04_definitions  # 拉多张

注意：
- 会全量覆盖本地 wiki_seed/*.json。跑之前请 git status 干净，否则会丢未提交改动。
- 不动 wiki_seed/README.md。
- 跑完后用 git diff 看变更、git add + commit 落入版本控制。
"""
from __future__ import annotations

import sys
from pathlib import Path

# 让 import 找到 _wiki_seed_common
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _wiki_seed_common import (  # noqa: E402
    TABLES,
    TableMeta,
    lark_base,
    load_id_map,
    load_json,
    save_id_map,
    save_json,
)


def _extract_items(resp: dict) -> list[dict]:
    """从 lark-cli record-list 返回里抽 items 列表。

    lark-cli 的返回形态可能是 {"items": [...]} 或 {"data": {"items": [...]}}，做兼容。
    """
    if "items" in resp and isinstance(resp["items"], list):
        return resp["items"]
    if "data" in resp and isinstance(resp["data"], dict):
        items = resp["data"].get("items")
        if isinstance(items, list):
            return items
    return []


def _extract_record_id(item: dict) -> str | None:
    """从一条 record dict 里取 record_id."""
    return item.get("record_id") or item.get("id")


def pull_one_table(meta: TableMeta) -> dict[str, str]:
    """拉一张表的所有 records → 写 JSON → 返回 business_id → record_id 映射。

    此阶段 link 字段保留飞书原始 record_id 形态，下一阶段统一翻译回业务 ID。
    """
    resp = lark_base("record-list", {"table-id": meta.table_id, "page-size": 500})
    items = _extract_items(resp)
    if not items:
        print(
            f"  ⚠ {meta.json_name}: record-list 返回空，原始响应前 500 字：{str(resp)[:500]}",
            file=sys.stderr,
        )

    business_records: list[dict] = []
    id_map: dict[str, str] = {}

    for item in items:
        rec_id = _extract_record_id(item)
        fields = item.get("fields", {})

        if not isinstance(fields, dict):
            print(f"  ⚠ {meta.json_name}: record {rec_id} fields 不是 dict，跳过", file=sys.stderr)
            continue

        business_id = fields.get(meta.business_id_field)
        if not business_id:
            print(
                f"  ⚠ {meta.json_name}: record {rec_id} 缺业务主键 {meta.business_id_field}，跳过",
                file=sys.stderr,
            )
            continue

        business_records.append(fields)
        id_map[business_id] = rec_id

    # 按业务主键排序，diff 友好
    business_records.sort(key=lambda r: r.get(meta.business_id_field, ""))
    save_json(meta.json_name, business_records)
    print(f"  ✓ {meta.json_name}: 拉到 {len(business_records)} 条")
    return id_map


def translate_links_in_records(
    records: list[dict],
    meta: TableMeta,
    full_id_map: dict[str, dict[str, str]],
) -> None:
    """把 records 里的 link 字段从 record_id 翻译回业务 ID（in-place）。

    full_id_map: { "01_tables": {"TBL001": "recvxx..."}, "02_fields": {...}, ... }
    需要反向索引：record_id → business_id。
    """
    if not meta.link_fields:
        return

    # 建反向索引：{ target_table: { record_id: business_id } }
    reverse_idx = {
        target: {rid: bid for bid, rid in full_id_map.get(target, {}).items()}
        for target in meta.link_fields.values()
    }

    for rec in records:
        for link_field, target in meta.link_fields.items():
            v = rec.get(link_field)
            if not v:
                continue
            idx = reverse_idx[target]

            # 飞书 link 字段的返回形态有多种：
            # 1) [{"record_ids": ["recxxx", "recyyy"]}]   —— 老 API
            # 2) ["recxxx", "recyyy"]                     —— 直接 record_id 列表
            # 3) "recxxx"                                  —— 单条
            # 4) [{"text": "...", "type": "...", "record_ids": [...]}]  —— 带文本的
            if isinstance(v, list):
                if v and isinstance(v[0], dict):
                    rec_ids = v[0].get("record_ids") or v[0].get("ids") or []
                else:
                    rec_ids = v
                rec[link_field] = [
                    idx.get(rid, f"<unknown:{rid}>") for rid in rec_ids
                ]
            elif isinstance(v, str):
                rec[link_field] = idx.get(v, f"<unknown:{v}>")


def main(argv: list[str]) -> int:
    targets = argv[1:] if len(argv) > 1 else list(TABLES.keys())
    invalid = [t for t in targets if t not in TABLES]
    if invalid:
        print(f"未知表名：{invalid}，可选：{list(TABLES)}", file=sys.stderr)
        return 2

    print(f"将拉取 {len(targets)} 张表：{targets}\n")

    # ── Phase 1：拉 records，收 id_map（link 字段保留 record_id 形态） ──
    full_id_map: dict[str, dict[str, str]] = {}
    for name in targets:
        meta = TABLES[name]
        full_id_map[name] = pull_one_table(meta)

    # ── Phase 2：用收齐的 id_map 翻译 link 字段 ──
    print("\n→ 翻译 link 字段（record_id → 业务 ID）...")
    for name in targets:
        meta = TABLES[name]
        if not meta.link_fields:
            continue
        records = load_json(name)
        translate_links_in_records(records, meta, full_id_map)
        save_json(name, records)
        print(f"  ✓ {name}: link 翻译完成")

    # ── Phase 3：写回 _record_id_map.json（保留没拉的表的 map） ──
    out_map = load_id_map()
    for name in targets:
        out_map[TABLES[name].id_map_key] = full_id_map[name]
    save_id_map(out_map)
    print(f"\n  ✓ _record_id_map.json 已更新（{len(targets)} 张表）")

    print()
    print("=" * 60)
    print("✓ 完成。下一步：")
    print("  1) git diff wiki_seed/        # 看变更")
    print('  2) git add wiki_seed/ && git commit -m "sync(wiki_seed): pull"')
    print("  3) 不满意 → git checkout wiki_seed/")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

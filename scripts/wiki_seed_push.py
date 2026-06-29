#!/usr/bin/env python3
"""wiki_seed_push.py — 本地 JSON → 飞书 base 差量 upsert。

把本地 wiki_seed/*.json 推到飞书 base，行为：
- 业务 ID 在 _record_id_map.json 里有 → record-update
- 新增的（JSON 里有但 map 里没有）→ record-create，把新 record_id 写回 map
- 飞书有但 JSON 里没的 → 不动（永不 delete，最保守）

用法：
    python3 scripts/wiki_seed_push.py --dry-run            # 只打印操作
    python3 scripts/wiki_seed_push.py                       # 真推
    python3 scripts/wiki_seed_push.py 04_definitions       # 只推 04
    python3 scripts/wiki_seed_push.py --dry-run 04         # 组合

跑完后如新建了记录，_record_id_map.json 会更新，记得 git add + commit。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _wiki_seed_common import (  # noqa: E402
    TABLES,
    TableMeta,
    lark_base,
    load_id_map,
    load_json,
    save_id_map,
)


def translate_links_for_push(
    record: dict,
    meta: TableMeta,
    id_map: dict[str, dict[str, str]],
) -> dict:
    """返回新 dict：link 字段从业务 ID 翻译成 record_id 列表。

    入参 record 不修改。

    未知业务 ID → RuntimeError（明确报错，让人先 pull 一次刷 id_map）。
    """
    out = dict(record)
    for link_field, target_table in meta.link_fields.items():
        v = out.get(link_field)
        if not v:
            continue
        target_meta = TABLES[target_table]
        target_map = id_map.get(target_meta.id_map_key, {})

        if isinstance(v, list):
            translated = []
            for biz_id in v:
                rid = target_map.get(biz_id)
                if not rid:
                    raise RuntimeError(
                        f"{meta.json_name}.{link_field} 引用未知业务 ID {biz_id!r} "
                        f"(目标表 {target_table})。建议先跑 wiki_seed_pull.py 刷新 _record_id_map.json。"
                    )
                translated.append(rid)
            out[link_field] = translated
        elif isinstance(v, str):
            rid = target_map.get(v)
            if not rid:
                raise RuntimeError(
                    f"{meta.json_name}.{link_field} 引用未知业务 ID {v!r}"
                )
            out[link_field] = rid
    return out


def push_one_table(
    meta: TableMeta,
    id_map: dict[str, dict[str, str]],
    dry_run: bool = False,
) -> tuple[int, int]:
    """推一张表，返回 (created, updated) 计数."""
    records = load_json(meta.json_name)
    table_map = id_map.setdefault(meta.id_map_key, {})

    created = 0
    updated = 0

    for rec in records:
        biz_id = rec.get(meta.business_id_field)
        if not biz_id:
            print(
                f"  ⚠ {meta.json_name}: 缺业务主键 {meta.business_id_field}，跳过 "
                f"{json.dumps(rec, ensure_ascii=False)[:100]}",
                file=sys.stderr,
            )
            continue

        fields = translate_links_for_push(rec, meta, id_map)
        fields_json = json.dumps(fields, ensure_ascii=False)

        rec_id = table_map.get(biz_id)
        if rec_id:
            if dry_run:
                print(f"  [dry] UPDATE {meta.json_name} {biz_id} → {rec_id}")
            else:
                lark_base("record-update", {
                    "table-id": meta.table_id,
                    "record-id": rec_id,
                    "fields-json": fields_json,
                })
                print(f"  ✓ UPDATE {biz_id} → {rec_id}")
            updated += 1
        else:
            if dry_run:
                print(f"  [dry] CREATE {meta.json_name} {biz_id}")
            else:
                resp = lark_base("record-create", {
                    "table-id": meta.table_id,
                    "fields-json": fields_json,
                })
                # 兼容 lark-cli 返回形态
                new_rid = (
                    resp.get("record_id")
                    or (resp.get("record") or {}).get("record_id")
                    or (resp.get("data") or {}).get("record", {}).get("record_id")
                )
                if not new_rid:
                    raise RuntimeError(
                        f"record-create 没返回 record_id: {json.dumps(resp, ensure_ascii=False)[:500]}"
                    )
                table_map[biz_id] = new_rid
                print(f"  ✓ CREATE {biz_id} → {new_rid}")
            created += 1

    return created, updated


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="wiki_seed JSON → 飞书 base 差量 upsert",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="跑前强烈建议 --dry-run 看一遍",
    )
    parser.add_argument("tables", nargs="*", help="要同步的表名，默认全部 4 张")
    parser.add_argument("--dry-run", action="store_true", help="只打印操作，不真调飞书")
    args = parser.parse_args(argv[1:])

    targets = args.tables or list(TABLES.keys())
    invalid = [t for t in targets if t not in TABLES]
    if invalid:
        print(f"未知表名：{invalid}", file=sys.stderr)
        print(f"可选：{list(TABLES)}", file=sys.stderr)
        return 2

    if args.dry_run:
        print(">>> DRY RUN — 不会真调飞书 <<<\n")
    else:
        print(f"将推 {len(targets)} 张表到飞书 base：{targets}\n")

    id_map = load_id_map()

    total_c = total_u = 0
    for name in targets:
        meta = TABLES[name]
        print(f"→ {name}:")
        c, u = push_one_table(meta, id_map, dry_run=args.dry_run)
        print(f"  小计：created={c}, updated={u}\n")
        total_c += c
        total_u += u

    if not args.dry_run:
        save_id_map(id_map)
        print("─" * 60)
        print(f"✓ 完成。total created={total_c}, updated={total_u}")
        print(f"  _record_id_map.json 已更新（如有新建）")
        print(f"  记得 git add wiki_seed/_record_id_map.json && git commit")
    else:
        print("─" * 60)
        print(f"dry-run 完成。预计 created={total_c}, updated={total_u}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

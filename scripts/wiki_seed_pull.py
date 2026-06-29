#!/usr/bin/env python3
"""wiki_seed_pull.py — 从飞书 base 拉所有记录，merge 到本地 JSON。

飞书 base 是 source of truth，本脚本把那边的状态镜像回 git 仓库。

merge 语义（不是覆盖）：
- 按业务主键（口径ID / 字段ID / ...）匹配本地与飞书记录
- 飞书有的字段 → 用飞书值
- 飞书没有但本地有的字段 → 保留（包括所有以 `_` 开头的本地辅助字段）
- 飞书有但本地没有的记录 → 新增
- 飞书没有但本地有的记录 → 保留（永不删本地数据）

用法：
    python3 scripts/wiki_seed_pull.py                    # 拉全部 4 张表
    python3 scripts/wiki_seed_pull.py 04_definitions     # 只拉某表
    python3 scripts/wiki_seed_pull.py 03_dim_values 04_definitions

注意：
- 跑完后用 git diff 看变更、git add + commit 落入版本控制
- 首次跑可能 diff 巨大（schema 漂移），那是预期，仔细 review
- 4 张表 limit=200 一次拉完；如果 has_more=True 会 assert 失败，
  那时需要在脚本里加分页（用 --offset 或 --limit）
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _wiki_seed_common import (  # noqa: E402
    TABLES,
    TableMeta,
    lark_base,
    load_json,
    save_json,
)


def reconstruct_rows(resp: dict) -> tuple[list[dict], list[str]]:
    """把 lark-cli record-list 的列存响应拼回行存。

    输入形态（lark-cli 1.0.59）::

        {
          "ok": true,
          "data": {
            "data": [[v00, v01, ...], [v10, v11, ...], ...],   # 每行一个 list，列序与 fields 对齐
            "fields": ["维值ID", "责任人", ...],
            "field_id_list": ["fld...", "fld...", ...],
            "record_id_list": ["rec...", "rec...", ...],         # 行存的 record_id，与 data 行平行
            "has_more": false,
            ...
          }
        }

    返回 (rows, record_ids)：
        rows: [{"维值ID": "DIM001", ...}, ...]
        record_ids: ["recvnPEDlDvA8J", ...]

    如果 has_more=True 抛 RuntimeError —— 4 张表 ≤ 200 行（limit 上限），
    超出需要分页支持（未实现）。
    """
    data = resp.get("data") or {}
    rows_raw = data.get("data") or []
    fields = data.get("fields") or []
    record_ids = data.get("record_id_list") or []

    if data.get("has_more"):
        raise RuntimeError(
            f"飞书返回 has_more=True（行数 > limit=200），需要在 pull 脚本里加分页支持。"
            f" 本次拿到 {len(rows_raw)} 行，fields={len(fields)} 列。"
        )

    if len(rows_raw) != len(record_ids):
        raise RuntimeError(
            f"data.data 行数 ({len(rows_raw)}) 与 record_id_list 长度 ({len(record_ids)}) 不一致"
        )

    rows: list[dict] = []
    for row in rows_raw:
        if len(row) != len(fields):
            raise RuntimeError(
                f"行宽 {len(row)} 与 fields 列数 {len(fields)} 不一致：{row[:3]}..."
            )
        rows.append(dict(zip(fields, row)))

    return rows, record_ids


def extract_link_ids(cell_value) -> list[str]:
    """从 link 字段单元格里抽 record_id 列表。

    lark-cli 1.0.59 返回的 link 字段形态::

        [{"id": "recxxx"}, {"id": "recyyy"}]        # 标准
        [{"id": "rec...", "text": "..."}]            # 带显示文本
        []                                           # 空
        null                                         # 也是空

    """
    if not cell_value:
        return []
    if not isinstance(cell_value, list):
        return []
    out = []
    for item in cell_value:
        if isinstance(item, dict) and item.get("id"):
            out.append(item["id"])
        elif isinstance(item, str) and item.startswith("rec"):
            # 兜底：直接是字符串列表
            out.append(item)
    return out


def translate_links_in_records(
    records: list[dict],
    meta: TableMeta,
    full_id_map: dict[str, dict[str, str]],
) -> None:
    """把 records 里的 link 字段从 record_id 翻译回业务 ID（in-place）。

    full_id_map: { "01_tables": {"TBL001": "recxxx"}, "02_fields": {...}, ... }
    需要反向索引：record_id → business_id。

    未知 record_id → "<unknown:recxxx>" 标记，不抛异常。
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
            rec_ids = extract_link_ids(v)
            rec[link_field] = [idx.get(rid, f"<unknown:{rid}>") for rid in rec_ids]


def merge_into_local(
    local: list[dict],
    remote: list[dict],
    business_id_field: str,
) -> list[dict]:
    """按业务主键 merge 飞书 records 进本地 records。

    规则：
    - remote 有的字段 → 用 remote 值（覆盖 local）
    - local 有但 remote 没有的字段 → 保留（包括 `_` 前缀字段、其他 helper）
    - remote 有但 local 没有的记录 → 新增（按业务主键判断）
    - local 有但 remote 没有的记录 → 保留（永不删本地数据）

    返回新列表，按业务主键排序，diff 友好。
    """
    by_biz_id: dict[str, dict] = {}
    for rec in local:
        biz_id = rec.get(business_id_field)
        if biz_id:
            by_biz_id[biz_id] = dict(rec)   # 浅拷贝，避免改原对象

    for rec in remote:
        biz_id = rec.get(business_id_field)
        if not biz_id:
            print(
                f"  ⚠ skip remote record without {business_id_field}: {str(rec)[:120]}",
                file=sys.stderr,
            )
            continue
        existing = by_biz_id.get(biz_id, {})
        # remote 的字段覆盖 local；local 独有字段（如 _*）保留
        merged = {**existing, **rec}
        by_biz_id[biz_id] = merged

    out = list(by_biz_id.values())
    out.sort(key=lambda r: r.get(business_id_field, ""))
    return out


def pull_one_table(meta: TableMeta) -> tuple[list[dict], dict[str, str]]:
    """拉一张表：

    返回 (merged_records, id_map)
      merged_records: 已 merge 进本地（保留 `_*` helper 字段）
      id_map: {business_id → record_id}，用于 link 字段反查
    """
    resp = lark_base("record-list", {"table-id": meta.table_id, "limit": 200})
    rows, record_ids = reconstruct_rows(resp)

    # 收 id_map（用 link 字段反查阶段）+ 准备 remote records
    remote_records: list[dict] = []
    id_map: dict[str, str] = {}
    for row, rid in zip(rows, record_ids):
        biz_id = row.get(meta.business_id_field)
        if not biz_id:
            print(
                f"  ⚠ {meta.json_name}: record {rid} 缺业务主键 {meta.business_id_field}，跳过",
                file=sys.stderr,
            )
            continue
        remote_records.append(row)
        id_map[biz_id] = rid

    # merge 进本地
    try:
        local_records = load_json(meta.json_name)
    except FileNotFoundError:
        local_records = []
    merged = merge_into_local(local_records, remote_records, meta.business_id_field)

    print(
        f"  ✓ {meta.json_name}: 飞书 {len(remote_records)} 条，本地 {len(local_records)} 条 → merged {len(merged)} 条"
    )
    return merged, id_map


def fetch_id_map_only(meta: TableMeta) -> dict[str, str]:
    """只拉一张表的业务 ID → record_id 映射，不 merge 不写盘。

    用于"单表 pull 时为了翻译 link 字段，要顺手拿目标表的 id_map"。
    """
    resp = lark_base(
        "record-list",
        {
            "table-id": meta.table_id,
            "limit": 200,
            "field-id": meta.business_id_field,  # 只投影业务主键，减少负载
        },
    )
    rows, record_ids = reconstruct_rows(resp)
    id_map: dict[str, str] = {}
    for row, rid in zip(rows, record_ids):
        biz_id = row.get(meta.business_id_field)
        if biz_id:
            id_map[biz_id] = rid
    return id_map


def main(argv: list[str]) -> int:
    targets = argv[1:] if len(argv) > 1 else list(TABLES.keys())
    invalid = [t for t in targets if t not in TABLES]
    if invalid:
        print(f"未知表名：{invalid}，可选：{list(TABLES)}", file=sys.stderr)
        return 2

    print(f"将拉取 {len(targets)} 张表：{targets}\n")

    # ── Phase 1：拉所有目标表 + 收 id_map（link 字段保留 record_id 形态）──
    full_id_map: dict[str, dict[str, str]] = {}
    merged_by_table: dict[str, list[dict]] = {}
    for name in targets:
        meta = TABLES[name]
        merged, id_map = pull_one_table(meta)
        merged_by_table[name] = merged
        full_id_map[name] = id_map

    # ── Phase 1.5：单表 pull 时，link 字段指向的目标表如果没拉，补拉 id_map ──
    # 目的：单表 pull (如只 pull 03_dim_values) 也能正确翻译 link 字段
    needed_targets: set[str] = set()
    for name in targets:
        for target in TABLES[name].link_fields.values():
            if target not in full_id_map:
                needed_targets.add(target)
    if needed_targets:
        print(f"\n→ 补拉 link 目标表 id_map（仅投影业务主键）：{sorted(needed_targets)}")
        for target in needed_targets:
            full_id_map[target] = fetch_id_map_only(TABLES[target])
            print(f"  ✓ {target}: 拿到 {len(full_id_map[target])} 个 id 映射")

    # ── Phase 2：用收齐的 id_map 翻译 link 字段（record_id → 业务 ID）──
    print("\n→ 翻译 link 字段...")
    for name in targets:
        meta = TABLES[name]
        if not meta.link_fields:
            continue
        translate_links_in_records(merged_by_table[name], meta, full_id_map)
        print(f"  ✓ {name}: link 翻译完成")

    # ── Phase 3：写回本地 ──
    for name in targets:
        save_json(name, merged_by_table[name])

    print()
    print("=" * 60)
    print("✓ 完成。下一步：")
    print("  1) git diff wiki_seed/        # 看变更")
    print('  2) git add wiki_seed/ && git commit -m "sync(wiki_seed): pull"')
    print("  3) 不满意 → git checkout wiki_seed/")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

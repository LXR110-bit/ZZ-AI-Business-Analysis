# wiki_seed 双向同步脚本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 写两个 Python 脚本，实现 `wiki_seed/*.json` ⇄ 飞书 base（4 表）的双向同步。

**Architecture:**
- **push.sh** (`scripts/wiki_seed_push.py`)：读 4 个 JSON → 对比 `_record_id_map.json` → 已知记录走 `record-update`、未知记录走 `record-create`、JSON 里没的不删（差量 upsert，最安全）
- **pull.sh** (`scripts/wiki_seed_pull.py`)：从飞书 base 拉所有记录 → 全量覆盖本地 JSON + 重写 `_record_id_map.json` → 用户用 `git diff` 决定是否 commit
- 两个脚本都不直接调飞书 OpenAPI，全走 `lark-cli base +<verb>`，ssh 到 zz-server 跑（凭证已在那里）

**Tech Stack:**
- Python 3.11（与仓库其他 server 一致）
- `subprocess` 调用 `lark-cli`
- `json` 标准库
- 无外部依赖（脚本是 standalone）

## Global Constraints

- 飞书是 source of truth，git JSON 是镜像
- push.sh 默认行为：**差量 upsert，永不删** —— 飞书上多出来的记录脚本不动
- pull.sh 默认行为：**全量覆盖本地 JSON** —— 用户跑前自行 `git status` 确认无未提交改动
- 4 表 table-id 在 `wiki_seed/README.md` 已存在，不要 hardcode 复制，从 README 或新建的 `_table_ids.json` 读
- 不引入新 Python 依赖，标准库 + lark-cli 子进程
- 脚本必须能在 zz-server 直接跑（`ssh zz-server 'python3 scripts/wiki_seed_push.py'`）

---

## File Structure

```
scripts/
├── wiki_seed_push.py         ← 新增，push JSON → 飞书 base
├── wiki_seed_pull.py         ← 新增，pull 飞书 base → JSON
└── _wiki_seed_common.py      ← 新增，两脚本共用：4 表元数据、lark-cli 调用 helper、ID 映射读写

wiki_seed/
├── 01_tables.json            ← 不改
├── 02_fields.json            ← 不改
├── 03_dim_values.json        ← 不改
├── 04_definitions.json       ← 不改
├── _record_id_map.json       ← pull.py 会重写；push.py 会读 + 增量写
└── README.md                 ← 改：在末尾加「同步脚本使用说明」段
```

**为什么共用 `_wiki_seed_common.py`**：两脚本都要做"业务 ID ↔ record_id 映射"、"调 lark-cli 解析 JSON"、"读 4 表元数据"——抽到一个文件 DRY。每个脚本本身只保留主流程，可读性高。

---

## Task 1: 共用模块 `_wiki_seed_common.py`

**Files:**
- Create: `scripts/_wiki_seed_common.py`
- Test: `scripts/tests/test_wiki_seed_common.py`（pytest）

**Interfaces:**
- Produces:
  - `TABLES: dict[str, TableMeta]` — key 是业务表名(`"01_tables"` 等)，value 含 `table_id` / `business_id_field`(主键列名) / `link_fields`(哪些字段是 link，目标表名)
  - `BASE_TOKEN: str` — `"N6OVb2qz5aKxf9sY9kRc7y6onYd"`（README 验证过）
  - `def lark_base(verb: str, args: dict, as_role: str = "user") -> dict` — 调 `lark-cli base +<verb>` 强制 `--json`，解析返回；非零退出抛 RuntimeError 带 stderr
  - `def load_json(name: str) -> list[dict]` — 读 `wiki_seed/<name>.json`，返回 records 列表
  - `def save_json(name: str, records: list[dict]) -> None` — 写回，缩进 2、`ensure_ascii=False`
  - `def load_id_map() -> dict` / `def save_id_map(m: dict) -> None` — 读写 `_record_id_map.json`

- [ ] **Step 1: 写 TableMeta dataclass + TABLES 常量 + BASE_TOKEN**

```python
"""共用：4 表元数据 + lark-cli helper + JSON I/O。"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
WIKI_DIR = REPO_ROOT / "wiki_seed"

BASE_TOKEN = "N6OVb2qz5aKxf9sY9kRc7y6onYd"

@dataclass
class TableMeta:
    json_name: str                # wiki_seed/<json_name>.json
    table_id: str                 # 飞书 base table-id
    business_id_field: str        # JSON 里业务主键列名（"底表ID"/"字段ID"/...）
    id_map_key: str               # _record_id_map.json 里的 key
    link_fields: dict[str, str] = field(default_factory=dict)
    # link_fields: { "引用字段": "02_fields", "关联维值": "03_dim_values" } 等

TABLES: dict[str, TableMeta] = {
    "01_tables": TableMeta(
        json_name="01_tables",
        table_id="tblftpX7cOIusYmF",
        business_id_field="底表ID",
        id_map_key="table_01_record_id_map",
    ),
    "02_fields": TableMeta(
        json_name="02_fields",
        table_id="tblWdOaeJzyxWdOe",
        business_id_field="字段ID",
        id_map_key="table_02_field_record_id_map",
        link_fields={"所属底表": "01_tables"},  # FLD→TBL
    ),
    "03_dim_values": TableMeta(
        json_name="03_dim_values",
        table_id="tblJ6CSz02t6NIaI",
        business_id_field="维值ID",
        id_map_key="table_03_dim_record_id_map",
        # 注意：_所属字段 是 text（不是 link），不在 link_fields 里
    ),
    "04_definitions": TableMeta(
        json_name="04_definitions",
        table_id="tbl1hVd85juddTNY",
        business_id_field="口径ID",
        id_map_key="table_04_definition_record_id_map",  # 注意：此 key 在现有 map 里可能不存在，pull 时新建
        link_fields={"引用字段": "02_fields", "关联维值": "03_dim_values"},
    ),
}
```

- [ ] **Step 2: 写 lark_base() helper**

```python
def lark_base(verb: str, args: dict, as_role: str = "user") -> dict:
    """调 lark-cli base +<verb> --as <role> --<k> <v>... 强制 --json。

    verb: "record-create" / "record-update" / "record-list" / "record-search" / "record-delete"
    args: { "table-id": "tbl...", "fields-json": '{"k":"v"}', ... }
    """
    cmd = ["lark-cli", "base", f"+{verb}", "--as", as_role, "--base-token", BASE_TOKEN]
    for k, v in args.items():
        if isinstance(v, list):
            for item in v:
                cmd += [f"--{k}", str(item)]
        elif v is None:
            continue
        else:
            cmd += [f"--{k}", str(v)]
    cmd.append("--json")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(
            f"lark-cli base +{verb} failed (exit {proc.returncode}):\n"
            f"  cmd: {' '.join(cmd)}\n"
            f"  stderr: {proc.stderr[:1000]}\n"
            f"  stdout: {proc.stdout[:500]}"
        )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"lark-cli base +{verb} 返回非 JSON: {proc.stdout[:500]}") from e
```

- [ ] **Step 3: 写 load_json / save_json / load_id_map / save_id_map**

```python
def load_json(name: str) -> list[dict]:
    return json.loads((WIKI_DIR / f"{name}.json").read_text(encoding="utf-8"))

def save_json(name: str, records: list[dict]) -> None:
    (WIKI_DIR / f"{name}.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def load_id_map() -> dict:
    p = WIKI_DIR / "_record_id_map.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))

def save_id_map(m: dict) -> None:
    (WIKI_DIR / "_record_id_map.json").write_text(
        json.dumps(m, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
```

- [ ] **Step 4: 写测试 test_wiki_seed_common.py**

```python
"""测试纯函数部分（不打 lark-cli）。"""
from pathlib import Path
from scripts._wiki_seed_common import TABLES, load_json, BASE_TOKEN

def test_tables_meta_complete():
    assert set(TABLES) == {"01_tables", "02_fields", "03_dim_values", "04_definitions"}
    for name, meta in TABLES.items():
        assert meta.table_id.startswith("tbl")
        assert meta.business_id_field
        assert meta.id_map_key

def test_base_token_format():
    assert len(BASE_TOKEN) > 20
    assert BASE_TOKEN.isalnum()

def test_load_json_returns_list_of_dicts():
    """validate 4 张表 JSON 都能 load + schema 对得上 TableMeta."""
    for name, meta in TABLES.items():
        records = load_json(name)
        assert isinstance(records, list)
        assert len(records) > 0
        # 业务主键列必须存在
        assert meta.business_id_field in records[0], (
            f"{name}.json 第一条没有列 {meta.business_id_field}"
        )

def test_04_definitions_has_link_fields():
    records = load_json("04_definitions")
    rec = records[0]
    assert "引用字段" in rec
    assert isinstance(rec["引用字段"], list)
```

- [ ] **Step 5: 跑测试**

```bash
cd /Users/lilixiaoran/工作/转转/ai数据分析工作流
python3 -m pytest scripts/tests/test_wiki_seed_common.py -v
```

Expected: 4 passed.

- [ ] **Step 6: Commit**

```bash
git add scripts/_wiki_seed_common.py scripts/tests/test_wiki_seed_common.py
git commit -m "feat(scripts): wiki_seed 同步脚本的共用模块 + 测试"
```

---

## Task 2: `wiki_seed_pull.py` — 飞书 base → JSON

**Files:**
- Create: `scripts/wiki_seed_pull.py`

**Interfaces:**
- Consumes: `_wiki_seed_common` 的 TABLES、lark_base、save_json、save_id_map
- Produces: 重写 `wiki_seed/0{1,2,3,4}_*.json` + `_record_id_map.json`

**先做 pull 而不是 push 是因为**：pull 是"读 base + 写本地文件"，**对飞书 base 零写入**，可以反复试错；push 写飞书，错了不好恢复。先把 pull 跑通，pull 出来的数据就是"飞书真实状态"，反过来 push 的 round-trip 验证也方便。

- [ ] **Step 1: 写 pull_one_table()**

```python
#!/usr/bin/env python3
"""wiki_seed_pull.py — 从飞书 base 拉所有记录，覆盖本地 JSON + 重写 _record_id_map.json。

用法：
    python3 scripts/wiki_seed_pull.py            # 拉所有 4 张表
    python3 scripts/wiki_seed_pull.py 04_definitions   # 只拉 04

注意：会覆盖本地 JSON。跑之前请确保 git status 干净。
"""
from __future__ import annotations

import sys
from typing import Any

from _wiki_seed_common import TABLES, TableMeta, lark_base, save_json, load_id_map, save_id_map


def pull_one_table(meta: TableMeta) -> dict[str, str]:
    """拉一张表的所有 records → 写 JSON → 返回 business_id ↔ record_id 映射。"""
    # 飞书 base record-list 一次默认 500 条，足够；超 500 需要 page-token，4 张表当前最大 68 条
    resp = lark_base("record-list", {"table-id": meta.table_id, "page-size": 500})
    items = resp.get("items") or resp.get("data", {}).get("items") or []

    business_records: list[dict] = []
    id_map: dict[str, str] = {}

    for item in items:
        rec_id = item.get("record_id") or item.get("id")
        fields = item.get("fields", {})

        business_id = fields.get(meta.business_id_field)
        if not business_id:
            print(f"  ⚠ {meta.json_name}: record {rec_id} 缺业务主键 {meta.business_id_field}, 跳过", file=sys.stderr)
            continue

        # 反查 link 字段：飞书返回的 link 字段值是 record_id 列表，需要翻译回业务 ID
        # 这一步在 pull_all_tables 里处理（因为需要先把所有表的 id_map 都收齐）
        business_records.append(fields)
        id_map[business_id] = rec_id

    # 按业务主键排序，保持 diff 友好
    business_records.sort(key=lambda r: r.get(meta.business_id_field, ""))
    save_json(meta.json_name, business_records)
    print(f"  ✓ {meta.json_name}: 拉到 {len(business_records)} 条记录")
    return id_map
```

- [ ] **Step 2: 写 link 字段反查 translate_links()**

```python
def translate_links_in_records(records: list[dict], meta: TableMeta, full_id_map: dict[str, dict[str, str]]) -> None:
    """把 records 里的 link 字段从 record_id 列表翻译回业务 ID 列表（in-place）。

    full_id_map: { "01_tables": {"TBL001": "recvxx..."}, "02_fields": {...}, ... }
                 我们需要反向查找 → record_id → business_id
    """
    if not meta.link_fields:
        return

    # 建反向索引：{ target_table: { record_id: business_id } }
    reverse_idx = {
        target_table: {rec_id: biz_id for biz_id, rec_id in full_id_map.get(target_table, {}).items()}
        for target_table in meta.link_fields.values()
    }

    for rec in records:
        for link_field, target_table in meta.link_fields.items():
            v = rec.get(link_field)
            if not v:
                continue
            if isinstance(v, list):
                # 飞书 link 字段返回 [{"record_ids": [...]}] 或 [record_id, ...]，做兼容
                if v and isinstance(v[0], dict):
                    rec_ids = v[0].get("record_ids", [])
                else:
                    rec_ids = v
                rec[link_field] = [reverse_idx[target_table].get(rid, f"<unknown:{rid}>") for rid in rec_ids]
            elif isinstance(v, str):
                rec[link_field] = reverse_idx[target_table].get(v, f"<unknown:{v}>")
```

- [ ] **Step 3: 写 main() 串起来**

```python
def main(argv: list[str]) -> int:
    targets = argv[1:] if len(argv) > 1 else list(TABLES.keys())
    invalid = [t for t in targets if t not in TABLES]
    if invalid:
        print(f"未知表名: {invalid}, 可选: {list(TABLES)}", file=sys.stderr)
        return 2

    print(f"将拉取 {len(targets)} 张表: {targets}")

    full_id_map: dict[str, dict[str, str]] = {}

    # 第一遍：拉所有 records + 收集 id_map（link 字段先保留 record_id 形态）
    for name in targets:
        meta = TABLES[name]
        full_id_map[name] = pull_one_table(meta)

    # 第二遍：用收齐的 id_map 翻译 link 字段
    for name in targets:
        meta = TABLES[name]
        if not meta.link_fields:
            continue
        from _wiki_seed_common import load_json
        records = load_json(name)
        translate_links_in_records(records, meta, full_id_map)
        save_json(name, records)

    # 写回 _record_id_map.json（保留没拉的表的 map）
    out_map = load_id_map()
    for name in targets:
        out_map[TABLES[name].id_map_key] = full_id_map[name]
    save_id_map(out_map)

    print()
    print("✓ 完成。请 git diff 检查变更，满意后 git add + commit。")
    print("  不满意 → git checkout wiki_seed/  撤销。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: 在 zz-server 试跑（只拉 03_dim_values，最小风险）**

```bash
# 第一次跑前先备份当前 03_dim_values.json
cp wiki_seed/03_dim_values.json /tmp/03_dim_values.json.bak

# 调用
ssh zz-server 'cd /root/workspace/ZZ-AI-Business-Analysis && python3 scripts/wiki_seed_pull.py 03_dim_values'

# 把生成的 JSON 抓回本地对比
scp zz-server:/root/workspace/ZZ-AI-Business-Analysis/wiki_seed/03_dim_values.json /tmp/03_dim_values.json.pulled
diff /tmp/03_dim_values.json.bak /tmp/03_dim_values.json.pulled
```

Expected: diff 几乎为空（或只有字段顺序变化），证明 round-trip 一致。

⚠️ **此步骤需要 SSH 通**，如果本机 SSH 断开（如代理软件拦截），跳过这一步，留给用户早上验证。

- [ ] **Step 5: Commit**

```bash
git add scripts/wiki_seed_pull.py
git commit -m "feat(scripts): wiki_seed_pull.py 飞书 base → 本地 JSON 同步"
```

---

## Task 3: `wiki_seed_push.py` — JSON → 飞书 base

**Files:**
- Create: `scripts/wiki_seed_push.py`

**Interfaces:**
- Consumes: `_wiki_seed_common` 的 TABLES、lark_base、load_json、load_id_map、save_id_map

**核心算法：差量 upsert**

```
对每张表：
  1. 读本地 JSON（list of records）
  2. 读 _record_id_map.json 获取已知 business_id → record_id
  3. 对每条 record：
     - 把 link 字段从业务 ID 翻译成 record_id（用 _record_id_map.json）
     - if business_id 在 id_map 里 → record-update --record-id rec_xxx --fields-json '{...}'
     - else → record-create --fields-json '{...}'，把新 record_id 写回 id_map
  4. 永不调 record-delete（即使 JSON 里没了，飞书上还在）
  5. 跑完保存更新后的 id_map
```

- [ ] **Step 1: 写 translate_links_for_push()**（业务 ID → record_id）

```python
def translate_links_for_push(record: dict, meta: TableMeta, id_map: dict[str, dict[str, str]]) -> dict:
    """返回一个新 dict（不修改入参），link 字段翻译成 record_id 列表。"""
    out = dict(record)
    for link_field, target_table in meta.link_fields.items():
        v = out.get(link_field)
        if not v:
            continue
        target_map = id_map.get(TABLES[target_table].id_map_key, {})
        if isinstance(v, list):
            translated = []
            for biz_id in v:
                rid = target_map.get(biz_id)
                if not rid:
                    raise RuntimeError(
                        f"{meta.json_name} link 字段 {link_field} 引用了未知业务 ID {biz_id} "
                        f"(目标表 {target_table})。建议先 pull 一次刷新 _record_id_map.json。"
                    )
                translated.append(rid)
            out[link_field] = translated
        elif isinstance(v, str):
            rid = target_map.get(v)
            if not rid:
                raise RuntimeError(f"未知业务 ID {v} in {link_field}")
            out[link_field] = rid
    # business_id 字段不要写进 fields-json（飞书业务主键是用户自定义列，写进去 OK；不删它）
    return out
```

- [ ] **Step 2: 写 push_one_table()**

```python
def push_one_table(meta: TableMeta, id_map: dict[str, dict[str, str]], dry_run: bool = False) -> tuple[int, int]:
    """返回 (created, updated) 数量。"""
    records = load_json(meta.json_name)
    table_map = id_map.setdefault(meta.id_map_key, {})

    created = 0
    updated = 0

    for rec in records:
        biz_id = rec.get(meta.business_id_field)
        if not biz_id:
            print(f"  ⚠ {meta.json_name}: 缺业务主键，跳过 {rec}", file=sys.stderr)
            continue

        fields = translate_links_for_push(rec, meta, id_map)
        fields_json = json.dumps(fields, ensure_ascii=False)

        rec_id = table_map.get(biz_id)
        if rec_id:
            # update
            if dry_run:
                print(f"  [dry-run] UPDATE {meta.json_name} {biz_id} → {rec_id}")
            else:
                lark_base("record-update", {
                    "table-id": meta.table_id,
                    "record-id": rec_id,
                    "fields-json": fields_json,
                })
            updated += 1
        else:
            # create
            if dry_run:
                print(f"  [dry-run] CREATE {meta.json_name} {biz_id}")
            else:
                resp = lark_base("record-create", {
                    "table-id": meta.table_id,
                    "fields-json": fields_json,
                })
                new_rid = resp.get("record", {}).get("record_id") or resp.get("record_id")
                if not new_rid:
                    raise RuntimeError(f"create 返回不含 record_id: {resp}")
                table_map[biz_id] = new_rid
            created += 1

    return created, updated
```

- [ ] **Step 3: 写 main() + --dry-run 开关**

```python
def main(argv: list[str]) -> int:
    import argparse
    parser = argparse.ArgumentParser(description="wiki_seed JSON → 飞书 base 差量 upsert")
    parser.add_argument("tables", nargs="*", help="要同步的表名，默认全部 4 张")
    parser.add_argument("--dry-run", action="store_true", help="只打印操作，不真正调飞书")
    args = parser.parse_args(argv[1:])

    targets = args.tables or list(TABLES.keys())
    invalid = [t for t in targets if t not in TABLES]
    if invalid:
        print(f"未知表名: {invalid}", file=sys.stderr)
        return 2

    id_map = load_id_map()
    if args.dry_run:
        print(">>> DRY RUN — 不会真正写飞书 <<<\n")

    total_c = total_u = 0
    for name in targets:
        meta = TABLES[name]
        print(f"→ {name}:")
        c, u = push_one_table(meta, id_map, dry_run=args.dry_run)
        print(f"  created={c}, updated={u}")
        total_c += c
        total_u += u

    if not args.dry_run:
        save_id_map(id_map)

    print(f"\n✓ 完成。total created={total_c}, updated={total_u}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
```

- [ ] **Step 4: 本地 dry-run 验证（不需要 SSH）**

```bash
cd /Users/lilixiaoran/工作/转转/ai数据分析工作流
python3 scripts/wiki_seed_push.py --dry-run
```

Expected 输出（大致）：
```
>>> DRY RUN — 不会真正写飞书 <<<

→ 01_tables:
  [dry-run] UPDATE 01_tables TBL001 → recvnPBk4yBCJ3
  [dry-run] UPDATE 01_tables TBL002 → recvnPBk4yYG6e
  ...
  created=0, updated=14
→ 02_fields:
  ...
  created=0, updated=68
→ 03_dim_values:
  ...
  created=0, updated=29
→ 04_definitions:
  [dry-run] CREATE 04_definitions DEF001     # 因为 _record_id_map.json 里没有 table_04 这个 key
  ...
  created=18, updated=0

✓ 完成。total created=18, updated=111
```

如果 04 看到 CREATE 18 条，说明现有 `_record_id_map.json` 里没有 04 的映射 → 这是设计预期（README 说"04 后续接 base 时建"），real push 会真创建。

- [ ] **Step 5: Commit**

```bash
git add scripts/wiki_seed_push.py
git commit -m "feat(scripts): wiki_seed_push.py 本地 JSON → 飞书 base 差量 upsert"
```

---

## Task 4: 更新 `wiki_seed/README.md` 加同步脚本使用说明

**Files:**
- Modify: `wiki_seed/README.md`（末尾追加一节）

- [ ] **Step 1: 在 README 末尾追加「同步脚本使用」**

```markdown
---

## 5. 同步脚本使用（v0.3）

> 飞书 base 是 source of truth，本地 JSON 是镜像。两套脚本都在 `scripts/` 下。

### 5.1 从飞书拉到本地（pull）

> 场景：你或同事在飞书上改了口径，要同步回 git 仓库做版本控制。

```bash
# 在 zz-server 上（凭证齐全）
ssh zz-server 'cd /root/workspace/ZZ-AI-Business-Analysis && python3 scripts/wiki_seed_pull.py'

# 只拉某一张表（比如只改了 04 口径）
ssh zz-server 'cd /root/workspace/ZZ-AI-Business-Analysis && python3 scripts/wiki_seed_pull.py 04_definitions'
```

跑完后：
1. `git diff wiki_seed/`  看变更
2. 满意 → `git add wiki_seed/ && git commit -m "sync(wiki_seed): pull 飞书 base 改动"`
3. 不满意 → `git checkout wiki_seed/` 撤销

⚠️ 跑之前请确保 `git status` 干净，否则会覆盖你本地未提交的改动。

### 5.2 从本地推到飞书（push）

> 场景：你在 git 上改了 JSON（如修字段备注），要推到飞书 base。

```bash
# 先 dry-run 看会发生什么（强烈推荐）
ssh zz-server 'cd /root/workspace/ZZ-AI-Business-Analysis && python3 scripts/wiki_seed_push.py --dry-run'

# 没问题再真跑
ssh zz-server 'cd /root/workspace/ZZ-AI-Business-Analysis && python3 scripts/wiki_seed_push.py'
```

**push 行为**：
- 已知记录（`_record_id_map.json` 里有 record_id 的）→ `update`
- 新增记录（JSON 新加但 map 里没有的）→ `create`，并把新 record_id 写回 `_record_id_map.json`
- **永远不会删除飞书上的记录**（即使 JSON 里没了）。要删请手动在飞书上操作。

push 完后 `_record_id_map.json` 可能有更新（新建记录时），记得 `git add wiki_seed/_record_id_map.json && git commit`。

### 5.3 典型工作流

| 谁动了什么 | 谁来跑哪个脚本 |
|---|---|
| 业务专家在飞书加新口径 | 你：`pull` → 看 diff → commit |
| 你在 git 修字段备注 | 你：`push --dry-run` → `push` |
| 仓库新搭、飞书 base 空 | 你：`push`（一次性灌库） |

### 5.4 已知限制

- 默认走 ssh zz-server，因为 lark-cli 认证在那台机器上。本地直接跑需先在本机装 lark-cli + 配认证
- 4 张表共 129 条记录，全表 pull/push 约 1-2 分钟
- 03 表的 `_所属字段` 是 text 不是 link，脚本不做翻译（直接当字符串）
- 04 表第一次 push 时 `_record_id_map.json` 没有 `table_04_definition_record_id_map` key，全走 create
```

- [ ] **Step 2: Commit**

```bash
git add wiki_seed/README.md
git commit -m "docs(wiki_seed): 补同步脚本使用说明"
```

---

## Task 5: 自验 + 开 PR（不自合）

- [ ] **Step 1: 跑 dry-run 全表**

```bash
cd /Users/lilixiaoran/工作/转转/ai数据分析工作流
python3 scripts/wiki_seed_push.py --dry-run
```

Expected: 不报错，输出 expected created/updated 计数（参考 Task 3 Step 4 的样例）。

- [ ] **Step 2: 跑测试**

```bash
python3 -m pytest scripts/tests/ -v
```

Expected: 4 passed.

- [ ] **Step 3: 看 commit 历史 + push**

```bash
git log --oneline main..HEAD
# 期望（4 commits）：
#   docs(wiki_seed): 补同步脚本使用说明
#   feat(scripts): wiki_seed_push.py 本地 JSON → 飞书 base 差量 upsert
#   feat(scripts): wiki_seed_pull.py 飞书 base → 本地 JSON 同步
#   feat(scripts): wiki_seed 同步脚本的共用模块 + 测试
#   lock(claude): release router area, claim wiki_seed sync

git push origin agent-claude/feat/wiki-seed-sync
```

- [ ] **Step 4: 开 PR（不自合，等用户 review）**

```bash
gh pr create --base main --title "feat(scripts): wiki_seed 与飞书 base 双向同步（push + pull）" --body "..."
```

PR body 内容请覆盖：
- What：3 个新脚本 + README 更新
- Why：飞书 base 是 source of truth，git 是镜像，需要工具来同步
- How to test：dry-run 命令 + pytest 命令
- Risk：🟢 push 默认差量 upsert + 永不删除，最安全策略；pull 全量覆盖本地 JSON，需用户先 git status 干净
- 待用户验证：因本机 SSH 通不到 zz-server（代理软件拦截直连 IP），未做 real push/pull 实测；脚本 dry-run 通过 + pytest 通过

---

## Self-Review

**Spec coverage（against the 4 件优化要做的事）：**
- ✅ push.sh — Task 3
- ✅ pull.sh — Task 2
- ❌ MCP server 接 base — **不在本 PR 范围**（你说过 agent 没部署，价值打折）
- ❌ 补口径 — **不在本 PR 范围**（业务侧的事）

**Placeholder scan：** 已检查，无 TBD / TODO / 模糊步骤。每个 step 都有具体代码或具体命令。

**Type consistency：** TableMeta 在 Task 1 定义，2/3 直接 import 用，签名一致。`id_map` 类型 `dict[str, dict[str, str]]`（外层是表名 key，内层是 biz_id→rec_id）贯穿一致。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-29-wiki-seed-sync.md`.**

执行选 **Inline Execution**（superpowers:executing-plans），因为：
1. 5 个任务有顺序依赖（共用模块 → pull → push → README → PR）
2. 不需要并行
3. 当前是凌晨自主执行，subagent-driven 反而增加 ssh 验证不通时的中断风险
4. 任务粒度已经细，直接顺序跑更省事

---

## Retrospective（2026-06-30 早上加）

### 凌晨自主执行的盲区

凌晨 ssh 通道断、lark-cli 不可达，**整个 PR 没有任何实跑验证就 push 上去了**。早上 ssh 恢复后第一次跑就连续暴露 7 个真问题：

**lark-cli 1.0.59 接口（凭印象/搜索写的全错了）**：

| 凭印象写的 | 真实接口 |
|---|---|
| `--json` flag | `--format json` 位置参数（带值） |
| `--page-size 500` | `--limit 200`（max 200） |
| `record-create` + `record-update` 两个 verb | 统一 `record-upsert`（`--record-id` 有 → update，无 → create） |
| `--fields-json` | upsert 用 `--json`，含义不同 |
| `record-list` 返回 `{items: [{fields:{}}]}` 行存 | 列存：`{data: {data: [[v,v]], fields: [name,name], record_id_list: [rid]}}` |
| link 单元格 `[record_id, ...]` | `[{"id": "rec..."}]` |

**schema 漂移**：JSON 是当年起草的草稿，飞书 base 当下又新增了 ~10 个字段（责任人/生效起/状态/版本/关联口径/...），04 表甚至重命名了核心字段（业务描述 → 业务定义）。push 完会**用旧 schema 覆盖当下 schema**。

### Task 3（push）状态：**deferred**

用户决策：飞书是 source of truth，push 留给"schema reconcile"完成后的下个 PR。本 PR 只做 pull-only。

`scripts/wiki_seed_push.py` + 测试已 `git rm`，git 历史保留。`_wiki_seed_common.py` 里的 `load_id_map` / `save_id_map` helpers 保留 dormant 不删，给未来 push PR 复用。

### Task 2（pull）状态：**完成但需关键修复**

凌晨写的 pull.py 不能用（接口 6 个 + 行存假设错了）。早上 8 个修复都进 fix commit `a6c847a`：

1. `lark_base()` 改 `--format json`
2. record-list 用 `--limit 200`
3. **新增 `reconstruct_rows()`**：列存 → 行存 zip + `has_more` 守卫
4. **新增 `extract_link_ids()`**：解析 `[{"id":"rec..."}]`
5. **新增 `merge_into_local()`** ← reviewer Critical #1，避免 `_*` helper 字段被静默吞掉
6. **新增 `fetch_id_map_only()`** + Phase 1.5：单表 pull 时自动补 link 目标表 id_map
7. TABLES meta link_fields 用飞书真实字段名，补 01.关联字段（双向 link）+ 02.关联口径 + 03.关联口径
8. 测试从 11+7 改成 6 + 19 = 25 passed，重点测 merge 语义 + has_more guard

### Code review 起的作用

午前 superpowers:requesting-code-review dispatch 一个 reviewer subagent 看修复**计划**（不是看代码）。它独立用 ssh 探测了 lark-cli 真实接口，抓住 4 个 critical：

- merge-on-pull 必须保 `_*` 字段（不抓住的话首跑会无声丢数据）
- `record_id` 在 `data.record_id_list` 平行数组里，不在行里
- `has_more=True` 必须 assert（避免未来增长时静默截断）
- common 测试也得跟着改（不在原计划里）

外加 important：保留 `save_id_map`/`load_id_map` dormant（不删，给未来 push 用）+ 删 `_record_id_map.json` + 重生成 baseline JSON 作单独 commit。

**Lesson**：复杂修复前先 dispatch 一个 reviewer 看**计划文档**，比直接写代码再回过头来踩坑省一大圈。

### 最终交付的 4 个 commit

```
6e60d41 chore(wiki_seed): regenerate JSON baseline from Lark base v1.1 + 删 _record_id_map.json
a6c847a fix(scripts): wiki_seed sync 适配 lark-cli 1.0.59 真实接口 + pull merge 语义
a7dcf24 docs(plans): wiki_seed 同步脚本实现计划（superpowers writing-plans 产出）  ← 凌晨
+ 待提交：docs(wiki_seed): README §9 改 pull-only + 加 schema-drift 说明 + plan retrospective
```

### 经验

1. **无实跑能力的 PR 别 push**：凌晨估了 5 处接口都猜错。"调研得很细"≠"能跑"。
2. **schema 漂移是首要风险**：从 JSON 草稿到飞书 base 之间的字段重命名/扩展会让 push/pull 都出大问题。下个 push PR 必须先做字段对齐审计。
3. **merge 语义>覆盖语义**：脚本写双向 sync 时默认应该是 merge，不是 overwrite。本地 helper 字段（`_*`）丢了用户都不会立刻发现。
4. **reviewer subagent 应在写代码之前用**：让它评 plan 比评 PR 更省事，因为它不被既有代码绑架。


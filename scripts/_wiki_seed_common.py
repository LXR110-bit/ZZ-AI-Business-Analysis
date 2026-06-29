"""wiki_seed 同步脚本的共用模块。

4 张表的元数据 + lark-cli 子进程调用 helper + JSON I/O。

push/pull 两个脚本都依赖这里的常量和函数。
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
WIKI_DIR = REPO_ROOT / "wiki_seed"

# 飞书 base token，在 wiki_seed/README.md 已记录
BASE_TOKEN = "N6OVb2qz5aKxf9sY9kRc7y6onYd"


@dataclass
class TableMeta:
    """4 张表的元数据."""
    json_name: str                            # wiki_seed/<json_name>.json
    table_id: str                             # 飞书 base table-id
    business_id_field: str                    # JSON 业务主键列名
    id_map_key: str                           # _record_id_map.json 顶层 key
    link_fields: dict[str, str] = field(default_factory=dict)
    # link_fields: { JSON 列名: 目标表的 json_name }


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
        link_fields={"所属底表": "01_tables"},
    ),
    "03_dim_values": TableMeta(
        json_name="03_dim_values",
        table_id="tblJ6CSz02t6NIaI",
        business_id_field="维值ID",
        id_map_key="table_03_dim_record_id_map",
        # _所属字段 是 text（不是 link），脚本当字符串处理，不在 link_fields 里
    ),
    "04_definitions": TableMeta(
        json_name="04_definitions",
        table_id="tbl1hVd85juddTNY",
        business_id_field="口径ID",
        id_map_key="table_04_definition_record_id_map",
        link_fields={"引用字段": "02_fields", "关联维值": "03_dim_values"},
    ),
}


def lark_base(verb: str, args: dict, as_role: str = "user") -> dict:
    """调 lark-cli base +<verb> --as <role> ... --json，解析返回。

    verb: "record-create" / "record-update" / "record-list" / "record-search" / "record-delete"
    args: { "table-id": "tbl...", "fields-json": '{"k":"v"}', "page-size": 500, ... }
          list 值会展开成多次 --key value（如多个 --field-id）

    非零退出 → RuntimeError 带 stderr/stdout 上下文。
    """
    cmd = ["lark-cli", "base", f"+{verb}", "--as", as_role, "--base-token", BASE_TOKEN]
    for k, v in args.items():
        if v is None:
            continue
        if isinstance(v, list):
            for item in v:
                cmd += [f"--{k}", str(item)]
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
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"lark-cli base +{verb} 返回非 JSON: {proc.stdout[:500]}"
        ) from exc


def load_json(name: str) -> list[dict]:
    """读 wiki_seed/<name>.json，返回 records 列表."""
    return json.loads((WIKI_DIR / f"{name}.json").read_text(encoding="utf-8"))


def save_json(name: str, records: list[dict]) -> None:
    """写回 wiki_seed/<name>.json，缩进 2、保留中文."""
    (WIKI_DIR / f"{name}.json").write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def load_id_map() -> dict:
    """读 _record_id_map.json，不存在返回空 dict."""
    p = WIKI_DIR / "_record_id_map.json"
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8"))


def save_id_map(m: dict) -> None:
    """写回 _record_id_map.json."""
    (WIKI_DIR / "_record_id_map.json").write_text(
        json.dumps(m, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

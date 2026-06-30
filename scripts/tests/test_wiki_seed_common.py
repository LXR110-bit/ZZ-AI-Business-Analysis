"""scripts/_wiki_seed_common.py 的纯函数测试。

不调用 lark-cli，只测元数据 + JSON I/O 行为。

设计目标：标准库可跑（不强依赖 pytest），用法：
    python3 scripts/tests/test_wiki_seed_common.py         # 直接跑
    python3 -m pytest scripts/tests/                       # 也兼容 pytest

退出码 0 = 全 pass，1 = 至少一个 fail。
"""
from __future__ import annotations

import sys
from pathlib import Path

# 让 import 能找到 scripts/ 下的模块（它不是 package）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _wiki_seed_common import BASE_TOKEN, TABLES, load_id_map, load_json  # noqa: E402


def test_tables_meta_complete():
    """4 张表都注册了，元数据格式正确."""
    assert set(TABLES) == {
        "01_tables", "02_fields", "03_dim_values", "04_definitions"
    }
    for name, meta in TABLES.items():
        assert meta.table_id.startswith("tbl"), f"{name} table_id 不像飞书 ID: {meta.table_id}"
        assert meta.business_id_field, f"{name} 缺业务主键列名"
        assert meta.id_map_key, f"{name} 缺 id_map_key"
        assert isinstance(meta.link_fields, dict)


def test_base_token_format():
    """飞书 base token 是 22 字符英数字."""
    assert len(BASE_TOKEN) >= 20
    assert BASE_TOKEN.isalnum()


def test_load_json_returns_list_of_dicts():
    """4 张表都能 load，且业务主键列存在."""
    for name, meta in TABLES.items():
        records = load_json(name)
        assert isinstance(records, list), f"{name} 顶层不是 list"
        assert len(records) > 0, f"{name} 是空表"
        assert isinstance(records[0], dict)
        assert meta.business_id_field in records[0], (
            f"{name}.json 第一条没有列 {meta.business_id_field}"
        )


def test_04_definitions_has_link_fields():
    """04 表的 link 字段（引用字段/关联维值）是 list."""
    records = load_json("04_definitions")
    rec = records[0]
    assert "引用字段" in rec
    assert isinstance(rec["引用字段"], list)
    # 至少 DEF001 应该引用 FLD006
    assert any("FLD" in str(x) for x in rec["引用字段"])


def test_id_map_dormant_helpers_callable():
    """pull-only 模式下 _record_id_map.json 可能不存在；helpers 仍应可调用。

    load_id_map(): 文件存在 → 返回 dict；不存在 → 返回 {}。
    （v1.1 删了 _record_id_map.json，留 helpers 给未来 push PR 复用）
    """
    m = load_id_map()
    assert isinstance(m, dict), f"load_id_map 应该返回 dict，实际 {type(m)}"
    # 如果文件存在，键名约定要对上
    if m:
        assert any(k.startswith("table_") for k in m), (
            f"_record_id_map.json 存在但键名不符 table_*: {list(m)[:3]}"
        )


def test_link_fields_target_existing_tables():
    """link_fields 的 value 必须是已注册的表名."""
    for name, meta in TABLES.items():
        for link_col, target in meta.link_fields.items():
            assert target in TABLES, (
                f"{name}.{link_col} 指向未知表 {target}"
            )


# ─── Standalone runner (不依赖 pytest) ───
def _run_all_tests() -> int:
    """跑本文件所有 test_* 函数，返回退出码."""
    import inspect

    tests = [
        (name, fn)
        for name, fn in inspect.getmembers(sys.modules[__name__], inspect.isfunction)
        if name.startswith("test_")
    ]
    passed = failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  ✓ {name}")
            passed += 1
        except AssertionError as e:
            print(f"  ✗ {name}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ✗ {name}: {type(e).__name__}: {e}")
            failed += 1

    print()
    print(f"═══ {passed} passed, {failed} failed ═══")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_all_tests())

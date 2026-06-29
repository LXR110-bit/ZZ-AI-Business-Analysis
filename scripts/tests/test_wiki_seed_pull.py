"""scripts/wiki_seed_pull.py 的纯函数测试（不打 lark-cli）。

测：
- _extract_items 兼容多种返回形态
- _extract_record_id 兼容 record_id / id 字段
- translate_links_in_records 各种 link 形态 + 未知 ID 降级

用法：
    python3 scripts/tests/test_wiki_seed_pull.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _wiki_seed_common import TABLES  # noqa: E402
from wiki_seed_pull import (  # noqa: E402
    _extract_items,
    _extract_record_id,
    translate_links_in_records,
)


def test_extract_items_top_level():
    assert _extract_items({"items": [{"a": 1}, {"b": 2}]}) == [{"a": 1}, {"b": 2}]


def test_extract_items_nested_data():
    assert _extract_items({"data": {"items": [1, 2]}}) == [1, 2]


def test_extract_items_empty():
    assert _extract_items({"foo": "bar"}) == []
    assert _extract_items({}) == []
    assert _extract_items({"items": None}) == []


def test_extract_record_id_record_id_field():
    assert _extract_record_id({"record_id": "recA", "fields": {}}) == "recA"


def test_extract_record_id_id_fallback():
    assert _extract_record_id({"id": "recB", "fields": {}}) == "recB"


def test_extract_record_id_none():
    assert _extract_record_id({"fields": {}}) is None


def test_translate_links_simple_list_form():
    """飞书返回 [record_id, ...] 直接列表."""
    records = [{"引用字段": ["recF6"], "关联维值": ["recD2"]}]
    id_map = {
        "02_fields": {"FLD006": "recF6"},
        "03_dim_values": {"DIM002": "recD2"},
    }
    translate_links_in_records(records, TABLES["04_definitions"], id_map)
    assert records[0]["引用字段"] == ["FLD006"]
    assert records[0]["关联维值"] == ["DIM002"]


def test_translate_links_legacy_form():
    """老 API 形态 [{'record_ids': [...]}]."""
    records = [{"引用字段": [{"record_ids": ["recF6"]}]}]
    id_map = {"02_fields": {"FLD006": "recF6"}, "03_dim_values": {}}
    translate_links_in_records(records, TABLES["04_definitions"], id_map)
    assert records[0]["引用字段"] == ["FLD006"]


def test_translate_links_unknown_id_degrade():
    """未知 record_id 不抛异常，标记 <unknown:xxx>."""
    records = [{"引用字段": ["recXXX"]}]
    id_map = {"02_fields": {}, "03_dim_values": {}}
    translate_links_in_records(records, TABLES["04_definitions"], id_map)
    assert records[0]["引用字段"] == ["<unknown:recXXX>"]


def test_translate_links_empty_value():
    """空 / None 值不处理."""
    records = [{"引用字段": [], "关联维值": None}]
    id_map = {"02_fields": {}, "03_dim_values": {}}
    translate_links_in_records(records, TABLES["04_definitions"], id_map)
    assert records[0]["引用字段"] == []
    assert records[0]["关联维值"] is None


def test_translate_links_no_link_fields():
    """没 link_fields 的表（如 01_tables）不报错."""
    records = [{"底表ID": "TBL001"}]
    id_map: dict = {}
    translate_links_in_records(records, TABLES["01_tables"], id_map)
    assert records[0] == {"底表ID": "TBL001"}


def _run_all_tests() -> int:
    import inspect

    tests = [
        (n, f) for n, f in inspect.getmembers(sys.modules[__name__], inspect.isfunction)
        if n.startswith("test_")
    ]
    passed = failed = 0
    for n, f in tests:
        try:
            f()
            print(f"  ✓ {n}")
            passed += 1
        except AssertionError as e:
            print(f"  ✗ {n}: {e}")
            failed += 1
        except Exception as e:
            print(f"  ✗ {n}: {type(e).__name__}: {e}")
            failed += 1
    print()
    print(f"═══ {passed} passed, {failed} failed ═══")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run_all_tests())

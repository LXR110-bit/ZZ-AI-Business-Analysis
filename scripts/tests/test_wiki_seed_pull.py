"""scripts/wiki_seed_pull.py 的纯函数测试（不打 lark-cli）。

测：
- reconstruct_rows: 列存 → 行存 zip，校验 has_more / 行宽 / record_id 平行性
- extract_link_ids: link 字段单元格各种形态
- translate_links_in_records: record_id → 业务 ID 反向翻译，未知降级
- merge_into_local: 飞书 + 本地按业务主键 merge，保留 `_*` helper 字段

用法：python3 scripts/tests/test_wiki_seed_pull.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _wiki_seed_common import TABLES  # noqa: E402
from wiki_seed_pull import (  # noqa: E402
    extract_link_ids,
    merge_into_local,
    reconstruct_rows,
    translate_links_in_records,
)


# ─── reconstruct_rows ───
def test_reconstruct_rows_happy_path():
    """飞书列存返回拼回行存."""
    resp = {
        "ok": True,
        "data": {
            "data": [
                ["DIM001", "80", "成交"],
                ["DIM002", "1", "测试单"],
            ],
            "fields": ["维值ID", "原始值", "业务含义"],
            "field_id_list": ["fld7Z7se0d", "fldF44MAWF", "fldoMVsvtU"],
            "record_id_list": ["recA1", "recA2"],
            "has_more": False,
        },
    }
    rows, rids = reconstruct_rows(resp)
    assert rows == [
        {"维值ID": "DIM001", "原始值": "80", "业务含义": "成交"},
        {"维值ID": "DIM002", "原始值": "1", "业务含义": "测试单"},
    ]
    assert rids == ["recA1", "recA2"]


def test_reconstruct_rows_empty():
    """空表."""
    resp = {"data": {"data": [], "fields": ["x"], "record_id_list": [], "has_more": False}}
    rows, rids = reconstruct_rows(resp)
    assert rows == []
    assert rids == []


def test_reconstruct_rows_has_more_raises():
    """has_more=True 拒绝处理（避免静默 truncate）."""
    resp = {
        "data": {"data": [["a"]], "fields": ["x"], "record_id_list": ["recX"], "has_more": True}
    }
    try:
        reconstruct_rows(resp)
    except RuntimeError as e:
        assert "has_more" in str(e)
        return
    raise AssertionError("应该抛 RuntimeError")


def test_reconstruct_rows_row_width_mismatch_raises():
    """行宽 ≠ fields 列数：报错（schema 不一致警报）."""
    resp = {
        "data": {
            "data": [["a", "b"]],
            "fields": ["x", "y", "z"],
            "record_id_list": ["recX"],
            "has_more": False,
        }
    }
    try:
        reconstruct_rows(resp)
    except RuntimeError as e:
        assert "行宽" in str(e) or "fields" in str(e)
        return
    raise AssertionError("应该抛 RuntimeError")


def test_reconstruct_rows_record_id_count_mismatch_raises():
    """record_id_list 长度 ≠ data 行数：报错."""
    resp = {
        "data": {
            "data": [["a"], ["b"]],
            "fields": ["x"],
            "record_id_list": ["recX"],   # 少了一个
            "has_more": False,
        }
    }
    try:
        reconstruct_rows(resp)
    except RuntimeError as e:
        assert "record_id_list" in str(e) or "不一致" in str(e)
        return
    raise AssertionError("应该抛 RuntimeError")


# ─── extract_link_ids ───
def test_extract_link_ids_dict_form():
    """标准飞书 link 字段 [{'id': 'rec...'}]."""
    assert extract_link_ids([{"id": "recF6"}, {"id": "recF7"}]) == ["recF6", "recF7"]


def test_extract_link_ids_with_text():
    """带 text 字段也只取 id."""
    assert extract_link_ids([{"id": "recF6", "text": "显示名"}]) == ["recF6"]


def test_extract_link_ids_empty():
    assert extract_link_ids([]) == []
    assert extract_link_ids(None) == []
    assert extract_link_ids("") == []


def test_extract_link_ids_string_fallback():
    """兜底：直接是 rec 开头字符串列表."""
    assert extract_link_ids(["recF6", "recF7"]) == ["recF6", "recF7"]


# ─── translate_links_in_records ───
def test_translate_links_basic():
    """[{"id": "recF6"}] → ["FLD006"]."""
    records = [
        {"口径ID": "DEF001", "引用字段": [{"id": "recF6"}], "引用维值": [{"id": "recD2"}]}
    ]
    full_id_map = {
        "02_fields": {"FLD006": "recF6"},
        "03_dim_values": {"DIM002": "recD2"},
    }
    translate_links_in_records(records, TABLES["04_definitions"], full_id_map)
    assert records[0]["引用字段"] == ["FLD006"]
    assert records[0]["引用维值"] == ["DIM002"]


def test_translate_links_unknown_id_degrades():
    """未知 record_id 标 <unknown:xxx>，不抛."""
    records = [{"引用字段": [{"id": "recXXX"}]}]
    full_id_map = {"02_fields": {}, "03_dim_values": {}}
    translate_links_in_records(records, TABLES["04_definitions"], full_id_map)
    assert records[0]["引用字段"] == ["<unknown:recXXX>"]


def test_translate_links_no_link_table_noop():
    """01_tables 当前 meta 没 link_fields → 不报错."""
    records = [{"底表ID": "TBL001", "中文名": "测试"}]
    translate_links_in_records(records, TABLES["01_tables"], {})
    assert records[0] == {"底表ID": "TBL001", "中文名": "测试"}


def test_translate_links_empty_cell_skipped():
    """空 link 单元格不处理."""
    records = [{"引用字段": [], "引用维值": None}]
    full_id_map = {"02_fields": {}, "03_dim_values": {}}
    translate_links_in_records(records, TABLES["04_definitions"], full_id_map)
    assert records[0]["引用字段"] == []
    assert records[0]["引用维值"] is None


# ─── merge_into_local ───
def test_merge_preserves_local_underscore_fields():
    """关键：飞书没有 `_所属字段`，merge 后本地的不能丢."""
    local = [
        {"维值ID": "DIM001", "原始值": "80", "_所属字段": "FLD001", "_备注": "本地辅助"}
    ]
    remote = [
        {"维值ID": "DIM001", "原始值": "80", "责任人": "张三", "状态": "已审核"}
    ]
    merged = merge_into_local(local, remote, "维值ID")
    assert len(merged) == 1
    rec = merged[0]
    # remote 覆盖 + remote 新字段加入
    assert rec["责任人"] == "张三"
    assert rec["状态"] == "已审核"
    # ★ local 独有字段保留
    assert rec["_所属字段"] == "FLD001"
    assert rec["_备注"] == "本地辅助"


def test_merge_remote_field_overrides_local():
    """两边都有的字段，remote 覆盖 local."""
    local = [{"字段ID": "FLD001", "字段名": "OLD名字"}]
    remote = [{"字段ID": "FLD001", "字段名": "新名字"}]
    merged = merge_into_local(local, remote, "字段ID")
    assert merged[0]["字段名"] == "新名字"


def test_merge_remote_only_record_added():
    """飞书有但本地没的记录 → 加入."""
    local = [{"字段ID": "FLD001"}]
    remote = [{"字段ID": "FLD001"}, {"字段ID": "FLD002", "字段名": "新加的"}]
    merged = merge_into_local(local, remote, "字段ID")
    ids = sorted(r["字段ID"] for r in merged)
    assert ids == ["FLD001", "FLD002"]


def test_merge_local_only_record_kept():
    """本地有但飞书没的记录 → 保留（永不删本地）."""
    local = [{"字段ID": "FLD001"}, {"字段ID": "FLD_LOCAL_DRAFT", "字段名": "草稿"}]
    remote = [{"字段ID": "FLD001"}]
    merged = merge_into_local(local, remote, "字段ID")
    ids = sorted(r["字段ID"] for r in merged)
    assert ids == ["FLD001", "FLD_LOCAL_DRAFT"]


def test_merge_sorted_by_business_id():
    """结果按业务主键排序（diff 友好）."""
    local = [{"字段ID": "FLD003"}, {"字段ID": "FLD001"}]
    remote = [{"字段ID": "FLD002"}]
    merged = merge_into_local(local, remote, "字段ID")
    assert [r["字段ID"] for r in merged] == ["FLD001", "FLD002", "FLD003"]


def test_merge_skip_remote_without_business_id():
    """飞书 record 缺业务主键 → 跳过（带警告，但不抛）."""
    local = [{"字段ID": "FLD001"}]
    remote = [{"字段ID": "FLD002"}, {"字段名": "无主键"}]
    merged = merge_into_local(local, remote, "字段ID")
    ids = sorted(r["字段ID"] for r in merged if "字段ID" in r)
    assert ids == ["FLD001", "FLD002"]


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

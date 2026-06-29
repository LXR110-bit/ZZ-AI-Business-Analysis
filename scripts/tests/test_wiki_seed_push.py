"""scripts/wiki_seed_push.py 的纯函数测试 + 全局 dry-run smoke 测试。

不调 lark-cli（无网络验证），只测纯函数 + dry-run 模式不抛异常。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _wiki_seed_common import TABLES  # noqa: E402
from wiki_seed_push import main as push_main, translate_links_for_push  # noqa: E402


def test_translate_links_for_push_basic():
    """业务 ID → record_id 翻译."""
    rec = {"口径ID": "DEF001", "引用字段": ["FLD006"], "关联维值": ["DIM002"]}
    id_map = {
        "table_02_field_record_id_map": {"FLD006": "recF006"},
        "table_03_dim_record_id_map": {"DIM002": "recD002"},
    }
    out = translate_links_for_push(rec, TABLES["04_definitions"], id_map)
    assert out["引用字段"] == ["recF006"]
    assert out["关联维值"] == ["recD002"]
    # 入参不被修改
    assert rec["引用字段"] == ["FLD006"]


def test_translate_links_for_push_missing_id_raises():
    """未知业务 ID 应抛 RuntimeError，且消息明示让先 pull."""
    rec = {"口径ID": "DEF999", "引用字段": ["FLD_XXXXX"]}
    id_map = {"table_02_field_record_id_map": {}, "table_03_dim_record_id_map": {}}
    try:
        translate_links_for_push(rec, TABLES["04_definitions"], id_map)
    except RuntimeError as e:
        assert "FLD_XXXXX" in str(e)
        assert "pull" in str(e).lower() or "wiki_seed_pull" in str(e)
        return
    raise AssertionError("应该抛 RuntimeError")


def test_translate_links_for_push_no_link_table():
    """没 link_fields 的表（01_tables）：直接返回 dict 副本."""
    rec = {"底表ID": "TBL001", "中文名": "回收订单宽表"}
    out = translate_links_for_push(rec, TABLES["01_tables"], {})
    assert out == rec
    assert out is not rec   # 是新 dict


def test_translate_links_for_push_str_form():
    """单个 string 形式的 link（02.所属底表 → 01_tables 主键）."""
    rec = {"字段ID": "FLD001", "所属底表": "TBL001"}
    id_map = {"table_01_record_id_map": {"TBL001": "recT001"}}
    out = translate_links_for_push(rec, TABLES["02_fields"], id_map)
    assert out["所属底表"] == "recT001"


def test_translate_links_for_push_empty_link_ok():
    """空 link 字段不抛，直接保留."""
    rec = {"口径ID": "DEF100", "引用字段": [], "关联维值": None}
    id_map = {"table_02_field_record_id_map": {}, "table_03_dim_record_id_map": {}}
    out = translate_links_for_push(rec, TABLES["04_definitions"], id_map)
    assert out["引用字段"] == []
    assert out["关联维值"] is None


def test_push_main_dry_run_full_repo():
    """全表 dry-run 应能跑完不抛异常。

    这是 smoke 测试：保证 4 张表当前 JSON + 现有 _record_id_map.json 在 dry-run 模式下能完整走通，
    覆盖 push_one_table / translate_links / id_map 查找全路径。
    """
    rc = push_main(["wiki_seed_push.py", "--dry-run"])
    assert rc == 0, f"dry-run 退出码 {rc} 不是 0"


def test_push_main_unknown_table_returns_2():
    rc = push_main(["wiki_seed_push.py", "--dry-run", "999_nonexistent"])
    assert rc == 2


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

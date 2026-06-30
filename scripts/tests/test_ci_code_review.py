"""scripts/ci_code_review.py 的单测。

设计目标（与同目录其他测试一致）：标准库可跑，无强 pytest 依赖：

    python3 scripts/tests/test_ci_code_review.py           # 直接跑
    python3 -m pytest scripts/tests/test_ci_code_review.py # 也兼容 pytest

退出码 0 = 全 pass，1 = 至少一个 fail。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_main_function_exists():
    """脚本可导入并暴露 main()."""
    import ci_code_review  # noqa: F401

    assert hasattr(ci_code_review, "main")
    assert callable(ci_code_review.main)


# ─── extract_json ────────────────────────────────────────────────────────

import json  # noqa: E402

from ci_code_review import extract_json  # noqa: E402


def test_extract_json_plain():
    assert extract_json('{"a": 1}') == {"a": 1}


def test_extract_json_strips_markdown_fence_with_lang():
    assert extract_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_strips_markdown_fence_without_lang():
    assert extract_json('```\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_empty_returns_empty_dict():
    assert extract_json("") == {}
    assert extract_json("   ") == {}


def test_extract_json_invalid_raises():
    try:
        extract_json("not json")
    except json.JSONDecodeError:
        return
    raise AssertionError("expected json.JSONDecodeError")


# ─── assemble_diff ───────────────────────────────────────────────────────

from ci_code_review import assemble_diff  # noqa: E402


def _file(name, patch="@@ -1 +1 @@\n-old\n+new", additions=1, deletions=1, status="modified"):
    d = {"filename": name, "status": status, "additions": additions, "deletions": deletions}
    if patch is not None:
        d["patch"] = patch
    return d


def test_assemble_diff_basic_includes_filenames_and_fence():
    out = assemble_diff([_file("a.py"), _file("b.py")])
    assert "### a.py" in out
    assert "### b.py" in out
    assert "```diff" in out


def test_assemble_diff_skips_binary_no_fence():
    out = assemble_diff([_file("logo.png", patch=None)])
    assert "logo.png" in out
    assert "(binary, skipped)" in out
    assert "```diff" not in out


def test_assemble_diff_truncates_when_over_budget():
    big = _file("big.py", patch="x" * 100_000)
    out = assemble_diff([big], max_chars=1000)
    assert "[truncated" in out
    assert len(out) <= 1500  # budget + truncation marker overhead


def test_assemble_diff_includes_status_marker():
    out = assemble_diff([_file("new.py", status="added")])
    assert "added" in out


# ─── build_messages + SYSTEM_PROMPT ──────────────────────────────────────

from ci_code_review import build_messages, SYSTEM_PROMPT  # noqa: E402


def test_build_messages_shape():
    msgs = build_messages("title", "body", "diff")
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system"
    assert msgs[1]["role"] == "user"


def test_build_messages_user_carries_pr_metadata_and_diff():
    msgs = build_messages("Add foo", "Fixes #123", "### a.py\n```diff\n+x\n```")
    user = msgs[1]["content"]
    assert "Add foo" in user
    assert "Fixes #123" in user
    assert "### a.py" in user


def test_system_prompt_demands_json_with_findings_and_severity():
    low = SYSTEM_PROMPT.lower()
    assert "json" in low
    assert "findings" in low
    assert "severity" in low


# ─── Standalone runner (不依赖 pytest) ───
def _run_all_tests() -> int:
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

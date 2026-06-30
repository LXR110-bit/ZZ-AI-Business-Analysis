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


# ─── call_llm (requests mocked) ──────────────────────────────────────────

from unittest.mock import MagicMock, patch  # noqa: E402

from ci_code_review import call_llm  # noqa: E402


def _mock_response(content_json: str):
    resp = MagicMock()
    resp.status_code = 200
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"choices": [{"message": {"content": content_json}}]}
    return resp


@patch("ci_code_review.requests.post")
def test_call_llm_appends_v1_when_missing(post):
    post.return_value = _mock_response('{"summary":"ok","findings":[]}')
    call_llm([{"role": "user", "content": "x"}], api_key="k", base_url="https://v2.qixuw.com")
    args, _ = post.call_args
    assert args[0] == "https://v2.qixuw.com/v1/chat/completions"


@patch("ci_code_review.requests.post")
def test_call_llm_does_not_double_append_v1(post):
    post.return_value = _mock_response('{"summary":"ok","findings":[]}')
    call_llm([{"role": "user", "content": "x"}], api_key="k", base_url="https://v2.qixuw.com/v1")
    args, _ = post.call_args
    assert args[0] == "https://v2.qixuw.com/v1/chat/completions"


@patch("ci_code_review.requests.post")
def test_call_llm_payload_uses_json_object_and_temp_zero(post):
    post.return_value = _mock_response('{"summary":"ok","findings":[]}')
    call_llm([{"role": "user", "content": "x"}], api_key="k", base_url="https://v2.qixuw.com")
    _, kwargs = post.call_args
    payload = kwargs["json"]
    assert payload["model"] == "gpt-5.5"
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["temperature"] == 0.0
    assert kwargs["headers"]["Authorization"] == "Bearer k"


@patch("ci_code_review.requests.post")
def test_call_llm_parses_content_json(post):
    post.return_value = _mock_response('{"summary":"ok","findings":[{"severity":"MAJOR"}]}')
    out = call_llm([{"role": "user", "content": "x"}], api_key="k", base_url="https://v2.qixuw.com")
    assert out["summary"] == "ok"
    assert out["findings"][0]["severity"] == "MAJOR"


def test_call_llm_missing_api_key_raises():
    try:
        call_llm([], api_key="", base_url="https://v2.qixuw.com")
    except RuntimeError as e:
        assert "OPENAI_API_KEY" in str(e)
        return
    raise AssertionError("expected RuntimeError")


def test_call_llm_missing_base_url_raises():
    try:
        call_llm([], api_key="k", base_url="")
    except RuntimeError as e:
        assert "OPENAI_BASE_URL" in str(e)
        return
    raise AssertionError("expected RuntimeError")


@patch("ci_code_review.requests.post")
def test_call_llm_raises_when_message_lacks_content(post):
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"choices": [{"message": {"role": "assistant"}, "finish_reason": "content_filter"}]}
    post.return_value = resp
    try:
        call_llm([{"role": "user", "content": "x"}], api_key="k", base_url="https://v2.qixuw.com")
    except RuntimeError as e:
        assert "content" in str(e)
        return
    raise AssertionError("expected RuntimeError")


@patch("ci_code_review.requests.post")
def test_call_llm_raises_when_choices_empty(post):
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {"choices": []}
    post.return_value = resp
    try:
        call_llm([{"role": "user", "content": "x"}], api_key="k", base_url="https://v2.qixuw.com")
    except RuntimeError as e:
        assert "choices" in str(e) or "message" in str(e)
        return
    raise AssertionError("expected RuntimeError")


# ─── format_comment ──────────────────────────────────────────────────────

from ci_code_review import format_comment  # noqa: E402


def test_format_comment_empty_findings_renders_clean():
    body = format_comment({"summary": "Looks good.", "findings": []})
    assert "🤖 AI Code Review" in body
    assert "Looks good." in body
    assert "No blocking issues" in body


def test_format_comment_groups_by_severity_order():
    verdict = {
        "summary": "Mixed",
        "findings": [
            {"severity": "MINOR", "file": "a.py", "line": "10", "category": "style", "why": "w1", "suggestion": "s1"},
            {"severity": "BLOCKER", "file": "b.py", "line": "20", "category": "security", "why": "w2", "suggestion": "s2"},
            {"severity": "MAJOR", "file": "c.py", "line": "30", "category": "correctness", "why": "w3", "suggestion": "s3"},
        ],
    }
    body = format_comment(verdict)
    b_idx = body.index("BLOCKER")
    m_idx = body.index("MAJOR")
    n_idx = body.index("MINOR")
    assert b_idx < m_idx < n_idx
    assert "a.py:10" in body and "b.py:20" in body and "c.py:30" in body


def test_format_comment_tolerates_missing_keys():
    body = format_comment({})
    assert "🤖 AI Code Review" in body


def test_format_comment_unknown_severity_falls_through():
    verdict = {"summary": "x", "findings": [{"severity": "WAT", "file": "a.py", "line": "1", "why": "w", "suggestion": "s"}]}
    body = format_comment(verdict)
    assert "WAT" in body


# ─── main() orchestration ────────────────────────────────────────────────

import io  # noqa: E402
import os  # noqa: E402
from contextlib import redirect_stdout  # noqa: E402

import requests  # noqa: E402, F401  (used in test below)

from ci_code_review import main  # noqa: E402


def _isolate_env(**overrides):
    """Build a clean env dict (mock os.environ) with only the keys we set."""
    base = {
        "GITHUB_TOKEN": "t",
        "GITHUB_REPOSITORY": "o/r",
        "PR_NUMBER": "5",
    }
    base.update(overrides)
    return base


def test_main_missing_openai_secrets_dry_run_prints_setup_hint():
    env = _isolate_env()  # no OPENAI_*
    with patch.dict(os.environ, env, clear=True):
        with patch("ci_code_review.post_review") as post:
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = main(["--dry-run"])
    assert code == 0
    assert "未运行" in buf.getvalue()
    assert "OPENAI_API_KEY" in buf.getvalue()
    post.assert_not_called()


def test_main_missing_openai_secrets_live_run_posts_setup_hint():
    env = _isolate_env()
    with patch.dict(os.environ, env, clear=True):
        with patch("ci_code_review.post_review") as post:
            code = main([])
    assert code == 0
    post.assert_called_once()
    body = post.call_args.args[2]
    assert "未运行" in body and "OPENAI_API_KEY" in body


def test_main_missing_actions_env_returns_zero():
    """没 GITHUB_REPOSITORY/PR_NUMBER/GITHUB_TOKEN 时不该崩。"""
    with patch.dict(os.environ, {}, clear=True):
        code = main([])
    assert code == 0


def test_main_happy_path_calls_post_review():
    env = _isolate_env(OPENAI_API_KEY="k", OPENAI_BASE_URL="https://v2.qixuw.com")
    with patch.dict(os.environ, env, clear=True):
        with patch("ci_code_review.post_review") as post, \
             patch("ci_code_review.call_llm") as llm, \
             patch("ci_code_review.fetch_pr_metadata") as meta, \
             patch("ci_code_review.fetch_pr_files") as files:
            files.return_value = [_file("a.py")]
            meta.return_value = ("Add foo", "Fixes #1")
            llm.return_value = {"summary": "ok", "findings": []}
            code = main([])
    assert code == 0
    post.assert_called_once()
    body = post.call_args.args[2]
    assert "AI Code Review" in body


def test_main_dry_run_skips_post():
    env = _isolate_env(OPENAI_API_KEY="k", OPENAI_BASE_URL="https://v2.qixuw.com")
    with patch.dict(os.environ, env, clear=True):
        with patch("ci_code_review.post_review") as post, \
             patch("ci_code_review.call_llm") as llm, \
             patch("ci_code_review.fetch_pr_metadata") as meta, \
             patch("ci_code_review.fetch_pr_files") as files:
            files.return_value = [_file("a.py")]
            meta.return_value = ("t", "b")
            llm.return_value = {"summary": "ok", "findings": []}
            buf = io.StringIO()
            with redirect_stdout(buf):
                code = main(["--dry-run"])
    assert code == 0
    post.assert_not_called()
    assert "AI Code Review" in buf.getvalue()


def test_main_llm_error_posts_unavailable_comment():
    env = _isolate_env(OPENAI_API_KEY="k", OPENAI_BASE_URL="https://v2.qixuw.com")
    with patch.dict(os.environ, env, clear=True):
        with patch("ci_code_review.post_review") as post, \
             patch("ci_code_review.call_llm") as llm, \
             patch("ci_code_review.fetch_pr_metadata") as meta, \
             patch("ci_code_review.fetch_pr_files") as files:
            files.return_value = [_file("a.py")]
            meta.return_value = ("t", "b")
            llm.side_effect = requests.HTTPError("502 upstream_error")
            code = main([])
    assert code == 0  # 永远不让 workflow fail
    post.assert_called_once()
    body = post.call_args.args[2]
    assert "unavailable" in body.lower() or "未生成" in body


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

# CI AI Code Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Action that runs on every PR (`opened` / `synchronize`), feeds the PR diff to 中转站 `gpt-5.5`, and posts a single AI review comment back on the PR.

**Architecture:** One workflow file (`.github/workflows/ai-code-review.yml`) drives one Python script (`scripts/ci_code_review.py`). The script mirrors the `review_gate/critic.py` LLM call pattern (raw `requests`, json_object response, auto-`/v1` base URL), fetches changed files via `gh api`, assembles a bounded diff, asks the LLM for structured findings, and posts a comment via `gh pr review --comment`. No new package, no import of the `review_gate/` package — the pattern is mirrored deliberately to keep the action independent of internal review_gate changes.

**Tech Stack:** Python 3.11 (CI) / 3.9+ (local), `requests` (raw HTTP, not openai SDK), `gh` CLI (preinstalled on ubuntu-latest), stdlib `unittest.mock` for tests. Tests stdlib-runnable, matching the convention in `scripts/tests/test_wiki_seed_common.py`.

## Global Constraints

- LLM call MUST use `requests` directly; the openai SDK adds `x-stainless-*` headers that 中转站 rejects with `502 upstream_error`.
- `OPENAI_BASE_URL` is stored without `/v1`; code MUST append `/v1` only when missing (idempotent).
- Model is `gpt-5.5`; `temperature=0.0`; `response_format={"type":"json_object"}`; HTTP timeout 180s.
- Branch name MUST be `agent-claude/feat/ci-code-reviewer` (per CONTRIBUTING §二).
- Conventional Commits with scope `infra` for workflow/script, `test` for tests-only commits, `lock` / `docs` as appropriate.
- `.agent-locks/claude-ci-code-reviewer-<unix>.yml` MUST be claimed in commit #1 of the branch.
- Must NOT push to `main` directly; merge style is Squash and merge.
- PR body MUST fill every field of `.github/PULL_REQUEST_TEMPLATE.md` (What / Why / How to test / Risk / Checklist / Agent 信息), and explicitly call out that the user needs to add `OPENAI_API_KEY` and `OPENAI_BASE_URL` to repo secrets.
- All file edits happen in the local git worktree `/tmp/ci-code-reviewer-wt`; the server `47.84.94.234` is used only for the real-LLM dry-run smoke test (where `/root/secrets/.env` provides the keys).
- Fork-PR / missing-secrets behavior: post a single comment "AI Code Reviewer 未运行：仓库 secrets 未配置（OPENAI_API_KEY / OPENAI_BASE_URL）。请仓库管理员配置后重跑。" and exit 0. Do NOT fail the workflow.
- Test files are stdlib-runnable (no hard pytest dependency, matching `scripts/tests/test_wiki_seed_common.py`): plain `assert`, `unittest.mock`, try/except for raise tests, `_run_all_tests()` runner at file bottom.

## File Structure

| Path | Responsibility |
|---|---|
| `.agent-locks/claude-ci-code-reviewer-<unix>.yml` | Lock claim per CONTRIBUTING §六 |
| `.github/workflows/ai-code-review.yml` | Workflow: trigger, env wiring, single Python step |
| `scripts/ci_code_review.py` | All review logic: fetch diff, build prompt, call LLM, format, post |
| `scripts/tests/test_ci_code_review.py` | Unit tests covering every helper + main() error paths |

No `__init__.py` is added — existing tests use `sys.path.insert` and module-level import per the project convention.

---

### Task 1: Lock claim + plan doc commit

Already accomplished implicitly by Task 0 in this session: worktree at `/tmp/ci-code-reviewer-wt` is on branch `agent-claude/feat/ci-code-reviewer` off latest origin/main. This task documents the lock-file write and the first commit.

### Task 2–8: Helpers + main() (TDD)

For each helper:
1. Append failing tests to `scripts/tests/test_ci_code_review.py`
2. Run `python3 scripts/tests/test_ci_code_review.py` — confirm failures
3. Implement helper in `scripts/ci_code_review.py`
4. Re-run — confirm pass
5. Conventional-Commit each helper individually

Helpers in order:
- **Task 3** — `extract_json(text: str) -> dict` (strip fence, parse, `{}` on empty)
- **Task 4** — `assemble_diff(files: list[dict], max_chars: int = 60_000) -> str` (markdown blocks, skip binary, truncate)
- **Task 5** — `build_messages(pr_title, pr_body, diff_text) -> list[dict]` + `SYSTEM_PROMPT` constant
- **Task 6** — `call_llm(messages, api_key, base_url, model='gpt-5.5', timeout=180) -> dict` (requests POST, auto `/v1`, parse via `extract_json`)
- **Task 7** — `format_comment(verdict: dict) -> str` (severity-grouped markdown)
- **Task 8** — `main(argv: list[str] | None = None) -> int` with `--dry-run`, plus `fetch_pr_files` / `fetch_pr_metadata` / `post_review` subprocess helpers

### Task 9: Workflow yml

`.github/workflows/ai-code-review.yml`:
```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize]

concurrency:
  group: ai-code-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Install runtime deps
        run: pip install requests
      - name: Run AI code review
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_BASE_URL: ${{ secrets.OPENAI_BASE_URL }}
        run: python scripts/ci_code_review.py
```

### Task 10: Server-side dry-run against PR #5

On `47.84.94.234`:
1. Pull branch
2. Run `uv run --with requests python scripts/ci_code_review.py --dry-run` with real env from `/root/secrets/.env`, against PR #5 (now merged but the diff endpoint still works)
3. Save output to `/tmp/ai-review-dryrun.md` for PR-body evidence

### Task 11: Open PR

Fill `.github/PULL_REQUEST_TEMPLATE.md` completely. Explicitly note: repo admin must add `OPENAI_API_KEY` + `OPENAI_BASE_URL` to repo secrets before the action does anything useful; until then it posts the setup-hint comment.

---

## Self-Review

**Spec coverage:** ✓ workflow yml, ✓ script, ✓ tests, ✓ requests-only LLM, ✓ /v1 append, ✓ gh pr review --comment, ✓ CONTRIBUTING branch/lock/conventional commits, ✓ template-filled PR body with secrets-setup note, ✓ writing-plans → executing-plans flow.

**Decisions worth flagging:**
- `gh api --paginate` returns concatenated JSON arrays separated by `][`. The `out.replace("][", ",")` trick works for the files endpoint where each page is a flat array.
- `gh pr review` uses `--body-file -` (stdin) to avoid shell-arg length limits for large comments.
- `subprocess.run(..., check=True)` propagates `CalledProcessError`; the outer `try/except Exception` in `main` catches it and posts the unavailable comment, so a transient `gh` failure also doesn't fail the workflow.
- Workflow uses `pip install requests` only — pytest is not needed in CI because tests live for pre-merge verification; the action itself only runs `scripts/ci_code_review.py`.

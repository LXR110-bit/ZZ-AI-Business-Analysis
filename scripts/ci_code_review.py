"""CI AI Code Reviewer entry point.

每次 PR opened / synchronize 时，GitHub Action 调用本脚本：
  - 拉 PR 改动 diff（gh api）
  - 拼 prompt，调中转站 gpt-5.5（requests，不用 openai SDK）
  - 把审查结论作为一条 PR 评论留下（gh pr review --comment）

env 入口：
  - GITHUB_TOKEN       (Actions 自动注入)
  - GITHUB_REPOSITORY  (owner/repo)
  - PR_NUMBER          (PR 号)
  - OPENAI_API_KEY     (repo secret)
  - OPENAI_BASE_URL    (repo secret，不带 /v1，代码自动补)

仓库 secret 缺时 → 留 setup-hint 评论，exit 0；不阻断 workflow。
"""
from __future__ import annotations

import json
import os

import requests


def extract_json(text: str) -> dict:
    """去 markdown 围栏并 parse JSON。空串返回 {}。

    中转站偶尔会把 JSON 包在 ```json ... ``` 里，即使 response_format=json_object。
    """
    text = (text or "").strip()
    if not text:
        return {}
    if text.startswith("```"):
        lines = text.split("\n")
        if lines and lines[-1].strip() == "```":
            lines = lines[1:-1]
        else:
            lines = lines[1:]
        text = "\n".join(lines).strip()
        if not text:
            return {}
    return json.loads(text)


def assemble_diff(files: list[dict], max_chars: int = 60_000) -> str:
    """渲染 PR 改动文件为单块 markdown，每个文件一个 fenced diff。

    - 二进制文件（无 `patch` 键）标 `(binary, skipped)`，不出 diff 围栏
    - 总长度超过 `max_chars` 时截断，并附 `[truncated, original was N chars]`
    """
    parts: list[str] = []
    for f in files:
        name = f.get("filename", "<unknown>")
        status = f.get("status", "modified")
        adds = f.get("additions", 0)
        dels = f.get("deletions", 0)
        header = f"### {name} ({status}, +{adds}/-{dels})"
        patch = f.get("patch")
        if patch is None:
            parts.append(f"{header}\n\n(binary, skipped)\n")
        else:
            parts.append(f"{header}\n\n```diff\n{patch}\n```\n")
    full = "\n".join(parts)
    if len(full) > max_chars:
        truncated = full[:max_chars]
        return f"{truncated}\n...[truncated, original was {len(full)} chars]"
    return full


SYSTEM_PROMPT = """你是严谨的工程 code reviewer。审查给定 PR 的代码 diff，输出结构化结论。

严苛 by design：宁可多报，也不要漏掉真问题；但不要无中生有，每条 finding 必须有 diff 中可定位的依据。

输出 JSON（不要 markdown 围栏）：
{
  "summary": "1-2 句概括 PR 的核心改动 + 总体评价",
  "findings": [
    {
      "severity": "BLOCKER|MAJOR|MINOR|NIT",
      "file": "相对路径",
      "line": "diff 中的行号或行号范围（hunk 里的 +N）",
      "category": "correctness|security|performance|readability|test|style",
      "why": "问题是什么，为什么有问题",
      "suggestion": "怎么改（可包含代码片段）"
    }
  ]
}

严重度定义：
- BLOCKER: 会导致功能错误、数据丢失、安全漏洞、生产事故
- MAJOR: 不会立即崩，但显著降低质量/可维护性/性能
- MINOR: 风格、命名、注释、轻微逻辑改进
- NIT: 可选优化

如果没有任何 finding，返回 `"findings": []`。
绝不输出空 summary。"""


def build_messages(pr_title: str, pr_body: str, diff_text: str) -> list[dict]:
    """拼 chat-completions 的 messages 数组（system + user）."""
    user = f"""## PR 标题

{pr_title}

## PR 描述

{pr_body or "(空)"}

## 改动 diff

{diff_text}
"""
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def call_llm(
    messages: list[dict],
    api_key: str,
    base_url: str,
    model: str = "gpt-5.5",
    timeout: int = 180,
) -> dict:
    """POST chat-completions 到中转站，返回解析过的 JSON dict。

    - 不走 openai SDK（SDK 加的 x-stainless-* 头会被中转站拒为 502）
    - base_url 自动补 /v1（idempotent）
    - response_format=json_object，temperature=0.0
    """
    if not api_key:
        raise RuntimeError("缺 OPENAI_API_KEY env var")
    if not base_url:
        raise RuntimeError("缺 OPENAI_BASE_URL env var")

    endpoint = base_url.rstrip("/")
    if not endpoint.endswith("/v1"):
        endpoint += "/v1"
    endpoint += "/chat/completions"

    payload = {
        "model": model,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": 0.0,
    }
    resp = requests.post(
        endpoint,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    return extract_json(content)


SEVERITY_ORDER = ["BLOCKER", "MAJOR", "MINOR", "NIT"]
SEVERITY_EMOJI = {"BLOCKER": "🛑", "MAJOR": "⚠️", "MINOR": "💡", "NIT": "🔧"}


def format_comment(verdict: dict) -> str:
    """渲染 verdict 为 markdown 评论体。

    - 无 findings → 写 "✅ No blocking issues found."
    - 有 findings → 按 BLOCKER→MAJOR→MINOR→NIT 分组，未知 severity 落最后
    - 容错：传入 {} 也能渲染出框架
    """
    summary = (verdict.get("summary") or "").strip() or "(无 summary)"
    findings = verdict.get("findings") or []

    lines = ["## 🤖 AI Code Review", "", f"**Summary:** {summary}", ""]

    if not findings:
        lines.append("✅ No blocking issues found.")
        return "\n".join(lines)

    grouped: dict[str, list[dict]] = {}
    for f in findings:
        sev = (f.get("severity") or "OTHER").upper()
        grouped.setdefault(sev, []).append(f)

    ordered_keys = [k for k in SEVERITY_ORDER if k in grouped] + [
        k for k in grouped if k not in SEVERITY_ORDER
    ]

    for sev in ordered_keys:
        emoji = SEVERITY_EMOJI.get(sev, "•")
        lines.append(f"### {emoji} {sev} ({len(grouped[sev])})")
        for f in grouped[sev]:
            file = f.get("file", "?")
            line = f.get("line", "?")
            cat = f.get("category", "")
            why = (f.get("why") or "").strip()
            sugg = (f.get("suggestion") or "").strip()
            lines.append(f"- **`{file}:{line}`** _{cat}_ — {why}")
            if sugg:
                lines.append(f"  - 建议：{sugg}")
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


SETUP_HINT_BODY = (
    "## 🤖 AI Code Review\n\n"
    "AI Code Reviewer 未运行：仓库 secrets 未配置 (`OPENAI_API_KEY` / `OPENAI_BASE_URL`)。"
    "请仓库管理员到 Settings → Secrets and variables → Actions 添加后重跑此 workflow。\n"
)


def fetch_pr_files(repo: str, pr: str, token: str) -> list[dict]:
    """gh api --paginate 拉 PR 改动文件列表。"""
    import subprocess

    env = {**os.environ, "GH_TOKEN": token}
    out = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls/{pr}/files", "--paginate"],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    # `--paginate` 把多页 JSON 数组用 `][` 拼起来，归一化成一个数组。
    out = out.replace("][", ",")
    return json.loads(out)


def fetch_pr_metadata(repo: str, pr: str, token: str) -> tuple[str, str]:
    """拉 PR 标题和描述."""
    import subprocess

    env = {**os.environ, "GH_TOKEN": token}
    out = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls/{pr}"],
        env=env,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    d = json.loads(out)
    return d.get("title", ""), d.get("body") or ""


def post_review(repo: str, pr: str, body: str, token: str) -> None:
    """通过 gh pr review --comment 留评论，正文从 stdin 喂以避开 arg 长度限制."""
    import subprocess

    env = {**os.environ, "GH_TOKEN": token}
    subprocess.run(
        ["gh", "pr", "review", pr, "--repo", repo, "--comment", "--body-file", "-"],
        input=body,
        env=env,
        text=True,
        check=True,
    )


def _build_unavailable_body(error: BaseException) -> str:
    return (
        "## 🤖 AI Code Review\n\n"
        f"AI reviewer unavailable (error class: `{type(error).__name__}`)。"
        "本次未生成 review，请手动检查或重跑 workflow。\n"
    )


def main(argv: list[str] | None = None) -> int:
    """主入口。返回 0 表示成功 / 优雅 no-op；非 0 仅在 unexpected 编程错误时."""
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="CI AI Code Reviewer")
    parser.add_argument("--dry-run", action="store_true", help="打印评论但不真 post")
    args = parser.parse_args(argv)

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    pr = os.environ.get("PR_NUMBER", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    api_key = os.environ.get("OPENAI_API_KEY", "")
    base_url = os.environ.get("OPENAI_BASE_URL", "")

    if not repo or not pr or not token:
        print("Missing GITHUB_REPOSITORY / PR_NUMBER / GITHUB_TOKEN — abort", file=sys.stderr)
        return 0

    if not api_key or not base_url:
        if args.dry_run:
            print(SETUP_HINT_BODY)
        else:
            post_review(repo, pr, SETUP_HINT_BODY, token)
        return 0

    files = fetch_pr_files(repo, pr, token)
    title, body = fetch_pr_metadata(repo, pr, token)
    diff_text = assemble_diff(files)
    messages = build_messages(title, body, diff_text)

    try:
        verdict = call_llm(messages, api_key=api_key, base_url=base_url)
    except Exception as exc:  # noqa: BLE001 — 任何 LLM/网络错误都不该让 workflow fail
        unavailable = _build_unavailable_body(exc)
        if args.dry_run:
            print(unavailable)
        else:
            post_review(repo, pr, unavailable, token)
        return 0

    comment = format_comment(verdict)
    if args.dry_run:
        print(comment)
    else:
        post_review(repo, pr, comment, token)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

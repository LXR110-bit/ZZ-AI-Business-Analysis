# Review Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `review_gate/` Python package that takes an agent's draft output + original user task + principle layer reference, calls a critic LLM to enforce the §6 self-check from `principles/core.md`, and returns a structured PASS/FAIL verdict with per-check status and concrete issues.

**Architecture:** 
- 独立 Python package (`review_gate/`)，与 `router/` 同级
- 不直接接入 `orchestrator/expert_runner.py`（接入是单独的下一个 PR，遵守 CONTRIBUTING.md "PR 只做一件事"）
- Critic system prompt 落 markdown 在 `review_gate/prompts/`，方便人工调优
- LLM 调用用 `requests` 直接打 transit station（不用 openai SDK——会被 stainless headers 拦截，已在 router/ 验证）
- 输出 `Verdict` dataclass，可序列化成 JSON 给上游消费

**Tech Stack:** Python 3.11、`requests`、`dataclasses`、`uv` 装依赖、`pytest` 测试

## Global Constraints

- 默认模型：`gpt-5.5`（critic 需要强推理；router 用 mini 是因为它做路由不做判断）
- Base URL：从 `OPENAI_BASE_URL` env 读，自动追加 `/v1`
- Auth：`OPENAI_API_KEY` env
- HTTP 超时：180s（critic 做深度推理可能慢）
- temperature=0.0、`response_format={"type": "json_object"}`
- 不能用 mock 掩盖真实失败；测试用纯函数 + dataclass 路径覆盖
- 所有路径相对 repo 根

---

### Task 1: 项目脚手架

**Files:**
- Create: `review_gate/pyproject.toml`
- Create: `review_gate/src/review_gate/__init__.py`
- Create: `review_gate/tests/__init__.py`
- Create: `review_gate/README.md`

**Interfaces:**
- Consumes: 无（新建 package）
- Produces: `review_gate` import path、`uv sync` 可装

- [ ] **Step 1:** 写 `pyproject.toml`（含 dependencies: requests, pytest）
- [ ] **Step 2:** 写空 `__init__.py`（package marker）
- [ ] **Step 3:** 写 `tests/__init__.py`
- [ ] **Step 4:** 写 `README.md` 草稿（说明 review gate 是干啥的）
- [ ] **Step 5:** `cd review_gate && uv sync`，验证装好
- [ ] **Step 6:** Commit: `feat(review-gate): scaffold package`

### Task 2: Critic 系统提示词

**Files:**
- Create: `review_gate/prompts/critic_system.md`

**Interfaces:**
- Consumes: 无
- Produces: 可被 `critic.py` 读取的纯 markdown

- [ ] **Step 1:** 写 `critic_system.md`，包括：
    - 角色定义（严苛 review 官）
    - 输入说明（原任务 / agent 输出 / 原则层全文）
    - 必查 6 项（§1 三层穿透 / §2 生命周期 / §3 瓶颈 / §4 异动四问 / §5 动作闭环 / §7 严谨性）
    - 输出 JSON schema（passed / verdict / checks / issues / summary）
    - 严苛标准（宁可误报，不能漏报）
- [ ] **Step 2:** Commit: `feat(review-gate): critic system prompt`

### Task 3: Verdict dataclass + JSON 解析

**Files:**
- Create: `review_gate/src/review_gate/verdict.py`
- Create: `review_gate/tests/test_verdict.py`

**Interfaces:**
- Consumes: 无
- Produces:
    ```python
    @dataclass
    class CheckResult:
        check: str         # e.g. "§1 三层穿透"
        passed: bool
        reason: str

    @dataclass
    class Issue:
        check: str
        what: str
        fix: str

    @dataclass
    class Verdict:
        passed: bool
        verdict: str           # "PASS" | "FAIL"
        checks: list[CheckResult]
        issues: list[Issue]
        summary: str
        raw: dict              # 原始 LLM 输出

        def to_json(self) -> str: ...
        @classmethod
        def from_dict(cls, d: dict) -> "Verdict": ...
    ```

- [ ] **Step 1:** 写 `verdict.py` 实现上面 dataclass
- [ ] **Step 2:** 写 `test_verdict.py` 覆盖：
    - `from_dict` 正常解析
    - `from_dict` 容错（缺字段 / 类型错乱）
    - `to_json` 往返
- [ ] **Step 3:** `uv run pytest tests/test_verdict.py -v` → 全过
- [ ] **Step 4:** Commit: `feat(review-gate): Verdict dataclass + tests`

### Task 4: critic.py 主函数（LLM 调用）

**Files:**
- Create: `review_gate/src/review_gate/critic.py`
- Create: `review_gate/tests/test_critic.py`

**Interfaces:**
- Consumes: `verdict.Verdict`、`prompts/critic_system.md`
- Produces:
    ```python
    def review(
        task: str,
        agent_output: str,
        principle_text: str,
        model: str = "gpt-5.5",
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: int = 180,
    ) -> Verdict: ...
    ```

- [ ] **Step 1:** 写 `critic.py`：
    - 读 `prompts/critic_system.md` 作 system prompt
    - 组装 user message（任务 + 输出 + 原则）
    - 用 `requests` POST 到 `<base_url>/v1/chat/completions`
    - `response_format={"type":"json_object"}`、`temperature=0.0`
    - 解析返回 JSON → `Verdict.from_dict()`
- [ ] **Step 2:** 写 `test_critic.py`：
    - 测 user message 组装格式（断言含原任务 + agent 输出 + 关键 §标签）
    - 测 base_url 自动补 `/v1`
    - 测缺 env var 时抛 RuntimeError
- [ ] **Step 3:** `uv run pytest -v` → 全过
- [ ] **Step 4:** Commit: `feat(review-gate): critic.review() main fn + tests`

### Task 5: CLI 入口

**Files:**
- Create: `review_gate/src/review_gate/__main__.py`

**Interfaces:**
- Consumes: `critic.review()`
- Produces: CLI `python -m review_gate --task "..." --output @file --principles principles/core.md`

- [ ] **Step 1:** 写 `__main__.py`：
    - `argparse` 解析 `--task`、`--output`（支持 `@file` 引用）、`--principles`、`--model`
    - 调 `critic.review()`
    - 输出 `verdict.to_json()` 到 stdout
    - exit code: PASS → 0，FAIL → 1
- [ ] **Step 2:** Commit: `feat(review-gate): CLI entry point`

### Task 6: 烟测 + 文档完善

**Files:**
- Modify: `review_gate/README.md`
- Modify: `CHANGELOG.md`（[Unreleased] 加新条目）

**Interfaces:** 无

- [ ] **Step 1:** 准备测试样本 `/tmp/sample_agent_output.md`，故意写一份**违反原则**的"周报"（不带§4 异动四问、动作建议没闭环）
- [ ] **Step 2:** 跑 `python -m review_gate --task "iPhone 14 周报" --output @/tmp/sample_agent_output.md --principles principles/core.md`
    - 预期：FAIL，issues 列出至少 2 条（§4 四问缺、§5 闭环缺）
- [ ] **Step 3:** 准备合格样本 `/tmp/good_agent_output.md`（覆盖全部 §1-§5），跑 review_gate → PASS
- [ ] **Step 4:** 完善 `README.md`（含跑通的烟测命令 + 输出示例）
- [ ] **Step 5:** 更新 CHANGELOG.md `[Unreleased]` 段
- [ ] **Step 6:** Commit: `docs(review-gate): smoke test results + README`

### Task 7: 开 PR

**Files:** 无新增

- [ ] **Step 1:** `git push -u origin agent-claude/feat/review-gate`
- [ ] **Step 2:** `gh pr create` with template body (含 What/Why/Test/Risk/Checklist/Agent info)
- [ ] **Step 3:** 把 PR URL 返回给用户

---

## 验收标准

PR 合并前必须满足：
- [ ] `uv run pytest -q` 全过（review_gate 自己的测试）
- [ ] 烟测：故意违反原则的样本 → FAIL；合格样本 → PASS
- [ ] CHANGELOG 更新
- [ ] PR body 完整填写
- [ ] `.agent-locks/` 锁文件存在

## 不在本 PR 范围

- 接入 `orchestrator/expert_runner.py`（下个 PR）
- 接入 router 调用计划的 Review Gate 拦截（下下个 PR）
- 多次重试机制（下个 PR）
- 真实业务样本回归测试（业务同学贡献）

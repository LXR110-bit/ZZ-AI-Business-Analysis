<!--
PR 标题格式：<type>(<scope>): <一句话描述>
type 列表：feat / fix / chore / docs / refactor / test / perf / style / revert
-->

## What（改了啥）

<!-- 一句话总结这次改动 -->


## Why（为什么改）

<!-- 业务/技术上下文。链接相关 issue 如有 -->

- 关联 issue: #
- 关联里程碑: MVP-?


## How to test（怎么验证）

<!-- 写给 reviewer 看：怎么一步步验证你的改动 -->

```bash
# 例：
bash scripts/test_pipeline.sh "iPhone 14 周报"
```

预期：
- [ ] xxx
- [ ] yyy


## Risk（可能的副作用）

<!-- 这个改动可能影响什么？哪些场景需要回归测试？ -->


## Checklist

- [ ] 我已经 `git rebase origin/main`，没有冲突
- [ ] 跑过所在 MCP server 的单测
- [ ] 跑过一次 e2e 烟测
- [ ] commit message 符合 Conventional Commits 规范
- [ ] PR 只做一件事，没夹带其他修改
- [ ] 没有提交 secrets / 大文件 / node_modules / .venv
- [ ] 如果改了 `principles/` 或 `skills/process/` → 提供了至少 3 个 prompt 测试样例
- [ ] 如果改了 MCP 工具签名 → 升 MAJOR + 在 CHANGELOG 标 BREAKING
- [ ] 如果是 Agent 提交 → 在 PR 描述里说明用了哪个 Agent (`claude` / `codex` / `cursor`)


## Agent 信息（如果是 AI 提交）

- **Agent**: <!-- claude / codex / cursor / etc -->
- **Session ID**: <!-- 如有 -->
- **Lock claimed**: <!-- 文件路径 .agent-locks/xxx.yml -->


---

<!--
合并前 reviewer 自查：
- [ ] PR 标题和描述清晰
- [ ] 改动符合 §一 单一职责
- [ ] 没破坏现有功能
- [ ] 文档更新了（如适用）
- [ ] 等所有 checklist 都勾完再 approve
-->

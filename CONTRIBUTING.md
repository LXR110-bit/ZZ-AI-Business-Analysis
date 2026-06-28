# 贡献指南 · CONTRIBUTING.md

> **本仓库会有多个 AI Agent + 人类协作。规则必须刚性，否则代码必乱。**
> 任何 commit 不符合本指南 → 直接打回，不讨论。

---

## 一、核心原则（最重要）

1. **`main` 永远可部署**。不可直接 push，只能合 PR。
2. **一个分支只做一件事**。混在一起的 PR 一律拒收。
3. **冲突解决靠 rebase，不靠 merge commit**。保持 history 线性。
4. **多 Agent 写同一区域 → 必须先认领锁**（见 §六）。
5. **写代码前先 `git pull --rebase origin main`**。基于过时的 main 改东西是事故源头。

---

## 二、分支策略（trunk-based + 短命分支）

### 分支命名

```
<type>/<scope>-<短描述>
```

| type | 含义 | 例 |
|---|---|---|
| `feat` | 新功能 | `feat/router-skill-metadata` |
| `fix` | bug 修复 | `fix/imap-decode-utf7` |
| `chore` | 工程维护、依赖升级 | `chore/upgrade-mcp-1.7` |
| `docs` | 仅文档改动 | `docs/skill-writing-guide` |
| `refactor` | 重构不改行为 | `refactor/extract-router` |
| `test` | 测试相关 | `test/yoy-skill-mock` |

### Agent 专属前缀（多 Agent 协作必须）

每个 AI Agent 写代码必须在分支名加 **agent 标识**：

```
agent-<agent-id>/<type>/<scope>
```

例：
```
agent-claude/feat/review-gate
agent-codex/feat/yoy-implementation
agent-cursor/fix/email-encoding
```

`<agent-id>` 列表（请在新增 agent 时同步更新这里）：
- `claude` — Claude Code (Anthropic)
- `codex` — OpenAI Codex CLI
- `cursor` — Cursor agent mode
- `human` — 人类直接提交（罕见）

### 分支生命周期

- **存活时间 ≤ 3 天**。超过 3 天没合的分支会被关闭重做
- **合并后立即删分支**。`git push origin --delete <branch>`
- **`main` 分支保护**（GitHub 设置里配，见 §五）：
  - 禁止直接 push
  - 必须 PR + 至少 1 review
  - 必须通过 CI

---

## 三、Commit 规范（Conventional Commits）

### 格式

```
<type>(<scope>): <一句话 imperative 描述>

<body 可选：解释为什么这么改，不解释改了什么>

<footer 可选：BREAKING CHANGE / 关联 issue / Co-Authored-By>
```

### type 列表（与分支 type 对齐）

`feat` / `fix` / `chore` / `docs` / `refactor` / `test` / `perf` / `style` / `revert`

### scope（推荐）

`router` / `agent` / `review-gate` / `skills` / `mcp-data` / `mcp-lark` / `mcp-kb` / `infra` / `docs`

### 例

✅ 好：
```
feat(router): 加 skill 元数据加载器

Router 启动时扫描 skills/ 目录，把 frontmatter 转成调用计划生成器
的输入 schema，避免每次问问题时重新解析。

Co-Authored-By: Claude <noreply@anthropic.com>
```

❌ 坏：
```
update code                 ← 不写干了啥
WIP                         ← 不允许进 main
修了一下 router 顺便改了点 mcp ← 一次只做一件事
fix bug                     ← 哪个 bug？
```

### 中英文

- type/scope 用英文（统一）
- 描述用中文 OK（团队是中文为主）

---

## 四、PR 流程

### 4.1 开 PR 前自检（不做就别开）

```bash
# 1. rebase 到最新 main
git fetch origin
git rebase origin/main

# 2. 跑测试（每个 MCP server 自己的）
cd mcp_servers/data_tools && uv run pytest -q
cd mcp_servers/lark_tools && uv run pytest -q

# 3. 起码做一次 e2e 烟测
bash scripts/test_pipeline.sh "简单问题验证"

# 4. 看 diff，自己 review 一遍
git diff origin/main
```

任何一步失败 → **不开 PR**，修完再来。

### 4.2 PR 标题

```
<type>(<scope>): <描述>
```

跟 commit message 第一行一致即可。

### 4.3 PR 描述（用模板，见 `.github/PULL_REQUEST_TEMPLATE.md`）

必填字段：
- **What**：改了啥（一段话）
- **Why**：为什么改（业务/技术上下文）
- **How to test**：审阅者怎么验证
- **Risk**：可能的副作用
- **Checklist**：模板里的勾选项

### 4.4 Review 流程

- **Agent 开的 PR** → 需要人类 review（claude / codex / cursor 不能相互 approve）
- **人类开的 PR** → 至少 1 个人或一个高置信 Agent review
- **review 不通过** → 改完重新 request review
- **review 通过 + CI 绿** → 才能合

### 4.5 合并方式

**Squash and merge**。每个 PR 合成一个 commit 进 main。理由：
- main 历史干净，每条都是一个完整功能
- 方便 revert（一条命令）
- 不污染 history（开发分支的 wip commits 不进 main）

---

## 五、main 分支保护（GitHub Settings 里手动配）

去 `Settings → Branches → Add branch protection rule → main`：

- [x] Require a pull request before merging
- [x] Require approvals (1)
- [x] Require status checks to pass before merging（CI 加进来后勾这个）
- [x] Require branches to be up to date before merging
- [x] Require linear history
- [x] Do not allow bypassing the above settings
- [x] Restrict who can push to matching branches（只有 admin）

---

## 六、多 Agent 协作规则（关键章节）

**问题**：两个 Agent 同时改 `experts/daily_analyst/AGENTS.md` → 后提交的覆盖前面的。

### 6.1 写前认领（推荐）

在 `.agent-locks/` 下创建认领文件：

```bash
# 开始干活前
echo "agent: claude
branch: agent-claude/feat/review-gate
files:
  - review_gate/
  - skills/process/weekly_report.md
started: $(date -Iseconds)
expected_done: $(date -Iseconds -d '+2 hours')" > .agent-locks/claude-$(date +%s).yml

git add .agent-locks/
git commit -m "lock(claude): claim review_gate area until $(date -Iseconds -d '+2 hours')"
git push origin agent-claude/feat/review-gate
```

**其他 Agent 工作前必查**：`ls .agent-locks/`。如果发现你要改的文件被认领了，**不要动**，去做别的或者等锁释放。

### 6.2 锁文件规则

- **文件名**：`<agent>-<unix-timestamp>.yml`
- **过期机制**：超过 `expected_done` 8 小时还在 → 视为失效，可强行删
- **完成后立即删**：
  ```bash
  git rm .agent-locks/claude-1234567890.yml
  git commit -m "unlock(claude): release review_gate area"
  ```

### 6.3 强冲突区域

下列文件改动**必须先在 issue 里讨论 + 锁**（一次只能一个 Agent 改）：

- `principles/core.md`
- `agent/AGENTS.md`
- `router/router.py`
- `review_gate/critic.md`
- `mcp_servers/*/src/*/server.py`（接口层）
- `.codex/config.toml`
- `CONTRIBUTING.md` / `VERSIONING.md`

### 6.4 弱冲突区域（可以多 Agent 并行）

- `skills/implementation/*` — 每个 skill 一个文件，互不影响
- `knowledge/cases/*` — 历史案例，append-only
- `docs/*` — 各自独立的文档

### 6.5 冲突后处理

```bash
git fetch origin
git rebase origin/main
# 如果有冲突
# 1. 手工解决，保留两边都有意义的内容
# 2. git add 解决后的文件
# 3. git rebase --continue
# 4. force push 自己的分支（自己的分支可以 force，main 永远不能）
git push --force-with-lease
```

**严禁**：
- ❌ 在 main 上 `--force` push
- ❌ `merge` 别人的分支到自己的分支（产生 merge commit 污染历史）
- ❌ 跳过 rebase 直接合（PR 通常会被拒收）

---

## 七、Skill / Agent 改动的特殊规则

`skills/process/*.md` 和 `skills/implementation/*.md` 是 LLM 直接读的指令文档，**改动风险高**。

### 必填评估（在 PR 里）

| 项 | 说明 |
|---|---|
| **行为差异** | 改动前后，agent 输出会有什么变化？ |
| **测试 prompt** | 至少 3 个测试问题，证明改动符合预期 |
| **回滚成本** | 如果改坏了怎么撤回？ |

### Review 必须看

- diff 是否会让 LLM 误解
- 是否破坏了 §1-§9 原则的引用
- 是否引入新的"硬编码业务事实"（应该进 knowledge/ 而不是 skills/）

---

## 八、紧急情况

### 8.1 main 被弄坏了

任何人发现都可以 revert：

```bash
git fetch origin
git checkout main
git revert <bad-commit-sha>
git push origin main      # 如果有 admin 权限直接 push
                          # 否则开 PR 标 [URGENT]
```

### 8.2 锁僵尸了

Agent 死掉留下未释放的锁：

```bash
# 8 小时之后任何人可以清理
find .agent-locks/ -name "*.yml" -mmin +480 -delete
git commit -am "chore(locks): GC stale agent locks"
```

### 8.3 secret 不小心提交了

立刻：
1. 改 `/root/secrets/.env` 把对应密钥**作废 + 轮换**
2. `git rebase -i <bad-commit>~1` 删掉那行
3. `git push --force-with-lease`
4. 在 GitHub Issue 上记录事件 + 轮换的密钥列表

---

## 九、违规处罚

- 第 1 次：当事人（Agent 或人）改回来 + 在 PR 留言道歉
- 第 2 次：当事 Agent 被加入 `.codex/config.toml` 的 deny-list
- 第 3 次：钉死规则 + 单元测试自动拦截（pre-commit hook）

---

## 十、参考文档

- [VERSIONING.md](VERSIONING.md) — 版本号怎么升、什么时候发版
- [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) — PR 模板
- [CHANGELOG.md](CHANGELOG.md) — 变更日志

---

**版本**：v1.0  
**最后更新**：2026-06-28  
**生效起**：commit `a04f517` 之后所有改动

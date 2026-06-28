# 版本管理 · VERSIONING.md

## 一、版本号格式：语义化版本 (SemVer)

```
MAJOR.MINOR.PATCH

例：v0.1.0、v0.2.0、v1.0.0、v1.2.3
```

| 位 | 何时 +1 | 例子 |
|---|---|---|
| **MAJOR** | 破坏性变更：MCP 工具签名变 / Skill 协议变 / AGENTS.md 格式变 | 把 `read_email` 改名为 `fetch_email` |
| **MINOR** | 新增功能不破坏现有 API | 加新 Skill、加新 MCP 工具、加新专家 |
| **PATCH** | bug 修复 / 文档 / 性能优化 / 不影响接口的内部重构 | IMAP UTF-7 解码修复 |

## 二、Pre-1.0 特殊约定

在 `v1.0.0` 之前，**所有 MVP 里程碑用 MINOR 版本表示**：

| 里程碑 | 版本 | 范围 |
|---|---|---|
| MVP-1 | `v0.1.x` | 单 Agent + 周报 Skill + 邮件读取 + 飞书写入 |
| MVP-2 | `v0.2.x` | Router + Skill 分类 + Review Gate |
| MVP-3 | `v0.3.x` | 飞书 webhook + 多专家协作 |
| MVP-4 | `v0.4.x` | 历史案例向量库 + 监控接入 |
| GA | `v1.0.0` | 生产稳定 |

每个 MVP 里 PATCH 自由增长（bug 修复、文档）。

## 三、何时发版

| 触发 | 动作 |
|---|---|
| 修了 bug → 合到 main | PATCH 版本可选立刻发，也可累积发 |
| 加了功能 → 合到 main | MINOR 等里程碑结束时发 |
| 里程碑完成（MVP-N 全部 todo 通过） | MINOR 必须发，写 release notes |
| 破坏性变更进 main 前 | MAJOR 必须先在 issue 公告 ≥ 24h |

## 四、发版流程

### 4.1 准备

```bash
# 1. 在 main 上
git checkout main
git pull --rebase origin main

# 2. 跑全套测试
bash scripts/test_pipeline.sh "周报生成测试"
cd mcp_servers/data_tools && uv run pytest -q
cd mcp_servers/lark_tools && uv run pytest -q
cd mcp_servers/knowledge_base && uv run pytest -q

# 3. 更新 CHANGELOG.md（见 §五）
vim CHANGELOG.md
git add CHANGELOG.md
git commit -m "docs(changelog): 准备 v0.2.0"
```

### 4.2 打 tag + push

```bash
VERSION=v0.2.0
git tag -a $VERSION -m "release: $VERSION

主要变更：
- xxx
- yyy

破坏性变更：
- (如有) ...

迁移指南：
- (如有) ..."

git push origin main
git push origin $VERSION
```

### 4.3 GitHub Release

```bash
gh release create $VERSION \
    --title "$VERSION - <里程碑名>" \
    --notes-file CHANGELOG.md \
    --target main
```

或者 GitHub 网页 → Releases → New release → Tag 选刚 push 的。

## 五、CHANGELOG.md 规范

格式：[Keep a Changelog](https://keepachangelog.com/)

```markdown
# Changelog

## [Unreleased]

### Added
- 待发版的新功能

### Changed
- 待发版的改动

### Fixed
- 待发版的 bug 修复

## [0.2.0] - 2026-07-15

### Added
- Router 层（feat/router）
- Review Gate（feat/review-gate）
- 实现 Skill: YoY 计算 / 渠道异常检测

### Changed
- 去掉 3 个专家分割，统一为单 Agent

### Removed
- experts/ 目录（迁移到 skills/process/ 和 skills/implementation/）

### Migration
- 自定义 expert 需要拆到 skill/process/ 和 skill/implementation/

## [0.1.0] - 2026-06-28

### Added
- MVP-1：单 Agent + 周报 Skill 全链路打通
- 服务器部署：阿里云轻量 + 阿里云 ECS
- Codex CLI + 中转站接入
- lark-cli + 飞书 bot
- 3 个 MCP server: data_tools / lark_tools / knowledge_base
- 原则层 9 节（5 个业务框架 + 4 个工程原则）
```

每条改动一行；分类放对（同一改动不重复写）。

## 六、谁能发版

| 角色 | 能不能发 |
|---|---|
| 人类 owner | ✅ 任意版本 |
| 人类 collaborator | ✅ PATCH，MINOR 要 owner approve |
| Agent | ❌ **永远不能直接发版**。Agent 准备 release notes + 提 PR，由人类 review + 发 |

## 七、Hotfix 流程（生产已部署时 bug 修复）

```bash
# 从 tag 拉 hotfix 分支
git checkout -b hotfix/v0.1.1-imap-bug v0.1.0
# 改、测、提交
git commit -m "fix(mcp-data): 修复 IMAP UTF-7 解码"
# 直接 push + 打 patch tag
git tag v0.1.1
git push origin hotfix/v0.1.1-imap-bug v0.1.1
# 走 PR 合回 main
gh pr create --base main --title "fix(mcp-data): 修复 IMAP UTF-7 解码 [hotfix v0.1.1]"
```

## 八、回退发布

如果某个 release 严重出问题：

```bash
# 1. 立刻 revert 那个 commit 在 main
git revert <bad-merge-sha>
git push origin main

# 2. 打新的 patch tag
git tag v0.2.1
git push origin v0.2.1

# 3. 在 GitHub release 页面标记旧版本 "broken"
gh release edit v0.2.0 --notes "⚠️ broken - 已被 v0.2.1 修复"
```

**不要**：删除 tag、强 push 改历史。

---

**版本**：v1.0  
**最后更新**：2026-06-28

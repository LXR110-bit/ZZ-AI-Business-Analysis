# Agent 锁机制

详细说明见 [CONTRIBUTING.md §六](../CONTRIBUTING.md#六多-agent-协作规则关键章节)。

## 快速使用

### 认领（开始干活前）

```bash
cat > .agent-locks/$(whoami)-$(date +%s).yml <<EOF
agent: claude            # 你是哪个 agent
branch: agent-claude/feat/router
files:                   # 你要改的文件/目录
  - router/
  - skills/process/weekly_report.md
started: $(date -Iseconds)
expected_done: $(date -Iseconds -d '+2 hours')
reason: 实现 router 层 + 迁移周报到新 skill 格式
EOF

git add .agent-locks/
git commit -m "lock(claude): claim router area"
git push origin <你的分支>
```

### 检查别人的锁（开始干活前必查）

```bash
ls .agent-locks/*.yml | xargs cat | grep -E "files:|agent:|branch:"
```

发现冲突 → **不要动**，找别的事或等。

### 释放（合并 PR 前最后一步）

```bash
git rm .agent-locks/claude-1234567890.yml
git commit -m "unlock(claude): release router area"
```

### 清理僵尸锁（任何人都可以）

```bash
# 超过 8 小时未完成的锁视为失效
find .agent-locks/ -name "*.yml" -mmin +480 -delete
git commit -am "chore(locks): GC stale agent locks"
```

## 强冲突区域（必须先锁）

见 CONTRIBUTING.md §6.3。

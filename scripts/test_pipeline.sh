#!/usr/bin/env bash
# 测试 MVP-1 端到端管道
# 用法：bash scripts/test_pipeline.sh [问题]
set -euo pipefail
set -a; . /root/secrets/.env; set +a
cd "$(dirname "$0")/.."

QUESTION="${1:-列出最近 5 封邮件，并展示主题、发件人、日期、附件名}"

echo "─── 问题 ───"
echo "$QUESTION"
echo
echo "─── 启动 codex exec ───"
timeout 300 codex exec \
    --skip-git-repo-check \
    --cd experts/daily_analyst \
    --dangerously-bypass-approvals-and-sandbox \
    "$QUESTION" < /dev/null

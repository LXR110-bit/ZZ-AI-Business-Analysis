#!/usr/bin/env bash
# ZZ-AI-Business-Analysis 一键安装脚本（运行在干净 Ubuntu 22.04 服务器上）
# 用法：bash scripts/setup.sh
set -euo pipefail

SECRETS_DIR=/root/secrets
SECRETS_FILE=$SECRETS_DIR/.env
[ -f "$SECRETS_FILE" ] || { echo "请先在 $SECRETS_FILE 写好密钥（参考 .env.example）"; exit 1; }
set -a; . "$SECRETS_FILE"; set +a

echo "[1/3] 安装 MCP server 依赖..."
for d in mcp_servers/data_tools mcp_servers/lark_tools mcp_servers/knowledge_base orchestrator; do
    (cd "$d" && uv sync --quiet)
done

echo "[2/3] 注册 lark-cli app..."
echo -n "$LARK_APP_SECRET" | lark-cli config init \
    --app-id "$LARK_APP_ID" \
    --app-secret-stdin \
    --brand feishu 2>/dev/null || true

echo "[3/3] 注入 Codex API key..."
printenv OPENAI_API_KEY | codex login --with-api-key 2>/dev/null || true

echo "✓ 安装完成。"
echo "  - 跑专家 A：python -m orchestrator '<你的问题>'"
echo "  - 启动 FastAPI webhook：uv run --project orchestrator uvicorn orchestrator.server:app --host 0.0.0.0 --port 8000"

#!/usr/bin/env bash
# 机型周数据线上日常链路 cron 入口
# 默认使用 local-imports 模式: IMAP 拉取邮件 → 解析 xlsx → 写本地 CSV + manifest + active 指针
# 不执行飞书 Base 明细导入或旧 Sheets 写入
#
# 邮件每天 06:30 前全部发送完毕，cron 06:30 开始执行
# 如果首次未拉到全部 6 封邮件 (IMAP 同步延迟)，等待后重试
#
# crontab 示例 (每天 06:30 执行):
#   30 6 * * * /path/to/scripts/机型周数据_cron.sh >> /var/log/机型周数据_cron.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

# 环境变量可覆盖默认值
LOOKBACK_DAYS="${LOOKBACK_DAYS:-14}"
LOCAL_IMPORT_OUTPUT_DIR="${LOCAL_IMPORT_OUTPUT_DIR:-data/imports}"
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_INTERVAL="${RETRY_INTERVAL:-120}"  # 秒，默认 2 分钟

attempt=0
while [ $attempt -lt "$MAX_RETRIES" ]; do
  attempt=$((attempt + 1))
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] attempt ${attempt}/${MAX_RETRIES}"

  result=$(python3 -m skills.workflows.机型周数据 \
    --local-imports \
    --lookback-days "${LOOKBACK_DAYS}" \
    --local-output-dir "${LOCAL_IMPORT_OUTPUT_DIR}" 2>&1) && {
    echo "$result"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] success on attempt ${attempt}"
    exit 0
  }

  # 检查是否因邮件缺失失败 (missing_mail_sources)
  if echo "$result" | grep -q "missing_mail_sources"; then
    echo "$result"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] missing mail sources, retry in ${RETRY_INTERVAL}s..."
    sleep "$RETRY_INTERVAL"
  else
    # 非邮件缺失的错误直接退出
    echo "$result"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] failed (non-retryable)" >&2
    exit 1
  fi
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] exhausted ${MAX_RETRIES} retries" >&2
exit 1

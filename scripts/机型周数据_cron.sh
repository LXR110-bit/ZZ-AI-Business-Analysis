#!/usr/bin/env bash
# 机型周数据线上日常链路 cron 入口
# 默认使用 local-imports 模式: IMAP 拉取邮件 → 解析 xlsx → 写本地 CSV + manifest + active 指针
# 不执行飞书 Base 明细导入或旧 Sheets 写入
#
# crontab 示例 (每天 09:40 执行):
#   40 9 * * * /path/to/scripts/机型周数据_cron.sh >> /var/log/机型周数据_cron.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

# 环境变量可覆盖默认值
LOOKBACK_DAYS="${LOOKBACK_DAYS:-14}"
LOCAL_IMPORT_OUTPUT_DIR="${LOCAL_IMPORT_OUTPUT_DIR:-data/imports}"

exec python3 -m skills.workflows.机型周数据 \
  --local-imports \
  --lookback-days "${LOOKBACK_DAYS}" \
  --local-output-dir "${LOCAL_IMPORT_OUTPUT_DIR}"

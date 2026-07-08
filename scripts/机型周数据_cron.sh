#!/usr/bin/env bash
# 机型周数据每日 cron 入口
# 默认保持服务器现场 legacy 飞书备份链路：拉近 14 天邮件 → 旧 Sheets/飞书备份写入 → --skip-notify 禁止机器人通知。
# 如需启用 PR #39 新本地 CSV 链路，显式设置 WORKFLOW_MODE=local-imports。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}" || exit 1

if [[ -f /root/secrets/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /root/secrets/.env
  set +a
fi

WORKFLOW_MODE="${WORKFLOW_MODE:-legacy-backup}"
LOOKBACK_DAYS="${LOOKBACK_DAYS:-14}"
CONCURRENCY="${CONCURRENCY:-4}"
LOCAL_IMPORT_OUTPUT_DIR="${LOCAL_IMPORT_OUTPUT_DIR:-data/imports}"
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_INTERVAL="${RETRY_INTERVAL:-120}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
TODAY="$(date +%Y%m%d)"
LOG_DIR="${LOG_DIR:-/root/logs}"
mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/机型周数据_${TODAY}.log"

run_legacy_backup() {
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') 机型周数据 legacy backup start ==="
  "${PYTHON_BIN}" -m skills.workflows.机型周数据     --lookback-days "${LOOKBACK_DAYS}"     --concurrency "${CONCURRENCY}"     --skip-notify
  code=$?
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') legacy backup exit code=${code} ==="
  return "${code}"
}

run_local_imports() {
  attempt=0
  while [ "${attempt}" -lt "${MAX_RETRIES}" ]; do
    attempt=$((attempt + 1))
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] local-imports attempt ${attempt}/${MAX_RETRIES}"
    result=$("${PYTHON_BIN}" -m skills.workflows.机型周数据       --local-imports       --lookback-days "${LOOKBACK_DAYS}"       --local-output-dir "${LOCAL_IMPORT_OUTPUT_DIR}" 2>&1)
    code=$?
    echo "${result}"
    if [ "${code}" -eq 0 ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] local-imports success on attempt ${attempt}"
      return 0
    fi
    if echo "${result}" | grep -q "missing_mail_sources"; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] missing mail sources, retry in ${RETRY_INTERVAL}s..."
      sleep "${RETRY_INTERVAL}"
    else
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] local-imports failed (non-retryable)" >&2
      return "${code}"
    fi
  done
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] exhausted ${MAX_RETRIES} retries" >&2
  return 1
}

{
  case "${WORKFLOW_MODE}" in
    legacy|legacy-backup|backup)
      run_legacy_backup
      ;;
    local|local-imports)
      run_local_imports
      ;;
    *)
      echo "unknown WORKFLOW_MODE=${WORKFLOW_MODE}; expected legacy-backup or local-imports" >&2
      exit 2
      ;;
  esac
} >> "${LOG}" 2>&1

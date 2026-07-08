#!/usr/bin/env bash
# model-tag-monitor v1.1.0 daily refresh flow
# 06:30 Asia/Shanghai: local CSV/cache refresh -> dashboard health -> style-2 Lark card.
set -Eeuo pipefail

VERSION="1.1.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(cd "$MONITOR_DIR/.." && pwd)"
API_BASE="${API_BASE:-http://127.0.0.1:8848}"
DASHBOARD_URL="${DASHBOARD_URL:-http://47.84.94.234:8848/?tab=dashboard}"
REPORT_URL="${REPORT_URL:-$DASHBOARD_URL}"
IMPORT_DIR="${IMPORT_DIR:-/root/workspace/ZZ-AI-Business-Analysis-base-migration/data/imports}"
TARGET_WEEKS="${TARGET_WEEKS:-2026-W18,2026-W19,2026-W20,2026-W21,2026-W22,2026-W23,2026-W24,2026-W25,2026-W26,2026-W27}"
KEEP_WEEKS="${KEEP_WEEKS:-10}"
LOG_DIR="${LOG_DIR:-$MONITOR_DIR/logs}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

# Production deploys model-tag-monitor as /root/model-tag-monitor, while the
# reusable Feishu sender still lives in the workspace repo. Resolve both layouts.
FEISHU_REPO_DIR="${FEISHU_REPO_DIR:-}"
if [[ -z "$FEISHU_REPO_DIR" ]]; then
  for candidate in \
    "$PARENT_DIR" \
    /root/workspace/ZZ-AI-Business-Analysis \
    /root/workspace/ZZ-AI-Business-Analysis-base-migration; do
    if [[ -f "$candidate/tools/feishu_push/send_card.py" ]]; then
      FEISHU_REPO_DIR="$candidate"
      break
    fi
  done
fi
OUTBOX_DIR="${OUTBOX_DIR:-${FEISHU_REPO_DIR:+$FEISHU_REPO_DIR/tools/feishu_push/outbox}}"
OUTBOX_DIR="${OUTBOX_DIR:-$LOG_DIR/outbox}"
mkdir -p "$LOG_DIR" "$OUTBOX_DIR"

# Cron has a minimal environment. Load shared secrets if present, then map the
# existing weekly-report chat id into this script's FEISHU_* variables.
if [[ "${LOAD_SECRETS:-1}" != "0" && -f /root/secrets/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /root/secrets/.env
  set +a
fi
FEISHU_CHAT_ID="${FEISHU_CHAT_ID:-${WEEKLY_REPORT_CHAT_ID:-}}"
FEISHU_OPEN_ID="${FEISHU_OPEN_ID:-${MY_OPEN_ID:-}}"

RUN_ID="$(date +%Y%m%dT%H%M%S%z)"
PAYLOAD_FILE="$LOG_DIR/weekly-card-payload-$RUN_ID.json"
LOG_FILE="$LOG_DIR/refresh-dashboard-daily-$RUN_ID.log"

log() { printf '[%s] %s\n' "$(date '+%F %T%z')" "$*" | tee -a "$LOG_FILE" >&2; }
post_json() {
  local path="$1"
  log "POST $path"
  curl -fsS --max-time 900 -H 'Content-Type: application/json' -X POST "$API_BASE$path" | tee -a "$LOG_FILE" >/dev/null
}
get_json() {
  local path="$1"
  log "GET $path"
  curl -fsS --max-time 300 "$API_BASE$path"
}

log "model-tag-monitor refresh start version=$VERSION api=$API_BASE import_dir=$IMPORT_DIR target_weeks=$TARGET_WEEKS feishu_repo=${FEISHU_REPO_DIR:-<not-found>}"

# 注意：IMPORT_DIR/TARGET_WEEKS 必须在 PM2 env 中配置，curl 调用不会修改已运行 Node 进程环境。
# ecosystem.config.js 已固定 v1.1.0 生产默认值；此处打印用于日志审计。
post_json /api/sync
post_json /api/sync/taxonomy
post_json /api/sync/category

DASHBOARD_JSON="$(get_json /api/dashboard)"
printf '%s' "$DASHBOARD_JSON" > "$LOG_DIR/dashboard-$RUN_ID.json"
node - <<'NODE' "$LOG_DIR/dashboard-$RUN_ID.json" "$TARGET_WEEKS"
const fs = require('fs');
const file = process.argv[2];
const expected = process.argv[3].split(',').filter(Boolean);
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const weeks = d.weeks || d.weekWindow || [];
if (d.version !== '1.1.0') throw new Error(`dashboard version != 1.1.0: ${d.version}`);
if (JSON.stringify(weeks) !== JSON.stringify(expected)) throw new Error(`dashboard weeks mismatch: ${weeks.join(',')} != ${expected.join(',')}`);
if (d.week !== expected[expected.length - 1]) throw new Error(`dashboard latest week mismatch: ${d.week}`);
if (!d.board || !Array.isArray(d.categories) || !d.categories.length) throw new Error('dashboard contract incomplete');
console.log(`[health] dashboard ok version=${d.version} week=${d.week} weeks=${weeks.join(',')} categories=${d.categories.length}`);
NODE

node "$SCRIPT_DIR/build-weekly-card-payload.js" \
  --api-base "$API_BASE" \
  --dashboard-url "$DASHBOARD_URL" \
  --report-url "$REPORT_URL" \
  --out "$PAYLOAD_FILE" | tee -a "$LOG_FILE"

PUSH_ARGS=(--template monitor_weekly --payload "$PAYLOAD_FILE" --outbox-dir "$OUTBOX_DIR")
if [[ "${FEISHU_DRY_RUN:-0}" == "1" || -z "${FEISHU_TEST_WEBHOOK:-}${FEISHU_CHAT_ID:-}${FEISHU_OPEN_ID:-}" ]]; then
  PUSH_ARGS+=(--dry-run)
  log "Feishu dry-run enabled or no receiver configured; writing outbox only"
fi
if [[ -n "${FEISHU_TEST_WEBHOOK:-}" ]]; then PUSH_ARGS+=(--webhook-url "$FEISHU_TEST_WEBHOOK"); fi
if [[ -n "${FEISHU_CHAT_ID:-}" ]]; then PUSH_ARGS+=(--chat-id "$FEISHU_CHAT_ID"); fi
if [[ -n "${FEISHU_OPEN_ID:-}" ]]; then PUSH_ARGS+=(--open-id "$FEISHU_OPEN_ID"); fi

if [[ -z "${FEISHU_REPO_DIR:-}" || ! -f "$FEISHU_REPO_DIR/tools/feishu_push/send_card.py" ]]; then
  OUTBOX_FILE="$OUTBOX_DIR/$(basename "$PAYLOAD_FILE")"
  cp "$PAYLOAD_FILE" "$OUTBOX_FILE"
  log "Feishu sender module not found; wrote payload outbox=$OUTBOX_FILE"
  log "model-tag-monitor refresh done with outbox fallback"
  exit 0
fi

log "send style-2 card"
(cd "$FEISHU_REPO_DIR" && "$PYTHON_BIN" -m tools.feishu_push.send_card "${PUSH_ARGS[@]}") | tee -a "$LOG_FILE"
log "model-tag-monitor refresh done"

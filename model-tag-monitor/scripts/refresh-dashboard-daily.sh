#!/usr/bin/env bash
# model-tag-monitor v1.4.5 daily refresh flow
# 06:30 Asia/Shanghai: local imports -> coverage gate -> cache sync -> AI -> style-2 Lark card.
set -Eeuo pipefail
export PATH="/root/.local/bin:/root/.nvm/versions/node/v20.20.2/bin:$PATH"

VERSION="1.4.5"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(cd "$MONITOR_DIR/.." && pwd)"
API_BASE="${API_BASE:-http://127.0.0.1:8848}"
DASHBOARD_URL="${DASHBOARD_URL:-http://47.84.94.234:8848/?tab=dashboard}"
REPORT_URL="${REPORT_URL:-$DASHBOARD_URL}"
IMPORT_DIR="${IMPORT_DIR:-/root/workspace/ZZ-AI-Business-Analysis-base-migration/data/imports}"
TARGET_WEEKS="${TARGET_WEEKS:-2026-W19,2026-W20,2026-W21,2026-W22,2026-W23,2026-W24,2026-W25,2026-W26,2026-W27,2026-W28}"
KEEP_WEEKS="${KEEP_WEEKS:-10}"
LOOKBACK_DAYS="${LOOKBACK_DAYS:-14}"
LOG_DIR="${LOG_DIR:-$MONITOR_DIR/logs}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
mkdir -p "$LOG_DIR"

SCRIPT_STARTED_AT="$(date -Iseconds)"
RUN_ID="$(date +%Y%m%dT%H%M%S%z)"
TARGET_WEEK="$(TARGET_WEEKS="$TARGET_WEEKS" node - <<'NODE'
const weeks = String(process.env.TARGET_WEEKS || '').split(',').map((w) => w.trim()).filter(Boolean);
if (!weeks.length) process.exit(1);
process.stdout.write(weeks[weeks.length - 1]);
NODE
)"
TARGET_MONTH="$(MONITOR_DIR="$MONITOR_DIR" TARGET_WEEK="$TARGET_WEEK" node - <<'NODE'
const { isoWeekToRange } = require(`${process.env.MONITOR_DIR}/src/week-utils`);
process.stdout.write(isoWeekToRange(process.env.TARGET_WEEK).monday.slice(0, 7));
NODE
)"
PAYLOAD_FILE="$LOG_DIR/weekly-card-payload-$RUN_ID.json"
ALERT_PAYLOAD_FILE="$LOG_DIR/daily-refresh-alert-$RUN_ID.json"
COVERAGE_FILE="$LOG_DIR/daily-import-coverage-$RUN_ID.json"
FINAL_COVERAGE_FILE="$LOG_DIR/daily-import-coverage-final-$RUN_ID.json"
LOG_FILE="$LOG_DIR/refresh-dashboard-daily-$RUN_ID.log"
STAGING_IMPORT_DIR="$LOG_DIR/local-imports-$RUN_ID"

# Production deploys model-tag-monitor as /root/model-tag-monitor, while the
# data workflow and reusable Feishu sender live in the workspace repo.
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
mkdir -p "$OUTBOX_DIR"

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

write_alert_payload() {
  local stage="$1"
  local message="$2"
  local detail_file="${3:-}"
  STAGE="$stage" \
  MESSAGE="$message" \
  TARGET_WEEKS="$TARGET_WEEKS" \
  RUN_ID="$RUN_ID" \
  SCRIPT_STARTED_AT="$SCRIPT_STARTED_AT" \
  LOG_FILE="$LOG_FILE" \
  DETAIL_FILE="$detail_file" \
  DASHBOARD_URL="$DASHBOARD_URL" \
  node - <<'NODE' > "$ALERT_PAYLOAD_FILE"
const fs = require('fs');
const targetWeeks = String(process.env.TARGET_WEEKS || '').split(',').filter(Boolean);
const targetWeek = targetWeeks[targetWeeks.length - 1] || '-';
const detailFile = process.env.DETAIL_FILE || '';
let detail = '';
if (detailFile && fs.existsSync(detailFile)) {
  try {
    const json = JSON.parse(fs.readFileSync(detailFile, 'utf8'));
    detail = `\n**覆盖状态**：${json.state || '-'}\n**预期覆盖日期**：${json.expectedDataEnd || '-'}\n**预期天数**：${json.expectedDays ?? '-'}\n**错误摘要**：${(json.errors || []).join('; ') || json.message || '-'}`;
  } catch (e) {
    detail = `\n**详情文件**：${detailFile}`;
  }
}
const body = [
  `**失败阶段**：${process.env.STAGE || '-'}`,
  `**目标周**：${targetWeek}`,
  `**本次 run**：${process.env.RUN_ID || '-'}`,
  `**开始时间**：${process.env.SCRIPT_STARTED_AT || '-'}`,
  `**处理结果**：页面保留上一成功版本；本次未继续生成 AI/经营卡片。`,
  `**错误信息**：${process.env.MESSAGE || '-'}`,
  detail,
  `**日志路径**：${process.env.LOG_FILE || '-'}`,
].filter(Boolean).join('\n');
process.stdout.write(JSON.stringify({
  title: `🚨 AI经营分析日更失败 · ${process.env.STAGE || 'unknown'}`,
  template_color: 'red',
  body,
  button_text: '打开 Dashboard',
  link_url: process.env.DASHBOARD_URL || '',
}, null, 2));
NODE
}

send_alert() {
  local stage="$1"
  local message="$2"
  local detail_file="${3:-}"
  write_alert_payload "$stage" "$message" "$detail_file"
  log "send failure alert stage=$stage payload=$ALERT_PAYLOAD_FILE"
  if [[ -z "${FEISHU_REPO_DIR:-}" || ! -f "$FEISHU_REPO_DIR/tools/feishu_push/send_card.py" ]]; then
    cp "$ALERT_PAYLOAD_FILE" "$OUTBOX_DIR/$(basename "$ALERT_PAYLOAD_FILE")"
    log "WARN: Feishu sender not found; alert written to outbox"
    return 0
  fi
  local args=(--template generic_alert --payload "$ALERT_PAYLOAD_FILE" --outbox-dir "$OUTBOX_DIR")
  if [[ "${FEISHU_DRY_RUN:-0}" == "1" || -z "${FEISHU_TEST_WEBHOOK:-}${FEISHU_CHAT_ID:-}${FEISHU_OPEN_ID:-}" ]]; then
    args+=(--dry-run)
  fi
  if [[ -n "${FEISHU_TEST_WEBHOOK:-}" ]]; then args+=(--webhook-url "$FEISHU_TEST_WEBHOOK"); fi
  if [[ -n "${FEISHU_CHAT_ID:-}" ]]; then args+=(--chat-id "$FEISHU_CHAT_ID"); fi
  if [[ -n "${FEISHU_OPEN_ID:-}" ]]; then args+=(--open-id "$FEISHU_OPEN_ID"); fi
  (cd "$FEISHU_REPO_DIR" && "$PYTHON_BIN" -m tools.feishu_push.send_card "${args[@]}") | tee -a "$LOG_FILE" || log "WARN: failure alert delivery failed; payload=$ALERT_PAYLOAD_FILE"
}

fail_stage() {
  local stage="$1"
  local message="$2"
  local detail_file="${3:-}"
  local code="${4:-1}"
  log "FAIL stage=$stage message=$message"
  send_alert "$stage" "$message" "$detail_file"
  exit "$code"
}

log "model-tag-monitor refresh start version=$VERSION api=$API_BASE import_dir=$IMPORT_DIR staging_import_dir=$STAGING_IMPORT_DIR target_weeks=$TARGET_WEEKS feishu_repo=${FEISHU_REPO_DIR:-<not-found>} run_id=$RUN_ID target_week=$TARGET_WEEK target_month=$TARGET_MONTH"

if [[ -z "${FEISHU_REPO_DIR:-}" || ! -d "$FEISHU_REPO_DIR/skills/workflows/机型周数据" ]]; then
  fail_stage "data-import" "data workflow repo not found; cannot run local-imports" "" 2
fi

log "run local-imports into staging dir"
if ! (cd "$FEISHU_REPO_DIR" && "$PYTHON_BIN" -m skills.workflows.机型周数据 \
  --local-imports \
  --lookback-days "$LOOKBACK_DAYS" \
  --months "$TARGET_MONTH" \
  --local-output-dir "$STAGING_IMPORT_DIR" \
  --local-run-id "$RUN_ID" \
  --skip-notify) 2>&1 | tee -a "$LOG_FILE"; then
  fail_stage "data-import" "local-imports failed; dashboard cache was not touched" "" 10
fi

log "validate staged import coverage"
if ! node "$SCRIPT_DIR/validate-daily-import-coverage.js" \
  --import-dir "$STAGING_IMPORT_DIR" \
  --target-weeks "$TARGET_WEEKS" \
  --run-id "$RUN_ID" \
  --started-at "$SCRIPT_STARTED_AT" \
  --out "$COVERAGE_FILE" | tee -a "$LOG_FILE"; then
  fail_stage "coverage" "staged import coverage validation failed; dashboard cache was not touched" "$COVERAGE_FILE" 11
fi

log "promote staged imports into production import dir"
if ! node "$SCRIPT_DIR/promote-local-imports.js" \
  --source-dir "$STAGING_IMPORT_DIR" \
  --dest-dir "$IMPORT_DIR" \
  --run-id "$RUN_ID" | tee -a "$LOG_FILE"; then
  fail_stage "promote" "failed to promote validated imports; dashboard cache was not touched" "$COVERAGE_FILE" 12
fi

log "validate promoted import coverage"
if ! node "$SCRIPT_DIR/validate-daily-import-coverage.js" \
  --import-dir "$IMPORT_DIR" \
  --target-weeks "$TARGET_WEEKS" \
  --run-id "$RUN_ID" \
  --started-at "$SCRIPT_STARTED_AT" \
  --out "$FINAL_COVERAGE_FILE" | tee -a "$LOG_FILE"; then
  fail_stage "coverage" "promoted import coverage validation failed; dashboard cache was not touched" "$FINAL_COVERAGE_FILE" 13
fi

BOARD_METRICS_OUT="$IMPORT_DIR/board_metrics_feishu.csv"
log "sync board metrics from Feishu sheet -> $BOARD_METRICS_OUT"
if ! node "$SCRIPT_DIR/sync-board-metrics-from-feishu.js" --out "$BOARD_METRICS_OUT" | tee -a "$LOG_FILE"; then
  fail_stage "board-metrics" "Feishu board metrics materialization failed; dashboard cache was not touched" "$FINAL_COVERAGE_FILE" 14
fi
log "Feishu board metrics materialized"

# Only after local-imports and boundary validation pass can dashboard caches be refreshed.
post_json /api/sync || fail_stage "sync" "POST /api/sync failed" "$FINAL_COVERAGE_FILE" 20
post_json /api/sync/taxonomy || fail_stage "sync" "POST /api/sync/taxonomy failed" "$FINAL_COVERAGE_FILE" 21
post_json /api/sync/category || fail_stage "sync" "POST /api/sync/category failed" "$FINAL_COVERAGE_FILE" 22
post_json /api/sync/board || fail_stage "sync" "POST /api/sync/board failed" "$FINAL_COVERAGE_FILE" 23

DASHBOARD_JSON="$(get_json /api/dashboard)" || fail_stage "sync" "GET /api/dashboard failed after sync" "$FINAL_COVERAGE_FILE" 24
printf '%s' "$DASHBOARD_JSON" > "$LOG_DIR/dashboard-$RUN_ID.json"
if ! node - <<'NODE' "$LOG_DIR/dashboard-$RUN_ID.json" "$TARGET_WEEKS" "$VERSION" | tee -a "$LOG_FILE"; then
const fs = require('fs');
const file = process.argv[2];
const expected = process.argv[3].split(',').filter(Boolean);
const version = process.argv[4];
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const weeks = d.weeks || d.weekWindow || [];
if (d.version !== version) throw new Error(`dashboard version != ${version}: ${d.version}`);
if (JSON.stringify(weeks) !== JSON.stringify(expected)) throw new Error(`dashboard weeks mismatch: ${weeks.join(',')} != ${expected.join(',')}`);
if (d.week !== expected[expected.length - 1]) throw new Error(`dashboard latest week mismatch: ${d.week}`);
if (!d.board || !Array.isArray(d.categories) || !d.categories.length) throw new Error('dashboard contract incomplete');
console.log(`[health] dashboard ok version=${d.version} week=${d.week} weeks=${weeks.join(',')} categories=${d.categories.length}`);
NODE
  fail_stage "sync" "dashboard health check failed" "$FINAL_COVERAGE_FILE" 25
fi

log "generate business overview insights cache after data sync success"
if ! BUSINESS_OVERVIEW_AI_ENABLED="${BUSINESS_OVERVIEW_AI_ENABLED:-1}" \
  node "$SCRIPT_DIR/generate-business-overview-insights.js" --api-base "$API_BASE" | tee -a "$LOG_FILE"; then
  fail_stage "ai" "business overview insights generation failed after data sync" "$FINAL_COVERAGE_FILE" 30
fi
log "business overview insights cache generated"

if ! node "$SCRIPT_DIR/build-weekly-card-payload.js" \
  --api-base "$API_BASE" \
  --dashboard-url "$DASHBOARD_URL" \
  --report-url "$REPORT_URL" \
  --out "$PAYLOAD_FILE" | tee -a "$LOG_FILE"; then
  fail_stage "payload" "weekly card payload generation failed" "$FINAL_COVERAGE_FILE" 40
fi

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
if ! (cd "$FEISHU_REPO_DIR" && "$PYTHON_BIN" -m tools.feishu_push.send_card "${PUSH_ARGS[@]}") | tee -a "$LOG_FILE"; then
  fail_stage "push" "weekly card push failed" "$FINAL_COVERAGE_FILE" 50
fi
log "model-tag-monitor refresh done"

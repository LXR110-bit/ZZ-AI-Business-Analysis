#!/usr/bin/env bash
# AI 小万 v1.5.5 Feishu AI business summary sidecar flow.
# Server-side pull/copy zloop artifacts -> build/check ai_business_summary payload -> render dry-run outbox.
# This script intentionally never sends to real Feishu receivers; monitor_weekly production push stays in refresh-dashboard-daily.sh.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITOR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(cd "$MONITOR_DIR/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-python3}"
RUN_ID="${RUN_ID:-$(date +%Y%m%dT%H%M%S%z)}"
RUN_DT="${RUN_DT:-$(date +%F)}"
DASHBOARD_URL="${DASHBOARD_URL:-http://47.84.94.234:8848/?tab=dashboard}"
REPORT_URL="${REPORT_URL:-$DASHBOARD_URL}"
ZLOOP_URL="${ZLOOP_URL:-}"
LOG_ROOT="${LOG_ROOT:-$MONITOR_DIR/logs/ai-business-summary}"
WORK_DIR="${WORK_DIR:-$LOG_ROOT/$RUN_ID}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$WORK_DIR/artifacts}"
PAYLOAD_FILE="${PAYLOAD_FILE:-$WORK_DIR/ai-business-card-payload-$RUN_ID.json}"
QUALITY_FILE="${QUALITY_FILE:-$WORK_DIR/ai-business-card-quality-$RUN_ID.json}"
LOG_FILE="${LOG_FILE:-$WORK_DIR/render-ai-business-summary-dry-run-$RUN_ID.log}"
ZLOOP_ARTIFACT_SOURCE_DIR="${ZLOOP_ARTIFACT_SOURCE_DIR:-}"
ZLOOP_ARTIFACT_PULL_CMD="${ZLOOP_ARTIFACT_PULL_CMD:-}"
INSIGHTS_FILE="${INSIGHTS_FILE:-}"
SUMMARY_FILE="${SUMMARY_FILE:-}"
FINAL_STATUS_FILE="${FINAL_STATUS_FILE:-}"
VALIDATION_REPORT_FILE="${VALIDATION_REPORT_FILE:-}"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Options:
  --source-dir <dir>              Directory containing zloop artifacts to copy into the run workspace.
  --insights <file>               insights.json path (required unless --source-dir or ZLOOP_ARTIFACT_PULL_CMD provides it).
  --summary <file>                summary.md path (optional).
  --final-status <file>           final_status.json path (optional).
  --validation-report <file>      validation_report.json path (optional).
  --run-dt <YYYY-MM-DD>           Business date for the card (default: today).
  --report-url <url>              Button URL for the zloop summary/report artifact.
  --dashboard-url <url>           Button URL for the dashboard.
  --zloop-url <url>               Optional zloop run URL kept in payload metadata.
  --work-dir <dir>                Run workspace (default: logs/ai-business-summary/<RUN_ID>).
  --outbox-dir <dir>              Dry-run outbox directory.

Environment pull hook:
  ZLOOP_ARTIFACT_PULL_CMD         Optional command executed with RUN_DT and ARTIFACT_DIR exported.
                                  The command must write insights.json and optional summary.md,
                                  final_status.json, validation_report.json into ARTIFACT_DIR.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-dir) ZLOOP_ARTIFACT_SOURCE_DIR="$2"; shift 2 ;;
    --insights) INSIGHTS_FILE="$2"; shift 2 ;;
    --summary) SUMMARY_FILE="$2"; shift 2 ;;
    --final-status) FINAL_STATUS_FILE="$2"; shift 2 ;;
    --validation-report) VALIDATION_REPORT_FILE="$2"; shift 2 ;;
    --run-dt) RUN_DT="$2"; shift 2 ;;
    --report-url) REPORT_URL="$2"; shift 2 ;;
    --dashboard-url) DASHBOARD_URL="$2"; shift 2 ;;
    --zloop-url) ZLOOP_URL="$2"; shift 2 ;;
    --work-dir) WORK_DIR="$2"; ARTIFACT_DIR="$2/artifacts"; PAYLOAD_FILE="$2/ai-business-card-payload-$RUN_ID.json"; QUALITY_FILE="$2/ai-business-card-quality-$RUN_ID.json"; LOG_FILE="$2/render-ai-business-summary-dry-run-$RUN_ID.log"; shift 2 ;;
    --outbox-dir) OUTBOX_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

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
OUTBOX_DIR="${OUTBOX_DIR:-$WORK_DIR/outbox}"

mkdir -p "$WORK_DIR" "$ARTIFACT_DIR" "$OUTBOX_DIR"

log() { printf '[%s] %s\n' "$(date '+%F %T%z')" "$*" | tee -a "$LOG_FILE" >&2; }

copy_if_exists() {
  local src="$1"
  local dst="$2"
  [[ -f "$src" ]] || return 0
  cp "$src" "$dst"
  log "pulled artifact $(basename "$dst") from $src"
}

log "ai_business_summary dry-run start run_id=$RUN_ID run_dt=$RUN_DT work_dir=$WORK_DIR outbox_dir=$OUTBOX_DIR"

if [[ -n "$ZLOOP_ARTIFACT_PULL_CMD" ]]; then
  log "run zloop artifact pull hook into $ARTIFACT_DIR"
  RUN_DT="$RUN_DT" ARTIFACT_DIR="$ARTIFACT_DIR" bash -lc "$ZLOOP_ARTIFACT_PULL_CMD" 2>&1 | tee -a "$LOG_FILE"
elif [[ -n "$ZLOOP_ARTIFACT_SOURCE_DIR" ]]; then
  if [[ ! -d "$ZLOOP_ARTIFACT_SOURCE_DIR" ]]; then
    log "source dir not found: $ZLOOP_ARTIFACT_SOURCE_DIR"
    exit 3
  fi
  copy_if_exists "$ZLOOP_ARTIFACT_SOURCE_DIR/insights.json" "$ARTIFACT_DIR/insights.json"
  copy_if_exists "$ZLOOP_ARTIFACT_SOURCE_DIR/summary.md" "$ARTIFACT_DIR/summary.md"
  copy_if_exists "$ZLOOP_ARTIFACT_SOURCE_DIR/final_status.json" "$ARTIFACT_DIR/final_status.json"
  copy_if_exists "$ZLOOP_ARTIFACT_SOURCE_DIR/validation_report.json" "$ARTIFACT_DIR/validation_report.json"
fi

INSIGHTS_FILE="${INSIGHTS_FILE:-$ARTIFACT_DIR/insights.json}"
SUMMARY_FILE="${SUMMARY_FILE:-$ARTIFACT_DIR/summary.md}"
FINAL_STATUS_FILE="${FINAL_STATUS_FILE:-$ARTIFACT_DIR/final_status.json}"
VALIDATION_REPORT_FILE="${VALIDATION_REPORT_FILE:-$ARTIFACT_DIR/validation_report.json}"

if [[ ! -f "$INSIGHTS_FILE" ]]; then
  log "insights artifact missing: $INSIGHTS_FILE"
  exit 4
fi

BUILD_ARGS=(--insights "$INSIGHTS_FILE" --out "$PAYLOAD_FILE" --run-dt "$RUN_DT" --report-url "$REPORT_URL" --dashboard-url "$DASHBOARD_URL")
[[ -f "$SUMMARY_FILE" ]] && BUILD_ARGS+=(--summary "$SUMMARY_FILE")
[[ -f "$FINAL_STATUS_FILE" ]] && BUILD_ARGS+=(--final-status "$FINAL_STATUS_FILE")
[[ -f "$VALIDATION_REPORT_FILE" ]] && BUILD_ARGS+=(--validation-report "$VALIDATION_REPORT_FILE")
[[ -n "$ZLOOP_URL" ]] && BUILD_ARGS+=(--zloop-url "$ZLOOP_URL")

log "build ai_business_summary payload"
node "$SCRIPT_DIR/build-ai-business-card-payload.js" "${BUILD_ARGS[@]}" 2>&1 | tee -a "$LOG_FILE"

log "check ai_business_summary payload quality"
node "$SCRIPT_DIR/check-ai-business-card-payload.js" --payload "$PAYLOAD_FILE" --run-dt "$RUN_DT" --out "$QUALITY_FILE" 2>&1 | tee -a "$LOG_FILE"

if [[ -z "${FEISHU_REPO_DIR:-}" || ! -f "$FEISHU_REPO_DIR/tools/feishu_push/send_card.py" ]]; then
  cp "$PAYLOAD_FILE" "$OUTBOX_DIR/$(basename "$PAYLOAD_FILE")"
  log "Feishu sender not found; copied payload to outbox only"
  echo "{\"ok\":true,\"mode\":\"payload_outbox\",\"payload\":\"$PAYLOAD_FILE\",\"quality\":\"$QUALITY_FILE\",\"outbox_dir\":\"$OUTBOX_DIR\"}"
  exit 0
fi

log "render ai_business_summary Feishu card as dry-run outbox (hard gated; no receiver args are used)"
(
  cd "$FEISHU_REPO_DIR"
  "$PYTHON_BIN" "$FEISHU_REPO_DIR/tools/feishu_push/send_card.py" \
    --template ai_business_summary \
    --payload "$PAYLOAD_FILE" \
    --dry-run \
    --outbox-dir "$OUTBOX_DIR"
) 2>&1 | tee -a "$LOG_FILE"

log "ai_business_summary dry-run done payload=$PAYLOAD_FILE quality=$QUALITY_FILE"
echo "{\"ok\":true,\"mode\":\"dry_run_outbox\",\"payload\":\"$PAYLOAD_FILE\",\"quality\":\"$QUALITY_FILE\",\"outbox_dir\":\"$OUTBOX_DIR\"}"

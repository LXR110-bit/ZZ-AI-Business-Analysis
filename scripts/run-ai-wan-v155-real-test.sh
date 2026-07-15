#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DT=""
RAW_EXPORT_DIR=""
OUT_DIR=""
SERVER_SNAPSHOT_DIR="$ROOT_DIR/model-tag-monitor/data"
PREVIOUS_PROCESSED_CACHE=""
MODEL_TAG_SOURCE="file"
MODEL_TAG_API_BASE="${MODEL_TAG_API_BASE:-}"
MODEL_TAG_ACCESS_CODE="${MODEL_TAG_ACCESS_CODE:-}"
MODEL_TAG_COOKIE="${API_COOKIE:-}"
ALLOW_FILE_FALLBACK="1"
FEISHU_KNOWLEDGE_DOC="${FEISHU_KNOWLEDGE_DOC:-}"
FEISHU_DRY_RUN="0"
ANALYSIS_ARTIFACT_DIR=""
REPORT_URL=""
DASHBOARD_URL=""
SKIP_TAG_EXPORT="0"
SKIP_FULL_NPM_TEST="0"
KEEP_WORK="0"

usage() {
  cat <<USAGE
Usage: scripts/run-ai-wan-v155-real-test.sh --run-dt YYYY-MM-DD --raw-export-dir DIR [options]

Runs AI 小万 v1.5.5 real-scenario local replay:
  1) Fetch package raw xinghe exports -> raw_cache
  2) Export model tag snapshot/knowledge/sync manifest (API or file)
  3) Process raw_cache -> server_cache_bundle/analysis_history/data_quality_report/active_process_manifest
  4) Validate local artifacts and print zloop Analyze/Validate handoff paths
  5) Optional: if --analysis-artifact-dir is provided, render server AI card dry-run/outbox

Required:
  --run-dt YYYY-MM-DD              Business date, usually T-1.
  --raw-export-dir DIR             Directory containing six xinghe raw CSV exports:
                                  category_daily_avg*.csv, category_summary*.csv,
                                  category_fulfill_daily_avg*.csv, category_fulfill_summary*.csv,
                                  model_daily_avg*.csv, model_summary*.csv

Options:
  --out-dir DIR                    Test output root. Default: /tmp/ai-wan-v155-real-test-<run_dt>
  --server-snapshot-dir DIR        model-tag-monitor data dir for tags/tag-vocab/rules fallback.
                                  Default: model-tag-monitor/data
  --previous-processed-cache ZIP   Previous processed_cache zip for history merge/final freeze replay.
  --model-tag-source api|file      Tag source for standalone exporter. Default: file.
  --model-tag-api-base URL         model-tag-monitor API base. Env: MODEL_TAG_API_BASE.
  --model-tag-access-code CODE     Access code. Env: MODEL_TAG_ACCESS_CODE.
  --model-tag-cookie COOKIE        Cookie header. Env: API_COOKIE.
  --no-file-fallback               Disable API -> file fallback for model tag export.
  --feishu-doc DOC_OR_URL          Optional Feishu Doc/Wiki token/URL for tag summary sync. Env: FEISHU_KNOWLEDGE_DOC.
  --feishu-dry-run                 Dry-run lark-cli docs update when --feishu-doc is set.
  --skip-tag-export                Skip standalone model-tag exporter smoke; Process still reads --server-snapshot-dir.
  --analysis-artifact-dir DIR      Optional directory containing Analyze/Validate final artifacts for card dry-run.
                                  Expected files can be dated names or standard names:
                                  insights_<run_dt>.json or insights.json,
                                  summary_<run_dt>.md or summary.md,
                                  final_status_<run_dt>.json or final_status.json,
                                  validation_report_<run_dt>.json or validation_report.json.
  --report-url URL                 Report button URL for AI card dry-run.
  --dashboard-url URL              Dashboard button URL for AI card dry-run.
  --skip-full-npm-test             Skip full model-tag-monitor npm test; targeted tests still run.
  --keep-work                      Keep intermediate dirs even if a step fails.
  -h, --help                       Show this help.

Outputs under --out-dir:
  01_fetch/
  02_process/
  03_tag_export/
  04_card/                 (only with --analysis-artifact-dir)
  99_validation_summary.json
USAGE
}

log() { printf '\n\033[1;34m[%s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\n\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
fail() { printf '\n\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-dt) RUN_DT="$2"; shift 2 ;;
    --raw-export-dir) RAW_EXPORT_DIR="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --server-snapshot-dir) SERVER_SNAPSHOT_DIR="$2"; shift 2 ;;
    --previous-processed-cache) PREVIOUS_PROCESSED_CACHE="$2"; shift 2 ;;
    --model-tag-source) MODEL_TAG_SOURCE="$2"; shift 2 ;;
    --model-tag-api-base) MODEL_TAG_API_BASE="$2"; shift 2 ;;
    --model-tag-access-code) MODEL_TAG_ACCESS_CODE="$2"; shift 2 ;;
    --model-tag-cookie) MODEL_TAG_COOKIE="$2"; shift 2 ;;
    --no-file-fallback) ALLOW_FILE_FALLBACK="0"; shift ;;
    --feishu-doc) FEISHU_KNOWLEDGE_DOC="$2"; shift 2 ;;
    --feishu-dry-run) FEISHU_DRY_RUN="1"; shift ;;
    --skip-tag-export) SKIP_TAG_EXPORT="1"; shift ;;
    --analysis-artifact-dir) ANALYSIS_ARTIFACT_DIR="$2"; shift 2 ;;
    --report-url) REPORT_URL="$2"; shift 2 ;;
    --dashboard-url) DASHBOARD_URL="$2"; shift 2 ;;
    --skip-full-npm-test) SKIP_FULL_NPM_TEST="1"; shift ;;
    --keep-work) KEEP_WORK="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[[ -n "$RUN_DT" ]] || fail "--run-dt is required"
[[ "$RUN_DT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "--run-dt must be YYYY-MM-DD"
[[ -n "$RAW_EXPORT_DIR" ]] || fail "--raw-export-dir is required"
RAW_EXPORT_DIR="$(cd "$RAW_EXPORT_DIR" && pwd)" || fail "raw export dir not found: $RAW_EXPORT_DIR"
[[ -d "$SERVER_SNAPSHOT_DIR" ]] || fail "server snapshot dir not found: $SERVER_SNAPSHOT_DIR"
SERVER_SNAPSHOT_DIR="$(cd "$SERVER_SNAPSHOT_DIR" && pwd)"
if [[ -z "$OUT_DIR" ]]; then OUT_DIR="/tmp/ai-wan-v155-real-test-$RUN_DT"; fi
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

FETCH_DIR="$OUT_DIR/01_fetch"
PROCESS_DIR="$OUT_DIR/02_process"
TAG_DIR="$OUT_DIR/03_tag_export"
CARD_DIR="$OUT_DIR/04_card"
SUMMARY_FILE="$OUT_DIR/99_validation_summary.json"
mkdir -p "$FETCH_DIR" "$PROCESS_DIR" "$TAG_DIR" "$CARD_DIR"

REQUIRED_PREFIXES=(
  category_daily_avg
  category_summary
  category_fulfill_daily_avg
  category_fulfill_summary
  model_daily_avg
  model_summary
)

log "Checking required raw CSV exports in $RAW_EXPORT_DIR"
for prefix in "${REQUIRED_PREFIXES[@]}"; do
  compgen -G "$RAW_EXPORT_DIR/${prefix}*.csv" >/dev/null || fail "Missing raw CSV: ${prefix}*.csv in $RAW_EXPORT_DIR"
  printf '  OK %s -> %s\n' "$prefix" "$(ls "$RAW_EXPORT_DIR"/${prefix}*.csv | head -1)"
done

log "Running targeted local tests for Fetch/Process"
node --test \
  "$ROOT_DIR/zloop-skills/ai-wan-data-fetch/test/package-raw-cache.test.js" \
  "$ROOT_DIR/zloop-skills/ai-wan-data-process/test/process-pipeline.test.js"

log "Running targeted local tests for model tag exporter and AI card"
(
  cd "$ROOT_DIR/model-tag-monitor"
  node --test test/model-tag-snapshot.test.js test/ai-business-card-payload.test.js
)

if [[ "$SKIP_FULL_NPM_TEST" != "1" ]]; then
  log "Running full model-tag-monitor npm test"
  (cd "$ROOT_DIR/model-tag-monitor" && npm test)
else
  warn "Skipping full npm test by request"
fi

log "Running Fetch packageRawCache"
node "$ROOT_DIR/zloop-skills/ai-wan-data-fetch/bin/package-raw-cache.js" \
  --run-dt "$RUN_DT" \
  --input-dir "$RAW_EXPORT_DIR" \
  --out-dir "$FETCH_DIR"
unzip -tq "$FETCH_DIR/raw_cache_${RUN_DT}.zip"

log "Checking Fetch manifest"
python3 - "$FETCH_DIR" "$RUN_DT" <<'PY'
import json, pathlib, sys
fetch_dir = pathlib.Path(sys.argv[1]); run_dt = sys.argv[2]
active = json.loads((fetch_dir/'active_fetch_manifest.json').read_text())
status = active.get('status')
print(json.dumps({k: active.get(k) for k in ['stage','status','run_id','run_dt','raw_cache','raw_cache_sha256','sha256']}, ensure_ascii=False, indent=2))
if active.get('stage') != 'fetch': raise SystemExit('active_fetch_manifest.stage != fetch')
if active.get('run_dt') != run_dt: raise SystemExit('active_fetch_manifest.run_dt mismatch')
if status != 'success': raise SystemExit(f'Fetch status is {status}, expected success')
PY

if [[ "$SKIP_TAG_EXPORT" != "1" ]]; then
  log "Running standalone model tag export ($MODEL_TAG_SOURCE)"
  TAG_CMD=(node "$ROOT_DIR/model-tag-monitor/scripts/export-model-tag-snapshot.js" --source "$MODEL_TAG_SOURCE" --run-dt "$RUN_DT" --out-dir "$TAG_DIR" --quiet)
  if [[ "$MODEL_TAG_SOURCE" == "api" ]]; then
    [[ -n "$MODEL_TAG_API_BASE" ]] && TAG_CMD+=(--api-base "$MODEL_TAG_API_BASE")
    [[ -n "$MODEL_TAG_ACCESS_CODE" ]] && TAG_CMD+=(--access-code "$MODEL_TAG_ACCESS_CODE")
    [[ -n "$MODEL_TAG_COOKIE" ]] && TAG_CMD+=(--cookie "$MODEL_TAG_COOKIE")
    if [[ "$ALLOW_FILE_FALLBACK" == "1" ]]; then TAG_CMD+=(--allow-file-fallback --fallback-data-dir "$SERVER_SNAPSHOT_DIR"); fi
  else
    TAG_CMD+=(--data-dir "$SERVER_SNAPSHOT_DIR")
  fi
  [[ -n "$FEISHU_KNOWLEDGE_DOC" ]] && TAG_CMD+=(--feishu-doc "$FEISHU_KNOWLEDGE_DOC")
  [[ "$FEISHU_DRY_RUN" == "1" ]] && TAG_CMD+=(--feishu-dry-run)
  "${TAG_CMD[@]}" | tee "$TAG_DIR/export-result.json"
fi

log "Running Process processRawCache"
PROCESS_CMD=(node "$ROOT_DIR/zloop-skills/ai-wan-data-process/bin/process-raw-cache.js" --run-dt "$RUN_DT" --input-dir "$FETCH_DIR" --out-dir "$PROCESS_DIR" --snapshot-dir "$SERVER_SNAPSHOT_DIR")
if [[ -n "$PREVIOUS_PROCESSED_CACHE" ]]; then
  [[ -f "$PREVIOUS_PROCESSED_CACHE" ]] || fail "previous processed cache not found: $PREVIOUS_PROCESSED_CACHE"
  PROCESS_CMD+=(--previous-processed-cache "$PREVIOUS_PROCESSED_CACHE")
fi
"${PROCESS_CMD[@]}"

unzip -tq "$PROCESS_DIR/processed_cache_${RUN_DT}.zip"
unzip -tq "$PROCESS_DIR/server_cache_bundle_${RUN_DT}.zip"

log "Checking Process artifacts"
python3 - "$PROCESS_DIR" "$RUN_DT" <<'PY'
import json, pathlib, sys
process_dir = pathlib.Path(sys.argv[1]); run_dt = sys.argv[2]
required = [
  'active_process_manifest.json',
  f'analysis_history_{run_dt}.json',
  f'data_quality_report_{run_dt}.json',
  f'model_tag_snapshot_{run_dt}.json',
  f'model_tag_knowledge_{run_dt}.json',
  f'processed_cache_{run_dt}.zip',
  f'server_cache_bundle_{run_dt}.zip',
]
missing = [f for f in required if not (process_dir/f).exists()]
if missing: raise SystemExit(f'Missing Process artifacts: {missing}')
active = json.loads((process_dir/'active_process_manifest.json').read_text())
print(json.dumps({
  'stage': active.get('stage'),
  'status': active.get('status'),
  'run_dt': active.get('run_dt'),
  'history_weeks': active.get('history_weeks'),
  'history_weeks_available': active.get('history_weeks_available'),
  'analysis_history': active.get('analysis_history'),
  'model_tag_knowledge': active.get('model_tag_knowledge'),
  'quality_gates': active.get('quality_gates'),
  'known_gaps': active.get('known_gaps'),
}, ensure_ascii=False, indent=2))
if active.get('stage') != 'process': raise SystemExit('active_process_manifest.stage != process')
if active.get('run_dt') != run_dt: raise SystemExit('active_process_manifest.run_dt mismatch')
if active.get('status') not in ('success','warn'): raise SystemExit(f'Process status {active.get("status")} is not success|warn')
if int(active.get('history_weeks_available') or 0) < 8:
    print('WARN history_weeks_available < 8: Analyze must downgrade to wow_only')
PY

log "Running package-check for all four skills"
for d in \
  "$ROOT_DIR/zloop-skills/ai-wan-data-fetch" \
  "$ROOT_DIR/zloop-skills/ai-wan-data-process" \
  "$ROOT_DIR/zloop-skills/ai-wan-business-analyze" \
  "$ROOT_DIR/zloop-skills/ai-wan-business-validate"
do
  zloop skill-forge package-check "$d"
done

CARD_STATUS="skipped"
if [[ -n "$ANALYSIS_ARTIFACT_DIR" ]]; then
  ANALYSIS_ARTIFACT_DIR="$(cd "$ANALYSIS_ARTIFACT_DIR" && pwd)" || fail "analysis artifact dir not found: $ANALYSIS_ARTIFACT_DIR"
  log "Preparing Analyze/Validate artifacts for server AI-card dry-run"
  STANDARD_DIR="$CARD_DIR/zloop_final_artifacts"
  mkdir -p "$STANDARD_DIR"
  find_artifact() {
    local base="$1" ext="$2" src=""
    for candidate in "$ANALYSIS_ARTIFACT_DIR/${base}_${RUN_DT}.${ext}" "$ANALYSIS_ARTIFACT_DIR/${base}.${ext}"; do
      [[ -f "$candidate" ]] && { src="$candidate"; break; }
    done
    [[ -n "$src" ]] || return 1
    printf '%s' "$src"
  }
  cp "$(find_artifact insights json)" "$STANDARD_DIR/insights.json"
  if src="$(find_artifact summary md 2>/dev/null)"; then cp "$src" "$STANDARD_DIR/summary.md"; fi
  if src="$(find_artifact final_status json 2>/dev/null)"; then cp "$src" "$STANDARD_DIR/final_status.json"; fi
  if src="$(find_artifact validation_report json 2>/dev/null)"; then cp "$src" "$STANDARD_DIR/validation_report.json"; fi
  REPORT_URL="${REPORT_URL:-https://example.com/ai-wan-zloop-report/$RUN_DT}"
  DASHBOARD_URL="${DASHBOARD_URL:-https://example.com/ai-wan-dashboard}"
  "$ROOT_DIR/model-tag-monitor/scripts/render-ai-business-summary-dry-run.sh" \
    --source-dir "$STANDARD_DIR" \
    --run-dt "$RUN_DT" \
    --report-url "$REPORT_URL" \
    --dashboard-url "$DASHBOARD_URL" \
    --outbox-dir "$CARD_DIR/outbox"
  CARD_STATUS="pass"
else
  warn "No --analysis-artifact-dir provided; skipping server AI-card dry-run. Run it after zloop Analyze/Validate outputs are downloaded."
fi

log "Writing validation summary"
python3 - "$SUMMARY_FILE" "$RUN_DT" "$OUT_DIR" "$FETCH_DIR" "$PROCESS_DIR" "$TAG_DIR" "$CARD_DIR" "$CARD_STATUS" <<'PY'
import json, pathlib, sys, datetime
summary_file, run_dt, out_dir, fetch_dir, process_dir, tag_dir, card_dir, card_status = sys.argv[1:]
process_active = json.loads((pathlib.Path(process_dir)/'active_process_manifest.json').read_text())
fetch_active = json.loads((pathlib.Path(fetch_dir)/'active_fetch_manifest.json').read_text())
summary = {
  'ok': True,
  'run_dt': run_dt,
  'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'out_dir': out_dir,
  'fetch': {
    'status': fetch_active.get('status'),
    'run_id': fetch_active.get('run_id'),
    'dir': fetch_dir,
  },
  'process': {
    'status': process_active.get('status'),
    'run_id': process_active.get('run_id'),
    'history_weeks_available': process_active.get('history_weeks_available'),
    'analysis_scope_expected': 'trend_10w' if int(process_active.get('history_weeks_available') or 0) >= 8 else 'wow_only',
    'known_gaps': process_active.get('known_gaps') or [],
    'dir': process_dir,
  },
  'tag_export_dir': tag_dir,
  'card': {'status': card_status, 'dir': card_dir},
  'next_zloop_inputs': {
    'active_process_manifest': f'{process_dir}/active_process_manifest.json',
    'analysis_history': f'{process_dir}/analysis_history_{run_dt}.json',
    'model_tag_knowledge': f'{process_dir}/model_tag_knowledge_{run_dt}.json',
  },
  'dry_run_policy': {'publish_allowed': False, 'push_allowed': False},
}
pathlib.Path(summary_file).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
PY

log "DONE"
printf '\nSummary: %s\n' "$SUMMARY_FILE"
printf 'Fetch dir: %s\n' "$FETCH_DIR"
printf 'Process dir: %s\n' "$PROCESS_DIR"
printf 'Next zloop Analyze inputs:\n'
printf '  %s/active_process_manifest.json\n' "$PROCESS_DIR"
printf '  %s/analysis_history_%s.json\n' "$PROCESS_DIR" "$RUN_DT"
printf '  %s/model_tag_knowledge_%s.json\n' "$PROCESS_DIR" "$RUN_DT"

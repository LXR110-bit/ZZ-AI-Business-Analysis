#!/usr/bin/env node
'use strict';
const { processRawCache, parseArgs } = require('../lib/process-pipeline');
function usage() {
  return `Usage: node bin/process-raw-cache.js --run-dt YYYY-MM-DD --input-dir DIR --out-dir DIR [--snapshot-dir DIR] [--previous-processed-cache ZIP]\n\nConsumes active_fetch_manifest.json + raw_cache_<run_dt>.zip and emits imports, processed_cache, server_cache_bundle, analysis_history, data_quality_report and active_process_manifest. No SQL/LLM calls.`;
}
(async () => {
  const args = parseArgs();
  if (args.help) { console.log(usage()); return; }
  const result = await processRawCache({ runDt: args.runDt || process.env.RUN_DT, inputDir: args.inputDir || process.env.INPUT_DIR || '.', outDir: args.outDir || process.env.OUT_DIR || '.', snapshotDir: args.snapshotDir || process.env.SNAPSHOT_DIR, previousProcessedCache: args.previousProcessedCache || process.env.PREVIOUS_PROCESSED_CACHE, runId: args.runId || process.env.RUN_ID });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });

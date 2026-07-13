'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  REQUIRED_OUTPUTS,
  expectedCoverage,
  validateDailyImportCoverage,
} = require('../scripts/validate-daily-import-coverage');
const { deriveTargetWeeks } = require('../scripts/derive-target-weeks');

const TARGET_WEEKS = '2026-W27,2026-W28';
const RUN_ID = 'unit_20260709T065000+0800';
const STARTED_AT = '2026-07-09T06:50:00+08:00';
const GENERATED_AT = '2026-07-09T06:51:00+08:00';
const NOW = '2026-07-09T08:00:00+08:00';

function writeImportFixture({ dayCnt = 3, includeTargetRows = true, runId = RUN_ID, generatedAt = GENERATED_AT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-import-coverage-'));
  const manifestDir = path.join(dir, 'manifests');
  fs.mkdirSync(manifestDir, { recursive: true });
  const outputs = {};
  const manifestOutputs = {};
  for (const key of REQUIRED_OUTPUTS) {
    const file = path.join(dir, `${key}_2026-07.csv`);
    if (key === 'category_daily_avg') {
      fs.writeFileSync(file, includeTargetRows
        ? `week_start_date,品类名称,day_cnt,成交gmv\n2026-07-06,组装自行车,${dayCnt},30000\n`
        : 'week_start_date,品类名称,day_cnt,成交gmv\n2026-06-29,组装自行车,7,20000\n', 'utf8');
    } else if (key === 'model_daily_avg') {
      fs.writeFileSync(file, includeTargetRows
        ? `week_start_date,品类名称,机型名称,day_cnt,成交gmv\n2026-07-06,组装自行车,测试机型,${dayCnt},30000\n`
        : 'week_start_date,品类名称,机型名称,day_cnt,成交gmv\n2026-06-29,组装自行车,测试机型,7,20000\n', 'utf8');
    } else {
      fs.writeFileSync(file, 'week_start_date,day_cnt\n2026-07-06,3\n', 'utf8');
    }
    outputs[key] = file;
    manifestOutputs[key] = { path: file, filename: path.basename(file), row_count: 1 };
  }
  const manifestPath = path.join(manifestDir, `${runId}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    run_id: runId,
    generated_at: generatedAt,
    month: '2026-07',
    outputs: manifestOutputs,
    validation_status: 'pass',
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({
    schema_version: 1,
    run_id: runId,
    generated_at: generatedAt,
    outputs,
    manifest: manifestPath,
  }, null, 2), 'utf8');
  return dir;
}

async function validate(dir, extra = {}) {
  return validateDailyImportCoverage({
    importDir: dir,
    targetWeeks: TARGET_WEEKS,
    runId: RUN_ID,
    startedAt: STARTED_AT,
    now: NOW,
    ...extra,
  });
}

test('expectedCoverage: W28 on 2026-07-09 expects 3 days through 2026-07-08', () => {
  const result = expectedCoverage('2026-W28', NOW);
  assert.equal(result.weekStart, '2026-07-06');
  assert.equal(result.weekEnd, '2026-07-12');
  assert.equal(result.expectedDataEnd, '2026-07-08');
  assert.equal(result.expectedDays, 3);
});

test('deriveTargetWeeks: Monday cron targets the just-ended week', () => {
  assert.deepEqual(
    deriveTargetWeeks({ keepWeeks: 10, now: '2026-07-13T06:50:00+08:00' }),
    ['2026-W19', '2026-W20', '2026-W21', '2026-W22', '2026-W23', '2026-W24', '2026-W25', '2026-W26', '2026-W27', '2026-W28'],
  );
});

test('deriveTargetWeeks: next Monday cron rolls target window to W29', () => {
  assert.deepEqual(
    deriveTargetWeeks({ keepWeeks: 10, now: '2026-07-20T06:50:00+08:00' }),
    ['2026-W20', '2026-W21', '2026-W22', '2026-W23', '2026-W24', '2026-W25', '2026-W26', '2026-W27', '2026-W28', '2026-W29'],
  );
});

test('validateDailyImportCoverage: day_cnt=3 is complete for W28 on 2026-07-09', async () => {
  const dir = writeImportFixture({ dayCnt: 3 });
  const result = await validate(dir);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'complete');
  assert.equal(result.observed.category_daily_avg.dayCounts[0], 3);
  assert.equal(result.observed.model_daily_avg.dayCounts[0], 3);
});

test('validateDailyImportCoverage: day_cnt=1 is incomplete and blocks sync/push', async () => {
  const dir = writeImportFixture({ dayCnt: 1 });
  const result = await validate(dir);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'incomplete');
  assert.match(result.message, /expected 3, got 1/);
});

test('validateDailyImportCoverage: day_cnt greater than expected is invalid', async () => {
  const dir = writeImportFixture({ dayCnt: 4 });
  const result = await validate(dir);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'invalid');
  assert.match(result.message, /expected 3, got 4/);
});

test('validateDailyImportCoverage: missing target week rows are missing', async () => {
  const dir = writeImportFixture({ includeTargetRows: false });
  const result = await validate(dir);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'missing');
  assert.match(result.message, /has no rows for 2026-W28/);
});

test('validateDailyImportCoverage: active manifest before script start is stale', async () => {
  const dir = writeImportFixture({ dayCnt: 3, generatedAt: '2026-07-09T06:00:00+08:00' });
  const result = await validate(dir);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'stale');
  assert.match(result.message, /generated_at is stale/);
});

test('promoteLocalImports: copies staged CSVs and rewrites active/manifest paths to dest dir', () => {
  const sourceDir = writeImportFixture({ dayCnt: 3 });
  const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-import-promote-'));
  const { promoteLocalImports } = require('../scripts/promote-local-imports');
  const promoted = promoteLocalImports({ sourceDir, destDir, runId: RUN_ID });
  assert.equal(promoted.ok, true);
  const active = JSON.parse(fs.readFileSync(path.join(destDir, 'active.json'), 'utf8'));
  assert.equal(active.run_id, RUN_ID);
  assert.ok(active.outputs.category_daily_avg.startsWith(destDir));
  assert.ok(fs.existsSync(active.outputs.category_daily_avg));
  const manifest = JSON.parse(fs.readFileSync(active.manifest, 'utf8'));
  assert.equal(manifest.outputs.category_daily_avg.path, active.outputs.category_daily_avg);
  assert.ok(manifest.manifest_path.startsWith(destDir));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { packageRawCache } = require('../lib/package-raw-cache');

test('packageRawCache writes raw_cache and active_fetch_manifest only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wan-fetch-test-'));
  const input = path.join(root, 'input');
  const out = path.join(root, 'out');
  fs.mkdirSync(input, { recursive: true });
  for (const name of ['category_daily_avg','category_summary','category_fulfill_daily_avg','category_fulfill_summary','model_daily_avg','model_summary']) {
    fs.writeFileSync(path.join(input, `${name}.csv`), 'week_start_date,品类名称,day_cnt\n2026-07-13,手机,3\n', 'utf8');
    fs.writeFileSync(path.join(input, `${name}.sql`), 'select 1;\n', 'utf8');
  }
  const res = packageRawCache({ runDt: '2026-07-15', inputDir: input, outDir: out, runId: 'fetch_fixture' });
  assert.equal(res.ok, true);
  const active = JSON.parse(fs.readFileSync(path.join(out, 'active_fetch_manifest.json'), 'utf8'));
  assert.equal(active.contract_version, 'ai-wan-v1.5.5-fetch');
  assert.equal(active.stage, 'fetch');
  assert.equal(active.raw_cache, 'raw_cache_2026-07-15.zip');
  assert.ok(active.raw_cache_sha256);
  assert.ok(fs.existsSync(path.join(out, active.raw_cache)));
});

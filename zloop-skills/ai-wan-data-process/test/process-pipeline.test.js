'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { packageRawCache } = require('../../ai-wan-data-fetch/lib/package-raw-cache');
const { processRawCache } = require('../lib/process-pipeline');

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
function fixture(dir) {
  write(path.join(dir, 'category_daily_avg.csv'), 'week_start_date,品类名称,day_cnt,机况uv,估价uv,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv\n2026-07-06,手机,7,700,350,210,140,120,110,100,80,5,80000\n2026-07-13,手机,3,300,150,90,60,50,45,40,32,2,32000\n');
  write(path.join(dir, 'category_summary.csv'), 'week_start_date,品类名称,机况uv,估价uv,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv\n2026-07-06,手机,4900,2450,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,900,450,270,180,150,135,120,96,6,96000\n');
  write(path.join(dir, 'category_fulfill_daily_avg.csv'), 'week_start_date,品类名称,履约方式（只取线上流程）,day_cnt,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv\n2026-07-06,手机,邮寄,7,210,140,120,110,100,80,5,80000\n2026-07-13,手机,邮寄,3,90,60,50,45,40,32,2,32000\n');
  write(path.join(dir, 'category_fulfill_summary.csv'), 'week_start_date,品类名称,履约方式（只取线上流程）,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv\n2026-07-06,手机,邮寄,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,邮寄,270,180,150,135,120,96,6,96000\n');
  const model = 'week_start_date,品类名称,机型id,机型名称,day_cnt,机况uv,估价uv,下单uv,下单量,发货量,签收量,质检量,成交量,退回量,成交gmv,核心属性（估价）,成色等级（估价）,品类名称.1,机型id.1,核心属性（质检）,成色等级（质检）,履约方式（只取线上流程）\n2026-07-06,手机,1,iPhone 15,7,350,175,105,70,60,55,50,40,2,40000,,,,,,邮寄\n2026-07-13,手机,1,iPhone 15,3,150,75,45,30,25,22,20,16,1,16000,,,,,,邮寄\n';
  write(path.join(dir, 'model_daily_avg.csv'), model);
  write(path.join(dir, 'model_summary.csv'), model);
  for (const name of ['category_daily_avg','category_summary','category_fulfill_daily_avg','category_fulfill_summary','model_daily_avg','model_summary']) write(path.join(dir, `${name}.sql`), 'select 1;\n');
}

test('processRawCache emits v1.5.5 process artifacts with tags and server bundle', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wan-process-test-'));
  const input = path.join(root, 'input');
  const out = path.join(root, 'out');
  const snap = path.join(root, 'snap');
  fixture(input);
  write(path.join(snap, 'tags.json'), '{"手机||iPhone 15":{"dimensions":{"core":"核心","lifecycle":"主流","price":"高价段"},"tags":["核心"],"note":""}}\n');
  write(path.join(snap, 'tag-vocab.json'), '{"core":["核心","非核心","观察"],"lifecycle":["新品","主流","长尾","淘汰"],"price":["高价段","中价段","低价段"],"custom":{}}\n');
  const fetch = packageRawCache({ runDt: '2026-07-15', inputDir: input, outDir: out, runId: 'fetch_fixture' });
  assert.equal(fetch.ok, true);
  const result = await processRawCache({ runDt: '2026-07-15', inputDir: out, outDir: out, snapshotDir: snap, runId: 'process_fixture' });
  assert.equal(result.ok, true);
  const active = JSON.parse(fs.readFileSync(path.join(out, 'active_process_manifest.json'), 'utf8'));
  assert.equal(active.contract_version, 'ai-wan-v1.5.5-process');
  assert.equal(active.history_weeks, 10);
  assert.equal(active.history_weeks_available, 2);
  assert.equal(active.min_history_weeks_for_trend, 8);
  assert.equal(active.analysis_scope_hint, 'wow_only');
  assert.equal(active.rolling_week, '2026-W29');
  assert.ok(active.final_weeks.includes('2026-W28'));
  assert.equal(active.model_tag_stats.tagged_model_count, 1);
  assert.equal(active.artifact_hashes.model_tag_sync_manifest, active.model_tag_sync_manifest_sha256);
  for (const file of [active.processed_cache, active.server_cache_bundle, active.analysis_history, active.data_quality_report, active.model_tag_snapshot, active.model_tag_knowledge, active.model_tag_sync_manifest]) {
    assert.ok(fs.existsSync(path.join(out, file)), `${file} exists`);
  }
});

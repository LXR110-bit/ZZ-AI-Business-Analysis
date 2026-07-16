'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { packageRawCache } = require('../../ai-wan-data-fetch/lib/package-raw-cache');
const { processRawCache, parseCsvFile } = require('../lib/process-pipeline');

function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
function fixture(dir) {
  write(path.join(dir, 'category_daily_avg.csv'), 'week_start_date,cate_name,day_cnt,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,7,700,350,210,140,120,110,100,80,5,80000\n2026-07-13,手机,3,300,150,90,60,50,45,40,32,2,32000\n');
  write(path.join(dir, 'category_summary.csv'), 'week_start_date,cate_name_label,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,4900,2450,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,900,450,270,180,150,135,120,96,6,96000\n');
  write(path.join(dir, 'category_fulfill_daily_avg.csv'), 'week_start_date,cate_name_label,fulfill_type,day_cnt,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,邮寄,7,210,140,120,110,100,80,5,80000\n2026-07-13,手机,邮寄,3,90,60,50,45,40,32,2,32000\n');
  write(path.join(dir, 'category_fulfill_summary.csv'), 'week_start_date,cate_name_label,fulfill_type,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,邮寄,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,邮寄,270,180,150,135,120,96,6,96000\n');
  const model = 'week_start_date,cate_name_label,model_id_col,model_name_label,day_cnt,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,1,iPhone 15,7,350,175,105,70,60,55,50,40,2,40000\n2026-07-13,手机,1,iPhone 15,3,150,75,45,30,25,22,20,16,1,16000\n2026-07-13,手机,2,追觅,H12S,3,90,45,27,18,15,13,12,9,1,9000\n';
  write(path.join(dir, 'model_daily_avg.csv'), model);
  write(path.join(dir, 'model_summary.csv'), 'week_start_date,cate_name_label,model_id_col,model_name_label,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,1,iPhone 15,350,175,105,70,60,55,50,40,2,40000\n2026-07-13,手机,1,iPhone 15,150,75,45,30,25,22,20,16,1,16000\n2026-07-13,手机,2,追觅,H12S,90,45,27,18,15,13,12,9,1,9000\n');
  for (const name of ['category_daily_avg','category_summary','category_fulfill_daily_avg','category_fulfill_summary','model_daily_avg','model_summary']) write(path.join(dir, `${name}.sql`), 'select 1;\n');
}

function emptyFulfillFixture(dir) {
  fixture(dir);
  write(path.join(dir, 'category_fulfill_daily_avg.csv'), 'week_start_date,cate_name_label,fulfill_type,day_cnt,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n');
  write(path.join(dir, 'category_fulfill_summary.csv'), 'week_start_date,cate_name_label,fulfill_type,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n');
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
  const manifest = JSON.parse(fs.readFileSync(path.join(out, active.manifest), 'utf8'));
  assert.equal(manifest.imports.category_summary.import_rows, 2);
  assert.equal(manifest.imports.model_daily_avg.csv_repair.fixed_rows, 1);
  assert.equal(manifest.imports.model_summary.csv_repair.fixed_rows, 1);
  const inspectDir = path.join(root, 'inspect-imports');
  fs.mkdirSync(inspectDir, { recursive: true });
  const unzip = spawnSync('unzip', ['-q', path.join(out, active.imports_zip), '-d', inspectDir], { encoding: 'utf8' });
  assert.equal(unzip.status, 0, unzip.stderr || unzip.stdout);
  const categorySummary = parseCsvFile(path.join(inspectDir, 'category_summary_2026-07.csv')).rows;
  assert.equal(categorySummary[0]['品类名称'], '手机');
  assert.equal(categorySummary[0]['机况uv'], '4900');
  const modelRows = parseCsvFile(path.join(inspectDir, 'model_daily_avg_2026-07.csv')).rows;
  const commaModel = modelRows.find((r) => r['机型名称'] === '追觅,H12S');
  assert.ok(commaModel, 'repairs unquoted comma in model_name_label');
  assert.equal(commaModel['成交gmv'], '9000');
  for (const file of [active.processed_cache, active.server_cache_bundle, active.analysis_history, active.data_quality_report, active.model_tag_snapshot, active.model_tag_knowledge, active.model_tag_sync_manifest]) {
    assert.ok(fs.existsSync(path.join(out, file)), `${file} exists`);
  }
});

test('processRawCache allows fulfillment empty CSVs only when fetch marks known gaps', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wan-process-empty-fulfill-'));
  const input = path.join(root, 'input');
  const out = path.join(root, 'out');
  const snap = path.join(root, 'snap');
  emptyFulfillFixture(input);
  write(path.join(snap, 'tags.json'), '{}\n');
  write(path.join(snap, 'tag-vocab.json'), '{"core":[],"lifecycle":[],"price":[],"custom":{}}\n');
  const fetch = packageRawCache({ runDt: '2026-07-15', inputDir: input, outDir: out, runId: 'fetch_empty_fulfill' });
  assert.ok(fs.existsSync(fetch.raw_cache));
  const activePath = path.join(out, 'active_fetch_manifest.json');
  const fetchActive = JSON.parse(fs.readFileSync(activePath, 'utf8'));
  fetchActive.status = 'warn';
  fetchActive.known_gaps = ['category_fulfill_daily_avg_empty', 'category_fulfill_summary_empty'];
  fs.writeFileSync(activePath, JSON.stringify(fetchActive, null, 2));

  const result = await processRawCache({ runDt: '2026-07-15', inputDir: out, outDir: out, snapshotDir: snap, runId: 'process_empty_fulfill' });
  assert.equal(result.ok, true);
  const active = JSON.parse(fs.readFileSync(path.join(out, 'active_process_manifest.json'), 'utf8'));
  assert.equal(active.status, 'warn');
  assert.ok(active.known_gaps.includes('category_fulfill_daily_avg_empty'));
  assert.ok(active.known_gaps.includes('category_fulfill_summary_empty'));
  assert.ok(fs.existsSync(path.join(out, active.processed_cache)));
});

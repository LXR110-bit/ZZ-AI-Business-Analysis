'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { packageRawCache, BASE_SCRIPTS, SCRIPTS } = require('../lib/package-raw-cache');
const { processRawCache } = require('../lib/process-pipeline');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeInputs(dir, scripts) {
  const csv = {
    category_daily_avg: 'week_start_date,cate_name,day_cnt,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,7,700,350,210,140,120,110,100,80,5,80000\n2026-07-13,手机,3,300,150,90,60,50,45,40,32,2,32000\n',
    category_summary: 'week_start_date,cate_name_label,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,4900,2450,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,900,450,270,180,150,135,120,96,6,96000\n',
    category_fulfill_daily_avg: 'week_start_date,cate_name_label,fulfill_type,day_cnt,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,邮寄,7,210,140,120,110,100,80,5,80000\n2026-07-13,手机,邮寄,3,90,60,50,45,40,32,2,32000\n',
    category_fulfill_summary: 'week_start_date,cate_name_label,fulfill_type,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,邮寄,1470,980,840,770,700,560,35,560000\n2026-07-13,手机,邮寄,270,180,150,135,120,96,6,96000\n',
    model_daily_avg: 'week_start_date,cate_name_label,model_id_col,model_name_label,day_cnt,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,1,iPhone 15,7,350,175,105,70,60,55,50,40,2,40000\n2026-07-13,手机,1,iPhone 15,3,150,75,45,30,25,22,20,16,1,16000\n',
    model_summary: 'week_start_date,cate_name_label,model_id_col,model_name_label,ji_kuang_uv,gu_jia_uv,xia_dan_uv,xia_dan_cnt,fa_huo_cnt,qian_shou_cnt,zhi_jian_cnt,cheng_jiao_cnt,tui_hui_cnt,cheng_jiao_gmv\n2026-07-06,手机,1,iPhone 15,350,175,105,70,60,55,50,40,2,40000\n2026-07-13,手机,1,iPhone 15,150,75,45,30,25,22,20,16,1,16000\n',
  };
  for (const script of scripts) {
    write(path.join(dir, `${script}.csv`), csv[script]);
    write(path.join(dir, `${script}.sql`), `select '${script}';\n`);
  }
}

function writeSnapshot(dir) {
  write(path.join(dir, 'tags.json'), '{"\u624b\u673a||iPhone 15":{"dimensions":{"core":"\u6838\u5fc3"},"tags":["\u6838\u5fc3"],"note":""}}\n');
  write(path.join(dir, 'tag-vocab.json'), '{"core":["\u6838\u5fc3","\u975e\u6838\u5fc3","\u89c2\u5bdf"],"lifecycle":["\u65b0\u54c1","\u4e3b\u6d41","\u957f\u5c3e","\u6dd8\u6c70"],"price":["\u9ad8\u4ef7\u6bb5","\u4e2d\u4ef7\u6bb5","\u4f4e\u4ef7\u6bb5"],"custom":{}}\n');
  write(path.join(dir, 'category_mapping.csv'), '三级品类,阶段,业务状态,二级板块,归类置信度\n手机,发展,在售,手机通讯,高\n');
}

function unzip(zipFile, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync('unzip', ['-q', zipFile, '-d', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('packageRawCache keeps full6 as the default and validates explicit base4 scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwan-v16-package-scope-'));
  try {
    const fullInput = path.join(root, 'full-input');
    const fullOut = path.join(root, 'full-out');
    writeInputs(fullInput, SCRIPTS);
    const full = packageRawCache({ runDt: '2026-07-15', inputDir: fullInput, outDir: fullOut, runId: 'full_fixture' });
    assert.equal(full.ok, true);
    assert.equal(full.active_manifest.sql_scope, 'all');
    assert.deepEqual(full.active_manifest.scripts, SCRIPTS);
    assert.deepEqual(Object.keys(full.sql_status.scripts), SCRIPTS);

    const baseInput = path.join(root, 'base-input');
    const baseOut = path.join(root, 'base-out');
    writeInputs(baseInput, BASE_SCRIPTS);
    const base = packageRawCache({ runDt: '2026-07-15', inputDir: baseInput, outDir: baseOut, runId: 'base_fixture', sqlScope: 'base', scripts: BASE_SCRIPTS });
    assert.equal(base.ok, true);
    assert.equal(base.active_manifest.sql_scope, 'base');
    assert.deepEqual(base.active_manifest.scripts, BASE_SCRIPTS);
    assert.deepEqual(Object.keys(base.sql_status.scripts), BASE_SCRIPTS);
    assert.throws(
      () => packageRawCache({ runDt: '2026-07-15', inputDir: baseInput, outDir: path.join(root, 'invalid'), sqlScope: 'base', scripts: BASE_SCRIPTS.slice(0, 3) }),
      /do not match sqlScope=base/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package-raw-cache CLI forwards sql-scope and scripts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwan-v16-package-cli-'));
  try {
    const input = path.join(root, 'input');
    const out = path.join(root, 'out');
    writeInputs(input, BASE_SCRIPTS);
    const cli = spawnSync(process.execPath, [
      path.resolve(__dirname, '../bin/package-raw-cache.js'),
      '--run-dt', '2026-07-15',
      '--run-id', 'base_cli_fixture',
      '--input-dir', input,
      '--out-dir', out,
      '--sql-scope', 'base',
      '--scripts', BASE_SCRIPTS.join(','),
    ], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const result = JSON.parse(cli.stdout);
    assert.equal(result.active_manifest.sql_scope, 'base');
    assert.deepEqual(result.active_manifest.scripts, BASE_SCRIPTS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('processRawCache handles base4 and removes stale model evidence while full6 still builds models', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwan-v16-process-scope-'));
  try {
    const input = path.join(root, 'input');
    const out = path.join(root, 'out');
    const snapshot = path.join(root, 'snapshot');
    writeInputs(input, SCRIPTS);
    writeSnapshot(snapshot);

    packageRawCache({ runDt: '2026-07-15', inputDir: input, outDir: out, runId: 'full_fetch' });
    const full = await processRawCache({ runDt: '2026-07-15', inputDir: out, outDir: out, snapshotDir: snapshot, categoryMappingFile: path.join(snapshot, 'category_mapping.csv'), runId: 'full_process' });
    assert.equal(full.ok, true);
    assert.equal(full.manifest.sql_scope, 'all');
    assert.equal(full.manifest.model_enrichment_status, 'ready');
    const fullInspect = path.join(root, 'full-inspect');
    unzip(path.join(out, full.manifest.processed_cache), fullInspect);
    const fullModels = JSON.parse(fs.readFileSync(path.join(fullInspect, 'cache/model-cache.json'), 'utf8'));
    assert.ok(fullModels.rows.length > 0, 'full6 continues to build model cache');

    const baseInput = path.join(root, 'base-input');
    writeInputs(baseInput, BASE_SCRIPTS);
    packageRawCache({ runDt: '2026-07-15', inputDir: baseInput, outDir: out, runId: 'base_fetch', sqlScope: 'base', scripts: BASE_SCRIPTS });
    const base = await processRawCache({ runDt: '2026-07-15', inputDir: out, outDir: out, snapshotDir: snapshot, categoryMappingFile: path.join(snapshot, 'category_mapping.csv'), runId: 'base_process' });
    assert.equal(base.ok, true);
    assert.equal(base.manifest.sql_scope, 'base');
    assert.deepEqual(base.manifest.scripts, BASE_SCRIPTS);
    assert.equal(base.manifest.model_enrichment_status, 'disabled');

    const baseInspect = path.join(root, 'base-inspect');
    unzip(path.join(out, base.manifest.processed_cache), baseInspect);
    const baseModels = JSON.parse(fs.readFileSync(path.join(baseInspect, 'cache/model-cache.json'), 'utf8'));
    assert.equal(baseModels.status, 'disabled');
    assert.equal(baseModels.source.reason, 'model_sql_excluded_from_base_scope');
    assert.deepEqual(baseModels.categories, []);
    assert.deepEqual(baseModels.weeks, []);
    assert.deepEqual(baseModels.rows, []);
    assert.equal(fs.readdirSync(path.join(baseInspect, 'imports')).some((file) => file.startsWith('model_')), false, 'base artifacts do not retain stale model imports');
    const categoryCache = JSON.parse(fs.readFileSync(path.join(baseInspect, 'cache/category-cache.json'), 'utf8'));
    assert.ok(categoryCache.rows.length > 0, 'base category cache remains available');
    const baseServerInspect = path.join(root, 'base-server-inspect');
    unzip(path.join(out, base.manifest.server_cache_bundle), baseServerInspect);
    const publishedModels = JSON.parse(fs.readFileSync(path.join(baseServerInspect, 'model-cache.json'), 'utf8'));
    assert.equal(publishedModels.status, 'disabled');
    assert.deepEqual(publishedModels.rows, [], 'server bundle cannot publish fabricated or stale model evidence');
    const analysisHistory = JSON.parse(fs.readFileSync(path.join(out, base.manifest.analysis_history), 'utf8'));
    assert.deepEqual(analysisHistory.model_topn_history, []);
    assert.deepEqual(analysisHistory.model_detail_contributor_candidates, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

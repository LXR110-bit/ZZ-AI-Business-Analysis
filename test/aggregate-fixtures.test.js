'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIX_DIR = path.join(__dirname, 'fixtures');
const categoryCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));
const benchmarkCsv = fs.readFileSync(path.join(FIX_DIR, 'board_benchmark.csv'), 'utf8');

test('category-taxonomy.json：5 个品类，tier 取值合法，含 1 个已下线', () => {
  assert.equal(taxonomy.rows.length, 5);
  const tiers = new Set(taxonomy.rows.map((r) => r.tier));
  for (const t of tiers) assert.ok(['发展', '孵化', '种子'].includes(t));
  const offline = taxonomy.rows.filter((r) => r.status === '已下线');
  assert.equal(offline.length, 1);
  assert.equal(offline[0].category, '运动相机');
});

test('category-cache.json：5 品类 × 2 周 = 10 行，字段齐全', () => {
  assert.equal(categoryCache.rows.length, 10);
  const weeks = new Set(categoryCache.rows.map((r) => r.week));
  assert.deepEqual([...weeks].sort(), ['2026-W26', '2026-W27']);
  for (const row of categoryCache.rows) {
    for (const k of ['jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv', 'evaRate', 'orderRate', 'shipRate', 'dealRate']) {
      assert.ok(k in row, `缺字段 ${k}`);
    }
  }
});

test('board_benchmark.csv：GMV 等于品类层同周求和', () => {
  const lines = benchmarkCsv.trim().split('\n').slice(1); // skip header
  for (const line of lines) {
    const [week, gmvStr] = line.split(',');
    const benchmarkGmv = Number(gmvStr);
    const sumGmv = categoryCache.rows.filter((r) => r.week === week).reduce((s, r) => s + r.gmv, 0);
    assert.equal(benchmarkGmv, sumGmv, `benchmark GMV 应等于 ${week} 品类求和`);
  }
});

// --- 新增 fixture 校验 ---

const boardMetricsCsv = fs.readFileSync(path.join(FIX_DIR, 'board-metrics.csv'), 'utf8');
const modelCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-cache.json'), 'utf8'));
const modelTaxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-taxonomy.json'), 'utf8'));

test('board-metrics.csv：2 周数据，含 appDau 和 recycleEntranceUv', () => {
  const lines = boardMetricsCsv.trim().split('\n').slice(1);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parts = line.split(',');
    assert.equal(parts.length, 3);
    assert.ok(parts[0].startsWith('2026-W'));
    assert.ok(Number(parts[1]) > 0, 'appDau > 0');
    assert.ok(Number(parts[2]) > 0, 'recycleEntranceUv > 0');
  }
});

test('model-cache.json：3 品类 × 2 周，每行含 modelName 和漏斗字段', () => {
  const categories = new Set(modelCache.rows.map((r) => r.category));
  assert.equal(categories.size, 3);
  const weeks = new Set(modelCache.rows.map((r) => r.week));
  assert.deepEqual([...weeks].sort(), ['2026-W26', '2026-W27']);
  for (const row of modelCache.rows) {
    assert.ok('modelName' in row, '缺 modelName');
    for (const k of ['jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv']) {
      assert.ok(k in row, `缺字段 ${k}`);
    }
  }
});

test('model-cache.json：无人机机型求和 ≈ category-cache 无人机行（W27）', () => {
  const modelRows = modelCache.rows.filter((r) => r.category === '无人机' && r.week === '2026-W27');
  const catRow = categoryCache.rows.find((r) => r.category === '无人机' && r.week === '2026-W27');
  const modelJkuv = modelRows.reduce((s, r) => s + r.jkuv, 0);
  assert.equal(modelJkuv, catRow.jkuv, '机型 jkuv 求和应等于品类 jkuv');
  const modelGmv = modelRows.reduce((s, r) => s + r.gmv, 0);
  assert.equal(modelGmv, catRow.gmv, '机型 gmv 求和应等于品类 gmv');
});

test('model-taxonomy.json：8 个机型，modelTier 取值合法', () => {
  assert.equal(modelTaxonomy.rows.length, 8);
  const validTiers = ['旗舰', '入门', '高端', '中端'];
  for (const row of modelTaxonomy.rows) {
    assert.ok('category' in row && 'modelName' in row && 'modelTier' in row);
    assert.ok(validTiers.includes(row.modelTier), `非法 modelTier: ${row.modelTier}`);
  }
});

test('model-taxonomy.json：覆盖 model-cache 中所有机型', () => {
  const modelNames = new Set(modelCache.rows.map((r) => `${r.category}|${r.modelName}`));
  const taxNames = new Set(modelTaxonomy.rows.map((r) => `${r.category}|${r.modelName}`));
  for (const name of modelNames) {
    assert.ok(taxNames.has(name), `taxonomy 缺少: ${name}`);
  }
});

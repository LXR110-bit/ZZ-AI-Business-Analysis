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

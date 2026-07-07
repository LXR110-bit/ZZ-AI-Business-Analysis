'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFourLayerPayload } = require('../src/aggregate/index');

const FIX_DIR = path.join(__dirname, 'fixtures');
const categoryCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));

// 解析 benchmark CSV
function parseBenchmarkCsv(csvStr) {
  const lines = csvStr.trim().split('\n').slice(1);
  const rows = lines.map((line) => {
    const [week, gmvStr] = line.split(',');
    return { week, gmv: Number(gmvStr) };
  });
  return { rows };
}
const benchmarkCsv = fs.readFileSync(path.join(FIX_DIR, 'board_benchmark.csv'), 'utf8');
const boardBenchmark = parseBenchmarkCsv(benchmarkCsv);

test('端到端：返回 board/tiers/categories 三层', () => {
  const payload = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26', boardBenchmark,
  });
  assert.ok('board' in payload);
  assert.ok('tiers' in payload);
  assert.ok('categories' in payload);
});

test('categories 层：5 品类', () => {
  const { categories } = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
  });
  assert.equal(categories.length, 5);
});

test('tiers 层：3 个 tier', () => {
  const { tiers } = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
  });
  assert.equal(tiers.length, 3);
});

test('board.cur.gmv = 所有品类 gmv 之和', () => {
  const { board, categories } = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
  });
  const sumGmv = categories.reduce((s, c) => s + (c.cur.gmv || 0), 0);
  assert.equal(board.cur.gmv, sumGmv);
});

test('board.reconciliation 与 benchmark 一致 → 无告警', () => {
  const { board } = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26', boardBenchmark,
  });
  assert.equal(board.reconciliation.benchmarkAvailable, true);
  assert.equal(board.reconciliation.diffPct, 0);
  assert.equal(board.reconciliation.alert, false);
});

test('无 boardBenchmark：reconciliation.benchmarkAvailable = false', () => {
  const { board } = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
  });
  assert.equal(board.reconciliation.benchmarkAvailable, false);
});

test('prevWeek 为 null：所有层 delta 为 null', () => {
  const { board, tiers, categories } = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: null,
  });
  // board
  assert.deepEqual(board.delta, { evaRate: null, orderRate: null, shipRate: null, dealRate: null });
  // tiers
  for (const t of tiers) assert.equal(t.delta, null);
  // categories
  for (const c of categories) assert.equal(c.delta, null);
});

test('tier.cur 各字段之和 = board.cur（验证层间一致性）', () => {
  const { board, tiers } = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
  });
  const tierJkuvSum = tiers.reduce((s, t) => s + t.cur.jkuv, 0);
  assert.equal(tierJkuvSum, board.cur.jkuv);
  const tierGmvSum = tiers.reduce((s, t) => s + t.cur.gmv, 0);
  assert.equal(tierGmvSum, board.cur.gmv);
});

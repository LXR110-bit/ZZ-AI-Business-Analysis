'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCategoryLayer } = require('../src/aggregate/category');
const { buildBoardLayer, RECONCILIATION_THRESHOLD } = require('../src/aggregate/board');

const FIX_DIR = path.join(__dirname, 'fixtures');
const categoryCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));

const categoriesW27 = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
const categoriesW26 = buildCategoryLayer(categoryCache, taxonomy, '2026-W26', null);

test('RECONCILIATION_THRESHOLD = 0.05', () => {
  assert.equal(RECONCILIATION_THRESHOLD, 0.05);
});

test('cur：全部品类（含已下线）求和后重算转化率', () => {
  const board = buildBoardLayer(categoriesW27, categoriesW26, null, '2026-W27');
  // 全 5 品类 jkuv 求和: 1000+180+800+100+2000 = 4080
  assert.equal(board.cur.jkuv, 4080);
  // evaUv: 500+90+400+100+1000 = 2090
  assert.equal(board.cur.evaUv, 2090);
  // gmv: 600000+90000+500000+80000+1200000 = 2470000
  assert.equal(board.cur.gmv, 2470000);
  // evaRate = 2090/4080
  assert.ok(Math.abs(board.cur.evaRate - 2090 / 4080) < 1e-9);
  // orderRate = 513/2090
  assert.ok(Math.abs(board.cur.orderRate - 513 / 2090) < 1e-9);
});

test('delta：排除已下线品类后求和算环比', () => {
  const board = buildBoardLayer(categoriesW27, categoriesW26, null, '2026-W27');
  // W27 在售 orderUv=125+100+20+250=495, evaUv=500+400+100+1000=2000
  // W27 在售 orderRate = 495/2000 = 0.2475
  // W26 在售 orderUv=100+80+10+200=390, evaUv=500+400+100+1000=2000
  // W26 在售 orderRate = 390/2000 = 0.195
  // delta = (0.2475 - 0.195) / 0.195
  const expectedDelta = (0.2475 - 0.195) / 0.195;
  assert.ok(Math.abs(board.delta.orderRate - expectedDelta) < 1e-9);
});

test('categoriesPrev 为 null：delta 全字段 null', () => {
  const board = buildBoardLayer(categoriesW27, null, null, '2026-W27');
  assert.deepEqual(board.delta, { evaRate: null, orderRate: null, shipRate: null, dealRate: null });
});

test('categories 为空数组：cur 计数全 0，转化率全 null', () => {
  const board = buildBoardLayer([], [], null, '2026-W27');
  assert.equal(board.cur.jkuv, 0);
  assert.equal(board.cur.gmv, 0);
  assert.equal(board.cur.evaRate, null);
  assert.equal(board.cur.orderRate, null);
});

// --- reconciliation tests ---

const benchmarkMatch = { rows: [{ week: '2026-W27', gmv: 2470000 }] };
const benchmarkMismatch = { rows: [{ week: '2026-W27', gmv: 2000000 }] };

test('reconciliation：有 benchmark 且 GMV 一致 → 无告警', () => {
  const board = buildBoardLayer(categoriesW27, categoriesW26, benchmarkMatch, '2026-W27');
  assert.equal(board.reconciliation.benchmarkAvailable, true);
  assert.equal(board.reconciliation.benchmarkGmv, 2470000);
  assert.equal(board.reconciliation.computedGmv, 2470000);
  assert.equal(board.reconciliation.diffPct, 0);
  assert.equal(board.reconciliation.alert, false);
});

test('reconciliation：有 benchmark 且差异超 5% → 触发告警', () => {
  const board = buildBoardLayer(categoriesW27, categoriesW26, benchmarkMismatch, '2026-W27');
  assert.equal(board.reconciliation.benchmarkAvailable, true);
  assert.equal(board.reconciliation.benchmarkGmv, 2000000);
  assert.equal(board.reconciliation.computedGmv, 2470000);
  // diffPct = (2470000 - 2000000) / 2000000 = 0.235
  assert.ok(Math.abs(board.reconciliation.diffPct - 0.235) < 1e-9);
  assert.equal(board.reconciliation.alert, true);
});

test('reconciliation：无 benchmark（null）→ benchmarkAvailable=false，alert=false', () => {
  const board = buildBoardLayer(categoriesW27, categoriesW26, null, '2026-W27');
  assert.equal(board.reconciliation.benchmarkAvailable, false);
  assert.equal(board.reconciliation.benchmarkGmv, null);
  assert.equal(board.reconciliation.alert, false);
});

test('reconciliation：有 benchmark 但当周行不存在 → benchmarkAvailable=false', () => {
  const benchmarkOtherWeek = { rows: [{ week: '2026-W25', gmv: 1000000 }] };
  const board = buildBoardLayer(categoriesW27, categoriesW26, benchmarkOtherWeek, '2026-W27');
  assert.equal(board.reconciliation.benchmarkAvailable, false);
  assert.equal(board.reconciliation.alert, false);
});

test('reconciliation：benchmarkGmv 为 0 → diffPct null，alert false', () => {
  const benchmarkZero = { rows: [{ week: '2026-W27', gmv: 0 }] };
  const board = buildBoardLayer(categoriesW27, categoriesW26, benchmarkZero, '2026-W27');
  assert.equal(board.reconciliation.benchmarkAvailable, true);
  assert.equal(board.reconciliation.benchmarkGmv, 0);
  assert.equal(board.reconciliation.diffPct, null);
  assert.equal(board.reconciliation.alert, false);
});

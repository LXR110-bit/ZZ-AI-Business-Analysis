'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBoardPenetrationLayer } = require('../src/aggregate/board-penetration');

const boardMetrics = {
  rows: [
    { week: '2026-W26', appDau: 5000000, recycleEntranceUv: 150000 },
    { week: '2026-W27', appDau: 5200000, recycleEntranceUv: 162000 },
  ],
};

test('正常计算渗透率和真实渗透率', () => {
  const boardCur = { orderUv: 513 };
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W26', boardCur);
  assert.equal(result.appDau, 5200000);
  assert.equal(result.recycleEntranceUv, 162000);
  // penetrationRate = 162000 / 5200000
  assert.ok(Math.abs(result.penetrationRate - 162000 / 5200000) < 1e-10);
  // realPenetrationRate = 513 / 5200000
  assert.ok(Math.abs(result.realPenetrationRate - 513 / 5200000) < 1e-10);
});

test('penetrationRate 环比正确', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W26', null);
  // W26: 150000/5000000 = 0.03, W27: 162000/5200000 ≈ 0.031154
  const prevRate = 150000 / 5000000;
  const curRate = 162000 / 5200000;
  const expected = (curRate - prevRate) / prevRate;
  assert.ok(Math.abs(result.delta.penetrationRate - expected) < 1e-10);
});

test('boardMetrics 为 null → 全部返回 null', () => {
  const result = buildBoardPenetrationLayer(null, '2026-W27', '2026-W26', { orderUv: 100 });
  assert.equal(result.appDau, null);
  assert.equal(result.recycleEntranceUv, null);
  assert.equal(result.penetrationRate, null);
  assert.equal(result.realPenetrationRate, null);
  assert.deepEqual(result.delta, { penetrationRate: null, realPenetrationRate: null });
});

test('当周行不存在 → 全部返回 null', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W28', '2026-W27', { orderUv: 100 });
  assert.equal(result.appDau, null);
  assert.equal(result.penetrationRate, null);
});

test('prevWeek 为 null → delta 全 null', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', null, { orderUv: 100 });
  assert.deepEqual(result.delta, { penetrationRate: null, realPenetrationRate: null });
});

test('prevWeek 行不存在 → delta 全 null', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W25', { orderUv: 100 });
  assert.deepEqual(result.delta, { penetrationRate: null, realPenetrationRate: null });
});

test('boardCur 为 null → realPenetrationRate 为 null', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W26', null);
  assert.equal(result.realPenetrationRate, null);
  // penetrationRate 仍正常计算
  assert.ok(result.penetrationRate > 0);
});

test('appDau 为 0 → 渗透率为 null', () => {
  const metrics = { rows: [{ week: '2026-W27', appDau: 0, recycleEntranceUv: 100 }] };
  const result = buildBoardPenetrationLayer(metrics, '2026-W27', null, { orderUv: 50 });
  assert.equal(result.penetrationRate, null);
  assert.equal(result.realPenetrationRate, null);
});

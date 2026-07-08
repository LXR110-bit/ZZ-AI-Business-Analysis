'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBoardPenetrationLayer } = require('../src/aggregate/board-penetration');

const boardMetrics = {
  rows: [
    { week: '2026-W26', appDau: 5000000, recycleEntranceUv: 150000, penetrationRate: 0.0300, realPenetrationRate: 0.0200 },
    { week: '2026-W27', appDau: 5200000, recycleEntranceUv: 162000, penetrationRate: 0.0312, realPenetrationRate: 0.0210 },
  ],
};

const NULL_DELTA = {
  appDau: null,
  recycleEntranceUv: null,
  penetrationRate: null,
  realPenetrationRate: null,
};

test('正常计算渗透率和真实渗透率', () => {
  const boardCur = { orderUv: 513 };
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W26', boardCur);
  assert.equal(result.appDau, 5200000);
  assert.equal(result.recycleEntranceUv, 162000);
  // 周会 Excel 已提供渗透率时优先使用原始值，不用 recycleEntranceUv/appDau 重算。
  assert.equal(result.penetrationRate, 0.0312);
  assert.equal(result.realPenetrationRate, 0.0210);
});

test('penetrationRate delta 用百分点绝对差', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W26', null);
  assert.equal(result.delta.appDau, 200000);
  assert.equal(result.delta.recycleEntranceUv, 12000);
  assert.ok(Math.abs(result.delta.penetrationRate - 0.0012) < 1e-10);
  assert.ok(Math.abs(result.delta.realPenetrationRate - 0.0010) < 1e-10);
});

test('boardMetrics 为 null → 全部返回 null', () => {
  const result = buildBoardPenetrationLayer(null, '2026-W27', '2026-W26', { orderUv: 100 });
  assert.equal(result.appDau, null);
  assert.equal(result.recycleEntranceUv, null);
  assert.equal(result.penetrationRate, null);
  assert.equal(result.realPenetrationRate, null);
  assert.deepEqual(result.delta, NULL_DELTA);
});

test('当周行不存在 → 全部返回 null', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W28', '2026-W27', { orderUv: 100 });
  assert.equal(result.appDau, null);
  assert.equal(result.penetrationRate, null);
});

test('prevWeek 为 null → delta 全 null', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', null, { orderUv: 100 });
  assert.deepEqual(result.delta, NULL_DELTA);
});

test('prevWeek 行不存在 → delta 全 null', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W25', { orderUv: 100 });
  assert.deepEqual(result.delta, NULL_DELTA);
});

test('boardCur 为 null 但提供真实渗透率 → 优先使用原始值', () => {
  const result = buildBoardPenetrationLayer(boardMetrics, '2026-W27', '2026-W26', null);
  assert.equal(result.realPenetrationRate, 0.0210);
  // penetrationRate 仍正常计算
  assert.ok(result.penetrationRate > 0);
});

test('未提供真实渗透率且 boardCur 为 null → realPenetrationRate 为 null', () => {
  const metrics = { rows: [{ week: '2026-W27', appDau: 5200000, recycleEntranceUv: 162000 }] };
  const result = buildBoardPenetrationLayer(metrics, '2026-W27', null, null);
  assert.equal(result.realPenetrationRate, null);
});

test('appDau 为 0 → 渗透率为 null', () => {
  const metrics = { rows: [{ week: '2026-W27', appDau: 0, recycleEntranceUv: 100 }] };
  const result = buildBoardPenetrationLayer(metrics, '2026-W27', null, { orderUv: 50 });
  assert.equal(result.penetrationRate, null);
  assert.equal(result.realPenetrationRate, null);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { COUNT_KEYS, RATE_KEYS, sumCounts, calcRates, calcDelta } = require('../src/aggregate/funnel');

test('COUNT_KEYS：11 个计数字段', () => {
  assert.equal(COUNT_KEYS.length, 11);
  assert.ok(COUNT_KEYS.includes('jkuv'));
  assert.ok(COUNT_KEYS.includes('gmv'));
});

test('RATE_KEYS：4 个转化率字段', () => {
  assert.equal(RATE_KEYS.length, 4);
  assert.deepEqual(RATE_KEYS, ['evaRate', 'orderRate', 'shipRate', 'dealRate']);
});

test('sumCounts：多行求和', () => {
  const rows = [
    { jkuv: 100, evaUv: 50, evaCnt: 50, orderUv: 10, orderCnt: 10, shipCnt: 10, signCnt: 9, qcCnt: 8, dealCnt: 5, returnCnt: 1, gmv: 10000 },
    { jkuv: 200, evaUv: 100, evaCnt: 100, orderUv: 20, orderCnt: 20, shipCnt: 20, signCnt: 18, qcCnt: 16, dealCnt: 10, returnCnt: 2, gmv: 20000 },
  ];
  const sums = sumCounts(rows);
  assert.equal(sums.jkuv, 300);
  assert.equal(sums.evaUv, 150);
  assert.equal(sums.gmv, 30000);
  assert.equal(sums.dealCnt, 15);
});

test('sumCounts：空数组返回全 0', () => {
  const sums = sumCounts([]);
  for (const k of COUNT_KEYS) assert.equal(sums[k], 0);
});

test('sumCounts：字段缺失视为 0', () => {
  const rows = [{ jkuv: 100 }];
  const sums = sumCounts(rows);
  assert.equal(sums.jkuv, 100);
  assert.equal(sums.evaUv, 0);
  assert.equal(sums.gmv, 0);
});

test('calcRates：正常计算', () => {
  const sums = { jkuv: 1000, evaUv: 500, evaCnt: 500, orderUv: 100, orderCnt: 100, shipCnt: 100, signCnt: 90, qcCnt: 80, dealCnt: 50, returnCnt: 5, gmv: 500000 };
  const rates = calcRates(sums);
  assert.equal(rates.evaRate, 0.5);
  assert.equal(rates.orderRate, 0.2);
  assert.equal(rates.shipRate, 0.2);
  assert.equal(rates.dealRate, 0.1);
});

test('calcRates：jkuv 为 0 → evaRate null', () => {
  const sums = { jkuv: 0, evaUv: 0, evaCnt: 0, orderUv: 0, orderCnt: 0, shipCnt: 0, signCnt: 0, qcCnt: 0, dealCnt: 0, returnCnt: 0, gmv: 0 };
  const rates = calcRates(sums);
  assert.equal(rates.evaRate, null);
  assert.equal(rates.orderRate, null);
});

test('calcRates：jkuv > 0 但 evaUv = 0 → orderRate/shipRate/dealRate null', () => {
  const sums = { jkuv: 100, evaUv: 0, evaCnt: 0, orderUv: 0, orderCnt: 0, shipCnt: 0, signCnt: 0, qcCnt: 0, dealCnt: 0, returnCnt: 0, gmv: 0 };
  const rates = calcRates(sums);
  assert.equal(rates.evaRate, 0);
  assert.equal(rates.orderRate, null);
  assert.equal(rates.shipRate, null);
  assert.equal(rates.dealRate, null);
});

test('calcDelta：正常环比', () => {
  const cur = { evaRate: 0.6, orderRate: 0.25, shipRate: 0.2, dealRate: 0.15 };
  const prev = { evaRate: 0.5, orderRate: 0.2, shipRate: 0.2, dealRate: 0.1 };
  const delta = calcDelta(cur, prev);
  assert.ok(Math.abs(delta.evaRate - 0.2) < 1e-9);
  assert.ok(Math.abs(delta.orderRate - 0.25) < 1e-9);
  assert.equal(delta.shipRate, 0);
  assert.ok(Math.abs(delta.dealRate - 0.5) < 1e-9);
});

test('calcDelta：prev 为 null → 全 null', () => {
  const cur = { evaRate: 0.5, orderRate: 0.2, shipRate: 0.2, dealRate: 0.1 };
  const delta = calcDelta(cur, null);
  for (const k of RATE_KEYS) assert.equal(delta[k], null);
});

test('calcDelta：cur 为 null → 全 null', () => {
  const prev = { evaRate: 0.5, orderRate: 0.2, shipRate: 0.2, dealRate: 0.1 };
  const delta = calcDelta(null, prev);
  for (const k of RATE_KEYS) assert.equal(delta[k], null);
});

test('calcDelta：prev 某字段为 0 → 该字段 null（除零保护）', () => {
  const cur = { evaRate: 0.5, orderRate: 0.2, shipRate: 0.2, dealRate: 0.1 };
  const prev = { evaRate: 0, orderRate: 0.2, shipRate: 0.2, dealRate: 0.1 };
  const delta = calcDelta(cur, prev);
  assert.equal(delta.evaRate, null);
  assert.equal(delta.orderRate, 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBoardRecord, computeRates, mergeRows } = require('../src/board-sync');

test('normalizeBoardRecord: 中文字段名映射，无 category 字段', () => {
  const fields = {
    统计周: '2026-W27',
    机况UV日均: 9800,
    估价UV日均: 3100,
    估价量日均: 3100,
    下单UV日均: 620,
    下单量日均: 620,
    发货量日均: 500,
    签收量日均: 500,
    质检量日均: 480,
    成交量日均: 420,
    退回量日均: 20,
    成交GMV日均: 1500000,
  };
  const row = normalizeBoardRecord(fields);
  assert.equal(row.week, '2026-W27');
  assert.equal(row.jkuv, 9800);
  assert.equal(row.category, undefined, 'board 行不应有 category 字段');
});

test('normalizeBoardRecord: 缺失数字字段兜底为0', () => {
  const row = normalizeBoardRecord({ 统计周: '2026-W27' });
  assert.equal(row.jkuv, 0);
  assert.equal(row.gmv, 0);
});

test('computeRates: 分母为0 → null', () => {
  const rates = computeRates({ jkuv: 0, evaUv: 0, orderUv: 0, shipCnt: 0, dealCnt: 0 });
  assert.equal(rates.evaRate, null);
  assert.equal(rates.dealRate, null);
});

test('mergeRows: 去重 key=week，后出现的月份覆盖前面', () => {
  const monthlyRowsInOrder = [
    { monthKey: '2026-06', rows: [{ week: '2026-W27', gmv: 100 }] },
    { monthKey: '2026-07', rows: [{ week: '2026-W27', gmv: 999 }] },
  ];
  const out = mergeRows(monthlyRowsInOrder);
  assert.equal(out.length, 1);
  assert.equal(out[0].gmv, 999);
});

test('mergeRows: 缺 week 的行被跳过', () => {
  const monthlyRowsInOrder = [{ monthKey: '2026-06', rows: [{ week: '', gmv: 1 }] }];
  assert.equal(mergeRows(monthlyRowsInOrder).length, 0);
});

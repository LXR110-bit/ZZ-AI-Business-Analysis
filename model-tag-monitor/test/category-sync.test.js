'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCategoryRecord,
  computeRates,
  mergeRows,
  buildExcludedCategorySet,
  filterByExcludedCategories,
  dateToISOWeek,
} = require('../src/category-sync');

test('normalizeCategoryRecord: 中文字段名映射 + 数字兜底0', () => {
  const fields = {
    统计周: '2026-W27',
    品类名称: '无人机',
    机况UV日均: '3200',
    估价UV日均: '1100',
    估价量日均: '1100',
    下单UV日均: '220',
    下单量日均: '220',
    发货量日均: '180',
    签收量日均: '180',
    质检量日均: '170',
    成交量日均: '150',
    退回量日均: '10',
    成交GMV日均: '480000',
  };
  const row = normalizeCategoryRecord(fields);
  assert.equal(row.week, '2026-W27');
  assert.equal(row.category, '无人机');
  assert.equal(row.jkuv, 3200);
  assert.equal(row.gmv, 480000);
});


test('normalizeCategoryRecord: 真实 category_daily_avg 头映射，普通指标列按 day_cnt 转周日均', () => {
  const row = normalizeCategoryRecord({
    week_start_date: '2026-07-06',
    品类名称: '手机',
    机况uv: '8888',
    估价uv: '54242',
    下单uv: '1234',
    发货量: '100',
    成交量: '80',
    成交gmv: '3,512,396',
    day_cnt: '2',
  });
  assert.equal(row.week, '2026-W28');
  assert.equal(row.category, '手机');
  assert.equal(row.jkuv, 4444);
  assert.equal(row.evaUv, 27121);
  assert.equal(row.orderUv, 617);
  assert.equal(row.shipCnt, 50);
  assert.equal(row.dealCnt, 40);
  assert.equal(row.gmv, 1756198);
  assert.equal(row.daysReceived, 2);
  assert.equal(row.conditionUv, row.jkuv);
});

test('normalizeCategoryRecord: 显式日均字段不按 day_cnt 重复除', () => {
  const row = normalizeCategoryRecord({
    统计周: '2026-W27',
    品类名称: '手机',
    机况UV日均: '8888',
    估价UV日均: '54242',
    发货量日均: '100',
    成交GMV日均: '3,512,396',
    day_cnt: '7',
  });
  assert.equal(row.jkuv, 8888);
  assert.equal(row.evaUv, 54242);
  assert.equal(row.shipCnt, 100);
  assert.equal(row.gmv, 3512396);
  assert.equal(row.daysReceived, 7);
});

test('dateToISOWeek: 2026-07-06 属于 2026-W28', () => {
  assert.equal(dateToISOWeek('2026-07-06'), '2026-W28');
});

test('normalizeCategoryRecord: 缺失数字字段兜底为0，缺失文本字段兜底为空串', () => {
  const row = normalizeCategoryRecord({ 统计周: '2026-W27', 品类名称: '无人机' });
  assert.equal(row.jkuv, 0);
  assert.equal(row.gmv, 0);
});

test('computeRates: 分母>0 正常算比率', () => {
  const rates = computeRates({ jkuv: 100, evaUv: 50, orderUv: 10, shipCnt: 8, dealCnt: 5 });
  assert.equal(rates.evaRate, 0.5);
  assert.equal(rates.orderRate, 0.2);
  assert.equal(rates.shipRate, 0.16);
  assert.equal(rates.dealRate, 0.1);
});


test('computeRates: 有 conditionUv 时估价完成率优先用 conditionUv 作分母', () => {
  const rates = computeRates({ jkuv: 100, conditionUv: 80, evaUv: 40, orderUv: 10, shipCnt: 8, dealCnt: 4 });
  assert.equal(rates.evaRate, 0.5);
  assert.equal(rates.orderRate, 0.25);
});

test('computeRates: 分母为0或缺失 → 该比率为 null（不是0）', () => {
  const rates = computeRates({ jkuv: 0, evaUv: 0, orderUv: 5, shipCnt: 3, dealCnt: 2 });
  assert.equal(rates.evaRate, null);
  assert.equal(rates.orderRate, null);
  assert.equal(rates.shipRate, null);
  assert.equal(rates.dealRate, null);
});

test('mergeRows: 去重 key=week||category，后出现的月份覆盖前面', () => {
  const monthlyRowsInOrder = [
    { monthKey: '2026-06', rows: [{ week: '2026-W27', category: '无人机', gmv: 100 }] },
    { monthKey: '2026-07', rows: [{ week: '2026-W27', category: '无人机', gmv: 999 }] },
  ];
  const out = mergeRows(monthlyRowsInOrder);
  assert.equal(out.length, 1);
  assert.equal(out[0].gmv, 999, '后出现的月份(07月)应覆盖前面(06月)');
});

test('mergeRows: 不同 week 或不同 category 都保留', () => {
  const monthlyRowsInOrder = [
    {
      monthKey: '2026-06',
      rows: [
        { week: '2026-W26', category: '无人机', gmv: 1 },
        { week: '2026-W27', category: '运动相机', gmv: 2 },
      ],
    },
  ];
  const out = mergeRows(monthlyRowsInOrder);
  assert.equal(out.length, 2);
});

test('mergeRows: 缺 week 或 category 的行被跳过', () => {
  const monthlyRowsInOrder = [
    { monthKey: '2026-06', rows: [{ week: '', category: '无人机', gmv: 1 }, { week: '2026-W27', category: '', gmv: 2 }] },
  ];
  const out = mergeRows(monthlyRowsInOrder);
  assert.equal(out.length, 0);
});

test('buildExcludedCategorySet: 从原始分层数据中提取自营(非聚合)品类集合', () => {
  const rawTaxonomyRows = [
    { category: '无人机', tier: '发展' },
    { category: '自营尾货', tier: '自营(非聚合)' },
  ];
  const set = buildExcludedCategorySet(rawTaxonomyRows);
  assert.equal(set.has('自营尾货'), true);
  assert.equal(set.has('无人机'), false);
});

test('filterByExcludedCategories: 排除集合内的品类行', () => {
  const rows = [{ category: '无人机', gmv: 1 }, { category: '自营尾货', gmv: 2 }];
  const out = filterByExcludedCategories(rows, new Set(['自营尾货']));
  assert.deepEqual(out.map((r) => r.category), ['无人机']);
});

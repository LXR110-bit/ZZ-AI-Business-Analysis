const test = require('node:test');
const assert = require('node:assert/strict');
const {
  customDimensionKey,
  normalizeTagRecord,
  normalizeTagVocab,
  UNTAGGED_VALUE,
} = require('../src/tagging');
const { monitor } = require('../src/monitor');

function withRates(row) {
  const safe = (a, b) => (b ? a / b : null);
  return {
    startDate: row.week === '2026-W27' ? '2026-06-29' : '2026-07-06',
    endDate: row.week === '2026-W27' ? '2026-07-05' : '2026-07-12',
    modelId: `${row.category}-${row.modelName}`,
    qcCnt: 0,
    returnCnt: 0,
    ...row,
    evaRate: safe(row.evaUv, row.jkuv),
    orderRate: safe(row.orderUv, row.evaUv),
    shipRate: safe(row.shipCnt, row.evaUv),
    dealRate: safe(row.dealCnt, row.evaUv),
    returnRate: safe(row.returnCnt || 0, row.qcCnt || 0),
  };
}

function cache(rows) {
  return {
    syncedAt: '2026-07-10T00:00:00.000Z',
    weeks: ['2026-W27', '2026-W28'],
    categories: [...new Set(rows.map((r) => r.category))],
    rows: rows.map(withRates),
  };
}

test('v1.5 tag vocab: one category can define multiple custom single-select dimensions', () => {
  const vocab = normalizeTagVocab({
    lifecycle: ['新品', '主流'],
    price: ['高价段', '低价段'],
    core: ['核心', '观察'],
    custom: {
      组装机: [
        { id: 'tier', name: '组装机标签1', options: ['A层', 'B层', 'A层'] },
        { id: 'stability', name: '组装机标签2', options: ['稳定', '波动'] },
      ],
      手机: ['旧结构标签会被忽略'],
    },
  });
  assert.deepEqual(vocab.custom.组装机, [
    { id: 'tier', name: '组装机标签1', options: ['A层', 'B层'] },
    { id: 'stability', name: '组装机标签2', options: ['稳定', '波动'] },
  ]);
  assert.equal(vocab.custom.手机, undefined);
});

test('v1.5 tag record stores dimensions and keeps flattened tags for compatibility', () => {
  const rec = normalizeTagRecord({
    dimensions: { core: '核心', lifecycle: '主流', price: '', ignored: '未打标' },
    note: '重点观察',
  });
  assert.deepEqual(rec.dimensions, { core: '核心', lifecycle: '主流' });
  assert.deepEqual(rec.tags, ['核心', '主流']);
  assert.equal(rec.note, '重点观察');
});

test('monitor tagSummary uses full model data, not Top-N monitor pool', () => {
  const c = cache([
    { week: '2026-W27', category: '组装机', modelName: 'A', jkuv: 100, evaUv: 80, orderUv: 20, shipCnt: 10, dealCnt: 8, gmv: 800, qcCnt: 9, returnCnt: 1 },
    { week: '2026-W27', category: '组装机', modelName: 'B', jkuv: 100, evaUv: 70, orderUv: 14, shipCnt: 8, dealCnt: 7, gmv: 700, qcCnt: 8, returnCnt: 1 },
    { week: '2026-W27', category: '组装机', modelName: 'C', jkuv: 100, evaUv: 60, orderUv: 12, shipCnt: 6, dealCnt: 6, gmv: 600, qcCnt: 7, returnCnt: 1 },
    { week: '2026-W28', category: '组装机', modelName: 'A', jkuv: 100, evaUv: 90, orderUv: 30, shipCnt: 15, dealCnt: 12, gmv: 1200, qcCnt: 10, returnCnt: 1 },
    { week: '2026-W28', category: '组装机', modelName: 'B', jkuv: 100, evaUv: 80, orderUv: 20, shipCnt: 10, dealCnt: 8, gmv: 900, qcCnt: 10, returnCnt: 2 },
    { week: '2026-W28', category: '组装机', modelName: 'C', jkuv: 100, evaUv: 70, orderUv: 7, shipCnt: 4, dealCnt: 3, gmv: 300, qcCnt: 8, returnCnt: 1 },
  ]);
  const tags = {
    '组装机||A': { dimensions: { core: '核心' }, note: '' },
    '组装机||B': { dimensions: { core: '核心' }, note: '' },
  };
  const result = monitor(c, { poolTopN: 1, waveThreshold: 0.1, trendWeeks: 3 }, tags, { week: '2026-W28', tagDimension: 'core' });

  assert.equal(result.pool.length, 1, 'original monitor pool still honors Top-N');
  const core = result.tagSummary.groups.find((g) => g.value === '核心');
  const untagged = result.tagSummary.groups.find((g) => g.value === UNTAGGED_VALUE);
  assert.equal(core.modelCount, 2, 'tag aggregation sees all tagged models, not only Top-N');
  assert.equal(untagged.modelCount, 1);
  assert.equal(core.cur.evaUv, 170);
  assert.equal(core.cur.orderUv, 50);
  assert.equal(core.cur.orderRate, 50 / 170, 'rates are calculated after summing funnel numerator/denominator');
});

test('monitor supports category-scoped custom tag dimensions and 未打标 group', () => {
  const customKey = customDimensionKey('组装机', 'tier');
  const c = cache([
    { week: '2026-W27', category: '组装机', modelName: 'A', jkuv: 100, evaUv: 80, orderUv: 20, shipCnt: 10, dealCnt: 8, gmv: 800 },
    { week: '2026-W27', category: '组装机', modelName: 'B', jkuv: 100, evaUv: 70, orderUv: 14, shipCnt: 8, dealCnt: 7, gmv: 700 },
    { week: '2026-W28', category: '组装机', modelName: 'A', jkuv: 100, evaUv: 90, orderUv: 30, shipCnt: 15, dealCnt: 12, gmv: 1200 },
    { week: '2026-W28', category: '组装机', modelName: 'B', jkuv: 100, evaUv: 80, orderUv: 20, shipCnt: 10, dealCnt: 8, gmv: 900 },
  ]);
  const vocab = normalizeTagVocab({ custom: { 组装机: [{ id: 'tier', name: '组装机标签1', options: ['A层', 'B层'] }] } });
  const result = monitor(c, {}, {
    '组装机||A': { dimensions: { [customKey]: 'A层' }, note: '' },
  }, { week: '2026-W28', category: '组装机', tagDimension: customKey, tagVocab: vocab });

  assert.ok(result.tagDimensions.some((d) => d.key === customKey && d.label === '组装机标签1'));
  assert.equal(result.tagSummary.dimension, customKey);
  assert.equal(result.tagSummary.groups.find((g) => g.value === 'A层').modelCount, 1);
  assert.equal(result.tagSummary.groups.find((g) => g.value === UNTAGGED_VALUE).modelCount, 1);
});

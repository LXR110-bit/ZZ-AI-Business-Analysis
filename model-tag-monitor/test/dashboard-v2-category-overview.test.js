'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCategoryOverviewModel, filterCategoryOverviewList } = require('../public/dashboard-v2');

const categories = [
  {
    tier: '发展',
    board: '运动户外',
    category: '运动相机',
    cur: { gmv: 120000, dealCnt: 80, evaRate: 0.42, orderUv: 300, shipCnt: 70 },
    delta: { evaRate: -0.08, orderRate: -0.03, gmv: -20000 },
    trend: { orderUv: { deltaPct: -0.12 }, shipCnt: { deltaPct: -0.08 }, gmv: { deltaPct: -0.14 } },
    anomalyScore: 2,
  },
  {
    tier: '发展',
    board: '运动户外',
    category: '无人机',
    cur: { gmv: 80000, dealCnt: 60, evaRate: 0.5, orderUv: 200, shipCnt: 50 },
    delta: { evaRate: 0.01, orderRate: 0.02, gmv: 5000 },
    trend: { orderUv: { deltaPct: 0.04 }, shipCnt: { deltaPct: 0.03 }, gmv: { deltaPct: 0.05 } },
    anomalyScore: 0,
  },
  {
    tier: '发展',
    board: '数码3C',
    category: '组装机',
    cur: { gmv: 300000, dealCnt: 150, evaRate: 0.55, orderUv: 500, shipCnt: 130 },
    delta: { evaRate: -0.02, orderRate: -0.01, gmv: -10000 },
    trend: { orderUv: { deltaPct: -0.02 }, shipCnt: { deltaPct: -0.01 }, gmv: { deltaPct: -0.03 } },
    anomalyScore: 1,
  },
  {
    tier: '孵化',
    board: '运动户外',
    category: 'VR眼镜',
    cur: { gmv: 90000, dealCnt: 40, evaRate: 0.35, orderUv: 100, shipCnt: 30 },
    delta: { evaRate: -0.12, orderRate: -0.07, gmv: -15000 },
    trend: { orderUv: { deltaPct: -0.2 }, shipCnt: { deltaPct: -0.15 }, gmv: { deltaPct: -0.18 } },
    anomalyScore: 3,
  },
];

function allText(model) {
  return [
    model.title,
    model.body,
    ...(model.coreCategories || []),
    ...(model.volatileCategories || []),
    ...(model.suggestionMetrics || []),
  ].join(' ');
}

test('category overview follows active tier and selected secondary', () => {
  const model = buildCategoryOverviewModel(categories, '发展', '运动户外');
  const text = allText(model);

  assert.equal(model.empty, false);
  assert.equal(model.title, '品类简述概览 · 发展 / 运动户外');
  assert.equal(model.filteredCount, 2);
  assert.match(model.body, /当前筛选：发展 · 运动户外/);
  assert.match(text, /运动相机/);
  assert.match(text, /无人机/);
  assert.doesNotMatch(text, /组装机/);
  assert.doesNotMatch(text, /VR眼镜/);
});

test('category overview clears secondary to current tier full list only', () => {
  const model = buildCategoryOverviewModel(categories, '发展', '');
  const text = allText(model);

  assert.equal(model.filteredCount, 3);
  assert.match(model.body, /当前筛选：发展 · 全部二级类目/);
  assert.match(text, /组装机/);
  assert.match(text, /运动相机/);
  assert.match(text, /无人机/);
  assert.doesNotMatch(text, /VR眼镜/);
});

test('category overview switches tier without leaking other tiers', () => {
  const model = buildCategoryOverviewModel(categories, '孵化', '运动户外');
  const text = allText(model);

  assert.equal(model.filteredCount, 1);
  assert.match(text, /VR眼镜/);
  assert.doesNotMatch(text, /运动相机/);
  assert.doesNotMatch(text, /无人机/);
  assert.doesNotMatch(text, /组装机/);
});

test('category overview empty state does not fallback to global or other contexts', () => {
  const model = buildCategoryOverviewModel(categories, '种子', '运动户外');
  const text = allText(model);

  assert.equal(model.empty, true);
  assert.equal(model.filteredCount, 0);
  assert.match(model.body, /该筛选下暂无品类/);
  assert.doesNotMatch(text, /运动相机|无人机|组装机|VR眼镜/);
});

test('filterCategoryOverviewList returns only current context categories', () => {
  const list = filterCategoryOverviewList(categories, '发展', '运动户外');
  assert.deepEqual(list.map((c) => c.category), ['运动相机', '无人机']);
});

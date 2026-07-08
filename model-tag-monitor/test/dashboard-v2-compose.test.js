'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { composeDashboard } = require('../src/compose-dashboard');
const { COUNT_KEYS, RATE_KEYS } = require('../src/aggregate/funnel');

const FIX_DIR = path.join(__dirname, 'fixtures');
const categoryCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));
const modelCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-cache.json'), 'utf8'));
const modelTaxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-taxonomy.json'), 'utf8'));

function parseBenchmarkCsv(csvStr) {
  const lines = csvStr.trim().split('\n').slice(1);
  return { rows: lines.map((l) => { const [week, gmv] = l.split(','); return { week, gmv: Number(gmv) }; }) };
}
const boardBenchmark = parseBenchmarkCsv(fs.readFileSync(path.join(FIX_DIR, 'board_benchmark.csv'), 'utf8'));

function parseBoardMetrics(csvStr) {
  const lines = csvStr.trim().split('\n').slice(1);
  return { rows: lines.map((l) => { const [week, appDau, recycleEntranceUv] = l.split(','); return { week, appDau: Number(appDau), recycleEntranceUv: Number(recycleEntranceUv) }; }) };
}
const boardMetrics = parseBoardMetrics(fs.readFileSync(path.join(FIX_DIR, 'board-metrics.csv'), 'utf8'));

const baseOpts = {
  categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
  boardBenchmark, boardMetrics, modelCache, modelTaxonomy,
};

// --- 顶层结构 ---

test('顶层结构包含所有契约字段', () => {
  const result = composeDashboard(baseOpts);
  assert.ok('week' in result);
  assert.ok('weekRange' in result);
  assert.ok('syncedAt' in result);
  assert.ok('board' in result);
  assert.ok('penetration' in result);
  assert.ok('tiers' in result);
  assert.ok('categories' in result);
  assert.ok('reconciliation' in result);
});

test('week 透传', () => {
  const result = composeDashboard(baseOpts);
  assert.equal(result.week, '2026-W27');
});

test('weekRange 格式正确', () => {
  const result = composeDashboard(baseOpts);
  assert.equal(result.weekRange, '2026-06-29 ~ 2026-07-05');
});

test('syncedAt 来自 categoryCache', () => {
  const result = composeDashboard(baseOpts);
  assert.equal(result.syncedAt, categoryCache.syncedAt);
});

// --- board ---

test('board.cur 含漏斗计数字段 + 4 rates', () => {
  const { board } = composeDashboard(baseOpts);
  const keys = Object.keys(board.cur).sort();
  assert.deepEqual(keys, [...COUNT_KEYS, ...RATE_KEYS].sort());
  assert.ok('jkuv' in board.cur);
  assert.ok('orderUv' in board.cur);
  assert.ok('dealCnt' in board.cur);
});

test('board.cur.gmv > 0', () => {
  const { board } = composeDashboard(baseOpts);
  assert.ok(board.cur.gmv > 0);
});

test('大盘漏斗计数字段均由品类维度日均 cache 聚合，不读取大盘补充表', () => {
  const noisyBoardMetrics = {
    rows: [
      {
        week: '2026-W27',
        appDau: 5200000,
        recycleEntranceUv: 162000,
        brandPageUv: 999999999,
        evaUv: 999999999,
        orderUv: 999999999,
        shipCnt: 999999999,
        dealCnt: 999999999,
        gmv: 999999999,
      },
    ],
  };
  const { board } = composeDashboard({ ...baseOpts, boardMetrics: noisyBoardMetrics });
  const expected = {};
  for (const k of COUNT_KEYS) expected[k] = 0;
  for (const row of categoryCache.rows.filter((r) => r.week === '2026-W27')) {
    for (const k of COUNT_KEYS) expected[k] += Number(row[k]) || 0;
  }
  if (!expected.conditionUv && expected.jkuv) expected.conditionUv = expected.jkuv;

  for (const k of COUNT_KEYS) {
    assert.equal(board.cur[k], expected[k], `board.cur.${k} 必须等于 category-cache 当周品类日均求和`);
  }
});

test('board.delta 为绝对差（非百分比变化率）', () => {
  const { board } = composeDashboard(baseOpts);
  // delta 的 rate 字段值应接近 0（小幅波动），而非百分比变化率（>1 or <-1 的可能性极低）
  for (const k of ['evaRate', 'orderRate', 'shipRate', 'dealRate']) {
    if (board.delta[k] != null) {
      assert.ok(Math.abs(board.delta[k]) < 1, `board.delta.${k} 应为绝对差，实际: ${board.delta[k]}`);
    }
  }
});

test('board.delta.gmv 为绝对差数值', () => {
  const { board } = composeDashboard(baseOpts);
  assert.equal(typeof board.delta.gmv, 'number');
});

// --- tiers ---

test('tiers 含 3 个 tier', () => {
  const { tiers } = composeDashboard(baseOpts);
  assert.equal(tiers.length, 3);
});

test('tiers[].cur 含 categoryCount', () => {
  const { tiers } = composeDashboard(baseOpts);
  for (const t of tiers) {
    assert.ok('categoryCount' in t.cur);
    assert.equal(typeof t.cur.categoryCount, 'number');
  }
});

test('tiers[].cur 含漏斗计数字段 + rates + categoryCount', () => {
  const { tiers } = composeDashboard(baseOpts);
  const expectedKeys = [...COUNT_KEYS, ...RATE_KEYS, 'categoryCount'].sort();
  for (const t of tiers) {
    assert.deepEqual(Object.keys(t.cur).sort(), expectedKeys);
  }
});

test('tiers[].delta 含 gmv + 4 rates', () => {
  const { tiers } = composeDashboard(baseOpts);
  for (const t of tiers) {
    assert.ok('gmv' in t.delta);
    assert.ok('evaRate' in t.delta);
  }
});

// --- categories ---

test('categories 数量 = taxonomy 行数', () => {
  const { categories } = composeDashboard(baseOpts);
  assert.equal(categories.length, taxonomy.rows.length);
});

test('categories[].cur 含漏斗计数字段 + rates', () => {
  const { categories } = composeDashboard(baseOpts);
  const expectedKeys = [...COUNT_KEYS, ...RATE_KEYS].sort();
  for (const c of categories) {
    assert.deepEqual(Object.keys(c.cur).sort(), expectedKeys);
  }
});

test('categories[] 包含 category/tier/board/status 元数据', () => {
  const { categories } = composeDashboard(baseOpts);
  for (const c of categories) {
    assert.ok('category' in c);
    assert.ok('tier' in c);
    assert.ok('board' in c);
    assert.ok('status' in c);
  }
});

test('已下线品类 delta 为 null，anomalyScore 为 0', () => {
  const { categories } = composeDashboard(baseOpts);
  const offline = categories.find((c) => c.status === '已下线');
  assert.ok(offline);
  assert.equal(offline.delta, null);
  assert.equal(offline.anomalyScore, 0);
});

test('在售品类 delta 为对象，含 gmv + 4 rates', () => {
  const { categories } = composeDashboard(baseOpts);
  const online = categories.filter((c) => c.status !== '已下线');
  for (const c of online) {
    assert.ok(c.delta != null);
    assert.ok('gmv' in c.delta);
    assert.ok('evaRate' in c.delta);
    assert.ok('orderRate' in c.delta);
    assert.ok('shipRate' in c.delta);
    assert.ok('dealRate' in c.delta);
  }
});

test('categories[].anomalyScore 取值 0-3', () => {
  const { categories } = composeDashboard(baseOpts);
  for (const c of categories) {
    assert.ok(c.anomalyScore >= 0 && c.anomalyScore <= 3);
  }
});


test('估价UV口径：board/tier/category 均来自 category-cache，不被 model-cache 明细累加覆盖', () => {
  const customModelCache = JSON.parse(JSON.stringify(modelCache));
  for (const row of customModelCache.rows) {
    if (row.week === '2026-W27') row.evaUv = 9999999;
  }
  const result = composeDashboard({ ...baseOpts, modelCache: customModelCache });
  const expectedBoardEvaUv = categoryCache.rows
    .filter((r) => r.week === '2026-W27')
    .reduce((sum, r) => sum + Number(r.evaUv || 0), 0);
  assert.equal(result.board.cur.evaUv, expectedBoardEvaUv);
  const drone = result.categories.find((c) => c.category === '无人机');
  assert.equal(drone.cur.evaUv, 500);
});

// --- anomalyScore 逻辑验证 ---

test('anomalyScore：手动构造下降 > 5 百分点场景', () => {
  // W26 无人机: jkuv=1000, evaUv=500 → evaRate=0.50
  // 修改 W27 无人机: evaUv=400 → evaRate=0.40, delta = 0.40-0.50 = -0.10 → 触发
  const customCache = JSON.parse(JSON.stringify(categoryCache));
  const w27Row = customCache.rows.find((r) => r.week === '2026-W27' && r.category === '无人机');
  w27Row.evaUv = 400;

  const result = composeDashboard({ ...baseOpts, categoryCache: customCache });
  const drone = result.categories.find((c) => c.category === '无人机');
  assert.ok(drone.anomalyScore >= 1, `expected >= 1, got ${drone.anomalyScore}`);
});

// --- reconciliation ---

test('reconciliation 透传', () => {
  const { reconciliation } = composeDashboard(baseOpts);
  assert.ok('benchmarkAvailable' in reconciliation);
  assert.ok('alert' in reconciliation);
});

// --- prevWeek 为 null ---

test('prevWeek 为 null：board.delta 全 null', () => {
  const result = composeDashboard({ ...baseOpts, prevWeek: null });
  const { board } = result;
  assert.equal(board.delta.gmv, null);
  assert.equal(board.delta.evaRate, null);
});

test('prevWeek 为 null：categories delta 全 null，anomalyScore 全 0', () => {
  const result = composeDashboard({ ...baseOpts, prevWeek: null });
  for (const c of result.categories) {
    assert.equal(c.delta, null);
    assert.equal(c.anomalyScore, 0);
  }
});


test('kpiCards: 无大盘补充数据时不展示空 DAU 卡，估价UV口径文案为日切片品类去重', () => {
  const result = composeDashboard({ ...baseOpts, boardMetrics: null });
  const keys = result.kpiCards.map((c) => c.key);
  assert.equal(keys.includes('appDau'), false);
  assert.equal(keys.includes('recycleEntranceUv'), false);
  const evaCard = result.kpiCards.find((c) => c.key === 'evaUv');
  assert.ok(evaCard);
  assert.equal(evaCard.note, '日切片品类维度估价UV去重汇总');
});


test('kpiCards: 有大盘补充数据时展示 APP DAU 与回收入口UV，不展示回收DAU', () => {
  const result = composeDashboard(baseOpts);
  const keys = result.kpiCards.map((c) => c.key);
  assert.equal(keys.includes('appDau'), true);
  assert.equal(keys.includes('recycleEntranceUv'), true);
  assert.equal(keys.includes('recycleDau'), false);
});

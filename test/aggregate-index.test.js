'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildFourLayerPayload, buildSixLayerPayload } = require('../src/aggregate/index');

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

// --- buildSixLayerPayload 集成测试 ---

const boardMetricsCsv = fs.readFileSync(path.join(FIX_DIR, 'board-metrics.csv'), 'utf8');
function parseBoardMetricsCsv(csvStr) {
  const lines = csvStr.trim().split('\n').slice(1);
  return {
    rows: lines.map((line) => {
      const [week, appDau, recycleEntranceUv] = line.split(',');
      return { week, appDau: Number(appDau), recycleEntranceUv: Number(recycleEntranceUv) };
    }),
  };
}
const boardMetrics = parseBoardMetricsCsv(boardMetricsCsv);
const modelCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-cache.json'), 'utf8'));
const modelTaxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-taxonomy.json'), 'utf8'));

test('buildSixLayerPayload：返回六层结构', () => {
  const payload = buildSixLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
    boardBenchmark, boardMetrics, modelCache, modelTaxonomy,
  });
  assert.ok('penetration' in payload);
  assert.ok('board' in payload);
  assert.ok('tiers' in payload);
  assert.ok('categories' in payload);
  assert.ok('models' in payload);
  assert.ok('anomalies' in payload);
});

test('buildSixLayerPayload：penetration 层包含渗透率', () => {
  const { penetration } = buildSixLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
    boardMetrics, modelCache, modelTaxonomy,
  });
  assert.equal(penetration.appDau, 5200000);
  assert.equal(penetration.recycleEntranceUv, 162000);
  assert.ok(penetration.penetrationRate > 0);
});

test('buildSixLayerPayload：models 层只包含在线品类', () => {
  const { models, categories } = buildSixLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
    boardMetrics, modelCache, modelTaxonomy,
  });
  const onlineCount = categories.filter((c) => c.status !== '已下线').length;
  assert.equal(Object.keys(models).length, onlineCount);
  // 运动相机（已下线）不在 models 中
  assert.equal(models['运动相机'], undefined);
});

test('buildSixLayerPayload：models 有数据的品类返回 tier 分组', () => {
  const { models } = buildSixLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
    boardMetrics, modelCache, modelTaxonomy,
  });
  assert.ok(models['无人机'].length >= 2); // 旗舰 + 入门
  assert.ok(models['显卡'].length >= 2);   // 高端 + 中端
});

test('buildSixLayerPayload：anomalies 按品类组织', () => {
  const { anomalies } = buildSixLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
    boardMetrics, modelCache, modelTaxonomy,
  });
  assert.ok('无人机' in anomalies);
  assert.ok('显卡' in anomalies);
  // anomalies 是数组（可能为空）
  assert.ok(Array.isArray(anomalies['无人机']));
});

test('buildSixLayerPayload：board 层与 fourLayer 结果一致', () => {
  const four = buildFourLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26', boardBenchmark,
  });
  const six = buildSixLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
    boardBenchmark, boardMetrics, modelCache, modelTaxonomy,
  });
  assert.deepEqual(six.board.cur, four.board.cur);
  assert.deepEqual(six.board.delta, four.board.delta);
});

test('buildSixLayerPayload：不传可选参数 → penetration/models/anomalies 仍返回合法结构', () => {
  const payload = buildSixLayerPayload({
    categoryCache, taxonomy, week: '2026-W27', prevWeek: '2026-W26',
  });
  assert.equal(payload.penetration.appDau, null);
  for (const cat of Object.keys(payload.models)) {
    assert.ok(Array.isArray(payload.models[cat]));
  }
  for (const cat of Object.keys(payload.anomalies)) {
    assert.ok(Array.isArray(payload.anomalies[cat]));
  }
});

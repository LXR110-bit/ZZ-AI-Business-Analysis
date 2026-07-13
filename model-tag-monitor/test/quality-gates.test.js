'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkWtdQuality } = require('../scripts/check-wtd-quality');
const { validateDashboardContract } = require('../scripts/check-dashboard-contract');
const { validateAiInsightsQuality } = require('../scripts/check-ai-insights-quality');
const { validateCardPayload } = require('../scripts/check-card-payload');
const { validateBoardMetricsCache } = require('../scripts/check-board-metrics-cache');
const { composeDashboard } = require('../src/compose-dashboard');
const APP_VERSION = require('../package.json').version;

const FIX_DIR = path.join(__dirname, 'fixtures');

function writeWtdImport(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-quality-'));
  const categoryFile = path.join(dir, 'category_daily_avg_2026-07.csv');
  const modelFile = path.join(dir, 'model_daily_avg_2026-07.csv');
  const header = 'week_start_date,品类名称,day_cnt,成交量,成交gmv,下单量';
  const categoryLines = [header];
  const modelLines = ['week_start_date,品类名称,机型名称,day_cnt,成交量,成交gmv,下单量'];
  for (const row of rows) {
    categoryLines.push(`2026-07-06,${row.category},${row.dayCnt},${row.dealCnt},${row.gmv},${row.orderCnt || row.dealCnt}`);
    modelLines.push(`2026-07-06,${row.category},测试机型,${row.dayCnt},${row.dealCnt},${row.gmv},${row.orderCnt || row.dealCnt}`);
  }
  fs.writeFileSync(categoryFile, `${categoryLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(modelFile, `${modelLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({
    schema_version: 1,
    run_id: `unit_${Date.now()}`,
    generated_at: '2026-07-10T07:00:00+08:00',
    outputs: {
      category_daily_avg: categoryFile,
      model_daily_avg: modelFile,
    },
  }, null, 2), 'utf8');
  return dir;
}

function parseBenchmarkCsv(csvStr) {
  const lines = csvStr.trim().split('\n').slice(1);
  return { rows: lines.map((line) => { const [week, gmv] = line.split(','); return { week, gmv: Number(gmv) }; }) };
}

function parseBoardMetrics(csvStr) {
  const lines = csvStr.trim().split('\n').slice(1);
  return { rows: lines.map((line) => { const [week, appDau, recycleEntranceUv] = line.split(','); return { week, appDau: Number(appDau), recycleEntranceUv: Number(recycleEntranceUv) }; }) };
}

function buildDashboard() {
  const categoryCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
  const taxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));
  const modelCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-cache.json'), 'utf8'));
  const modelTaxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-taxonomy.json'), 'utf8'));
  const boardBenchmark = parseBenchmarkCsv(fs.readFileSync(path.join(FIX_DIR, 'board_benchmark.csv'), 'utf8'));
  const boardMetrics = parseBoardMetrics(fs.readFileSync(path.join(FIX_DIR, 'board-metrics.csv'), 'utf8'));
  return composeDashboard({
    categoryCache,
    taxonomy,
    modelCache,
    modelTaxonomy,
    boardBenchmark,
    boardMetrics,
    week: '2026-W27',
    prevWeek: '2026-W26',
    analysisNow: '2026-07-09T02:30:00.000Z',
  });
}

function completeInsightMap(keys, prefix) {
  return Object.fromEntries(keys.map((key) => [key, `${prefix}${key}：成交GMV、下单率和风险判断已覆盖，当前维持观察。`]));
}

function buildAiCache(dashboard, override = {}) {
  const secondary = [...new Set(dashboard.categories.filter((c) => c.status !== '已下线').map((c) => c.secondaryCategory || c.board).filter(Boolean))];
  const categories = [...new Set(dashboard.categories.map((c) => c.category).filter(Boolean))];
  return {
    version: APP_VERSION,
    week: dashboard.week,
    prevWeek: dashboard.prevWeek,
    generatedAt: '2026-07-10T00:00:00.000Z',
    generatedBy: 'codex-cli-read-only',
    mode: 'ai',
    inputHash: 'unit',
    analysisStatus: dashboard.analysisStatus,
    insights: {
      board: '大盘：成交GMV稳定，估价到下单链路维持观察。',
      tiers: {
        发展: '发展层：成交GMV稳定，维持观察。',
        孵化: '孵化层：成交GMV稳定，维持观察。',
        种子: '种子层：成交GMV稳定，维持观察。',
      },
      secondaryCategories: completeInsightMap(secondary, '二级类目'),
      categories: completeInsightMap(categories, '品类'),
      category: '品类概览：按成交GMV和下单率识别风险。',
      monitor: '监测页：本期查看结构化异动明细。',
    },
    warnings: [],
    ...override,
  };
}

test('checkWtdQuality: blocks 2026-07-10 day_cnt 正确但组装自行车数值断崖式回退', async () => {
  const baselineDir = writeWtdImport([
    { category: '组装自行车', dayCnt: 3, dealCnt: 20, gmv: 36057 },
    { category: '手机', dayCnt: 3, dealCnt: 100, gmv: 100000 },
  ]);
  const currentDir = writeWtdImport([
    { category: '组装自行车', dayCnt: 4, dealCnt: 7, gmv: 10729 },
    { category: '手机', dayCnt: 4, dealCnt: 120, gmv: 140000 },
  ]);
  const result = await checkWtdQuality({ currentDir, baselineDir, targetWeeks: '2026-W28' });
  assert.equal(result.ok, false);
  assert.equal(result.state, 'blocked');
  assert.match(result.errors.join('\n'), /组装自行车/);
  assert.match(result.errors.join('\n'), /成交GMV|成交量/);
});

test('checkWtdQuality: passes corrected 组装自行车 WTD values', async () => {
  const baselineDir = writeWtdImport([
    { category: '组装自行车', dayCnt: 3, dealCnt: 20, gmv: 36057 },
  ]);
  const currentDir = writeWtdImport([
    { category: '组装自行车', dayCnt: 4, dealCnt: 60, gmv: 102134 },
  ]);
  const result = await checkWtdQuality({ currentDir, baselineDir, targetWeeks: '2026-W28' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'pass');
});

test('validateDashboardContract: accepts composed dashboard v2 contract and rejects missing KPI cards', () => {
  const dashboard = buildDashboard();
  const targetWeeks = dashboard.weeks.join(',');
  const result = validateDashboardContract(dashboard, { targetWeeks, expectedVersion: APP_VERSION });
  assert.equal(result.ok, true, result.errors.join('\n'));

  const broken = { ...dashboard };
  delete broken.kpiCards;
  const invalid = validateDashboardContract(broken, { targetWeeks, expectedVersion: APP_VERSION });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /kpiCards/);
});

test('validateAiInsightsQuality: blocks technical field leakage and enforces rolling/final cache alignment', () => {
  const dashboard = buildDashboard();
  const good = validateAiInsightsQuality(buildAiCache(dashboard), { dashboard });
  assert.equal(good.ok, true, good.errors.join('\n'));

  const badCache = buildAiCache(dashboard, {
    insights: {
      ...buildAiCache(dashboard).insights,
      board: 'orderRate 下降 1pct，需要关注',
    },
  });
  const bad = validateAiInsightsQuality(badCache, { dashboard });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /orderRate/);
  assert.match(bad.errors.join('\n'), /pct/);
});

test('validateAiInsightsQuality: accepts deterministic fallback after pct localization', () => {
  const { fallbackInsights } = require('../scripts/generate-business-overview-insights');
  const dashboard = buildDashboard();
  const dashboardInsightText = JSON.stringify(dashboard.insights);
  assert.doesNotMatch(dashboardInsightText, /(?:^|[^A-Za-z])(?:pct|pp)\b/i);

  const cache = fallbackInsights(dashboard, []);
  const cacheInsightText = JSON.stringify(cache.insights);
  assert.doesNotMatch(cacheInsightText, /(?:^|[^A-Za-z])(?:pct|pp)\b/i);
  assert.match(cacheInsightText, /下单率变化 (?:上升|下降|持平|待补)/);

  const result = validateAiInsightsQuality(cache, { dashboard });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('validateCardPayload: blocks technical field leakage before Feishu send', () => {
  const payload = {
    version: APP_VERSION,
    week: '2026-W28',
    prev_week: '2026-W27',
    week_range: '2026-07-06 ~ 2026-07-12',
    total: 10,
    watch_count: 1,
    delta: '1.0%',
    delta_symbol: '+',
    report_url: 'https://example.com/report',
    dashboard_url: 'https://example.com/dashboard',
    top_anomalies: [{
      rank: 1,
      name: '测试机型',
      metric_current: '下单率 10.0%',
      metric_prev: '下单率 12.0%',
      delta_label: '(-2.0%)',
      hypothesis: '下单率触发异动，建议进入监测详情查看机型链路',
    }],
  };
  const good = validateCardPayload(payload, { week: '2026-W28' });
  assert.equal(good.ok, true, good.errors.join('\n'));

  const bad = validateCardPayload({
    ...payload,
    top_anomalies: [{ ...payload.top_anomalies[0], metric_current: 'orderRate 10.0%' }],
  }, { week: '2026-W28' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /orderRate/);
});

test('validateBoardMetricsCache: enforces APP DAU / 回收入口UV whitelist and target week', () => {
  const csv = '统计周,APP日均DAU,回收入口UV,聚合回收渗透率,聚合回收真实渗透率\n2026-W28,3702708,739737,10.16%,7.44%\n';
  const good = validateBoardMetricsCache(csv, { targetWeek: '2026-W28' });
  assert.equal(good.ok, true, good.errors.join('\n'));

  const futureBlankCsv = '统计周,APP日均DAU,回收入口UV,聚合回收渗透率,聚合回收真实渗透率\n2026-W27,3859036,758687,10.71%,7.85%\n2026-W28,3702708,739737,10.16%,7.44%\n2026-W29,,,,\n';
  const futureBlank = validateBoardMetricsCache(futureBlankCsv, { requiredWeeks: ['2026-W27', '2026-W28'], targetWeek: '2026-W28' });
  assert.equal(futureBlank.ok, true, futureBlank.errors.join('\n'));
  assert.match(futureBlank.warnings.join('\n'), /2026-W29/);

  const badCsv = '统计周,APP日均DAU,回收入口UV,回收DAU\n2026-W28,3702708,739737,55033\n';
  const bad = validateBoardMetricsCache(badCsv, { targetWeek: '2026-W28' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /forbidden column/);

  const missingWeek = validateBoardMetricsCache(csv, { targetWeek: '2026-W29' });
  assert.equal(missingWeek.ok, false);
  assert.match(missingWeek.errors.join('\n'), /2026-W29/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { composeDashboard, mergeBusinessOverviewInsights } = require('../src/compose-dashboard');
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

// --- business overview insights cache ---

test('business overview cache: week 匹配时覆盖 insights 并附加 metadata/warnings', () => {
  const result = composeDashboard(baseOpts);
  const merged = mergeBusinessOverviewInsights(result, {
    version: '1.3.0',
    week: '2026-W27',
    prevWeek: '2026-W26',
    generatedAt: '2026-07-08T12:00:00.000Z',
    generatedBy: 'codex-cli-read-only',
    mode: 'ai',
    inputHash: 'abc123',
    insights: {
      board: 'AI 大盘洞察',
      tiers: { 发展: 'AI 发展洞察', 孵化: 'AI 孵化洞察', 种子: 'AI 种子洞察' },
      category: 'AI 品类洞察',
      monitor: 'AI 监测洞察',
    },
    warnings: ['未配置上周策略/预判，暂无法检核兑现'],
  });

  assert.equal(merged.insights.board, 'AI 大盘洞察');
  assert.equal(merged.insights.tiers.发展, 'AI 发展洞察');
  assert.equal(merged.insights.mode, 'ai');
  assert.equal(merged.insights.generatedBy, 'codex-cli-read-only');
  assert.deepEqual(merged.insights.warnings, ['未配置上周策略/预判，暂无法检核兑现']);
});

test('business overview cache: week 不匹配或坏结构时保持原 insights', () => {
  const result = composeDashboard(baseOpts);
  const original = result.insights.board;

  const mismatch = mergeBusinessOverviewInsights(result, {
    week: '2026-W26',
    insights: { board: '不应生效' },
  });
  assert.equal(mismatch.insights.board, original);

  const bad = mergeBusinessOverviewInsights(result, {
    week: '2026-W27',
    insights: null,
  });
  assert.equal(bad.insights.board, original);
});

test('business overview generator: Codex env is allowlisted and excludes production secrets by default', () => {
  const { buildCodexEnv } = require('../scripts/generate-business-overview-insights');
  const env = buildCodexEnv({
    PATH: '/usr/bin',
    HOME: '/root',
    CODEX_HOME: '/root/.codex',
    FEISHU_CHAT_ID: 'secret-chat',
    WEEKLY_REPORT_CHAT_ID: 'secret-weekly',
    MY_OPEN_ID: 'secret-open-id',
    LARK_APP_SECRET: 'secret-lark',
    OPENAI_API_KEY: 'secret-api-key',
  });

  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/root');
  assert.equal(env.CODEX_HOME, '/root/.codex');
  assert.equal(env.FEISHU_CHAT_ID, undefined);
  assert.equal(env.WEEKLY_REPORT_CHAT_ID, undefined);
  assert.equal(env.MY_OPEN_ID, undefined);
  assert.equal(env.LARK_APP_SECRET, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test('business overview generator: deterministic fallback does not reuse stale generated AI copy', () => {
  const { fallbackInsights } = require('../scripts/generate-business-overview-insights');
  const dashboard = composeDashboard(baseOpts);
  dashboard.insights = {
    board: '旧 AI 大盘洞察，不应复用',
    tiers: { 发展: '旧 AI 发展', 孵化: '旧 AI 孵化', 种子: '旧 AI 种子' },
    category: '旧 AI 品类洞察，不应复用',
    monitor: '旧 AI 监测洞察，不应复用',
    generatedBy: 'codex-cli-read-only',
    mode: 'ai',
    inputHash: 'old-hash',
  };

  const cache = fallbackInsights(dashboard, ['warning']);
  assert.equal(cache.mode, 'deterministic');
  assert.notEqual(cache.insights.board, '旧 AI 大盘洞察，不应复用');
  assert.notEqual(cache.insights.category, '旧 AI 品类洞察，不应复用');
  assert.notEqual(cache.insights.monitor, '旧 AI 监测洞察，不应复用');
  assert.notEqual(cache.insights.tiers.发展, '旧 AI 发展');
});

test('business overview generator: AI error warnings are sanitized and capped', () => {
  const { summarizeErrorMessage } = require('../scripts/generate-business-overview-insights');
  const err = new Error([
    'codex exec failed rc=1: OpenAI Codex v0.142.3',
    '--------',
    'user',
    '这里是完整 prompt，不应该进入 warning',
    '<dashboard_summary>',
    JSON.stringify({ categories: new Array(100).fill({ category: '敏感长数据' }) }),
    'ERROR: { "type": "invalid_request_error", "code": "invalid_json_schema", "message": "Invalid schema" }',
  ].join('\n'));
  const msg = summarizeErrorMessage(err, 120);
  assert.equal(msg.length <= 120, true);
  assert.equal(msg.includes('完整 prompt'), false);
  assert.equal(msg.includes('敏感长数据'), false);
  assert.equal(msg.includes('invalid_json_schema'), true);
});

test('business overview generator: AI disabled preserves existing AI cache', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'business-overview-preserve-test-'));
  const dashboardFile = path.join(tmp, 'dashboard.json');
  fs.writeFileSync(dashboardFile, JSON.stringify(composeDashboard(baseOpts)), 'utf8');
  const cacheFile = path.join(tmp, 'business-overview-insights.json');
  fs.writeFileSync(cacheFile, JSON.stringify({
    version: '1.3.0',
    week: '2026-W27',
    generatedBy: 'codex-cli-read-only',
    mode: 'ai',
    inputHash: 'existing-ai-hash',
    insights: {
      board: '已有 AI 大盘洞察',
      tiers: { 发展: '已有发展', 孵化: '已有孵化', 种子: '已有种子' },
      category: '已有品类',
      monitor: '已有监测',
    },
    warnings: ['已有 warning'],
  }), 'utf8');

  const proc = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'generate-business-overview-insights.js'),
    '--dashboard-file', dashboardFile,
    '--out-name', 'business-overview-insights.json',
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: tmp, BUSINESS_OVERVIEW_AI_ENABLED: '0' },
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  const stdout = JSON.parse(proc.stdout);
  assert.equal(stdout.preserved, true);

  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cache.mode, 'ai');
  assert.equal(cache.generatedBy, 'codex-cli-read-only');
  assert.equal(cache.insights.board, '已有 AI 大盘洞察');
});

test('business overview generator: fixture dry-run writes deterministic warning cache', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'business-overview-test-'));
  const dashboardFile = path.join(tmp, 'dashboard.json');
  fs.writeFileSync(dashboardFile, JSON.stringify(composeDashboard(baseOpts)), 'utf8');

  const proc = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'generate-business-overview-insights.js'),
    '--dashboard-file', dashboardFile,
    '--out-name', 'business-overview-insights.json',
  ], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: tmp, BUSINESS_OVERVIEW_AI_ENABLED: '0' },
    encoding: 'utf8',
  });
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);

  const cache = JSON.parse(fs.readFileSync(path.join(tmp, 'business-overview-insights.json'), 'utf8'));
  assert.equal(cache.week, '2026-W27');
  assert.equal(cache.mode, 'deterministic');
  assert.equal(cache.generatedBy, 'business_overview_deterministic');
  assert.equal(cache.insights.tiers.发展.length > 0, true);
  assert.equal(cache.insights.tiers.孵化.length > 0, true);
  assert.equal(cache.insights.tiers.种子.length > 0, true);
  assert.deepEqual(cache.warnings, ['未配置上周策略/预判，暂无法检核兑现']);
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

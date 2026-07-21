'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const boardSync = require('../src/board-sync');
const { buildDashboardProjection, normalizeBoardMetricsBundle } = require('../src/aiwan-insights-bridge');
const store = require('../src/store');
const FIX_DIR = path.join(__dirname, 'fixtures');
const categoryCacheFixture = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
const taxonomyFixture = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));
function parseBoardMetricsCsv(csvStr) {
  const lines = csvStr.trim().split('\n').slice(1);
  return {
    rows: lines.map((line) => {
      const [week, appDau, recycleEntranceUv] = line.split(',');
      return {
        week,
        appDau: Number(appDau),
        recycleEntranceUv: Number(recycleEntranceUv),
      };
    }),
  };
}
const boardMetricsFixture = parseBoardMetricsCsv(fs.readFileSync(path.join(FIX_DIR, 'board-metrics.csv'), 'utf8'));

test('normalizeBoardMetricRecord: 飞书备份字段映射 + 百分比归一化 + week_start_date 转 ISO 周', () => {
  const row = boardSync.normalizeBoardMetricRecord({
    week_start_date: '2026-07-06',
    'APP日均 DAU': '3,936,778',
    '回收入口 UV': '120,000',
    聚合回收渗透率: '3.05%',
    聚合回收真实渗透率: '1.24%',
  });
  assert.equal(row.week, '2026-W28');
  assert.equal(row.appDau, 3936778);
  assert.equal(row.recycleEntranceUv, 120000);
  assert.ok(Math.abs(row.penetrationRate - 0.0305) < 1e-12);
  assert.ok(Math.abs(row.realPenetrationRate - 0.0124) < 1e-12);
});


test('normalizeBoardMetricRecord: 兼容飞书表短周次 26-W27', () => {
  const row = boardSync.normalizeBoardMetricRecord({
    周次: '26-W27',
    'APP日均 DAU': '3,859,036',
    '回收入口 UV': '758,687',
  });
  assert.equal(row.week, '2026-W27');
  assert.equal(row.appDau, 3859036);
  assert.equal(row.recycleEntranceUv, 758687);
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'recycleDau'), false);
});

test('normalizeBoardMetricRecord: 兼容 process publication 的 dau / entryUv 别名', () => {
  const row = boardSync.normalizeBoardMetricRecord({
    week: '2026-W29',
    dau: 3850569,
    entryUv: 759995,
  });
  assert.deepEqual(row, {
    week: '2026-W29',
    startDate: '',
    appDau: 3850569,
    recycleEntranceUv: 759995,
    penetrationRate: null,
    realPenetrationRate: null,
  });
});

test('normalizeBoardMetricsBundle: 目标周补充指标缺失时阻断发布', () => {
  assert.throws(
    () => normalizeBoardMetricsBundle({ rows: [{ week: '2026-W29', dau: null, entryUv: 759995 }] }, { targetWeek: '2026-W29' }),
    /2026-W29\.appDau must be positive/
  );
  assert.throws(
    () => normalizeBoardMetricsBundle({ rows: [{ week: '2026-W28', dau: 3738062, entryUv: 742741 }] }, { targetWeek: '2026-W29' }),
    /missing target week 2026-W29/
  );
});

test('board-sync: 只从本地 board_metrics CSV 生成 board-metrics.json', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-sync-'));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-sync-data-'));
  const oldTarget = process.env.TARGET_WEEKS;
  const oldDataDir = process.env.DATA_DIR;
  process.env.TARGET_WEEKS = '2026-W27,2026-W28';
  process.env.DATA_DIR = dataDir;
  try {
    fs.writeFileSync(
      path.join(tmp, 'board_metrics_2026-07.csv'),
      [
        'week_start_date,APP日均 DAU,回收入口 UV,聚合回收渗透率,聚合回收真实渗透率',
        '2026-06-29,5200000,162000,3.12%,2.10%',
        '2026-07-06,3936778,120000,3.05%,1.24%',
      ].join('\n'),
      'utf8'
    );
    const result = boardSync.sync({ importsDir: tmp });
    assert.equal(result.rows, 2);
    const cache = store.readJSON('board-metrics.json', null);
    assert.deepEqual(cache.weeks, ['2026-W27', '2026-W28']);
    assert.equal(cache.rows[1].week, '2026-W28');
    assert.equal(cache.rows[1].appDau, 3936778);
    assert.equal(cache.rows[1].recycleEntranceUv, 120000);
    assert.equal(cache.source.dir, tmp);
  } finally {
    if (oldTarget === undefined) delete process.env.TARGET_WEEKS;
    else process.env.TARGET_WEEKS = oldTarget;
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
  }
});

test('aiwan-insights-bridge: 目标周缺失时可从 processed sqldau imports 重建 board-metrics', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-metrics-fallback-'));
  const processDir = path.join(tmp, 'process_artifacts');
  const importsDir = path.join(processDir, 'imports');
  fs.mkdirSync(importsDir, { recursive: true });
  fs.writeFileSync(
    path.join(importsDir, 'sqldau_2026-07.csv'),
    [
      'week_start_date,day_cnt,avg_dau,avg_recycle_entrance_uv',
      '2026-06-29,7,3839012,752000',
      '2026-07-06,7,3936778,120000',
    ].join('\n'),
    'utf8'
  );

  const staleBoardMetrics = {
    ...boardMetricsFixture,
    rows: boardMetricsFixture.rows.filter((row) => row.week !== '2026-W27'),
    weeks: ['2026-W28'],
  };
  const record = {
    payload: {
      processed_data: { artifacts: { process_dir: processDir } },
      publication_bundle: {
        category_cache: categoryCacheFixture,
        category_taxonomy: taxonomyFixture,
        board_metrics: staleBoardMetrics,
      },
    },
  };

  const projection = buildDashboardProjection(record, {
    week: '2026-W27',
    prevWeek: '2026-W26',
    generatedAt: '2026-07-09T00:00:00.000Z',
    analysisStatus: {
      analysis_key: '2026-W27:2026-07-08',
      data_end_date: '2026-07-08',
      base_revision: 2,
      deliveryState: 'base_published',
      publication_status: 'published',
    },
  });

  assert.equal(projection.bundle.boardMetrics.weeks.includes('2026-W27'), true);
  const target = projection.bundle.boardMetrics.rows.find((row) => row.week === '2026-W27');
  assert.equal(target.appDau, 3839012);
  assert.equal(target.recycleEntranceUv, 752000);
});

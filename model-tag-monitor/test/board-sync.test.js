'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const boardSync = require('../src/board-sync');
const store = require('../src/store');

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

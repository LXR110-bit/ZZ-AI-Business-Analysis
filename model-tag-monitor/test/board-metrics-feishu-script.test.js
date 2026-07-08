'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBoardRows, toCsv, normalizeWeek } = require('../scripts/sync-board-metrics-from-feishu');

test('normalizeWeek: 飞书短周次 26-W27 转为 2026-W27', () => {
  assert.equal(normalizeWeek('26-W27'), '2026-W27');
  assert.equal(normalizeWeek('2026-W28'), '2026-W28');
});

test('extractBoardRows: 从飞书 annotated_csv 提取 APP DAU 和回收入口UV，不产生回收DAU', () => {
  const annotated = [
    '[row=1] 周次,周日期,APP日均 DAU,回收入口 UV,日均品牌页 UV,聚合回收渗透率,聚合回收真实渗透率',
    '[row=29] 26-W27,0629-0705,"3,859,036","758,687","55,035",10.07%,7.25%',
    '[row=30] 26-W28,0706-0712,"3,702,708","739,737","55,033",10.16%,7.44%',
    '[row=31] ,环比变化,"-69,316",-268,"-1,553",-0.42%,-0.21%',
  ].join('\n');
  const rows = extractBoardRows(annotated);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    week: '2026-W27',
    appDau: '3859036',
    recycleEntranceUv: '758687',
    penetrationRate: '10.07%',
    realPenetrationRate: '7.25%',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'recycleDau'), false);
  assert.equal(toCsv(rows).split('\n')[0], '统计周,APP日均DAU,回收入口UV,聚合回收渗透率,聚合回收真实渗透率');
});

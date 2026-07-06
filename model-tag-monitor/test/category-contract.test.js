/**
 * 品类/大盘/分层数据契约验收测试
 *
 * 目的：锁定 backend-agent 产出给 analysis-agent 消费的三份契约文件的行结构，
 * 防止后续改动悄悄破坏字段名/取值范围（对应设计文档"对抗性 review"关注点）。
 * 契约来源：docs/superpowers/specs/2026-07-06-model-tag-monitor-v2-design.md「数据契约」一节
 *
 * 覆盖：
 *  1) category-cache.json 行字段集合与契约一致
 *  2) board-cache.json 行字段集合与契约一致，且明确不含 category 字段
 *  3) category-taxonomy.json 行字段集合与契约一致，tier 取值范围不含"自营(非聚合)"
 *  4) 自营(非聚合)品类的过滤逻辑在 category-sync 里真正生效（不是摆设）
 *  5) 品类层与大盘层共用同一套转化率公式，口径不漂移
 *
 * 跑法：npm test （node --test）
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const categorySync = require('../src/category-sync');
const boardSync = require('../src/board-sync');
const taxonomySync = require('../src/taxonomy-sync');

// 契约冻结的字段集合，来自设计文档 category-cache.json / board-cache.json 示例
const FUNNEL_NUMBER_FIELDS = [
  'jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt',
  'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv',
];
const FUNNEL_RATE_FIELDS = ['evaRate', 'orderRate', 'shipRate', 'dealRate'];
const TAXONOMY_FIELDS = ['category', 'tier', 'board', 'status', 'confidence', 'lastWeekGmv'];

function sampleFunnelFields() {
  return {
    统计周: '2026-W27',
    品类名称: '无人机',
    机况UV日均: 4000,
    估价UV日均: 1600,
    估价量日均: 1600,
    下单UV日均: 400,
    下单量日均: 400,
    发货量日均: 350,
    签收量日均: 350,
    质检量日均: 330,
    成交量日均: 300,
    退回量日均: 20,
    成交GMV日均: 900000,
  };
}

test('契约1：category-cache.json 行 = week+category+11个漏斗字段+4个比率字段，无多余字段', () => {
  const row = categorySync.normalizeCategoryRecord(sampleFunnelFields());
  const full = { ...row, ...categorySync.computeRates(row) };
  const expectedKeys = ['week', 'category', ...FUNNEL_NUMBER_FIELDS, ...FUNNEL_RATE_FIELDS].sort();
  assert.deepEqual(Object.keys(full).sort(), expectedKeys, 'category-cache 行字段集合必须与契约完全一致');
});

test('契约2：board-cache.json 行 = week+11个漏斗字段+4个比率字段，明确不含 category', () => {
  const fields = sampleFunnelFields();
  delete fields.品类名称;
  const row = boardSync.normalizeBoardRecord(fields);
  const full = { ...row, ...boardSync.computeRates(row) };
  const expectedKeys = ['week', ...FUNNEL_NUMBER_FIELDS, ...FUNNEL_RATE_FIELDS].sort();
  assert.deepEqual(Object.keys(full).sort(), expectedKeys, 'board-cache 行字段集合必须与契约完全一致');
  assert.equal('category' in full, false, '大盘层是最高汇总层级，行内不应出现 category 字段');
});

test('契约3：category-taxonomy.json 行字段集合与契约一致', () => {
  const row = taxonomySync.normalizeTaxonomyRecord({
    三级品类: '运动相机',
    阶段: '发展',
    二级板块: '摄影摄像',
    业务状态: '在售',
    归类置信度: '高',
    '最新周GMV(元)': 586271,
  });
  assert.deepEqual(Object.keys(row).sort(), [...TAXONOMY_FIELDS].sort());
});

test('契约3b：category-taxonomy.json 输出的 tier 取值范围不含"自营(非聚合)"', () => {
  const rawRows = [
    { category: '无人机', tier: '发展' },
    { category: '游戏机', tier: '孵化' },
    { category: '桌游', tier: '种子' },
    { category: '自营尾货', tier: '自营(非聚合)' },
  ];
  const output = taxonomySync.filterSelfOperated(rawRows);
  const tiers = new Set(output.map((r) => r.tier));
  assert.equal(tiers.has('自营(非聚合)'), false, '过滤后不应再出现自营(非聚合)');
  assert.deepEqual(
    [...tiers].sort(),
    taxonomySync.VALID_TIERS.filter((t) => t !== '自营(非聚合)').sort(),
  );
});

test('契约4：category-sync 的自营(非聚合)过滤真正生效——排除品类的行从最终产出里消失', () => {
  const rawTaxonomyRows = [
    { category: '无人机', tier: '发展' },
    { category: '自营尾货', tier: '自营(非聚合)' },
  ];
  const excluded = categorySync.buildExcludedCategorySet(rawTaxonomyRows);
  assert.equal(excluded.has('自营尾货'), true);

  const monthlyRowsInOrder = [
    {
      monthKey: '2026-06',
      rows: [
        { week: '2026-W27', category: '无人机', gmv: 100 },
        { week: '2026-W27', category: '自营尾货', gmv: 200 },
      ],
    },
  ];
  const merged = categorySync.mergeRows(monthlyRowsInOrder);
  assert.equal(merged.length, 2, '过滤前应保留两条(合并阶段不做业务过滤)');

  const filtered = categorySync.filterByExcludedCategories(merged, excluded);
  assert.deepEqual(filtered.map((r) => r.category), ['无人机'], '自营尾货必须被过滤,不能混入最终产出');
});

test('契约5：品类层与大盘层共用同一套转化率公式，口径不漂移', () => {
  const rowInput = { jkuv: 5000, evaUv: 2000, orderUv: 500, shipCnt: 420, dealCnt: 380 };
  const categoryRates = categorySync.computeRates(rowInput);
  const boardRates = boardSync.computeRates(rowInput);
  assert.deepEqual(categoryRates, boardRates, '同样输入下品类层/大盘层转化率公式必须产出一致结果');
});

test('契约5b：分母为0时品类层与大盘层都返回 null(不是0)，不会伪造出0%虚假下跌', () => {
  const zeroInput = { jkuv: 0, evaUv: 0, orderUv: 10, shipCnt: 5, dealCnt: 3 };
  const categoryRates = categorySync.computeRates(zeroInput);
  const boardRates = boardSync.computeRates(zeroInput);
  for (const key of FUNNEL_RATE_FIELDS) {
    assert.equal(categoryRates[key], null, `category computeRates.${key} 分母为0应为null`);
    assert.equal(boardRates[key], null, `board computeRates.${key} 分母为0应为null`);
  }
});

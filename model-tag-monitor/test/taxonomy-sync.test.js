'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTaxonomyRecord,
  isSelfOperated,
  filterSelfOperated,
  VALID_TIERS,
  VALID_STATUSES,
} = require('../src/taxonomy-sync');

test('normalizeTaxonomyRecord: 中文字段名映射到内部字段名', () => {
  const fields = {
    三级品类: '运动相机',
    阶段: '发展',
    二级板块: '摄影摄像',
    业务状态: '在售',
    归类置信度: '高',
    '最新周GMV(元)': 586271,
    备注: '不应出现在输出里',
  };
  const row = normalizeTaxonomyRecord(fields);
  assert.deepEqual(row, {
    category: '运动相机',
    tier: '发展',
    board: '摄影摄像',
    status: '在售',
    confidence: '高',
    lastWeekGmv: 586271,
  });
});

test('normalizeTaxonomyRecord: 富文本数组字段能正确取字符串', () => {
  const fields = {
    三级品类: [{ type: 'text', text: '无人机' }],
    阶段: '孵化',
    二级板块: '影音娱乐',
    业务状态: '已下线',
    归类置信度: '低',
    '最新周GMV(元)': null,
  };
  const row = normalizeTaxonomyRecord(fields);
  assert.equal(row.category, '无人机');
  assert.equal(row.lastWeekGmv, 0, 'GMV 缺失时兜底为 0');
});

test('isSelfOperated: tier === "自营(非聚合)" → true', () => {
  assert.equal(isSelfOperated({ tier: '自营(非聚合)' }), true);
  assert.equal(isSelfOperated({ tier: '发展' }), false);
});

test('filterSelfOperated: 过滤掉自营(非聚合)品类，保留其余', () => {
  const rows = [
    { category: 'A', tier: '发展' },
    { category: 'B', tier: '自营(非聚合)' },
    { category: 'C', tier: '种子' },
  ];
  const out = filterSelfOperated(rows);
  assert.deepEqual(out.map((r) => r.category), ['A', 'C']);
});

test('VALID_TIERS / VALID_STATUSES 枚举完整', () => {
  assert.deepEqual(VALID_TIERS.sort(), ['孵化', '种子', '发展', '自营(非聚合)'].sort());
  assert.deepEqual(VALID_STATUSES.sort(), ['已下线', '在售'].sort());
});

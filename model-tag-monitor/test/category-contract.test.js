'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

function readJSON(dataDir, name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
}

test('gen-mock-category.js 产出的文件字段/过滤规则符合契约', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tag-monitor-category-contract-'));
  execFileSync(process.execPath, ['scripts/gen-mock-category.js'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATA_DIR: dataDir },
  });

  const categoryCache = readJSON(dataDir, 'category-cache.json');
  const taxonomy = readJSON(dataDir, 'category-taxonomy.json');

  // 1) category-cache.json 字段名 100% 匹配契约
  const expectedCategoryFields = [
    'category', 'conditionUv', 'daysReceived', 'dealCnt', 'dealRate', 'endDate',
    'evaCnt', 'evaRate', 'evaUv', 'gmv', 'jkuv', 'orderCnt', 'orderRate',
    'orderUv', 'qcCnt', 'returnCnt', 'shipCnt', 'shipRate', 'signCnt',
    'startDate', 'week',
  ];
  assert.ok(categoryCache.rows.length > 0, 'category-cache 应有数据');
  for (const row of categoryCache.rows) {
    assert.deepEqual(Object.keys(row).sort(), expectedCategoryFields, `字段名必须与契约一致: ${JSON.stringify(Object.keys(row))}`);
  }

  // 2) category-taxonomy.json 字段名匹配契约
  const expectedTaxonomyFields = ['board', 'category', 'confidence', 'lastWeekGmv', 'status', 'tier'];
  assert.ok(taxonomy.rows.length > 0, 'category-taxonomy 应有数据');
  for (const row of taxonomy.rows) {
    assert.deepEqual(Object.keys(row).sort(), expectedTaxonomyFields);
  }

  // 3) 自营(非聚合)品类必须被过滤：taxonomy 和 category-cache 都不应出现"自营尾货"
  assert.ok(!taxonomy.rows.some((r) => r.category === '自营尾货'), 'taxonomy 不应包含自营(非聚合)品类');
  assert.ok(!taxonomy.rows.some((r) => r.tier === '自营(非聚合)'), 'taxonomy 不应包含 tier=自营(非聚合) 的行');
  assert.ok(!categoryCache.rows.some((r) => r.category === '自营尾货'), 'category-cache 不应包含自营(非聚合)品类的漏斗数据');

  // 4) status 取值只能是 在售/已下线 两种之一
  for (const row of taxonomy.rows) {
    assert.ok(['在售', '已下线'].includes(row.status), `status 取值必须 ∈ {在售,已下线}, 实际="${row.status}"`);
  }

  // 5) tier 取值只能是 发展/孵化/种子（自营(非聚合)已在源头过滤，不应出现）
  for (const row of taxonomy.rows) {
    assert.ok(['发展', '孵化', '种子'].includes(row.tier), `tier 取值必须 ∈ {发展,孵化,种子}, 实际="${row.tier}"`);
  }
});

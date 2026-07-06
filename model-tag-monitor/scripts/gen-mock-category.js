// 生成本地开发用 mock category-cache.json / category-taxonomy.json / board-cache.json
// 用法：node scripts/gen-mock-category.js
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'store'));
const taxonomySync = require(path.join(__dirname, '..', 'src', 'taxonomy-sync'));
const categorySync = require(path.join(__dirname, '..', 'src', 'category-sync'));
const boardSync = require(path.join(__dirname, '..', 'src', 'board-sync'));

const WEEKS = ['2026-W24', '2026-W25', '2026-W26', '2026-W27'];

// 手造的品类分层映射(含一个自营(非聚合)品类，用来验证过滤逻辑真实生效)
const RAW_TAXONOMY_ROWS = [
  { category: '无人机', tier: '发展', board: '影音娱乐', status: '在售', confidence: '高', lastWeekGmv: 820000 },
  { category: '运动相机', tier: '发展', board: '摄影摄像', status: '在售', confidence: '高', lastWeekGmv: 586271 },
  { category: '显卡', tier: '孵化', board: '电脑硬件', status: '在售', confidence: '中', lastWeekGmv: 210000 },
  { category: '台球杆', tier: '种子', board: '运动户外', status: '在售', confidence: '中', lastWeekGmv: 42000 },
  { category: '手环', tier: '孵化', board: '智能穿戴', status: '已下线', confidence: '低', lastWeekGmv: 8000 },
  { category: '自营尾货', tier: '自营(非聚合)', board: '自营', status: '在售', confidence: '高', lastWeekGmv: 999000 },
];

function seed(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

function genCategoryRow(category, week, base) {
  const r = seed(category + '|' + week);
  const jkuv = Math.round(base * (2.2 + r() * 0.8));
  const evaUv = Math.round(jkuv * (0.3 + r() * 0.3));
  const evaCnt = evaUv;
  const orderUv = Math.round(evaUv * (0.15 + r() * 0.2));
  const orderCnt = orderUv;
  const shipCnt = Math.round(orderUv * (0.7 + r() * 0.2));
  const signCnt = shipCnt;
  const qcCnt = Math.round(shipCnt * (0.85 + r() * 0.1));
  const dealCnt = Math.round(shipCnt * (0.6 + r() * 0.3));
  const returnCnt = Math.round(qcCnt * (0.02 + r() * 0.08));
  const gmv = Math.round(dealCnt * (500 + r() * 3000));
  const row = { week, category, jkuv, evaUv, evaCnt, orderUv, orderCnt, shipCnt, signCnt, qcCnt, dealCnt, returnCnt, gmv };
  return { ...row, ...categorySync.computeRates(row) };
}

function genBoardRow(week, base) {
  const r = seed('board|' + week);
  const jkuv = Math.round(base * (2.5 + r() * 0.5));
  const evaUv = Math.round(jkuv * (0.32 + r() * 0.2));
  const evaCnt = evaUv;
  const orderUv = Math.round(evaUv * (0.2 + r() * 0.15));
  const orderCnt = orderUv;
  const shipCnt = Math.round(orderUv * (0.75 + r() * 0.15));
  const signCnt = shipCnt;
  const qcCnt = Math.round(shipCnt * (0.88 + r() * 0.08));
  const dealCnt = Math.round(shipCnt * (0.65 + r() * 0.25));
  const returnCnt = Math.round(qcCnt * (0.02 + r() * 0.05));
  const gmv = Math.round(dealCnt * (600 + r() * 2500));
  const row = { week, jkuv, evaUv, evaCnt, orderUv, orderCnt, shipCnt, signCnt, qcCnt, dealCnt, returnCnt, gmv };
  return { ...row, ...boardSync.computeRates(row) };
}

// 1) taxonomy: 用真实过滤函数处理手造数据，保证 mock 和真实同步逻辑行为一致
const taxonomyRows = taxonomySync.filterSelfOperated(RAW_TAXONOMY_ROWS);
store.writeJSON('category-taxonomy.json', {
  syncedAt: new Date().toISOString(),
  rows: taxonomyRows,
});

// 2) category-cache: 每个品类(含自营，之后再过滤掉)生成 4 周数据，再用真实过滤函数排除自营
const CATEGORY_BASE = { 无人机: 3200, 运动相机: 2600, 显卡: 4100, 台球杆: 900, 手环: 1500, 自营尾货: 5000 };
let categoryRows = [];
for (const category of Object.keys(CATEGORY_BASE)) {
  for (const week of WEEKS) categoryRows.push(genCategoryRow(category, week, CATEGORY_BASE[category]));
}
const excluded = categorySync.buildExcludedCategorySet(RAW_TAXONOMY_ROWS);
categoryRows = categorySync.filterByExcludedCategories(categoryRows, excluded);
store.writeJSON('category-cache.json', {
  syncedAt: new Date().toISOString(),
  source: { wikiNodesByMonth: { '2026-mock': 'MOCK_NODE_TOKEN' } },
  rows: categoryRows,
});

// 3) board-cache: 大盘层，4 周
const boardRows = WEEKS.map((week) => genBoardRow(week, 9800));
store.writeJSON('board-cache.json', {
  syncedAt: new Date().toISOString(),
  source: { wikiNodesByMonth: { '2026-mock': 'MOCK_NODE_TOKEN' } },
  rows: boardRows,
});

console.log(
  `[mock] category-taxonomy.json: ${taxonomyRows.length} 品类(已排除 ${RAW_TAXONOMY_ROWS.length - taxonomyRows.length} 个自营)`
);
console.log(`[mock] category-cache.json: ${categoryRows.length} 行(${WEEKS.length} 周 × ${taxonomyRows.length} 品类)`);
console.log(`[mock] board-cache.json: ${boardRows.length} 行`);

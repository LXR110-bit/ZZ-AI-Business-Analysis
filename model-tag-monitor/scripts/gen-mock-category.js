// 生成本地开发用 mock 品类/大盘/分层数据(category-cache.json / board-cache.json / category-taxonomy.json)
// 不经过飞书 API，纯离线数据，字段结构对齐 src/category-sync.js / board-sync.js / taxonomy-sync.js 的输出契约
// 用法：node scripts/gen-mock-category.js
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'store'));

const CATEGORIES = ['无人机', '运动相机', '摄影摄像', '游戏机', '智能穿戴'];
const TIERS = { 无人机: '发展', 运动相机: '孵化', 摄影摄像: '发展', 游戏机: '种子', 智能穿戴: '自营(非聚合)' };
const BOARDS = { 无人机: '影音娱乐', 运动相机: '影音娱乐', 摄影摄像: '摄影摄像', 游戏机: '影音娱乐', 智能穿戴: '智能设备' };
const WEEKS = ['2026-W24', '2026-W25', '2026-W26', '2026-W27'];

function seed(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

const safeDiv = (a, b) => (b > 0 ? a / b : null);

function genFunnelRow(seedKey, base) {
  const r = seed(seedKey);
  const jkuv = Math.round(base * (2.2 + r() * 0.8));
  const evaUv = Math.round(jkuv * (0.3 + r() * 0.3));
  const orderUv = Math.round(evaUv * (0.15 + r() * 0.25));
  const shipCnt = Math.round(orderUv * (0.7 + r() * 0.25));
  const qcCnt = Math.round(shipCnt * (0.85 + r() * 0.15));
  const dealCnt = Math.round(shipCnt * (0.6 + r() * 0.35));
  const returnCnt = Math.round(qcCnt * (0.02 + r() * 0.1));
  const gmv = Math.round(dealCnt * (300 + r() * 2000));
  return {
    jkuv, evaUv, evaCnt: evaUv, orderUv, orderCnt: orderUv,
    shipCnt, signCnt: shipCnt, qcCnt, dealCnt, returnCnt, gmv,
    evaRate: safeDiv(evaUv, jkuv),
    orderRate: safeDiv(orderUv, evaUv),
    shipRate: safeDiv(shipCnt, evaUv),
    dealRate: safeDiv(dealCnt, evaUv),
  };
}

// ---- category-cache.json ----
const categoryRows = [];
for (const category of CATEGORIES) {
  WEEKS.forEach((week) => {
    categoryRows.push({ week, category, ...genFunnelRow(`${category}|${week}`, 1500) });
  });
}
store.writeJSON('category-cache.json', {
  syncedAt: new Date().toISOString(),
  source: { title: '本地 mock(品类)', wikiNodesByMonth: {} },
  rows: categoryRows,
});

// ---- board-cache.json ----
const boardRows = WEEKS.map((week) => ({ week, ...genFunnelRow(`board|${week}`, 8000) }));
store.writeJSON('board-cache.json', {
  syncedAt: new Date().toISOString(),
  source: { title: '本地 mock(大盘)', wikiNodesByMonth: {} },
  rows: boardRows,
});

// ---- category-taxonomy.json ----
const STATUS_BY_CAT = { 无人机: '在售', 运动相机: '在售', 摄影摄像: '在售', 游戏机: '已下线', 智能穿戴: '在售' };
const taxonomyRows = CATEGORIES.map((category) => {
  const lastWeekRow = categoryRows.find((r) => r.category === category && r.week === WEEKS[WEEKS.length - 1]);
  return {
    category,
    tier: TIERS[category],
    board: BOARDS[category],
    status: STATUS_BY_CAT[category],
    confidence: '高',
    lastWeekGmv: lastWeekRow ? lastWeekRow.gmv : 0,
  };
});
store.writeJSON('category-taxonomy.json', {
  syncedAt: new Date().toISOString(),
  rows: taxonomyRows.filter((r) => r.tier !== '自营(非聚合)'), // 契约文件本身也应用同样的过滤规则
});

console.log(
  `[mock-category] 生成完毕: category-cache ${categoryRows.length} 行, board-cache ${boardRows.length} 行, ` +
    `category-taxonomy ${taxonomyRows.length - 1} 行(已排除自营(非聚合))`
);

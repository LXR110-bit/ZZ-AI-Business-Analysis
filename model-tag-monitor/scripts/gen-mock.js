// 生成本地开发用 mock cache.json（不落 store 里的 sync 状态，纯离线数据）
// 用法：node scripts/gen-mock.js
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'store'));

const CATS = ['手机', '笔记本', '平板', '相机'];
const WEEKS = ['2025-W23', '2025-W24', '2025-W25', '2025-W26', '2025-W27'];
const MODEL_TEMPLATES = [
  ['iPhone 15 Pro', '手机'], ['iPhone 14', '手机'], ['小米 14', '手机'],
  ['华为 Mate60', '手机'], ['OPPO Find X7', '手机'], ['三星 S24', '手机'],
  ['vivo X100', '手机'], ['荣耀 Magic6', '手机'], ['一加 12', '手机'], ['红米 K70', '手机'],
  ['MacBook Pro 14', '笔记本'], ['MacBook Air 13', '笔记本'], ['Thinkpad X1', '笔记本'],
  ['联想小新Pro', '笔记本'], ['戴尔 XPS15', '笔记本'], ['华为 MateBook', '笔记本'],
  ['iPad Pro 12.9', '平板'], ['iPad Air', '平板'], ['小米平板6', '平板'],
  ['华为 MatePad', '平板'], ['Surface Pro9', '平板'],
  ['佳能 R6', '相机'], ['索尼 A7M4', '相机'], ['富士 XT5', '相机'],
];

function weekRange(week) {
  const n = parseInt(week.slice(-2), 10);
  const start = new Date(2025, 0, 1 + (n - 1) * 7);
  const end = new Date(start.getTime() + 6 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

function rand(min, max) { return min + Math.random() * (max - min); }
function seed(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return () => {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    return h / 0x7fffffff;
  };
}

function genRow(model, cat, week, wi, allWeeks) {
  const r = seed(model + '|' + week);
  const base = {
    'iPhone 15 Pro': 12000, 'iPhone 14': 9000, '小米 14': 7000, '华为 Mate60': 8500,
    'MacBook Pro 14': 3200, 'iPad Pro 12.9': 2400,
  }[model] || 1200 + Math.floor(r() * 4500);
  const trend = 1 + (wi - allWeeks.length / 2) * 0.03 * (r() > 0.5 ? 1 : -1);
  const jkuv = Math.round(base * (2.4 + r() * 0.6) * trend);
  const evaUv = Math.round(jkuv * (0.35 + r() * 0.3));
  const orderUv = Math.round(evaUv * (0.15 + r() * 0.25));
  const shipCnt = Math.round(orderUv * (0.7 + r() * 0.25));
  const qcCnt = Math.round(shipCnt * (0.85 + r() * 0.15));
  const dealCnt = Math.round(shipCnt * (0.6 + r() * 0.35));
  const returnCnt = Math.round(qcCnt * (0.02 + r() * 0.1));
  const gmv = Math.round(dealCnt * (400 + r() * 3800));
  const { startDate, endDate } = weekRange(week);
  const row = {
    week, startDate, endDate, daysReceived: 7,
    category: cat, modelId: 'M' + Math.abs(hash32(model)),
    modelName: model,
    jkuv, evaUv, evaCnt: evaUv,
    orderUv, orderCnt: orderUv,
    shipCnt, signCnt: shipCnt, qcCnt, dealCnt, returnCnt,
    gmv, avgPrice: dealCnt ? Math.round(gmv / dealCnt) : 0,
  };
  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  Object.assign(row, {
    evaRate: safeDiv(evaUv, jkuv),
    orderRate: safeDiv(orderUv, evaUv),
    shipRate: safeDiv(shipCnt, evaUv),
    dealRate: safeDiv(dealCnt, evaUv),
    returnRate: safeDiv(returnCnt, qcCnt),
  });
  return row;
}
function hash32(s) { let h = 0; for (const c of s) h = ((h * 31 + c.charCodeAt(0)) | 0); return h; }

const rows = [];
for (const [model, cat] of MODEL_TEMPLATES) {
  WEEKS.forEach((w, i) => rows.push(genRow(model, cat, w, i, WEEKS)));
}

const cache = {
  syncedAt: new Date().toISOString(),
  source: { title: '本地 mock', sheetTitle: 'mock' },
  headers: [],
  categories: [...new Set(rows.map((r) => r.category))].sort(),
  weeks: WEEKS,
  rows,
};
store.writeJSON('cache.json', cache);
store.writeJSON('rules.json', {
  poolTopN: 20, waveThreshold: 0.10, trendWeeks: 3, minEvaUv: 15,
  rates: [
    { key: 'evaRate', name: '估价完成率' },
    { key: 'orderRate', name: '估价下单率' },
    { key: 'shipRate', name: '估价发货率' },
    { key: 'dealRate', name: '估价成交率' },
    { key: 'returnRate', name: '质检退回率' },
  ],
});
store.writeJSON('tags.json', {});
console.log(`[mock] cache.json 生成完毕: ${rows.length} 行, ${cache.categories.length} 品类, ${WEEKS.length} 周`);

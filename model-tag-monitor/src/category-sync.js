// 品类维度漏斗数据同步：飞书 Bitable(月度分表) → data/category-cache.json
const store = require('./store');
const bitable = require('./feishu-bitable');
const taxonomySync = require('./taxonomy-sync');

// 月份 → { wikiNode, tableId }，每月新增表只需要在这里加一行
const MONTH_TABLES = {
  '2026-04': { wikiNode: 'WapgwtEW2iRGGPkcItyclRRMnCc', tableId: 'tblaWu89uXoXuNXQ' },
  '2026-05': { wikiNode: 'Vxluw1KQuilCfxkNEn4cPmVHnyh', tableId: 'tbl7MdKlLalygD4o' },
  '2026-06': { wikiNode: 'OR4xw9xnwiZiXkke49BcJdydnLe', tableId: 'tblp4djUOMmE9gvS' },
  '2026-07': { wikiNode: 'DAcFwVw8ViG3PHkqUOUcbmYGnDc', tableId: 'tbl5EZ8oGsVE8joQ' },
};

// 表头字段(中文列名) → 内部字段名，口径与 src/sync.js HEADER_MAP 一致(周日均)
// !! 待接入时用 scripts/inspect-bitable-fields.js 核验真实字段名，见本计划 Task 8
const HEADER_MAP = {
  统计周: 'week',
  周次: 'week',
  品类名称: 'category',
  品类: 'category',
  三级品类: 'category',
  机况UV日均: 'jkuv',
  估价UV日均: 'evaUv',
  估价量日均: 'evaCnt',
  下单UV日均: 'orderUv',
  下单量日均: 'orderCnt',
  发货量日均: 'shipCnt',
  签收量日均: 'signCnt',
  质检量日均: 'qcCnt',
  成交量日均: 'dealCnt',
  退回量日均: 'returnCnt',
  成交GMV日均: 'gmv',
};

const NUMBER_FIELDS = ['jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv'];
const TEXT_FIELDS = ['week', 'category'];

function normalizeCategoryRecord(fields) {
  const row = {};
  for (const [cnKey, enKey] of Object.entries(HEADER_MAP)) {
    if (fields[cnKey] === undefined) continue;
    row[enKey] = fields[cnKey];
  }
  for (const k of TEXT_FIELDS) row[k] = bitable.bitableFieldToString(row[k]);
  for (const k of NUMBER_FIELDS) row[k] = bitable.bitableFieldToNumber(row[k], 0);
  return row;
}

// 4 个核心转化率，口径与 src/sync.js computeRates 一致(契约只要这 4 个，不含 returnRate)
function computeRates(row) {
  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  return {
    evaRate: safeDiv(row.evaUv, row.jkuv),
    orderRate: safeDiv(row.orderUv, row.evaUv),
    shipRate: safeDiv(row.shipCnt, row.evaUv),
    dealRate: safeDiv(row.dealCnt, row.evaUv),
  };
}

// 按 monthKey(YYYY-MM) 升序合并多月数据，去重 key = week||category，同 key 后出现的月份覆盖前面
// monthlyRowsInOrder: [{ monthKey: '2026-04', rows: [...] }, ...]，调用方保证按 monthKey 升序传入
function mergeRows(monthlyRowsInOrder) {
  const map = new Map();
  for (const { rows } of monthlyRowsInOrder) {
    for (const row of rows) {
      if (!row.week || !row.category) continue;
      const key = `${row.week}||${row.category}`;
      map.set(key, row);
    }
  }
  return [...map.values()];
}

// 用未过滤的品类分层原始行判断哪些品类是"自营(非聚合)"，构造排除集合
function buildExcludedCategorySet(rawTaxonomyRows) {
  return new Set(rawTaxonomyRows.filter(taxonomySync.isSelfOperated).map((r) => r.category));
}

function filterByExcludedCategories(rows, excludedSet) {
  return rows.filter((r) => !excludedSet.has(r.category));
}

async function sync() {
  console.log('[category-sync] 开始同步品类漏斗数据...');
  const monthKeys = Object.keys(MONTH_TABLES).sort();
  const monthlyRowsInOrder = [];
  for (const monthKey of monthKeys) {
    const { wikiNode, tableId } = MONTH_TABLES[monthKey];
    console.log(`[category-sync] 拉取 ${monthKey} (node=${wikiNode}, table=${tableId})`);
    const { records } = await bitable.listBitableRecords(wikiNode, tableId);
    const rows = records.map((r) => normalizeCategoryRecord(r.fields)).filter((r) => r.week && r.category);
    console.log(`[category-sync] ${monthKey} 归一化后 ${rows.length} 行`);
    monthlyRowsInOrder.push({ monthKey, rows });
  }

  let merged = mergeRows(monthlyRowsInOrder);
  console.log(`[category-sync] 合并去重后 ${merged.length} 行`);

  const rawTaxonomyRows = await taxonomySync.fetchRawRows();
  const excluded = buildExcludedCategorySet(rawTaxonomyRows);
  merged = filterByExcludedCategories(merged, excluded);
  console.log(`[category-sync] 过滤自营(非聚合)品类后 ${merged.length} 行 (排除品类: ${[...excluded].join(',') || '无'})`);

  const rows = merged.map((row) => ({ ...row, ...computeRates(row) }));

  const wikiNodesByMonth = {};
  for (const monthKey of monthKeys) wikiNodesByMonth[monthKey] = MONTH_TABLES[monthKey].wikiNode;

  const cache = {
    syncedAt: new Date().toISOString(),
    source: { wikiNodesByMonth },
    rows,
  };
  store.writeJSON('category-cache.json', cache);
  store.appendLog({ action: 'category-sync', rows: rows.length, excludedCategories: excluded.size });
  console.log('[category-sync] 完成');
  return { rows: rows.length, excludedCategories: excluded.size };
}

module.exports = {
  sync,
  normalizeCategoryRecord,
  computeRates,
  mergeRows,
  buildExcludedCategorySet,
  filterByExcludedCategories,
  HEADER_MAP,
  MONTH_TABLES,
};

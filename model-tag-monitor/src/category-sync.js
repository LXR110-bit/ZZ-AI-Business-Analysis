// 品类维度漏斗数据同步：本地 CSV → data/category-cache.json
// 数据源：data pipeline 投递到 data/imports/category_daily_avg_*.csv
'use strict';

const { parseCSVGlob, getImportsDir } = require('./csv-reader');
const store = require('./store');
const taxonomySync = require('./taxonomy-sync');

const IMPORTS_DIR = getImportsDir();
const CSV_PREFIX = 'category_daily_avg_';

// 表头字段(中文列名) → 内部字段名，口径与 src/sync.js HEADER_MAP 一致(周日均)
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

// 数字转换
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCategoryRecord(fields) {
  const row = {};
  for (const [cnKey, enKey] of Object.entries(HEADER_MAP)) {
    if (fields[cnKey] === undefined) continue;
    row[enKey] = fields[cnKey];
  }
  for (const k of TEXT_FIELDS) row[k] = row[k] != null ? String(row[k]).trim() : '';
  for (const k of NUMBER_FIELDS) row[k] = toNum(row[k]);
  return row;
}

// 4 个核心转化率，口径与 src/sync.js computeRates 一致
function computeRates(row) {
  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  return {
    evaRate: safeDiv(row.evaUv, row.jkuv),
    orderRate: safeDiv(row.orderUv, row.evaUv),
    shipRate: safeDiv(row.shipCnt, row.evaUv),
    dealRate: safeDiv(row.dealCnt, row.evaUv),
  };
}

// 去重 key = week||category，后出现的行覆盖前面（CSV 已按月份升序排列）
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

function sync() {
  console.log('[category-sync] 开始同步品类漏斗数据...');
  const rawRows = parseCSVGlob(IMPORTS_DIR, CSV_PREFIX);
  if (!rawRows.length) {
    console.warn(`[category-sync] 未找到匹配文件: ${IMPORTS_DIR}/${CSV_PREFIX}*.csv`);
    return { rows: 0, excludedCategories: 0 };
  }
  console.log(`[category-sync] 读取到 ${rawRows.length} 行原始 CSV 数据`);

  const normalized = rawRows.map((r) => normalizeCategoryRecord(r)).filter((r) => r.week && r.category);
  // 包装成 mergeRows 需要的格式（单批次，CSV 文件已按月份排列）
  const monthlyRowsInOrder = [{ monthKey: 'all', rows: normalized }];

  let merged = mergeRows(monthlyRowsInOrder);
  console.log(`[category-sync] 归一化去重后 ${merged.length} 行`);

  const rawTaxonomyRows = taxonomySync.fetchRawRows();
  const excluded = buildExcludedCategorySet(rawTaxonomyRows);
  merged = filterByExcludedCategories(merged, excluded);
  console.log(`[category-sync] 过滤自营(非聚合)品类后 ${merged.length} 行 (排除品类: ${[...excluded].join(',') || '无'})`);

  const rows = merged.map((row) => ({ ...row, ...computeRates(row) }));

  const cache = {
    syncedAt: new Date().toISOString(),
    source: { dir: IMPORTS_DIR, prefix: CSV_PREFIX },
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
};

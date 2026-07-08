// 品类维度漏斗数据同步：本地 CSV → data/category-cache.json
// 数据源：data pipeline 投递到 data/imports/category_daily_avg_*.csv
'use strict';

const { parseCSVGlob, getImportsDir } = require('./csv-reader');
const store = require('./store');
const taxonomySync = require('./taxonomy-sync');

const IMPORTS_DIR = getImportsDir();
const CSV_PREFIX = 'category_daily_avg_';
const KEEP_WEEKS = Number.parseInt(process.env.KEEP_WEEKS || '10', 10);

const HEADER_MAP = {
  统计周: 'week',
  周次: 'week',
  week: 'week',
  week_start_date: 'startDate',
  周开始: 'startDate',
  开始日期: 'startDate',
  周结束: 'endDate',
  结束日期: 'endDate',
  day_cnt: 'daysReceived',
  已收到天数: 'daysReceived',
  品类名称: 'category',
  品类: 'category',
  三级品类: 'category',
  机况UV日均: 'jkuv',
  机况UV: 'jkuv',
  机况uv: 'jkuv',
  机况页UV: 'jkuv',
  conditionUv: 'conditionUv',
  机况页去重UV: 'conditionUv',
  估价UV日均: 'evaUv',
  估价UV: 'evaUv',
  估价uv: 'evaUv',
  估价量日均: 'evaCnt',
  估价量: 'evaCnt',
  下单UV日均: 'orderUv',
  下单UV: 'orderUv',
  下单uv: 'orderUv',
  下单量日均: 'orderCnt',
  下单量: 'orderCnt',
  发货量日均: 'shipCnt',
  发货量: 'shipCnt',
  签收量日均: 'signCnt',
  签收量: 'signCnt',
  质检量日均: 'qcCnt',
  质检量: 'qcCnt',
  成交量日均: 'dealCnt',
  成交量: 'dealCnt',
  退回量日均: 'returnCnt',
  退回量: 'returnCnt',
  成交GMV日均: 'gmv',
  成交GMV: 'gmv',
  成交gmv: 'gmv',
  GMV: 'gmv',
};

const NUMBER_FIELDS = ['jkuv', 'conditionUv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv', 'daysReceived'];
const TEXT_FIELDS = ['week', 'startDate', 'endDate', 'category'];

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function getField(fields, header) {
  if (Object.prototype.hasOwnProperty.call(fields, header)) return fields[header];
  const lower = header.toLowerCase();
  const hit = Object.keys(fields).find((k) => String(k).trim().toLowerCase() === lower);
  return hit ? fields[hit] : undefined;
}

function dateToISOWeek(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return '';
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  const dayOfWeek = d.getUTCDay() || 7;
  const weekThursday = new Date(d.getTime() + (4 - dayOfWeek) * 86400000);
  const year = weekThursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((weekThursday - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

function addDays(dateStr, days) {
  const d = new Date(String(dateStr || '') + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseTargetWeeks(value) {
  const weeks = String(value || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  if (!weeks.length) return null;
  const invalid = weeks.filter((w) => !/^\d{4}-W\d{2}$/.test(w));
  if (invalid.length) throw new Error(`TARGET_WEEKS 格式错误: ${invalid.join(',')}`);
  return new Set(weeks.sort());
}

function normalizeCategoryRecord(fields) {
  const row = {};
  for (const [cnKey, enKey] of Object.entries(HEADER_MAP)) {
    const val = getField(fields, cnKey);
    if (val === undefined) continue;
    row[enKey] = val;
  }
  for (const k of TEXT_FIELDS) row[k] = row[k] != null ? String(row[k]).trim() : '';
  if (!row.week && row.startDate) row.week = dateToISOWeek(row.startDate);
  if (!row.endDate && row.startDate) row.endDate = addDays(row.startDate, 6);
  for (const k of NUMBER_FIELDS) row[k] = toNum(row[k]);
  if (!row.conditionUv) row.conditionUv = row.jkuv;
  return row;
}

function computeRates(row) {
  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  const conditionDenominator = row.conditionUv || row.jkuv;
  return {
    evaRate: safeDiv(row.evaUv, conditionDenominator),
    orderRate: safeDiv(row.orderUv, row.evaUv),
    shipRate: safeDiv(row.shipCnt, row.evaUv),
    dealRate: safeDiv(row.dealCnt, row.evaUv),
  };
}

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

function buildExcludedCategorySet(rawTaxonomyRows) {
  return new Set(rawTaxonomyRows.filter(taxonomySync.isSelfOperated).map((r) => r.category));
}

function filterByExcludedCategories(rows, excludedSet) {
  return rows.filter((r) => !excludedSet.has(r.category));
}

function selectWeeks(rows) {
  const explicit = parseTargetWeeks(process.env.TARGET_WEEKS);
  if (explicit) return explicit;
  return new Set([...new Set(rows.map((r) => r.week).filter(Boolean))].sort().slice(-KEEP_WEEKS));
}

function sync() {
  console.log('[category-sync] 开始同步品类漏斗数据...');
  const rawRows = parseCSVGlob(IMPORTS_DIR, CSV_PREFIX);
  if (!rawRows.length) {
    console.warn(`[category-sync] 未找到匹配文件: ${IMPORTS_DIR}/${CSV_PREFIX}*.csv`);
    return { rows: 0, excludedCategories: 0, weeks: 0, categories: 0 };
  }
  console.log(`[category-sync] 读取到 ${rawRows.length} 行原始 CSV 数据`);

  const normalizedAll = rawRows.map((r) => normalizeCategoryRecord(r)).filter((r) => r.week && r.category);
  const targetWeeks = selectWeeks(normalizedAll);
  const normalized = normalizedAll.filter((r) => targetWeeks.has(r.week));
  const monthlyRowsInOrder = [{ monthKey: 'all', rows: normalized }];

  let merged = mergeRows(monthlyRowsInOrder);
  console.log(`[category-sync] 目标周 ${[...targetWeeks].sort().join(', ')}；归一化去重后 ${merged.length} 行`);

  const rawTaxonomyRows = taxonomySync.fetchRawRows();
  const excluded = buildExcludedCategorySet(rawTaxonomyRows);
  merged = filterByExcludedCategories(merged, excluded);
  console.log(`[category-sync] 过滤自营(非聚合)品类后 ${merged.length} 行 (排除品类: ${[...excluded].join(',') || '无'})`);

  const rows = merged.map((row) => ({ ...row, ...computeRates(row) }));
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  const categories = [...new Set(rows.map((r) => r.category))].sort();

  const cache = {
    syncedAt: new Date().toISOString(),
    version: '1.2.0',
    source: {
      dir: IMPORTS_DIR,
      prefix: CSV_PREFIX,
      targetWeeks: [...targetWeeks].sort(),
      grain: 'category_dedup_daily_avg',
      evaUv: 'category-level deduplicated weekly daily average',
    },
    weeks,
    categories,
    rows,
  };
  store.writeJSON('category-cache.json', cache);
  store.appendLog({ action: 'category-sync', rows: rows.length, categories: categories.length, weeks: weeks.length, excludedCategories: excluded.size });
  console.log('[category-sync] 完成');
  return { rows: rows.length, categories: categories.length, weeks: weeks.length, excludedCategories: excluded.size };
}

module.exports = {
  sync,
  normalizeCategoryRecord,
  computeRates,
  mergeRows,
  buildExcludedCategorySet,
  filterByExcludedCategories,
  dateToISOWeek,
  parseTargetWeeks,
  HEADER_MAP,
};

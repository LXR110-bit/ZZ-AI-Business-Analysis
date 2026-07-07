// 品类分层映射表同步：本地 CSV → data/category-taxonomy.json
// 数据源：data pipeline 投递到 data/imports/category_taxonomy.csv
'use strict';

const { parseCSV, getImportsDir } = require('./csv-reader');
const store = require('./store');

const IMPORTS_DIR = getImportsDir();
const CSV_FILE = 'category_taxonomy.csv';

// 表头字段(中文列名) → 内部字段名
const HEADER_MAP = {
  三级品类: 'category',
  阶段: 'tier',
  二级板块: 'board',
  业务状态: 'status',
  归类置信度: 'confidence',
  '最新周GMV(元)': 'lastWeekGmv',
};

const VALID_TIERS = ['发展', '孵化', '种子', '自营(非聚合)'];
const VALID_STATUSES = ['在售', '已下线'];

// 数字转换
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// 把一条 CSV 行对象(中文 key) 归一化成内部字段名
function normalizeTaxonomyRecord(fields) {
  const row = {};
  for (const [cnKey, enKey] of Object.entries(HEADER_MAP)) {
    const raw = fields[cnKey];
    if (enKey === 'lastWeekGmv') {
      row[enKey] = toNum(raw);
    } else {
      row[enKey] = raw != null ? String(raw).trim() : '';
    }
  }
  return row;
}

function isSelfOperated(row) {
  return row.tier === '自营(非聚合)';
}

function filterSelfOperated(rows) {
  return rows.filter((r) => !isSelfOperated(r));
}

// 读取 CSV + 归一化，不做自营过滤(给 category-sync 复用做交叉过滤判断)
function fetchRawRows() {
  const filepath = path.join(IMPORTS_DIR, CSV_FILE);
  const rawRows = parseCSV(filepath);
  const rows = rawRows.map((r) => normalizeTaxonomyRecord(r));
  for (const row of rows) {
    if (row.tier && !VALID_TIERS.includes(row.tier)) {
      console.warn(`[taxonomy-sync] 警告: 未知 tier 值 "${row.tier}" (category=${row.category})`);
    }
    if (row.status && !VALID_STATUSES.includes(row.status)) {
      console.warn(`[taxonomy-sync] 警告: 未知 status 值 "${row.status}" (category=${row.category})`);
    }
  }
  return rows;
}

function sync() {
  console.log('[taxonomy-sync] 开始同步品类分层映射...');
  const rawRows = fetchRawRows();
  const rows = filterSelfOperated(rawRows);
  console.log(`[taxonomy-sync] 原始 ${rawRows.length} 行, 过滤自营(非聚合)后 ${rows.length} 行`);

  const cache = {
    syncedAt: new Date().toISOString(),
    rows,
  };
  store.writeJSON('category-taxonomy.json', cache);
  store.appendLog({ action: 'taxonomy-sync', rows: rows.length, filtered: rawRows.length - rows.length });
  console.log('[taxonomy-sync] 完成');
  return { rows: rows.length, filtered: rawRows.length - rows.length };
}

module.exports = {
  sync,
  fetchRawRows,
  normalizeTaxonomyRecord,
  isSelfOperated,
  filterSelfOperated,
  HEADER_MAP,
  VALID_TIERS,
  VALID_STATUSES,
};

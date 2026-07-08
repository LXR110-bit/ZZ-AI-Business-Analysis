// 品类分层映射表同步：本地 CSV → data/category-taxonomy.json
// 数据源优先级：IMPORT_DIR/category_taxonomy.csv → config/category_taxonomy_seed.csv
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCSV, getImportsDir } = require('./csv-reader');
const store = require('./store');

const IMPORTS_DIR = getImportsDir();
const CSV_FILE = 'category_taxonomy.csv';
const SEED_FILE = path.join(__dirname, '..', 'config', 'category_taxonomy_seed.csv');

// 表头字段(中文列名) → 内部字段名
const HEADER_MAP = {
  三级品类: 'category',
  品类名称: 'category',
  品类: 'category',
  阶段: 'tier',
  分层: 'tier',
  二级板块: 'board',
  二级类目: 'board',
  业务状态: 'status',
  状态: 'status',
  归类置信度: 'confidence',
  置信度: 'confidence',
  '最新周GMV(元)': 'lastWeekGmv',
  lastWeekGmv: 'lastWeekGmv',
};

const VALID_TIERS = ['发展', '孵化', '种子', '自营(非聚合)'];
const VALID_STATUSES = ['在售', '已下线'];

function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function firstValue(fields, cnKey) {
  if (Object.prototype.hasOwnProperty.call(fields, cnKey)) return fields[cnKey];
  const lower = cnKey.toLowerCase();
  const hit = Object.keys(fields).find((k) => String(k).trim().toLowerCase() === lower);
  return hit ? fields[hit] : undefined;
}

function normalizeTaxonomyRecord(fields) {
  const row = {};
  for (const [cnKey, enKey] of Object.entries(HEADER_MAP)) {
    const raw = firstValue(fields, cnKey);
    if (raw === undefined) continue;
    if (enKey === 'lastWeekGmv') row[enKey] = toNum(raw);
    else row[enKey] = raw != null ? String(raw).trim() : '';
  }
  row.category = row.category || '';
  row.tier = row.tier || '';
  row.board = row.board || '';
  row.status = row.status || '在售';
  row.confidence = row.confidence || '';
  row.lastWeekGmv = toNum(row.lastWeekGmv);
  return row;
}

function isSelfOperated(row) {
  return row.tier === '自营(非聚合)';
}

function filterSelfOperated(rows) {
  return rows.filter((r) => !isSelfOperated(r));
}

function resolveSourceFile() {
  const importFile = path.join(IMPORTS_DIR, CSV_FILE);
  if (fs.existsSync(importFile)) return { filepath: importFile, sourceType: 'import' };
  if (fs.existsSync(SEED_FILE)) return { filepath: SEED_FILE, sourceType: 'seed' };
  throw new Error(`未找到品类分层映射 CSV：${importFile}，且 seed 不存在：${SEED_FILE}`);
}

function fetchRawRows() {
  const { filepath } = resolveSourceFile();
  const rawRows = parseCSV(filepath);
  const rows = rawRows.map((r) => normalizeTaxonomyRecord(r)).filter((r) => r.category);
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
  const source = resolveSourceFile();
  const rawRows = fetchRawRows();
  const rows = filterSelfOperated(rawRows);
  console.log(`[taxonomy-sync] source=${source.sourceType} raw=${rawRows.length}, filtered=${rows.length}`);

  const cache = {
    syncedAt: new Date().toISOString(),
    version: '1.2.3',
    source,
    rows,
  };
  store.writeJSON('category-taxonomy.json', cache);
  store.appendLog({ action: 'taxonomy-sync', rows: rows.length, filtered: rawRows.length - rows.length, sourceType: source.sourceType });
  console.log('[taxonomy-sync] 完成');
  return { rows: rows.length, filtered: rawRows.length - rows.length, sourceType: source.sourceType };
}

module.exports = {
  sync,
  fetchRawRows,
  resolveSourceFile,
  normalizeTaxonomyRecord,
  isSelfOperated,
  filterSelfOperated,
  HEADER_MAP,
  VALID_TIERS,
  VALID_STATUSES,
};

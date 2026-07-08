// 大盘/DAU/入口补充数据同步：本地 CSV → data/board-metrics.json
// 数据源边界：飞书只作为备份/补充；服务端运行时只读取已落地本地 CSV/JSON。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseCSV, getImportsDir } = require('./csv-reader');
const store = require('./store');

const FILE_PREFIXES = ['board_metrics_', 'board-metrics_', 'board_metrics', 'board-metrics'];
const KEEP_WEEKS = Number.parseInt(process.env.KEEP_WEEKS || '10', 10);

const HEADER_MAP = {
  统计周: 'week',
  周次: 'week',
  week: 'week',
  week_start_date: 'startDate',
  周日期: 'startDate',
  周开始: 'startDate',
  开始日期: 'startDate',
  APP日均DAU: 'appDau',
  'APP日均 DAU': 'appDau',
  'APP DAU': 'appDau',
  大盘DAU: 'appDau',
  大盘日均DAU: 'appDau',
  appDau: 'appDau',
  回收入口UV: 'recycleEntranceUv',
  '回收入口 UV': 'recycleEntranceUv',
  recycleEntranceUv: 'recycleEntranceUv',
  聚合回收渗透率: 'penetrationRate',
  penetrationRate: 'penetrationRate',
  聚合回收真实渗透率: 'realPenetrationRate',
  realPenetrationRate: 'realPenetrationRate',
};

const NUMBER_FIELDS = ['appDau', 'recycleEntranceUv'];
const RATE_FIELDS = ['penetrationRate', 'realPenetrationRate'];

function getField(fields, header) {
  if (Object.prototype.hasOwnProperty.call(fields, header)) return fields[header];
  const normalized = normalizeHeader(header);
  const hit = Object.keys(fields).find((k) => normalizeHeader(k) === normalized);
  return hit ? fields[hit] : undefined;
}

function normalizeHeader(header) {
  return String(header || '').trim().replace(/\s+/g, '').toLowerCase();
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, '');
  if (!s || s === '-' || s === '/') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function toRate(v) {
  if (v === null || v === undefined || v === '') return null;
  const raw = String(v).trim();
  if (!raw || raw === '-' || raw === '/') return null;
  const hasPct = raw.includes('%');
  const n = Number(raw.replace(/,/g, '').replace('%', ''));
  if (!Number.isFinite(n)) return null;
  if (hasPct) return n / 100;
  return Math.abs(n) > 1 ? n / 100 : n;
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

function normalizeWeek(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const full = s.match(/^(\d{4})[-_]?W(\d{1,2})$/i);
  if (full) return `${full[1]}-W${String(Number(full[2])).padStart(2, '0')}`;
  const short = s.match(/^(\d{2})[-_]?W(\d{1,2})$/i);
  if (short) return `20${short[1]}-W${String(Number(short[2])).padStart(2, '0')}`;
  return s;
}

function normalizeBoardMetricRecord(fields) {
  const row = {};
  for (const [sourceKey, targetKey] of Object.entries(HEADER_MAP)) {
    const val = getField(fields, sourceKey);
    if (val !== undefined) row[targetKey] = val;
  }
  row.week = row.week != null ? normalizeWeek(row.week) : '';
  row.startDate = row.startDate != null ? String(row.startDate).trim() : '';
  if (!row.week && row.startDate) row.week = dateToISOWeek(row.startDate);
  for (const k of NUMBER_FIELDS) row[k] = toNum(row[k]);
  for (const k of RATE_FIELDS) row[k] = toRate(row[k]);
  return row;
}

function isBoardMetricFile(file) {
  if (!file.endsWith('.csv')) return false;
  return FILE_PREFIXES.some((prefix) => file === `${prefix}.csv` || file.startsWith(prefix));
}

function readRawRows(importsDir = getImportsDir()) {
  if (!fs.existsSync(importsDir)) return [];
  const files = fs.readdirSync(importsDir).filter(isBoardMetricFile).sort();
  let rows = [];
  for (const file of files) {
    rows = rows.concat(parseCSV(path.join(importsDir, file)));
  }
  return rows;
}

function selectWeeks(rows) {
  const explicit = parseTargetWeeks(process.env.TARGET_WEEKS);
  if (explicit) return explicit;
  return new Set([...new Set(rows.map((r) => r.week).filter(Boolean))].sort().slice(-KEEP_WEEKS));
}

function mergeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.week) continue;
    map.set(row.week, row);
  }
  return [...map.values()].sort((a, b) => a.week.localeCompare(b.week));
}

function sync(opts = {}) {
  const importsDir = opts.importsDir || getImportsDir();
  console.log('[board-sync] 开始同步大盘/DAU/入口补充数据...');
  const rawRows = readRawRows(importsDir);
  if (!rawRows.length) {
    console.warn(`[board-sync] 未找到匹配文件: ${importsDir}/board_metrics*.csv`);
    return { rows: 0, weeks: 0, source: { dir: importsDir, prefixes: FILE_PREFIXES } };
  }

  const normalizedAll = rawRows.map((r) => normalizeBoardMetricRecord(r)).filter((r) => r.week);
  const targetWeeks = selectWeeks(normalizedAll);
  const rows = mergeRows(normalizedAll.filter((r) => targetWeeks.has(r.week)));
  const weeks = rows.map((r) => r.week);
  const cache = {
    syncedAt: new Date().toISOString(),
    version: '1.3.0',
    source: { dir: importsDir, prefixes: FILE_PREFIXES, targetWeeks: [...targetWeeks].sort() },
    weeks,
    rows,
  };
  store.writeJSON('board-metrics.json', cache);
  store.appendLog({ action: 'board-sync', rows: rows.length, weeks: weeks.length });
  console.log(`[board-sync] 完成 rows=${rows.length} weeks=${weeks.join(',')}`);
  return { rows: rows.length, weeks: weeks.length, source: cache.source };
}

module.exports = {
  sync,
  normalizeBoardMetricRecord,
  dateToISOWeek,
  parseTargetWeeks,
  normalizeWeek,
  mergeRows,
  toRate,
  HEADER_MAP,
};

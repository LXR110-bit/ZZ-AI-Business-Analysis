'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CONTRACT_VERSION = 'ai-wan-v1.5.5-process';
const FETCH_CONTRACT_VERSION = 'ai-wan-v1.5.5-fetch';
const CATEGORY_MAPPING_CONTRACT_VERSION = 'ai-wan-category-mapping/v1';
const CATEGORY_MAPPING_BASE_TOKEN = 'NKw4b2eKxaKhDTsOrD9cONklnGb';
const CATEGORY_MAPPING_TABLE = '品类映射';
const KEEP_WEEKS = 10;
const DASHBOARD_WINDOW_WEEKS = 2;
const MIN_HISTORY_WEEKS_FOR_TREND = 8;
const RAW_SCRIPTS = [
  'category_daily_avg',
  'category_summary',
  'category_fulfill_daily_avg',
  'category_fulfill_summary',
  'model_daily_avg',
  'model_summary',
];
const PREFIXES = RAW_SCRIPTS;
const MATERIALIZE_SCRIPTS = new Set(RAW_SCRIPTS.filter((script) => script !== 'model_summary'));
const METRIC_HEADERS = ['机况uv', '估价uv', '下单uv', '下单量', '发货量', '签收量', '质检量', '成交量', '退回量', '成交gmv'];
const METRIC_ALIASES = {
  '机况uv': ['机况uv', '机况UV', 'ji_kuang_uv', 'jkuv', 'jk_uv'],
  '估价uv': ['估价uv', '估价UV', 'gu_jia_uv', 'eva_uv', 'evaUv'],
  '下单uv': ['下单uv', '下单UV', 'xia_dan_uv', 'order_uv', 'orderUv'],
  '下单量': ['下单量', 'xia_dan_cnt', 'order_cnt', 'orderCnt'],
  '发货量': ['发货量', 'fa_huo_cnt', 'ship_cnt', 'shipCnt'],
  '签收量': ['签收量', 'qian_shou_cnt', 'sign_cnt', 'signCnt'],
  '质检量': ['质检量', 'zhi_jian_cnt', 'qc_cnt', 'qcCnt'],
  '成交量': ['成交量', 'cheng_jiao_cnt', 'deal_cnt', 'dealCnt'],
  '退回量': ['退回量', 'tui_hui_cnt', 'return_cnt', 'returnCnt'],
  '成交gmv': ['成交gmv', '成交GMV', 'cheng_jiao_gmv', 'deal_gmv', 'gmv'],
};
const CACHE_METRICS = ['jkuv', 'evaUv', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv'];
const MODEL_DETAIL_HEADERS = ['核心属性（估价）', '成色等级（估价）', '核心属性（质检）', '成色等级（质检）', '履约方式（只取线上流程）'];
const DEFAULT_VOCAB = {
  core: ['核心', '非核心', '观察'],
  lifecycle: ['新品', '主流', '长尾', '淘汰'],
  price: ['高价段', '中价段', '低价段'],
  custom: {},
};
const PACKAGE_SNAPSHOT_DIR = path.resolve(__dirname, '../references/server-snapshot');
const LOW_VOLUME_BASELINE_THRESHOLDS = { gmv: 1000, dealCnt: 2, orderCnt: 5, evaUv: 20 };

function nowIso() { return new Date().toISOString(); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function sha256Buffer(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(file) { return sha256Buffer(fs.readFileSync(file)); }
function sha256Json(value) { return sha256Buffer(Buffer.from(JSON.stringify(sortObject(value)), 'utf8')); }
function rel(from, file) { return path.relative(from, file).split(path.sep).join('/'); }
function safeReadJson(file, fallback) { return fs.existsSync(file) ? readJson(file) : fallback; }
function uniqueExistingDirs(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs.filter(Boolean).map((d) => path.resolve(d))) {
    if (!seen.has(dir) && fs.existsSync(dir)) { seen.add(dir); out.push(dir); }
  }
  return out;
}
function snapshotCandidateDirs(snapshotDir) {
  return uniqueExistingDirs([snapshotDir, PACKAGE_SNAPSHOT_DIR, path.resolve(__dirname, '../../../model-tag-monitor/data')]);
}
function firstExistingFile(dirs, name) {
  for (const dir of dirs) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return '';
}
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = sortObject(value[k]);
  return out;
}
function assertTool(name) {
  const p = spawnSync('sh', ['-lc', `command -v ${name}`], { encoding: 'utf8' });
  if (p.status !== 0) throw new Error(`missing required tool: ${name}`);
}
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res;
}
function zipDir(sourceDir, outFile, entries = ['.']) {
  assertTool('zip');
  ensureDir(path.dirname(outFile));
  const absOut = path.resolve(outFile);
  if (fs.existsSync(absOut)) fs.rmSync(absOut, { force: true });
  run('zip', ['-qr', absOut, ...entries], { cwd: sourceDir });
}
function unzip(zipFile, destDir) {
  assertTool('unzip');
  ensureDir(destDir);
  run('unzip', ['-q', path.resolve(zipFile), '-d', destDir]);
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${token}`);
      args[key] = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
function csvEscape(value) {
  const s = value == null ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function writeCsv(file, headers, rows) {
  ensureDir(path.dirname(file));
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}
function disambiguateHeaders(headers) {
  const seen = new Map();
  return headers.map((h) => {
    const base = String(h || '').trim();
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}.${n}`;
  });
}
function parseCsvFile(file, options = {}) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rawLines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (!rawLines.length) return { headers: [], rows: [], repair: { fixed_rows: 0, bad_rows: 0 } };
  const originalHeaders = parseCsvLine(rawLines[0]).map((h) => h.trim());
  const headers = disambiguateHeaders(originalHeaders);
  const modelNameIndex = headers.findIndex((h) => ['机型名称', '型号名称', '型号', 'model_name', 'model_name_label', 'modelName'].some((candidate) => normalizeHeader(h) === normalizeHeader(candidate)));
  const rows = [];
  const repair = { fixed_rows: 0, bad_rows: 0 };
  for (const line of rawLines.slice(1)) {
    let cols = parseCsvLine(line);
    if (options.repairModelNameCommas && cols.length > headers.length && modelNameIndex >= 0) {
      const surplus = cols.length - headers.length;
      cols = [
        ...cols.slice(0, modelNameIndex),
        cols.slice(modelNameIndex, modelNameIndex + surplus + 1).join(','),
        ...cols.slice(modelNameIndex + surplus + 1),
      ];
      repair.fixed_rows += 1;
    }
    if (cols.length !== headers.length) repair.bad_rows += 1;
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] == null ? '' : cols[idx]; });
    rows.push(row);
  }
  return { headers, rows, repair };
}
function normalizeHeader(h) { return String(h || '').trim().replace(/\s+/g, '').replace(/_/g, '').toLowerCase(); }
function first(row, candidates) {
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(row, c)) return row[c];
  }
  const keys = Object.keys(row);
  for (const c of candidates) {
    const n = normalizeHeader(c);
    const hit = keys.find((k) => normalizeHeader(k) === n);
    if (hit) return row[hit];
  }
  return '';
}
function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join(',');
  if (typeof value === 'object') {
    if (value.text != null) return textValue(value.text);
    if (value.name != null) return textValue(value.name);
    if (value.value != null) return textValue(value.value);
    if (value.en_name != null) return textValue(value.en_name);
    if (value.fields) return textValue(value.fields);
  }
  return '';
}
function toNum(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/,/g, '').replace(/%$/, '').trim());
  return Number.isFinite(n) ? n : 0;
}
function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dateDiffDays(a, b) {
  const da = new Date(`${a}T00:00:00Z`);
  const db = new Date(`${b}T00:00:00Z`);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.floor((da - db) / 86400000);
}
function dateToISOWeek(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return '';
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const dayOfWeek = d.getUTCDay() || 7;
  const weekThursday = new Date(d.getTime() + (4 - dayOfWeek) * 86400000);
  const year = weekThursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((weekThursday - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}
function rollingInfo(weekStart, runDt) {
  const endDate = addDays(weekStart, 6);
  const diff = dateDiffDays(runDt, weekStart);
  if (diff == null) return { day_cnt: 0, week: '', startDate: weekStart, endDate, rolling_status: 'unknown' };
  const dayCnt = Math.min(7, Math.max(1, diff + 1));
  const status = dayCnt < 7 && dateDiffDays(runDt, endDate) <= 0 ? 'rolling' : 'final';
  return { day_cnt: status === 'final' ? 7 : dayCnt, week: dateToISOWeek(weekStart), startDate: weekStart, endDate, rolling_status: status };
}
function isExplicitDailyAverageHeader(header) { return /日均|daily[_\s-]*avg|avg[_\s-]*daily/i.test(String(header || '')); }

function canonicalImportRows(script, parsed, runDt) {
  const rows = [];
  const repairs = parsed.repair || { fixed_rows: 0, bad_rows: 0 };
  for (const raw of parsed.rows) {
    const weekStart = String(first(raw, ['week_start_date', '周开始', '开始日期', '统计日期', '日期', 'startDate'])).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) continue;
    const info = rollingInfo(weekStart, runDt);
    const base = { week_start_date: weekStart };
    if (script.includes('category')) base['品类名称'] = String(first(raw, ['品类名称', '品类', '三级品类', 'cate_name', 'cate_name_label', 'category_name', 'category_name_label'])).trim();
    if (script.includes('fulfill')) base['履约方式（只取线上流程）'] = String(first(raw, ['履约方式（只取线上流程）', '履约方式', 'order_source_name', 'fulfillmentMethod', 'fulfill_type', 'fulfillment_type'])).trim();
    if (script.includes('model')) {
      base['品类名称'] = String(first(raw, ['品类名称', '品类', 'cate_name', 'cate_name_label', 'category_name', 'category_name_label'])).trim();
      base['机型id'] = String(first(raw, ['机型id', '机型ID', '型号ID', 'model_id', 'model_id_col', 'modelId'])).trim().replace(/^(\d+)\.0+$/, '$1');
      base['机型名称'] = String(first(raw, ['机型名称', '型号名称', '型号', 'model_name', 'model_name_label', 'modelName'])).trim();
      base['核心属性（估价）'] = String(first(raw, ['核心属性（估价）', '核心属性_估价', 'ev_param_name'])).trim();
      base['成色等级（估价）'] = String(first(raw, ['成色等级（估价）', '成色等级_估价', 'ev_grade_name'])).trim();
      base['品类名称.1'] = String(first(raw, ['品类名称.1', '品类名称', '品类', 'cate_name', 'cate_name_label', 'category_name', 'category_name_label'])).trim();
      base['机型id.1'] = String(first(raw, ['机型id.1', '机型ID.1', '机型id', '机型ID', 'model_id', 'model_id_col', 'modelId'])).trim().replace(/^(\d+)\.0+$/, '$1');
      base['核心属性（质检）'] = String(first(raw, ['核心属性（质检）', '核心属性_质检', 'qc_param_name'])).trim();
      base['成色等级（质检）'] = String(first(raw, ['成色等级（质检）', '成色等级_质检', 'qc_grade_name'])).trim();
      base['履约方式（只取线上流程）'] = String(first(raw, ['履约方式（只取线上流程）', '履约方式', 'order_source_name', 'fulfillmentMethod', 'fulfill_type', 'fulfillment_type'])).trim();
    }
    base.day_cnt = String(toNum(first(raw, ['day_cnt', '已收到天数', 'daysReceived'])) || info.day_cnt);
    for (const h of METRIC_HEADERS) {
      const value = first(raw, METRIC_ALIASES[h] || [h, h.replace('uv', 'UV'), h.replace('gmv', 'GMV')]);
      base[h] = value === '' ? '' : String(value).trim();
    }
    if (base['品类名称'] === '' && script.includes('category')) continue;
    if (script.includes('model') && base['机型名称'] === '') continue;
    rows.push(base);
  }
  return { rows, repairs };
}
function headersFor(script) {
  if (script.startsWith('category_fulfill')) return ['week_start_date', '品类名称', '履约方式（只取线上流程）', 'day_cnt', ...METRIC_HEADERS.slice(2)];
  if (script.startsWith('category')) return ['week_start_date', '品类名称', 'day_cnt', ...METRIC_HEADERS];
  return ['week_start_date', '品类名称', '机型id', '机型名称', 'day_cnt', ...METRIC_HEADERS, ...MODEL_DETAIL_HEADERS.slice(0, 2), '品类名称.1', '机型id.1', ...MODEL_DETAIL_HEADERS.slice(2)];
}
function scriptRawFile(unpacked, script, runDt) {
  const rawDir = path.join(unpacked, 'raw');
  const exact = path.join(rawDir, `${script}_${runDt}.csv`);
  if (fs.existsSync(exact)) return exact;
  const hit = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).find((f) => f === `${script}.csv` || f.startsWith(`${script}_`) && f.endsWith('.csv')) : '';
  return hit ? path.join(rawDir, hit) : '';
}
function monthOf(row) { return String(row.week_start_date || '').slice(0, 7) || 'unknown'; }
function materializeImports(unpacked, importsDir, runDt, activeKnownGaps = new Set()) {
  ensureDir(importsDir);
  const stats = {};
  for (const script of RAW_SCRIPTS) {
    const file = scriptRawFile(unpacked, script, runDt);
    if (!file) throw new Error(`missing raw csv for ${script}`);
    const parsed = parseCsvFile(file, { repairModelNameCommas: script.startsWith('model') });
    if (!MATERIALIZE_SCRIPTS.has(script)) {
      stats[script] = {
        raw_file: rel(unpacked, file),
        raw_rows: parsed.rows.length,
        import_rows: 0,
        headers: headersFor(script),
        months: [],
        csv_repair: parsed.repair,
        materialized: false,
        skip_reason: 'unused_by_dashboard_cache',
      };
      continue;
    }
    const { rows, repairs } = canonicalImportRows(script, parsed, runDt);
    if (!rows.length) {
      const knownGap = knownGapForEmptyRaw(script);
      if (knownGap && activeKnownGaps.has(knownGap)) {
        stats[script] = {
          raw_file: rel(unpacked, file),
          raw_rows: parsed.rows.length,
          import_rows: 0,
          headers: headersFor(script),
          months: [],
          csv_repair: repairs,
          known_gap: knownGap,
        };
        continue;
      }
      throw new Error(`raw csv ${script} has no valid rows after normalization`);
    }
    const byMonth = new Map();
    for (const row of rows) {
      const month = monthOf(row);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push(row);
    }
    for (const [month, monthRows] of byMonth) writeCsv(path.join(importsDir, `${script}_${month}.csv`), headersFor(script), monthRows);
    stats[script] = {
      raw_file: rel(unpacked, file),
      raw_rows: parsed.rows.length,
      import_rows: rows.length,
      headers: headersFor(script),
      months: [...byMonth.keys()].sort(),
      csv_repair: repairs,
    };
  }
  return { stats };
}
function rowsFromImportFiles(importsDir, prefix) {
  if (!fs.existsSync(importsDir)) return [];
  const files = fs.readdirSync(importsDir).filter((f) => f.startsWith(`${prefix}_`) && f.endsWith('.csv')).sort();
  let rows = [];
  for (const file of files) rows = rows.concat(parseCsvFile(path.join(importsDir, file)).rows);
  return rows;
}
function writeRowsByMonth(importsDir, prefix, rows) {
  for (const f of fs.existsSync(importsDir) ? fs.readdirSync(importsDir) : []) {
    if (f.startsWith(`${prefix}_`) && f.endsWith('.csv')) fs.rmSync(path.join(importsDir, f));
  }
  const byMonth = new Map();
  for (const row of rows) {
    const month = monthOf(row);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(row);
  }
  for (const [month, list] of byMonth) writeCsv(path.join(importsDir, `${prefix}_${month}.csv`), headersFor(prefix), list);
}
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const item of fs.readdirSync(src)) {
    const s = path.join(src, item);
    const d = path.join(dest, item);
    const st = fs.statSync(s);
    if (st.isDirectory()) fs.cpSync(s, d, { recursive: true });
    else fs.copyFileSync(s, d);
  }
}
function latestWeeksFromRows(rows) {
  return [...new Set(rows.map((r) => dateToISOWeek(r.week_start_date)).filter(Boolean))].sort().slice(-KEEP_WEEKS);
}
function promoteImports({ currentImportsDir, previousProcessedCache, workDir, outputImportsDir }) {
  ensureDir(outputImportsDir);
  const prevDir = path.join(workDir, 'prev_processed');
  if (previousProcessedCache && fs.existsSync(previousProcessedCache)) {
    if (!fs.existsSync(prevDir)) unzip(previousProcessedCache, prevDir);
    copyDirContents(path.join(prevDir, 'imports'), outputImportsDir);
  }
  const report = { previous_cache: previousProcessedCache || '', scripts: {} };
  for (const prefix of PREFIXES) {
    const prevRows = rowsFromImportFiles(outputImportsDir, prefix);
    const curRows = rowsFromImportFiles(currentImportsDir, prefix);
    const curPartitions = new Set(curRows.map((r) => r.week_start_date).filter(Boolean));
    const merged = prevRows.filter((r) => !curPartitions.has(r.week_start_date)).concat(curRows);
    const keepWeeks = latestWeeksFromRows(merged);
    const keepSet = new Set(keepWeeks);
    const kept = merged.filter((r) => keepSet.has(dateToISOWeek(r.week_start_date)));
    writeRowsByMonth(outputImportsDir, prefix, kept);
    report.scripts[prefix] = { previous_rows: prevRows.length, current_rows: curRows.length, promoted_partitions: [...curPartitions].sort(), output_rows: kept.length, keep_weeks: keepWeeks };
  }
  return report;
}

function metricSourcesFromHeaders(headers) {
  const out = {};
  for (const [cacheKey, header] of Object.entries({ jkuv: '机况uv', evaUv: '估价uv', orderUv: '下单uv', orderCnt: '下单量', shipCnt: '发货量', signCnt: '签收量', qcCnt: '质检量', dealCnt: '成交量', returnCnt: '退回量', gmv: '成交gmv' })) {
    const hit = headers.find((h) => normalizeHeader(h) === normalizeHeader(header) || normalizeHeader(h) === normalizeHeader(header.replace('uv', 'UV')) || normalizeHeader(h) === normalizeHeader(header.replace('gmv', 'GMV')));
    out[cacheKey] = hit || header;
  }
  return out;
}
function normalizeMetricRow(row, sourceHeaders, runDt) {
  const info = rollingInfo(row.week_start_date, runDt);
  const days = toNum(row.day_cnt || row.daysReceived) || info.day_cnt;
  const out = { week: info.week, startDate: row.week_start_date, endDate: info.endDate, daysReceived: days, rollingStatus: info.rolling_status, sourceRunDt: runDt };
  const sourceMap = metricSourcesFromHeaders(sourceHeaders);
  const sourceByCacheKey = { jkuv: '机况uv', evaUv: '估价uv', orderUv: '下单uv', orderCnt: '下单量', shipCnt: '发货量', signCnt: '签收量', qcCnt: '质检量', dealCnt: '成交量', returnCnt: '退回量', gmv: '成交gmv' };
  for (const key of CACHE_METRICS) {
    let v = toNum(row[sourceByCacheKey[key]]);
    if (days > 1 && !isExplicitDailyAverageHeader(sourceMap[key])) v /= days;
    out[key] = v;
  }
  out.avgPrice = out.dealCnt > 0 ? out.gmv / out.dealCnt : 0;
  out.rates = computeRates(out);
  return out;
}
function computeRates(row) {
  const div = (a, b) => (b > 0 ? a / b : 0);
  return {
    evaRate: div(row.evaUv, row.jkuv),
    orderRate: div(row.orderUv, row.evaUv),
    shipRate: div(row.shipCnt, row.orderCnt),
    signRate: div(row.signCnt, row.shipCnt),
    qcRate: div(row.qcCnt, row.signCnt),
    dealRate: div(row.dealCnt, row.qcCnt),
    returnRate: div(row.returnCnt, row.qcCnt),
  };
}
function mergeRowsByKey(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) { map.set(key, { ...row }); continue; }
    const cur = map.get(key);
    for (const m of CACHE_METRICS) cur[m] = toNum(cur[m]) + toNum(row[m]);
    cur.daysReceived = Math.max(toNum(cur.daysReceived), toNum(row.daysReceived));
    cur.avgPrice = cur.dealCnt > 0 ? cur.gmv / cur.dealCnt : 0;
    cur.rates = computeRates(cur);
  }
  return [...map.values()];
}
function readTaxonomy(snapshotDir, previousCacheDir, warnings) {
  const dirs = snapshotCandidateDirs(snapshotDir);
  const csvFile = firstExistingFile(dirs, 'category_taxonomy.csv');
  if (csvFile) {
    const parsed = parseCsvFile(csvFile);
    const rows = parsed.rows.map((r) => ({
      category: String(first(r, ['品类名称', '三级品类', '品类', 'category'])).trim(),
      tier: String(first(r, ['阶段', '分层', 'tier'])).trim(),
      board: String(first(r, ['二级板块', '二级类目', 'board'])).trim(),
      status: String(first(r, ['业务状态', '状态', 'status'])).trim() || '在售',
      confidence: String(first(r, ['归类置信度', '置信度', 'confidence'])).trim(),
      lastWeekGmv: toNum(first(r, ['最新周GMV(元)', 'lastWeekGmv'])),
    })).filter((r) => r.category);
    return { syncedAt: nowIso(), version: '1.5.5-zloop', source: { type: 'snapshot_csv', file: path.resolve(csvFile) }, rows };
  }
  const jsonFile = firstExistingFile(dirs, 'category-taxonomy.json');
  if (jsonFile) return { ...readJson(jsonFile), source: { ...(readJson(jsonFile).source || {}), fallback: 'snapshot_json', file: path.resolve(jsonFile) } };
  const prev = previousCacheDir ? path.join(previousCacheDir, 'cache', 'category-taxonomy.json') : '';
  if (prev && fs.existsSync(prev)) return { ...readJson(prev), source: { ...(readJson(prev).source || {}), fallback: 'previous_processed_cache' } };
  const seed = path.resolve(__dirname, '../../../model-tag-monitor/config/category_taxonomy_seed.csv');
  if (fs.existsSync(seed)) {
    const parsed = parseCsvFile(seed);
    const rows = parsed.rows.map((r) => ({
      category: String(first(r, ['品类名称', '三级品类', '品类', 'category'])).trim(),
      tier: String(first(r, ['阶段', '分层', 'tier'])).trim(),
      board: String(first(r, ['二级板块', '二级类目', 'board'])).trim(),
      status: String(first(r, ['业务状态', '状态', 'status'])).trim() || '在售',
      confidence: String(first(r, ['归类置信度', '置信度', 'confidence'])).trim(),
      lastWeekGmv: toNum(first(r, ['最新周GMV(元)', 'lastWeekGmv'])),
    })).filter((r) => r.category);
    return { syncedAt: nowIso(), version: '1.5.5-zloop', source: { type: 'seed_csv', file: seed }, rows };
  }
  warnings.push('taxonomy_snapshot_missing');
  return { syncedAt: nowIso(), version: '1.5.5-zloop', source: { type: 'empty' }, rows: [] };
}

function normalizeCategoryMappingRows(input) {
  const rawRows = Array.isArray(input) ? input : (input.records || input.rows || input.items || []);
  return rawRows.map((record) => {
    const row = record.fields || record;
    return {
      category: textValue(first(row, ['三级品类', '品类名称', '品类', 'category'])),
      tier: textValue(first(row, ['阶段', '分层', 'tier', 'stage'])),
      board: textValue(first(row, ['二级板块', '二级类目', 'board', 'secondaryCategory'])),
      status: textValue(first(row, ['业务状态', '状态', 'status'])) || '在售',
      confidence: textValue(first(row, ['归类置信度', '置信度', 'confidence'])),
      remark: textValue(first(row, ['备注', 'remark', 'note'])),
    };
  }).filter((r) => r.category);
}

function readCategoryMappingFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  const abs = path.resolve(file);
  const rows = abs.endsWith('.csv')
    ? parseCsvFile(abs).rows.map((r) => ({
      category: String(first(r, ['三级品类', '品类名称', '品类', 'category'])).trim(),
      tier: String(first(r, ['阶段', '分层', 'tier', 'stage'])).trim(),
      board: String(first(r, ['二级板块', '二级类目', 'board', 'secondaryCategory'])).trim(),
      status: String(first(r, ['业务状态', '状态', 'status'])).trim() || '在售',
      confidence: String(first(r, ['归类置信度', '置信度', 'confidence'])).trim(),
      remark: String(first(r, ['备注', 'remark', 'note'])).trim(),
    })).filter((r) => r.category)
    : normalizeCategoryMappingRows(readJson(abs));
  return {
    contract_version: CATEGORY_MAPPING_CONTRACT_VERSION,
    syncedAt: nowIso(),
    version: 'feishu-base-current-or-snapshot',
    source: {
      type: 'feishu_base_mapping_file',
      base_token: CATEGORY_MAPPING_BASE_TOKEN,
      table: CATEGORY_MAPPING_TABLE,
      file: abs,
      sha256: sha256File(abs),
    },
    rows,
  };
}

function resolveCategoryMapping({ categoryMappingFile, snapshotDir, previousCacheDir, warnings, knownGaps }) {
  const explicit = readCategoryMappingFile(categoryMappingFile);
  if (explicit) return explicit;
  const dirs = snapshotCandidateDirs(snapshotDir);
  const snapshotJson = firstExistingFile(dirs, 'category-mapping.json');
  const snapshotCsv = firstExistingFile(dirs, 'category_mapping.csv') || firstExistingFile(dirs, 'category_taxonomy.csv');
  const snapshot = readCategoryMappingFile(snapshotJson || snapshotCsv);
  if (snapshot) {
    snapshot.source.type = snapshotJson ? 'feishu_base_mapping_snapshot_json' : 'feishu_base_mapping_snapshot_csv';
    warnings.push('category_mapping_feishu_read_failed_used_snapshot');
    knownGaps.push('category_mapping_source_not_realtime');
    return snapshot;
  }
  const prev = previousCacheDir ? path.join(previousCacheDir, 'cache', 'category-mapping.json') : '';
  const previous = readCategoryMappingFile(prev);
  if (previous) {
    previous.source.type = 'previous_processed_category_mapping_snapshot';
    warnings.push('category_mapping_feishu_read_failed_used_previous_snapshot');
    knownGaps.push('category_mapping_source_not_realtime');
    return previous;
  }
  warnings.push('category_mapping_missing');
  knownGaps.push('category_mapping_missing');
  return {
    contract_version: CATEGORY_MAPPING_CONTRACT_VERSION,
    syncedAt: nowIso(),
    version: 'empty',
    source: { type: 'empty', base_token: CATEGORY_MAPPING_BASE_TOKEN, table: CATEGORY_MAPPING_TABLE },
    rows: [],
  };
}

function categoryMappingManifest(mapping, categoryRowsRaw, warnings, knownGaps) {
  const rows = mapping.rows || [];
  const categoriesInData = [...new Set((categoryRowsRaw || []).map((r) => r['品类名称']).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const byCategory = new Map(rows.map((r) => [r.category, r]));
  const unmatched = categoriesInData.filter((c) => !byCategory.has(c));
  const pending = rows.filter((r) => r.tier === '待归类' || r.confidence === '待你确认').map((r) => r.category);
  const offline = rows.filter((r) => r.status === '已下线').map((r) => r.category);
  const selfOperated = rows.filter((r) => r.tier === '自营(非聚合)').map((r) => r.category);
  if (unmatched.length) { warnings.push('category_mapping_unmatched_categories'); knownGaps.push('category_mapping_unmatched_categories'); }
  if (pending.length) warnings.push('category_mapping_pending_confirmation');
  return {
    contract_version: CATEGORY_MAPPING_CONTRACT_VERSION,
    generated_at: nowIso(),
    source: mapping.source || {},
    source_synced_at: mapping.syncedAt || '',
    source_sha256: sha256Json(rows),
    record_count: rows.length,
    stats: {
      categories_in_data: categoriesInData.length,
      unmatched_categories: unmatched.length,
      pending_categories: pending.length,
      offline_categories: offline.length,
      self_operated_non_aggregate: selfOperated.length,
      tiers: {
        '发展': rows.filter((r) => r.tier === '发展').length,
        '孵化': rows.filter((r) => r.tier === '孵化').length,
        '种子': rows.filter((r) => r.tier === '种子').length,
        '自营(非聚合)': selfOperated.length,
        '待归类': rows.filter((r) => r.tier === '待归类').length,
      },
    },
    unmatched_categories: unmatched,
    pending_categories: pending,
    offline_categories: offline,
    self_operated_categories: selfOperated,
  };
}

function buildCaches(importsDir, cacheDir, runDt, snapshotDir, previousCacheDir, warnings, knownGaps, categoryMappingFile) {
  ensureDir(cacheDir);
  const mapping = resolveCategoryMapping({ categoryMappingFile, snapshotDir, previousCacheDir, warnings, knownGaps });
  const taxonomy = (mapping.rows || []).length ? { syncedAt: mapping.syncedAt, version: mapping.version, source: mapping.source, rows: mapping.rows } : readTaxonomy(snapshotDir, previousCacheDir, warnings);
  const selfCats = new Set((taxonomy.rows || []).filter((r) => r.tier === '自营(非聚合)').map((r) => r.category));
  const offlineCats = new Set((taxonomy.rows || []).filter((r) => r.status === '已下线').map((r) => r.category));
  const categoryRowsRaw = rowsFromImportFiles(importsDir, 'category_daily_avg');
  const categoryHeaders = headersFor('category_daily_avg');
  const categoryMapping = categoryMappingManifest({ ...mapping, rows: taxonomy.rows || [] }, categoryRowsRaw, warnings, knownGaps);
  let categoryRows = categoryRowsRaw.map((r) => ({ category: r['品类名称'], ...normalizeMetricRow(r, categoryHeaders, runDt) })).filter((r) => r.week && r.category && !selfCats.has(r.category));
  const latestWeek = [...new Set(categoryRows.map((r) => r.week))].sort().slice(-1)[0] || '';
  if (latestWeek) categoryRows = categoryRows.filter((r) => !(r.week === latestWeek && offlineCats.has(r.category)));
  categoryRows = mergeRowsByKey(categoryRows, (r) => [r.week, r.category].join('\u001f'));
  const categoryWeeks = [...new Set(categoryRows.map((r) => r.week))].sort();
  const categories = [...new Set(categoryRows.map((r) => r.category))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const categoryCache = { syncedAt: nowIso(), version: '1.5.5-zloop', source: { dir: importsDir, prefix: 'category_daily_avg_', grain: 'daily_slice_category_dedup_daily_avg', evaUv: 'daily-slice category-level deduplicated UV sum' }, weeks: categoryWeeks, categories, rows: categoryRows };

  const fulfillRowsRaw = rowsFromImportFiles(importsDir, 'category_fulfill_daily_avg');
  const fulfillRows = mergeRowsByKey(fulfillRowsRaw.map((r) => ({ category: r['品类名称'], fulfillmentMethod: r['履约方式（只取线上流程）'], ...normalizeMetricRow(r, headersFor('category_fulfill_daily_avg'), runDt) })).filter((r) => r.week && r.category && !selfCats.has(r.category) && !(r.week === latestWeek && offlineCats.has(r.category))), (r) => [r.week, r.category, r.fulfillmentMethod].join('\u001f'));
  const fulfillCache = { syncedAt: nowIso(), version: '1.5.5-zloop', source: { dir: importsDir, prefix: 'category_fulfill_daily_avg_', grain: 'category_fulfillment_daily_avg' }, weeks: [...new Set(fulfillRows.map((r) => r.week))].sort(), categories, rows: fulfillRows };

  const modelRowsRaw = rowsFromImportFiles(importsDir, 'model_daily_avg');
  const modelNorm = modelRowsRaw.map((r) => ({ category: r['品类名称'], modelId: String(r['机型id'] || '').replace(/^(\d+)\.0+$/, '$1'), modelName: r['机型名称'], coreEval: r['核心属性（估价）'] || '', gradeEval: r['成色等级（估价）'] || '', coreQc: r['核心属性（质检）'] || '', gradeQc: r['成色等级（质检）'] || '', fulfillmentMethod: r['履约方式（只取线上流程）'] || '', ...normalizeMetricRow(r, headersFor('model_daily_avg'), runDt) })).filter((r) => r.week && r.category && r.modelName && !selfCats.has(r.category) && !(r.week === latestWeek && offlineCats.has(r.category)));
  const modelMain = mergeRowsByKey(modelNorm, (r) => [r.week, r.category, r.modelId || `name:${r.modelName}`, r.modelName].join('\u001f'));
  const modelCache = { syncedAt: nowIso(), version: '1.5.5-zloop', source: { dir: importsDir, prefix: 'model_daily_avg_', grain: 'model_main_daily_avg' }, categories: [...new Set(modelMain.map((r) => r.category))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')), weeks: [...new Set(modelMain.map((r) => r.week))].sort(), rows: modelMain };

  let boardCache;
  const boardCsv = firstExistingFile(snapshotCandidateDirs(snapshotDir), 'board_metrics_feishu.csv');
  if (boardCsv) {
    const boardRows = parseCsvFile(boardCsv).rows.map((r) => ({ week: String(first(r, ['week', '统计周', '周次'])).trim() || dateToISOWeek(String(first(r, ['week_start_date', '开始日期', '周开始'])).trim()), startDate: String(first(r, ['week_start_date', '开始日期', '周开始'])).trim(), dau: toNum(first(r, ['dau', 'DAU', 'APP日均DAU', 'app_dau', 'appDailyDau'])), entryUv: toNum(first(r, ['entryUv', '入口uv', '入口UV', '回收入口UV', 'recycle_entry_uv'])) })).filter((r) => r.week);
    boardCache = { syncedAt: nowIso(), version: '1.5.5-zloop', source: { prefixes: ['board_metrics', 'board_metrics_feishu'], file: path.resolve(boardCsv) }, weeks: [...new Set(boardRows.map((r) => r.week))].sort(), rows: boardRows };
  } else {
    knownGaps.push('board_metrics_feishu.csv pending');
    boardCache = { syncedAt: nowIso(), version: '1.5.5-zloop', source: { prefixes: ['board_metrics', 'board_metrics_feishu'], targetWeeks: categoryWeeks }, weeks: [], rows: [] };
  }

  writeJson(path.join(cacheDir, 'category-taxonomy.json'), taxonomy);
  writeJson(path.join(cacheDir, 'category-mapping.json'), { ...mapping, rows: taxonomy.rows || [] });
  writeJson(path.join(cacheDir, 'category-mapping-manifest.json'), categoryMapping);
  writeJson(path.join(cacheDir, 'category-cache.json'), categoryCache);
  writeJson(path.join(cacheDir, 'category-fulfill-cache.json'), fulfillCache);
  writeJson(path.join(cacheDir, 'cache.json'), modelCache);
  writeJson(path.join(cacheDir, 'model-cache.json'), modelCache);
  writeJson(path.join(cacheDir, 'board-metrics.json'), boardCache);
  return { taxonomy, categoryMapping, categoryCache, fulfillCache, modelCache, boardCache };
}

function normalizeTags(tags) {
  const out = {};
  for (const [key, value] of Object.entries(tags || {})) {
    if (!String(key).includes('||')) continue;
    if (Array.isArray(value)) out[key] = { dimensions: {}, tags: value.map(String), note: '' };
    else out[key] = { dimensions: value.dimensions || {}, tags: Array.isArray(value.tags) ? value.tags.map(String) : [], note: String(value.note || '') };
  }
  return out;
}
function normalizeVocab(vocab) { return { ...DEFAULT_VOCAB, ...(vocab && typeof vocab === 'object' ? vocab : {}), custom: (vocab && vocab.custom) || {} }; }
function buildTagArtifacts(snapshotDir, cacheDir, artifactDir, runDt, runId, warnings, knownGaps) {
  const candidateDirs = snapshotCandidateDirs(snapshotDir);
  const tagsFile = firstExistingFile(candidateDirs, 'tags.json');
  const vocabFile = firstExistingFile(candidateDirs, 'tag-vocab.json');
  const tagSourceDir = path.dirname(tagsFile || vocabFile || firstExistingFile(candidateDirs, 'rules.json') || path.join(candidateDirs[0] || PACKAGE_SNAPSHOT_DIR, 'missing'));
  const tags = normalizeTags(safeReadJson(tagsFile, {}));
  const vocab = normalizeVocab(safeReadJson(vocabFile, DEFAULT_VOCAB));
  if (!fs.existsSync(tagsFile)) { warnings.push('tag_snapshot_missing'); knownGaps.push('tag_snapshot_missing'); }
  if (!fs.existsSync(vocabFile)) warnings.push('tag_vocab_missing_used_default');
  const entries = Object.entries(tags).map(([key, rec]) => {
    const [category, ...rest] = key.split('||');
    return { key, category, model_name: rest.join('||'), dimensions: rec.dimensions || {}, tags: rec.tags || [], note: rec.note || '' };
  });
  const categories = [...new Set(entries.map((e) => e.category))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const snapshotBase = { schema_version: 'model_tag_snapshot/v1', artifact_type: 'model_tag_snapshot', run_id: runId, run_dt: runDt, generated_at: nowIso(), source_of_truth: 'model-tag-monitor-server-front-end-tags', source: { mode: fs.existsSync(tagsFile) ? 'file' : 'default_empty', data_dir: tagSourceDir }, stats: { tagged_model_count: entries.length, category_count: categories.length, categories, dimension_assignment_count: entries.reduce((n, e) => n + Object.keys(e.dimensions || {}).length, 0), custom_dimension_count: Object.keys(vocab.custom || {}).length }, vocab, dimension_catalog: { core: vocab.core, lifecycle: vocab.lifecycle, price: vocab.price, custom: vocab.custom }, rules: safeReadJson(path.join(tagSourceDir, 'rules.json'), {}), tags, entries };
  const snapshot = { ...snapshotBase, sha256: sha256Json(snapshotBase) };
  const enrichment = {};
  for (const e of entries) enrichment[e.key] = { category: e.category, model_name: e.model_name, core: e.dimensions.core || '', lifecycle: e.dimensions.lifecycle || '', price: e.dimensions.price || '', custom_dimensions: Object.fromEntries(Object.entries(e.dimensions || {}).filter(([k]) => !['core', 'lifecycle', 'price'].includes(k))), all_dimensions: e.dimensions || {}, tags: e.tags || [], note: e.note || '' };
  const category_summaries = categories.map((category) => ({ category, tagged_model_count: entries.filter((e) => e.category === category).length }));
  const knowledgeBase = { schema_version: 'model_tag_knowledge/v1', artifact_type: 'model_tag_knowledge', run_id: runId, run_dt: runDt, generated_at: snapshot.generated_at, source_snapshot_sha256: snapshot.sha256, rules_summary: {}, dimension_catalog: snapshot.dimension_catalog, category_summaries, model_enrichment: enrichment, feishu_knowledge_summary: { write_mode: 'summary_only_not_source_of_truth', markdown: `# AI 小万机型标签分层摘要（${runDt}）\n\n- Tagged models：${entries.length}\n- Categories：${categories.length}\n` }, consumer_contract: { join_key: 'category||model_name', missing_tag_policy: 'treat_as_未打标_and_do_not_infer_core/lifecycle/price' } };
  const knowledge = { ...knowledgeBase, sha256: sha256Json(knowledgeBase) };
  writeJson(path.join(artifactDir, `model_tag_snapshot_${runDt}.json`), snapshot);
  writeJson(path.join(artifactDir, `model_tag_knowledge_${runDt}.json`), knowledge);
  fs.writeFileSync(path.join(artifactDir, `model_tag_feishu_summary_${runDt}.md`), `${knowledge.feishu_knowledge_summary.markdown}\n`, 'utf8');
  writeJson(path.join(cacheDir, 'tags.json'), tags);
  writeJson(path.join(cacheDir, 'tag-vocab.json'), vocab);
  const manifest = { schema_version: 'tag_snapshot_manifest/v1', run_dt: runDt, generated_at: nowIso(), source: snapshot.source, tags_sha256: sha256Json(tags), tag_vocab_sha256: sha256Json(vocab), tagged_model_count: entries.length, category_count: categories.length, fallback: !fs.existsSync(tagsFile), snapshot: `model_tag_snapshot_${runDt}.json`, snapshot_sha256: snapshot.sha256, knowledge: `model_tag_knowledge_${runDt}.json`, knowledge_sha256: knowledge.sha256 };
  const tagWarnings = [...new Set((warnings || []).filter((w) => /tag|model_tag|feishu/i.test(String(w))))];
  const tagKnownGaps = [...new Set((knownGaps || []).filter((g) => /tag|model_tag|feishu/i.test(String(g))))];
  if (!Object.keys(knowledge.model_enrichment || {}).length) tagKnownGaps.push('model_tag_knowledge_empty');
  const feishuSync = {
    enabled: false,
    status: 'not_configured',
    write_mode: 'summary_only_not_source_of_truth'
  };
  const syncBase = {
    schema_version: 'model_tag_sync_manifest/v1',
    artifact_type: 'model_tag_sync_manifest',
    stage: 'process',
    status: tagWarnings.length || tagKnownGaps.length ? 'warn' : 'success',
    run_id: runId,
    run_dt: runDt,
    generated_at: manifest.generated_at,
    model_tag_snapshot: `model_tag_snapshot_${runDt}.json`,
    model_tag_knowledge: `model_tag_knowledge_${runDt}.json`,
    model_tag_feishu_summary: `model_tag_feishu_summary_${runDt}.md`,
    model_tag_snapshot_sha256: snapshot.sha256,
    model_tag_knowledge_sha256: knowledge.sha256,
    model_tag_source: snapshot.source_of_truth,
    model_tag_stats: {
      tagged_model_count: snapshot.stats.tagged_model_count,
      category_count: snapshot.stats.category_count,
      dimension_assignment_count: snapshot.stats.dimension_assignment_count,
      custom_dimension_count: snapshot.stats.custom_dimension_count
    },
    source: snapshot.source,
    feishu_sync: feishuSync,
    warnings: tagWarnings,
    known_gaps: tagKnownGaps
  };
  const syncManifest = { ...syncBase, sha256: sha256Json(syncBase) };
  writeJson(path.join(cacheDir, 'tag_snapshot_manifest.json'), manifest);
  writeJson(path.join(artifactDir, `model_tag_sync_manifest_${runDt}.json`), syncManifest);
  return { snapshot, knowledge, manifest, syncManifest };
}
function buildRollingStatus(caches) {
  const weeks = caches.categoryCache.weeks || [];
  const rolling = {};
  for (const row of caches.categoryCache.rows || []) rolling[row.week] = row.rollingStatus;
  return { generated_at: nowIso(), weeks, rolling_week: weeks.find((w) => rolling[w] === 'rolling') || '', final_weeks: weeks.filter((w) => rolling[w] !== 'rolling'), rolling_status_by_week: rolling };
}
function buildAnalysisHistory(caches, tagArtifacts, qualitySummary, knownGaps, runDt, runId) {
  const weeks = caches.categoryCache.weeks || [];
  const latest = weeks[weeks.length - 1] || '';
  const modelTop = [];
  for (const week of weeks.slice(-KEEP_WEEKS)) {
    const rows = (caches.modelCache.rows || []).filter((r) => r.week === week).sort((a, b) => toNum(b.gmv) - toNum(a.gmv)).slice(0, 50);
    modelTop.push(...rows.map((r) => ({ week, category: r.category, model_name: r.modelName, model_id: r.modelId, gmv: r.gmv, dealCnt: r.dealCnt, orderCnt: r.orderCnt, tags: (tagArtifacts.knowledge.model_enrichment[`${r.category}||${r.modelName}`] || {}).tags || [] })));
  }
  return { contract_version: 'ai-wan-v1.5.5-analysis-history', run_id: runId, run_dt: runDt, generated_at: nowIso(), history_weeks: KEEP_WEEKS, history_weeks_available: weeks.length, latest_week: latest, rolling_status: buildRollingStatus(caches), category_history: caches.categoryCache.rows || [], category_fulfill_history: caches.fulfillCache.rows || [], model_topn_history: modelTop, model_detail_contributor_candidates: modelTop.slice(0, 200), metric_baseline: buildMetricBaseline(caches.categoryCache.rows || []), tag_dimensions_summary: { tagged_model_count: tagArtifacts.snapshot.stats.tagged_model_count, category_count: tagArtifacts.snapshot.stats.category_count }, known_gaps: knownGaps, quality_summary: qualitySummary };
}
function buildMetricBaseline(categoryRows) {
  const byCat = new Map();
  for (const r of categoryRows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const out = {};
  for (const [cat, rows] of byCat) {
    const sorted = rows.slice().sort((a, b) => a.week.localeCompare(b.week));
    const prev = sorted.slice(-4, -1);
    if (!prev.length) continue;
    out[cat] = {};
    for (const metric of ['gmv', 'dealCnt', 'orderCnt', 'evaUv']) out[cat][metric] = prev.reduce((s, r) => s + toNum(r[metric]), 0) / prev.length;
  }
  return out;
}
function isLowVolumeWtd(metric, baseline) {
  const threshold = LOW_VOLUME_BASELINE_THRESHOLDS[metric];
  return threshold != null && toNum(baseline) < threshold;
}
function compareWtd(categoryRows) {
  const warnings = [];
  const errors = [];
  const byCat = new Map();
  for (const r of categoryRows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  const comparisons = [];
  for (const [cat, rows] of byCat) {
    const sorted = rows.slice().sort((a, b) => a.week.localeCompare(b.week));
    if (sorted.length < 2) continue;
    const cur = sorted[sorted.length - 1];
    const prev = sorted[sorted.length - 2];
    for (const metric of ['gmv', 'dealCnt', 'orderCnt', 'evaUv']) {
      if (toNum(prev[metric]) <= 0) continue;
      const ratio = toNum(cur[metric]) / toNum(prev[metric]);
      const lowVolume = isLowVolumeWtd(metric, prev[metric]);
      comparisons.push({ category: cat, metric, current: cur[metric], baseline: prev[metric], ratio, low_volume_baseline: lowVolume });
      if (cur.daysReceived >= prev.daysReceived && ratio < 0.5) {
        const msg = `${cat} ${metric} WTD ratio ${ratio.toFixed(3)} < 0.5`;
        if (lowVolume) warnings.push(`${msg} (low_volume_baseline=${toNum(prev[metric])}, warn_only)`);
        else errors.push(msg);
      }
      else if (cur.daysReceived >= prev.daysReceived && ratio < 0.8) warnings.push(`${cat} ${metric} WTD ratio ${ratio.toFixed(3)} < 0.8`);
    }
  }
  return { comparisons, warnings, errors, low_volume_baseline_thresholds: LOW_VOLUME_BASELINE_THRESHOLDS };
}

function writeServerBundle(serverDir, caches, tagArtifacts, rollingStatus, manifestBase) {
  ensureDir(serverDir);
  for (const name of ['cache.json', 'model-cache.json', 'category-cache.json', 'category-fulfill-cache.json', 'category-taxonomy.json', 'category-mapping.json', 'category-mapping-manifest.json', 'board-metrics.json', 'tags.json', 'tag-vocab.json', 'tag_snapshot_manifest.json']) {
    fs.copyFileSync(path.join(manifestBase.cacheDir, name), path.join(serverDir, name));
  }
  writeJson(path.join(serverDir, 'rolling-status.json'), rollingStatus);
  writeJson(path.join(serverDir, 'dashboard-source-manifest.json'), { contract_version: CONTRACT_VERSION, run_id: manifestBase.runId, run_dt: manifestBase.runDt, generated_at: nowIso(), sources: { processed_cache: `processed_cache_${manifestBase.runDt}.zip`, tag_snapshot: `model_tag_snapshot_${manifestBase.runDt}.json` }, cache_files: ['cache.json', 'model-cache.json', 'category-cache.json', 'category-fulfill-cache.json', 'category-taxonomy.json', 'board-metrics.json', 'tags.json', 'tag-vocab.json'] });
}
function resolvePreviousProcessedCache(inputDir, outDir, explicit) {
  if (explicit) return explicit;
  const active = path.join(inputDir, 'active_process_manifest.json');
  if (fs.existsSync(active)) {
    const m = readJson(active);
    const p = path.resolve(inputDir, m.processed_cache || '');
    if (fs.existsSync(p)) return p;
  }
  const outActive = path.join(outDir, 'active_process_manifest.json');
  if (fs.existsSync(outActive)) {
    const m = readJson(outActive);
    const p = path.resolve(outDir, m.processed_cache || '');
    if (fs.existsSync(p)) return p;
  }
  return '';
}
function writeFailure(outDir, runDt, runId, errors, upstream = {}) {
  ensureDir(outDir);
  const report = { contract_version: 'ai-wan-v1.5.5-quality', run_id: runId, run_dt: runDt, generated_at: nowIso(), quality_gates: 'failed', errors, warnings: [], known_gaps: [], upstream_fetch: upstream };
  const qualityFile = path.join(outDir, `data_quality_report_${runDt}.json`);
  writeJson(qualityFile, report);
  const manifest = { contract_version: CONTRACT_VERSION, stage: 'process', status: 'failed', run_id: runId, run_dt: runDt, upstream_stage: 'fetch', upstream_run_id: upstream.run_id || '', quality_gates: 'failed', errors, warnings: [], known_gaps: [], data_quality_report: path.basename(qualityFile), data_quality_report_sha256: sha256File(qualityFile), generated_at: nowIso() };
  writeJson(path.join(outDir, 'active_process_manifest.json'), manifest);
  return { ok: false, manifest, report };
}
function validateFetch(inputDir, runDt) {
  const activeFile = path.join(inputDir, 'active_fetch_manifest.json');
  if (!fs.existsSync(activeFile)) throw new Error(`missing active_fetch_manifest.json in ${inputDir}`);
  const active = readJson(activeFile);
  if (active.contract_version && active.contract_version !== FETCH_CONTRACT_VERSION) throw new Error(`unexpected fetch contract_version=${active.contract_version}`);
  if (active.stage !== 'fetch') throw new Error(`active_fetch_manifest.stage must be fetch`);
  if (!isAcceptableFetchStatus(active)) throw new Error(`active_fetch_manifest.status must be success or warn with only fulfillment empty known gaps`);
  if (active.run_dt !== runDt) throw new Error(`active_fetch_manifest.run_dt ${active.run_dt} != ${runDt}`);
  const rawCache = path.resolve(inputDir, active.raw_cache || `raw_cache_${runDt}.zip`);
  if (!fs.existsSync(rawCache)) throw new Error(`missing raw_cache: ${rawCache}`);
  const actualSha = sha256File(rawCache);
  const expectedSha = active.raw_cache_sha256 || active.sha256 || '';
  if (expectedSha && expectedSha !== actualSha) throw new Error(`raw_cache sha256 mismatch expected=${expectedSha} actual=${actualSha}`);
  return { active, rawCache, actualSha };
}

function isAcceptableFetchStatus(active) {
  if (active.status === 'success') return true;
  if (active.status !== 'warn') return false;
  const allowed = new Set(['category_fulfill_daily_avg_empty', 'category_fulfill_summary_empty']);
  const gaps = Array.isArray(active.known_gaps) ? active.known_gaps.map(String) : [];
  return gaps.length > 0 && gaps.every((gap) => allowed.has(gap));
}
function knownGapForEmptyRaw(script) {
  if (script === 'category_fulfill_daily_avg') return 'category_fulfill_daily_avg_empty';
  if (script === 'category_fulfill_summary') return 'category_fulfill_summary_empty';
  return '';
}
function validateUnpackedRaw(unpacked, active, runDt) {
  const rawManifestFile = path.join(unpacked, active.raw_manifest || `raw_manifest_${runDt}.json`);
  const sqlStatusFile = path.join(unpacked, active.sql_status || `sql_status_${runDt}.json`);
  const rawManifest = fs.existsSync(rawManifestFile) ? readJson(rawManifestFile) : {};
  const sqlStatus = fs.existsSync(sqlStatusFile) ? readJson(sqlStatusFile) : {};
  if (rawManifest.run_id && rawManifest.run_id !== active.run_id) throw new Error(`raw_manifest.run_id ${rawManifest.run_id} != active_fetch_manifest.run_id ${active.run_id}`);
  const activeKnownGaps = new Set(Array.isArray(active.known_gaps) ? active.known_gaps.map(String) : []);
  for (const script of RAW_SCRIPTS) {
    const file = scriptRawFile(unpacked, script, runDt);
    if (!file) throw new Error(`missing raw/${script}_${runDt}.csv`);
    const parsed = parseCsvFile(file, { repairModelNameCommas: script.startsWith('model') });
    if (parsed.rows.length <= 0) {
      const knownGap = knownGapForEmptyRaw(script);
      if (knownGap && activeKnownGaps.has(knownGap)) continue;
      throw new Error(`raw ${script} row_count=0`);
    }
  }
  return { rawManifest, sqlStatus };
}
async function processRawCache(options = {}) {
  const runDt = options.runDt;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(runDt || ''))) throw new Error(`runDt must be YYYY-MM-DD, got ${runDt}`);
  const inputDir = path.resolve(options.inputDir || '.');
  const outDir = path.resolve(options.outDir || inputDir);
  const snapshotDir = options.snapshotDir ? path.resolve(options.snapshotDir) : path.resolve(__dirname, '../../../model-tag-monitor/data');
  const runId = options.runId || `process_${runDt}_${crypto.randomBytes(4).toString('hex')}`;
  ensureDir(outDir);
  let fetch;
  try { fetch = validateFetch(inputDir, runDt); } catch (err) { return writeFailure(outDir, runDt, runId, [err.message]); }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `ai-wan-process-${runDt}-`));
  const warnings = [];
  const knownGaps = [];
  try {
    for (const gap of Array.isArray(fetch.active.known_gaps) ? fetch.active.known_gaps.map(String) : []) {
      if (knownGapForEmptyRaw('category_fulfill_daily_avg') === gap || knownGapForEmptyRaw('category_fulfill_summary') === gap) {
        knownGaps.push(gap);
        warnings.push(gap);
      }
    }
    const unpacked = path.join(workDir, 'raw_cache');
    unzip(fetch.rawCache, unpacked);
    const upstream = validateUnpackedRaw(unpacked, fetch.active, runDt);
    const stagingImports = path.join(workDir, 'staging_imports');
    const fetchKnownGaps = new Set(Array.isArray(fetch.active.known_gaps) ? fetch.active.known_gaps.map(String) : []);
    const importBuild = materializeImports(unpacked, stagingImports, runDt, fetchKnownGaps);
    const previousProcessedCache = resolvePreviousProcessedCache(inputDir, outDir, options.previousProcessedCache);
    const previousCacheDir = previousProcessedCache ? path.join(workDir, 'prev_processed') : '';
    if (previousProcessedCache && !fs.existsSync(previousCacheDir)) unzip(previousProcessedCache, previousCacheDir);
    const processedRoot = path.join(workDir, 'processed_cache_root');
    const processedImports = path.join(processedRoot, 'imports');
    const promoteReport = promoteImports({ currentImportsDir: stagingImports, previousProcessedCache, workDir, outputImportsDir: processedImports });
    const cacheDir = path.join(processedRoot, 'cache');
    const caches = buildCaches(processedImports, cacheDir, runDt, snapshotDir, previousCacheDir, warnings, knownGaps, options.categoryMappingFile);
    const tagArtifacts = buildTagArtifacts(snapshotDir, cacheDir, outDir, runDt, runId, warnings, knownGaps);
    const rollingStatus = buildRollingStatus(caches);
    const historyWeeksAvailable = (caches.categoryCache.weeks || []).length;
    if (historyWeeksAvailable < MIN_HISTORY_WEEKS_FOR_TREND) { warnings.push('history_insufficient'); knownGaps.push('history_insufficient_analyze_scope_wow_only'); }
    const wtd = compareWtd(caches.categoryCache.rows || []);
    warnings.push(...wtd.warnings);
    const qualityGate = wtd.errors.length ? 'failed' : (warnings.length || knownGaps.length ? 'warn' : 'pass');
    const qualitySummary = { quality_gates: qualityGate, warnings: warnings.slice(), known_gaps: knownGaps.slice(), wtd_quality_errors: wtd.errors.length };
    const analysisHistory = buildAnalysisHistory(caches, tagArtifacts, qualitySummary, knownGaps, runDt, runId);
    const analysisHistoryFile = path.join(outDir, `analysis_history_${runDt}.json`);
    writeJson(analysisHistoryFile, analysisHistory);

    const manifestFile = path.join(outDir, `manifest_${runDt}.json`);
    const manifest = { contract_version: CONTRACT_VERSION, run_id: runId, run_dt: runDt, generated_at: nowIso(), upstream_fetch_manifest: fetch.active, raw_manifest: upstream.rawManifest, sql_status: upstream.sqlStatus, imports: importBuild.stats, promote: promoteReport, rolling_status: rollingStatus, history_weeks: KEEP_WEEKS, history_weeks_available: historyWeeksAvailable, dashboard_window_weeks: DASHBOARD_WINDOW_WEEKS };
    writeJson(manifestFile, manifest);

    const stateDir = path.join(processedRoot, 'state');
    ensureDir(path.join(processedImports, 'manifests'));
    writeJson(path.join(processedImports, 'active.json'), { run_id: runId, run_dt: runDt, manifest: `manifests/manifest_${runDt}.json` });
    fs.copyFileSync(manifestFile, path.join(processedImports, 'manifests', `manifest_${runDt}.json`));
    ensureDir(stateDir);
    writeJson(path.join(stateDir, 'rolling-status.json'), rollingStatus);
    writeJson(path.join(stateDir, 'history-index.json'), { generated_at: nowIso(), keep_weeks: KEEP_WEEKS, weeks: caches.categoryCache.weeks || [], rolling_week: rollingStatus.rolling_week, final_weeks: rollingStatus.final_weeks });
    fs.copyFileSync(path.join(cacheDir, 'tag_snapshot_manifest.json'), path.join(stateDir, 'tag_snapshot_manifest.json'));
    fs.copyFileSync(path.join(cacheDir, 'category-mapping-manifest.json'), path.join(stateDir, 'category_mapping_manifest.json'));
    fs.copyFileSync(path.join(cacheDir, 'category-mapping-manifest.json'), path.join(outDir, 'category_mapping_manifest.json'));

    const qualityReport = { contract_version: 'ai-wan-v1.5.5-quality', run_id: runId, run_dt: runDt, generated_at: nowIso(), quality_gates: qualityGate, upstream_fetch: { run_id: fetch.active.run_id, raw_cache: path.basename(fetch.rawCache), raw_cache_sha256: fetch.actualSha, validated: true }, raw_imports: importBuild.stats, day_cnt: { rolling_week: rollingStatus.rolling_week, final_weeks: rollingStatus.final_weeks }, csv_repair: Object.fromEntries(Object.entries(importBuild.stats).map(([k, v]) => [k, v.csv_repair])), wtd_quality: wtd, keep_weeks: { configured: KEEP_WEEKS, history_weeks_available: historyWeeksAvailable, weeks: caches.categoryCache.weeks || [] }, taxonomy: { rows: (caches.taxonomy.rows || []).length, self_operated_filtered: (caches.taxonomy.rows || []).filter((r) => r.tier === '自营(非聚合)').length }, category_mapping_manifest: caches.categoryMapping, tag_snapshot: tagArtifacts.manifest, board_metrics: { rows: (caches.boardCache.rows || []).length, gap: knownGaps.includes('board_metrics_feishu.csv pending') }, warnings, errors: wtd.errors, known_gaps: knownGaps };
    const qualityFile = path.join(outDir, `data_quality_report_${runDt}.json`);
    writeJson(qualityFile, qualityReport);
    fs.copyFileSync(qualityFile, path.join(stateDir, `data_quality_report_${runDt}.json`));

    const serverRoot = path.join(workDir, 'server_cache_bundle_root');
    writeServerBundle(serverRoot, caches, tagArtifacts, rollingStatus, { cacheDir, runDt, runId });

    const importsZip = path.join(outDir, `imports_${runDt}.zip`);
    zipDir(processedImports, importsZip, ['.']);
    const processedZip = path.join(outDir, `processed_cache_${runDt}.zip`);
    zipDir(processedRoot, processedZip, ['imports', 'cache', 'state']);
    const serverZip = path.join(outDir, `server_cache_bundle_${runDt}.zip`);
    zipDir(serverRoot, serverZip, ['.']);
    const xlsxFile = path.join(outDir, `AI小万_聚合回收经营分析_${runDt}.xlsx`);
    writeMinimalXlsx(xlsxFile, manifest);

    const artifactHashes = {
      imports_zip: sha256File(importsZip),
      excel: sha256File(xlsxFile),
      manifest: sha256File(manifestFile),
      processed_cache: sha256File(processedZip),
      server_cache_bundle: sha256File(serverZip),
      analysis_history: sha256File(analysisHistoryFile),
      data_quality_report: sha256File(qualityFile),
      category_mapping_manifest: sha256File(path.join(cacheDir, 'category-mapping-manifest.json')),
      model_tag_snapshot: tagArtifacts.snapshot.sha256,
      model_tag_knowledge: tagArtifacts.knowledge.sha256,
      model_tag_sync_manifest: tagArtifacts.syncManifest.sha256
    };
    const active = { contract_version: CONTRACT_VERSION, stage: 'process', status: qualityGate === 'failed' ? 'failed' : (qualityGate === 'warn' ? 'warn' : 'success'), run_id: runId, run_dt: runDt, target_month: runDt.slice(0, 7), upstream_stage: 'fetch', upstream_run_id: fetch.active.run_id, upstream_raw_cache: path.basename(fetch.rawCache), upstream_raw_cache_sha256: fetch.actualSha, history_weeks: KEEP_WEEKS, history_weeks_available: historyWeeksAvailable, min_history_weeks_for_trend: MIN_HISTORY_WEEKS_FOR_TREND, analysis_scope_hint: historyWeeksAvailable < MIN_HISTORY_WEEKS_FOR_TREND ? 'wow_only' : 'trend_10w', dashboard_window_weeks: DASHBOARD_WINDOW_WEEKS, rolling_week: rollingStatus.rolling_week, final_weeks: rollingStatus.final_weeks, imports_zip: path.basename(importsZip), imports_zip_sha256: artifactHashes.imports_zip, excel: path.basename(xlsxFile), excel_sha256: artifactHashes.excel, manifest: path.basename(manifestFile), manifest_sha256: artifactHashes.manifest, processed_cache: path.basename(processedZip), processed_cache_sha256: artifactHashes.processed_cache, server_cache_bundle: path.basename(serverZip), server_cache_bundle_sha256: artifactHashes.server_cache_bundle, analysis_history: path.basename(analysisHistoryFile), analysis_history_sha256: artifactHashes.analysis_history, data_quality_report: path.basename(qualityFile), data_quality_report_sha256: artifactHashes.data_quality_report, category_mapping_manifest: 'category_mapping_manifest.json', category_mapping_manifest_sha256: artifactHashes.category_mapping_manifest, category_mapping_source: caches.categoryMapping.source, category_mapping_stats: caches.categoryMapping.stats, model_tag_snapshot: `model_tag_snapshot_${runDt}.json`, model_tag_snapshot_sha256: artifactHashes.model_tag_snapshot, model_tag_knowledge: `model_tag_knowledge_${runDt}.json`, model_tag_knowledge_sha256: artifactHashes.model_tag_knowledge, model_tag_sync_manifest: `model_tag_sync_manifest_${runDt}.json`, model_tag_sync_manifest_sha256: artifactHashes.model_tag_sync_manifest, model_tag_source: 'model-tag-monitor-server-front-end-tags', model_tag_stats: { tagged_model_count: tagArtifacts.snapshot.stats.tagged_model_count, category_count: tagArtifacts.snapshot.stats.category_count }, model_tag_feishu_sync: tagArtifacts.syncManifest.feishu_sync, feishu_sync: tagArtifacts.syncManifest.feishu_sync, model_tag_sync_status: tagArtifacts.syncManifest.status, artifact_hashes: artifactHashes, quality_gates: qualityGate, warnings, known_gaps: knownGaps, generated_at: nowIso() };
    writeJson(path.join(outDir, 'active_process_manifest.json'), active);
    if (qualityGate === 'failed') return { ok: false, manifest: active, report: qualityReport, outDir };
    return { ok: true, manifest: active, report: qualityReport, outDir };
  } catch (err) {
    return writeFailure(outDir, runDt, runId, [err.stack || err.message], fetch ? { run_id: fetch.active.run_id, raw_cache: path.basename(fetch.rawCache), raw_cache_sha256: fetch.actualSha } : {});
  } finally {
    if (options.keepWorkDir !== true) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
function xmlEscape(s) { return String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function writeMinimalXlsx(file, manifest) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-wan-xlsx-'));
  try {
    ensureDir(path.join(tmp, '_rels'));
    ensureDir(path.join(tmp, 'xl', '_rels'));
    ensureDir(path.join(tmp, 'xl', 'worksheets'));
    fs.writeFileSync(path.join(tmp, '[Content_Types].xml'), '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
    fs.writeFileSync(path.join(tmp, '_rels', '.rels'), '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    fs.writeFileSync(path.join(tmp, 'xl', 'workbook.xml'), '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="manifest" sheetId="1" r:id="rId1"/></sheets></workbook>');
    fs.writeFileSync(path.join(tmp, 'xl', '_rels', 'workbook.xml.rels'), '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    const rows = [['field', 'value'], ['run_id', manifest.run_id], ['run_dt', manifest.run_dt], ['history_weeks', manifest.history_weeks], ['history_weeks_available', manifest.history_weeks_available]];
    const sheetRows = rows.map((row, idx) => `<row r="${idx + 1}">${row.map((v, j) => `<c r="${String.fromCharCode(65 + j)}${idx + 1}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`).join('')}</row>`).join('');
    fs.writeFileSync(path.join(tmp, 'xl', 'worksheets', 'sheet1.xml'), `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
    zipDir(tmp, file, ['[Content_Types].xml', '_rels', 'xl']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { processRawCache, parseArgs, parseCsvFile, writeCsv, dateToISOWeek, rollingInfo, canonicalImportRows, computeRates, normalizeTags, normalizeVocab, compareWtd, sha256File, sha256Json, KEEP_WEEKS };

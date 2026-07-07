// 读取本地 CSV → 归一化 → 落到 cache.json
// 数据来源：data pipeline 投递到 data/imports/model_daily_avg_*.csv
'use strict';

const { parseCSVStreamMapped, scanColumnValues, getImportsDir } = require('./csv-reader');
const store = require('./store');
const fs = require('node:fs');
const path = require('node:path');

const IMPORTS_DIR = getImportsDir();
const CSV_PREFIX = 'model_daily_avg_';

// 保留最近几周的数据（与一期一致）
const KEEP_WEEKS = 5;

// 表头字段 → 内部字段名映射
// 官方口径已是"周日均":列名以 "XX日均" 结尾;老表用 "XX汇总" 是周累计,也做兼容(不推荐使用)
const HEADER_MAP = {
  // 时间维度
  统计周: 'week',
  周次: 'week',
  week_start_date: 'startDate',
  周开始: 'startDate',
  开始日期: 'startDate',
  周结束: 'endDate',
  结束日期: 'endDate',
  已收到天数: 'daysReceived',
  day_cnt: 'daysReceived',
  // 品类/机型
  品类名称: 'category',
  品类: 'category',
  一级品类: 'category',
  机型ID: 'modelId',
  机型id: 'modelId',
  型号ID: 'modelId',
  机型名称: 'modelName',
  型号: 'modelName',
  型号名称: 'modelName',
  // 漏斗指标(以"日均"为主口径,兼容旧"汇总"命名)
  机况UV日均: 'jkuv',
  机况UV汇总: 'jkuv',
  机况UV: 'jkuv',
  机况页UV: 'jkuv',
  机况uv: 'jkuv',
  估价UV日均: 'evaUv',
  估价UV汇总: 'evaUv',
  估价UV: 'evaUv',
  估价uv: 'evaUv',
  估价量日均: 'evaCnt',
  估价量: 'evaCnt',
  下单UV日均: 'orderUv',
  下单UV汇总: 'orderUv',
  下单UV: 'orderUv',
  下单uv: 'orderUv',
  下单量日均: 'orderCnt',
  下单量汇总: 'orderCnt',
  下单量: 'orderCnt',
  发货量日均: 'shipCnt',
  发货量汇总: 'shipCnt',
  发货量: 'shipCnt',
  签收量日均: 'signCnt',
  签收量汇总: 'signCnt',
  签收量: 'signCnt',
  质检量日均: 'qcCnt',
  质检量汇总: 'qcCnt',
  质检量: 'qcCnt',
  成交量日均: 'dealCnt',
  成交量汇总: 'dealCnt',
  成交量: 'dealCnt',
  退回量日均: 'returnCnt',
  退回量汇总: 'returnCnt',
  退回量: 'returnCnt',
  成交GMV日均: 'gmv',
  成交GMV汇总: 'gmv',
  成交GMV: 'gmv',
  成交gmv: 'gmv',
  GMV: 'gmv',
  客单价: 'avgPrice',
  成交客单价: 'avgPrice',
};

const NUMERIC_FIELDS = ['jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv'];
const MODEL_MAIN_DIMENSION_HEADERS = ['核心属性（估价）', '成色等级（估价）', '核心属性（质检）', '成色等级（质检）', '履约方式（只取线上流程）'];
const JIKUANG_UV_HEADERS = ['机况uv', '机况UV', '机况UV日均', '机况UV汇总', '机况页UV'];

function getRawValue(row, headerNames) {
  for (const h of headerNames) {
    if (Object.prototype.hasOwnProperty.call(row, h)) {
      return String(row[h] ?? '').trim();
    }
  }
  return '';
}

function canonicalizeModelId(value) {
  const s = String(value ?? '').trim();
  return s.replace(/^(\d+)\.0+$/, '$1');
}

function isModelMainGrainRow(csvRow) {
  const hasDetailDimension = MODEL_MAIN_DIMENSION_HEADERS.some((h) => getRawValue(csvRow, [h]) !== '');
  if (hasDetailDimension) return false;
  return getRawValue(csvRow, JIKUANG_UV_HEADERS) !== '';
}

function recomputeDerivedFields(row) {
  row.avgPrice = row.dealCnt > 0 ? row.gmv / row.dealCnt : 0;
  Object.assign(row, computeRates(row));
  return row;
}

function modelRowKey(row) {
  const timeKey = row.startDate || row.week || '';
  const modelKey = row.modelId || `name:${row.modelName}`;
  return [timeKey, row.category, modelKey, row.modelName].join('\u001f');
}

function mergeModelRows(rows) {
  const byKey = new Map();
  let mergedRows = 0;

  for (const row of rows) {
    const key = modelRowKey(row);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...row });
      continue;
    }

    mergedRows += 1;
    for (const field of NUMERIC_FIELDS) {
      existing[field] = toNum(existing[field]) + toNum(row[field]);
    }
    existing.daysReceived = Math.max(toNum(existing.daysReceived), toNum(row.daysReceived));
    if (!existing.week && row.week) existing.week = row.week;
    if (!existing.startDate && row.startDate) existing.startDate = row.startDate;
    if (!existing.endDate && row.endDate) existing.endDate = row.endDate;
  }

  const merged = [...byKey.values()].map(recomputeDerivedFields);
  return { rows: merged, mergedRows };
}

// 5 个核心转化率的计算口径
function computeRates(row) {
  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  return {
    evaRate: safeDiv(row.evaUv, row.jkuv), // 估价完成率 = 估价UV / 机况UV
    orderRate: safeDiv(row.orderUv, row.evaUv), // 估价下单率 = 下单UV / 估价UV
    shipRate: safeDiv(row.shipCnt, row.evaUv), // 估价发货率 = 发货量 / 估价UV
    dealRate: safeDiv(row.dealCnt, row.evaUv), // 估价成交率 = 成交量 / 估价UV
    returnRate: safeDiv(row.returnCnt, row.qcCnt), // 质检退回率 = 退回量 / 质检量
  };
}

// 数字转换,把飞书返回的字符串数字变成 number,处理空/非数字
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// 归一化一行:根据表头映射把值填入标准字段
function normalizeRow(headers, values) {
  const fields = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP[String(h || '').trim()];
    if (key) fields[key] = values[i];
  });
  // 数字字段
  ['jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv', 'avgPrice', 'daysReceived'].forEach(
    (k) => {
      if (fields[k] !== undefined) fields[k] = toNum(fields[k]);
      else fields[k] = 0;
    }
  );
  // 文本字段
  ['week', 'startDate', 'endDate', 'category', 'modelId', 'modelName'].forEach((k) => {
    if (fields[k] !== undefined) fields[k] = String(fields[k]).trim();
    else fields[k] = '';
  });
  fields.modelId = canonicalizeModelId(fields.modelId);
  // 转化率与客单价
  return recomputeDerivedFields(fields);
}

/**
 * 从 CSV 原始行对象归一化为标准字段
 * @param {Record<string, string>} csvRow parseCSV 返回的单行对象（key 是中文表头）
 * @returns {object} 归一化后的行
 */
function normalizeCSVRow(csvRow) {
  const headers = Object.keys(csvRow);
  const values = Object.values(csvRow);
  return normalizeRow(headers, values);
}

/**
 * 从日期字符串（如 "2026-07-06"）计算 ISO 周次（如 "2026-W28"）
 * @param {string} dateStr yyyy-MM-dd 格式
 * @returns {string} ISO 周次字符串，如 "2026-W28"
 */
function dateToISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  // ISO week: 周四所在的年的第几周
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const dayOfYear = Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000) + 1;
  // 调整到周一起始
  const dayOfWeek = d.getUTCDay() || 7; // 1=Mon ... 7=Sun
  const weekThursday = new Date(d.getTime() + (4 - dayOfWeek) * 86400000);
  const year = weekThursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((weekThursday - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

async function sync() {
  console.log('[sync] 开始同步本地 CSV 数据...');

  // 文件名倒序（最新月份优先），便于按需短路
  const allFiles = fs.readdirSync(IMPORTS_DIR)
    .filter((f) => f.startsWith(CSV_PREFIX) && f.endsWith('.csv'))
    .sort()
    .reverse();

  if (!allFiles.length) {
    console.warn(`[sync] 未找到匹配文件: ${IMPORTS_DIR}/${CSV_PREFIX}*.csv`);
    return { rows: 0, categories: 0, weeks: 0 };
  }

  // Pass 1: 从最新月份文件开始扫周次，累计够 KEEP_WEEKS 就停下
  // 单月文件如果自己就包含 >= KEEP_WEEKS 周，只扫这一个文件即可
  console.log('[sync] Pass 1: 扫描周次（按文件名倒序，短路策略）...');
  const filesToLoad = [];
  const keepWeeks = new Set();
  const keepDates = new Set();
  for (const file of allFiles) {
    const dates = await scanColumnValues(path.join(IMPORTS_DIR, file), 'week_start_date');
    const fileWeeks = new Set();
    for (const d of dates) {
      const w = dateToISOWeek(d);
      if (w) fileWeeks.add(w);
    }
    filesToLoad.push({ file, dates: [...dates], weeks: [...fileWeeks] });
    for (const w of fileWeeks) keepWeeks.add(w);
    // 一旦累计周次覆盖了最近 KEEP_WEEKS 周，就不再往前扫更老的文件
    if (keepWeeks.size >= KEEP_WEEKS) break;
  }

  // 只保留最新 KEEP_WEEKS 周
  const sortedWeeks = [...keepWeeks].sort();
  const finalWeeks = new Set(sortedWeeks.slice(-KEEP_WEEKS));
  // 只加载那些至少包含一个目标周的文件
  const targetFiles = filesToLoad.filter((f) => f.weeks.some((w) => finalWeeks.has(w)));
  for (const f of targetFiles) {
    for (const d of f.dates) {
      if (finalWeeks.has(dateToISOWeek(d))) keepDates.add(d);
    }
  }
  console.log(`[sync] 保留 ${finalWeeks.size} 周: ${[...finalWeeks].sort().join(', ')}`);
  console.log(`[sync] 待加载文件 ${targetFiles.length} 个: ${targetFiles.map((f) => f.file).join(', ')}`);

  // Pass 2: 流式加载 + filter + normalize 一步到位（不留 CSV 原始行数组，降低堆压力）
  console.log('[sync] Pass 2: 加载并归一化数据...');
  let rows = [];
  let totalRead = 0;
  for (const { file } of targetFiles) {
    const added = await parseCSVStreamMapped(
      path.join(IMPORTS_DIR, file),
      (row) => {
        const d = getRawValue(row, ['week_start_date', '周开始', '开始日期']);
        return keepDates.has(d) && isModelMainGrainRow(row);
      },
      (csvRow) => {
        const norm = normalizeCSVRow(csvRow);
        if (!norm.week && norm.startDate) {
          norm.week = dateToISOWeek(norm.startDate);
        }
        if (!norm.week || !norm.category || !norm.modelName) return null;
        return norm;
      },
      rows
    );
    totalRead += added;
    console.log(`[sync]   ${file}: +${added} 行, 累计 ${rows.length}`);
  }
  console.log(`[sync] 主粒度过滤+归一化后有效行数（聚合前）: ${rows.length}`);
  const beforeMergeRows = rows.length;
  const mergeResult = mergeModelRows(rows);
  rows = mergeResult.rows;
  console.log(`[sync] 同 key 聚合: ${beforeMergeRows} -> ${rows.length}, 合并重复行 ${mergeResult.mergedRows}`);

  // 统计品类
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  console.log(`[sync] 品类: ${categories.length} 个, 周次: ${weeks.length} 个`);

  const cache = {
    syncedAt: new Date().toISOString(),
    source: { dir: IMPORTS_DIR, prefix: CSV_PREFIX },
    categories,
    weeks,
    rows,
  };
  store.writeJSON('cache.json', cache);
  store.appendLog({
    action: 'sync',
    rows: rows.length,
    categories: categories.length,
    weeks: weeks.length,
  });
  console.log('[sync] 完成');
  return { rows: rows.length, categories: categories.length, weeks: weeks.length };
}

module.exports = { sync, computeRates, normalizeRow, normalizeCSVRow, toNum, HEADER_MAP, dateToISOWeek, isModelMainGrainRow, canonicalizeModelId, mergeModelRows };

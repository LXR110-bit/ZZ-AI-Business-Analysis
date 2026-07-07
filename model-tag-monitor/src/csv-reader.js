// 通用 CSV 解析模块（零依赖）
// 支持简单 CSV（无嵌套引号/换行），适用于 data pipeline 产出的规整数据
// 大文件使用流式逐行读取，避免 OOM
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

/**
 * 返回 CSV 数据目录路径（支持环境变量覆盖）
 * 优先读取 IMPORT_DIR 环境变量，未设置则回退到项目内 data/imports/
 */
function getImportsDir() {
  return process.env.IMPORT_DIR || path.join(__dirname, '..', 'data', 'imports');
}

/**
 * 同步解析小型 CSV 文件（< 5万行），返回 [{header: value, ...}] 数组
 * @param {string} filepath 绝对或相对路径
 * @returns {Array<Record<string, string>>}
 */
function parseCSV(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  const text = raw.replace(/^﻿/, ''); // strip UTF-8 BOM
  const [headerLine, ...dataLines] = text.trim().split(/\r?\n/);
  if (!headerLine) return [];
  const headers = headerLine.split(',').map((h) => h.trim());
  return dataLines.filter(Boolean).map((line) => {
    const values = line.split(',');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (values[i] || '').trim();
    });
    return row;
  });
}

/**
 * 流式解析单个 CSV 文件（适合大文件）
 * @param {string} filepath
 * @returns {Promise<Array<Record<string, string>>>}
 */
function parseCSVStream(filepath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    let isFirst = true;
    const input = fs.createReadStream(filepath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    rl.on('line', (rawLine) => {
      let line = rawLine;
      // strip BOM on first line
      if (isFirst) {
        line = line.replace(/^﻿/, '');
        isFirst = false;
      }
      if (!line.trim()) return;
      if (!headers) {
        headers = line.split(',').map((h) => h.trim());
        return;
      }
      const values = line.split(',');
      const row = {};
      headers.forEach((h, i) => {
        row[h] = (values[i] || '').trim();
      });
      rows.push(row);
    });
    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
    input.on('error', reject);
  });
}

/**
 * 扫描目录下匹配 prefix 的 CSV 文件并合并解析（同步版，适合小文件）
 */
function parseCSVGlob(dir, prefix) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .sort();
  let rows = [];
  for (const file of files) {
    const batch = parseCSV(path.join(dir, file));
    rows = rows.concat(batch);
  }
  return rows;
}

/**
 * 扫描目录下匹配 prefix 的 CSV 文件并流式合并解析（异步版，适合大文件）
 * @param {string} dir
 * @param {string} prefix
 * @returns {Promise<Array<Record<string, string>>>}
 */
async function parseCSVGlobAsync(dir, prefix) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.csv'))
    .sort();
  let rows = [];
  for (const file of files) {
    const batch = await parseCSVStream(path.join(dir, file));
    rows = rows.concat(batch);
  }
  return rows;
}

/**
 * 流式解析 CSV 文件，只保留满足 filter 条件的行（适合大文件按条件过滤）
 * @param {string} filepath
 * @param {function(Record<string, string>): boolean} filterFn 返回 true 则保留该行
 * @returns {Promise<Array<Record<string, string>>>}
 */
function parseCSVStreamFiltered(filepath, filterFn) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    let isFirst = true;
    const input = fs.createReadStream(filepath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    rl.on('line', (rawLine) => {
      let line = rawLine;
      if (isFirst) {
        line = line.replace(/^﻿/, '');
        isFirst = false;
      }
      if (!line.trim()) return;
      if (!headers) {
        headers = line.split(',').map((h) => h.trim());
        return;
      }
      const values = line.split(',');
      const row = {};
      headers.forEach((h, i) => {
        row[h] = (values[i] || '').trim();
      });
      if (filterFn(row)) rows.push(row);
    });
    rl.on('close', () => resolve(rows));
    rl.on('error', reject);
    input.on('error', reject);
  });
}

/**
 * 流式解析 CSV，filter + map 一步到位，结果直接 push 到 outArr
 * 与 parseCSVStreamFiltered 的区别：不在函数内累积原始 row 数组，
 * 归一化对象直接进入调用方数组，中间态可以被 GC，适合大文件。
 * @param {string} filepath
 * @param {function(Record<string, string>): boolean} filterFn 返回 true 则进入 mapFn
 * @param {function(Record<string, string>): any|null|undefined} mapFn 返回 null/undefined 则丢弃
 * @param {Array} outArr 输出数组（引用传入，避免额外拷贝）
 * @returns {Promise<number>} 本次追加到 outArr 的行数
 */
function parseCSVStreamMapped(filepath, filterFn, mapFn, outArr) {
  return new Promise((resolve, reject) => {
    const before = outArr.length;
    let headers = null;
    let isFirst = true;
    const input = fs.createReadStream(filepath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    rl.on('line', (rawLine) => {
      let line = rawLine;
      if (isFirst) {
        line = line.replace(/^﻿/, '');
        isFirst = false;
      }
      if (!line.trim()) return;
      if (!headers) {
        headers = line.split(',').map((h) => h.trim());
        return;
      }
      const values = line.split(',');
      const row = {};
      for (let i = 0; i < headers.length; i++) {
        row[headers[i]] = (values[i] || '').trim();
      }
      if (filterFn(row)) {
        const mapped = mapFn(row);
        if (mapped !== null && mapped !== undefined) outArr.push(mapped);
      }
    });
    rl.on('close', () => resolve(outArr.length - before));
    rl.on('error', reject);
    input.on('error', reject);
  });
}

/**
 * 流式扫描 CSV 文件，只提取指定列的唯一值（轻量，不创建完整行对象）
 * @param {string} filepath
 * @param {string} columnName 要提取的列名
 * @returns {Promise<Set<string>>} 该列的去重值集合
 */
function scanColumnValues(filepath, columnName) {
  return new Promise((resolve, reject) => {
    const values = new Set();
    let colIndex = -1;
    let isFirst = true;
    const input = fs.createReadStream(filepath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    rl.on('line', (rawLine) => {
      let line = rawLine;
      if (isFirst) {
        line = line.replace(/^﻿/, '');
        isFirst = false;
        // find column index
        const headers = line.split(',').map((h) => h.trim());
        colIndex = headers.indexOf(columnName);
        if (colIndex === -1) {
          // 尝试不区分大小写
          colIndex = headers.findIndex((h) => h.toLowerCase() === columnName.toLowerCase());
        }
        return;
      }
      if (colIndex === -1) return;
      let val;
      if (colIndex === 0) {
        const commaIdx = line.indexOf(',');
        val = commaIdx >= 0 ? line.slice(0, commaIdx) : line;
      } else {
        val = line.split(',')[colIndex];
      }
      if (val && val.trim()) values.add(val.trim());
    });
    rl.on('close', () => resolve(values));
    rl.on('error', reject);
    input.on('error', reject);
  });
}

module.exports = { parseCSV, parseCSVStream, parseCSVStreamFiltered, parseCSVStreamMapped, parseCSVGlob, parseCSVGlobAsync, scanColumnValues, getImportsDir };

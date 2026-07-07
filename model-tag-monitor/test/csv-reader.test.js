'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseCSV, parseCSVGlob, getImportsDir } = require('../src/csv-reader');

function tmpFile(content) {
  const p = path.join(os.tmpdir(), `csv-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function tmpDir(files) {
  const dir = path.join(os.tmpdir(), `csv-reader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8');
  }
  return dir;
}

test('parseCSV: 正常解析带中文表头的 CSV', () => {
  const p = tmpFile('统计周,品类名称,机况UV日均\n2026-W24,无人机,3200\n2026-W25,显卡,4100\n');
  const rows = parseCSV(p);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { 统计周: '2026-W24', 品类名称: '无人机', 机况UV日均: '3200' });
  assert.deepEqual(rows[1], { 统计周: '2026-W25', 品类名称: '显卡', 机况UV日均: '4100' });
  fs.unlinkSync(p);
});

test('parseCSV: 空文件返回空数组', () => {
  const p = tmpFile('');
  assert.deepEqual(parseCSV(p), []);
  fs.unlinkSync(p);
});

test('parseCSV: 只有表头没有数据行', () => {
  const p = tmpFile('a,b,c\n');
  assert.deepEqual(parseCSV(p), []);
  fs.unlinkSync(p);
});

test('parseCSV: 缺失列补空字符串', () => {
  const p = tmpFile('a,b,c\n1,2\n');
  const rows = parseCSV(p);
  assert.equal(rows[0].c, '');
  fs.unlinkSync(p);
});

test('parseCSV: trim 表头和值的空格', () => {
  const p = tmpFile(' name , value \n hello , 123 \n');
  const rows = parseCSV(p);
  assert.deepEqual(rows[0], { name: 'hello', value: '123' });
  fs.unlinkSync(p);
});

test('parseCSVGlob: 合并匹配前缀的多个文件', () => {
  const dir = tmpDir({
    'model_daily_avg_2026-04.csv': '统计周,品类名称\nW18,无人机\n',
    'model_daily_avg_2026-05.csv': '统计周,品类名称\nW19,显卡\nW20,台球杆\n',
    'category_daily_avg_2026-04.csv': '统计周,品类名称\nW18,手环\n',
    'other.txt': 'not a csv',
  });
  const rows = parseCSVGlob(dir, 'model_daily_avg_');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].品类名称, '无人机');
  assert.equal(rows[1].品类名称, '显卡');
  assert.equal(rows[2].品类名称, '台球杆');
  fs.rmSync(dir, { recursive: true });
});

test('parseCSVGlob: 无匹配文件返回空数组', () => {
  const dir = tmpDir({ 'unrelated.csv': 'a\n1\n' });
  const rows = parseCSVGlob(dir, 'model_daily_avg_');
  assert.deepEqual(rows, []);
  fs.rmSync(dir, { recursive: true });
});

test('parseCSV: UTF-8 BOM 不污染第一列表头', () => {
  const bom = '﻿';
  const p = tmpFile(`${bom}name,value\nalice,100\n`);
  const rows = parseCSV(p);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ['name', 'value']);
  assert.equal(rows[0].name, 'alice');
  fs.unlinkSync(p);
});

test('parseCSV: CRLF 换行正常解析', () => {
  const p = tmpFile('a,b\r\n1,2\r\n3,4\r\n');
  const rows = parseCSV(p);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: '1', b: '2' });
  assert.deepEqual(rows[1], { a: '3', b: '4' });
  fs.unlinkSync(p);
});

test('getImportsDir: 默认返回项目内 data/imports/', () => {
  const original = process.env.IMPORT_DIR;
  delete process.env.IMPORT_DIR;
  const dir = getImportsDir();
  assert.ok(dir.endsWith(path.join('data', 'imports')));
  if (original !== undefined) process.env.IMPORT_DIR = original;
});

test('getImportsDir: 读取 IMPORT_DIR 环境变量', () => {
  const original = process.env.IMPORT_DIR;
  process.env.IMPORT_DIR = '/tmp/custom-imports';
  assert.equal(getImportsDir(), '/tmp/custom-imports');
  if (original !== undefined) process.env.IMPORT_DIR = original;
  else delete process.env.IMPORT_DIR;
});

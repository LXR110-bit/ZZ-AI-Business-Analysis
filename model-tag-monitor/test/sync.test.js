'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRow, normalizeCSVRow, computeRates, toNum, HEADER_MAP } = require('../src/sync');

test('HEADER_MAP: 关键中文表头都有映射', () => {
  const expected = ['统计周', '品类名称', '机型名称', '机况UV日均', '估价UV日均', '下单UV日均', '成交量日均', '成交GMV日均'];
  for (const h of expected) {
    assert.ok(HEADER_MAP[h], `缺少映射: ${h}`);
  }
});

test('toNum: 各种输入格式', () => {
  assert.equal(toNum('3,200'), 3200);
  assert.equal(toNum(''), 0);
  assert.equal(toNum(null), 0);
  assert.equal(toNum(undefined), 0);
  assert.equal(toNum('abc'), 0);
  assert.equal(toNum(42), 42);
  assert.equal(toNum(' 100 '), 100);
});

test('normalizeRow: 把表头+值数组映射为标准字段', () => {
  const headers = ['统计周', '品类名称', '机型名称', '机况UV日均', '估价UV日均', '成交量日均'];
  const values = ['2026-W24', '无人机', 'DJI Mini 4', '1000', '800', '50'];
  const row = normalizeRow(headers, values);
  assert.equal(row.week, '2026-W24');
  assert.equal(row.category, '无人机');
  assert.equal(row.modelName, 'DJI Mini 4');
  assert.equal(row.jkuv, 1000);
  assert.equal(row.evaUv, 800);
  assert.equal(row.dealCnt, 50);
});

test('normalizeCSVRow: 从 CSV 行对象归一化', () => {
  const csvRow = { 统计周: '2026-W25', 品类名称: '显卡', 机型名称: 'RTX 4090', 机况UV日均: '500', 估价UV日均: '400' };
  const row = normalizeCSVRow(csvRow);
  assert.equal(row.week, '2026-W25');
  assert.equal(row.category, '显卡');
  assert.equal(row.modelName, 'RTX 4090');
  assert.equal(row.jkuv, 500);
  assert.equal(row.evaUv, 400);
});

test('computeRates: 正常计算转化率', () => {
  const row = { jkuv: 1000, evaUv: 800, orderUv: 200, shipCnt: 100, dealCnt: 50, returnCnt: 5, qcCnt: 60 };
  const rates = computeRates(row);
  assert.equal(rates.evaRate, 0.8);
  assert.equal(rates.orderRate, 0.25);
  assert.equal(rates.shipRate, 0.125);
  assert.equal(rates.dealRate, 0.0625);
  assert.ok(Math.abs(rates.returnRate - 5 / 60) < 1e-10);
});

test('computeRates: 分母为 0 返回 null', () => {
  const row = { jkuv: 0, evaUv: 0, orderUv: 0, shipCnt: 0, dealCnt: 0, returnCnt: 0, qcCnt: 0 };
  const rates = computeRates(row);
  assert.equal(rates.evaRate, null);
  assert.equal(rates.orderRate, null);
  assert.equal(rates.returnRate, null);
});

test('normalizeRow: 兼容旧"汇总"命名', () => {
  const headers = ['统计周', '品类名称', '机型名称', '机况UV汇总', '估价UV汇总'];
  const values = ['2026-W18', '手机', 'iPhone 15', '2000', '1500'];
  const row = normalizeRow(headers, values);
  assert.equal(row.jkuv, 2000);
  assert.equal(row.evaUv, 1500);
});


test('normalizeRow: model_daily_avg 普通指标列按 day_cnt 转机型日均', () => {
  const headers = ['week_start_date', '品类名称', '机型名称', 'day_cnt', '机况uv', '估价uv', '下单uv', '发货量', '成交量', '成交GMV'];
  const values = ['2026-06-29', '拍立得', '富士 instax mini 12', '7', '2934', '2566', '700', '140', '110', '28327'];
  const row = normalizeRow(headers, values);
  assert.equal(row.startDate, '2026-06-29');
  assert.equal(row.category, '拍立得');
  assert.equal(row.modelName, '富士 instax mini 12');
  assert.equal(row.daysReceived, 7);
  assert.equal(row.jkuv, 2934 / 7);
  assert.equal(row.evaUv, 2566 / 7);
  assert.equal(row.orderUv, 100);
  assert.equal(row.shipCnt, 20);
  assert.equal(row.dealCnt, 110 / 7);
  assert.equal(row.gmv, 28327 / 7);
});

test('normalizeRow: 显式日均字段不按 day_cnt 重复除', () => {
  const headers = ['统计周', '品类名称', '机型名称', 'day_cnt', '机况UV日均', '估价UV日均', '成交量日均', '成交GMV日均'];
  const values = ['2026-W27', '手机', 'iPhone 15', '7', '1000', '800', '50', '120000'];
  const row = normalizeRow(headers, values);
  assert.equal(row.jkuv, 1000);
  assert.equal(row.evaUv, 800);
  assert.equal(row.dealCnt, 50);
  assert.equal(row.gmv, 120000);
});

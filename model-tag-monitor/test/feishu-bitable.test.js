'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bitableFieldToString, bitableFieldToNumber } = require('../src/feishu-bitable');

test('bitableFieldToString: 纯字符串直接 trim', () => {
  assert.equal(bitableFieldToString('  无人机  '), '无人机');
});

test('bitableFieldToString: 富文本分段数组拼接 text', () => {
  assert.equal(
    bitableFieldToString([{ type: 'text', text: '无人机' }, { type: 'text', text: '(测试)' }]),
    '无人机(测试)'
  );
});

test('bitableFieldToString: null/undefined → 空字符串', () => {
  assert.equal(bitableFieldToString(null), '');
  assert.equal(bitableFieldToString(undefined), '');
});

test('bitableFieldToString: 数字类型转字符串', () => {
  assert.equal(bitableFieldToString(2026), '2026');
});

test('bitableFieldToNumber: 纯数字直接返回', () => {
  assert.equal(bitableFieldToNumber(1234), 1234);
});

test('bitableFieldToNumber: 千分位字符串去逗号转数字', () => {
  assert.equal(bitableFieldToNumber('12,345'), 12345);
});

test('bitableFieldToNumber: null/undefined/空字符串 → fallback(默认0)', () => {
  assert.equal(bitableFieldToNumber(null), 0);
  assert.equal(bitableFieldToNumber(undefined), 0);
  assert.equal(bitableFieldToNumber(''), 0);
});

test('bitableFieldToNumber: 自定义 fallback', () => {
  assert.equal(bitableFieldToNumber(null, -1), -1);
});

test('bitableFieldToNumber: 非数字字符串 → fallback', () => {
  assert.equal(bitableFieldToNumber('N/A'), 0);
});

test('bitableFieldToNumber: 富文本数组防御式处理', () => {
  assert.equal(bitableFieldToNumber([{ type: 'text', text: '888' }]), 888);
});

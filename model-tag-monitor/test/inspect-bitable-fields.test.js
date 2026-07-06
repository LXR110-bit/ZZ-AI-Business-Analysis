'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../scripts/inspect-bitable-fields');

test('parseArgs: 两个参数都给了 → 返回 { wikiNodeToken, tableId }', () => {
  const args = parseArgs(['DAcFwVw8ViG3PHkqUOUcbmYGnDc', 'tbl5EZ8oGsVE8joQ']);
  assert.deepEqual(args, { wikiNodeToken: 'DAcFwVw8ViG3PHkqUOUcbmYGnDc', tableId: 'tbl5EZ8oGsVE8joQ' });
});

test('parseArgs: 缺 tableId → 抛错', () => {
  assert.throws(() => parseArgs(['DAcFwVw8ViG3PHkqUOUcbmYGnDc']), /用法/);
});

test('parseArgs: 空参数 → 抛错', () => {
  assert.throws(() => parseArgs([]), /用法/);
});

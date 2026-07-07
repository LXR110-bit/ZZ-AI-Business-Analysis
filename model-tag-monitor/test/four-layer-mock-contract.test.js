'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mock = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dashboard-v2-mock.json'), 'utf8'));

const VALID_TIERS = ['发展', '孵化', '种子'];
const VALID_STATUSES = ['在售', '已下线'];
const RATE_KEYS = ['evaRate', 'orderRate', 'shipRate', 'dealRate'];

test('顶层字段完整', () => {
  assert.equal(typeof mock.week, 'string');
  assert.match(mock.week, /^\d{4}-W\d{2}$/);
  assert.equal(typeof mock.weekRange, 'string');
  assert.equal(typeof mock.syncedAt, 'string');
  assert.ok(mock.board);
  assert.ok(Array.isArray(mock.tiers));
  assert.ok(Array.isArray(mock.categories));
});

test('board 结构', () => {
  const { cur, delta } = mock.board;
  assert.equal(typeof cur.gmv, 'number');
  for (const k of RATE_KEYS) {
    assert.ok(cur[k] === null || typeof cur[k] === 'number', `board.cur.${k} should be number or null`);
    assert.ok(delta[k] === null || typeof delta[k] === 'number', `board.delta.${k} should be number or null`);
  }
  assert.ok(delta.gmv === null || typeof delta.gmv === 'number');
});

test('tiers: 3 层，tier 枚举正确，含 categoryCount', () => {
  assert.equal(mock.tiers.length, 3);
  const tierNames = mock.tiers.map((t) => t.tier);
  assert.deepEqual(tierNames.sort(), [...VALID_TIERS].sort());
  for (const t of mock.tiers) {
    assert.equal(typeof t.cur.gmv, 'number');
    assert.equal(typeof t.cur.categoryCount, 'number');
    for (const k of RATE_KEYS) {
      assert.ok(t.cur[k] === null || typeof t.cur[k] === 'number');
      assert.ok(t.delta[k] === null || typeof t.delta[k] === 'number');
    }
  }
});

test('categories: 字段完整、枚举正确、anomalyScore 0-3', () => {
  assert.ok(mock.categories.length > 0);
  for (const c of mock.categories) {
    assert.equal(typeof c.category, 'string');
    assert.ok(VALID_TIERS.includes(c.tier), `invalid tier: ${c.tier}`);
    assert.equal(typeof c.board, 'string');
    assert.ok(VALID_STATUSES.includes(c.status), `invalid status: ${c.status}`);
    assert.equal(typeof c.cur.gmv, 'number');
    for (const k of RATE_KEYS) {
      assert.ok(c.cur[k] === null || typeof c.cur[k] === 'number');
    }
    if (c.delta !== null) {
      for (const k of RATE_KEYS) {
        assert.ok(c.delta[k] === null || typeof c.delta[k] === 'number');
      }
    }
    assert.ok(c.anomalyScore >= 0 && c.anomalyScore <= 3, `anomalyScore out of range: ${c.anomalyScore}`);
  }
});

test('已下线品类 delta 为 null', () => {
  const offline = mock.categories.filter((c) => c.status === '已下线');
  for (const c of offline) {
    assert.equal(c.delta, null, `已下线品类 ${c.category} 的 delta 应为 null`);
  }
});

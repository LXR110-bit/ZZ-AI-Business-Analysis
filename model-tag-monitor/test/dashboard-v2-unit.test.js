'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fmtGmvShort, fmtDeltaArrow, anomalyDots } = require('../public/dashboard-v2.js');

test('fmtGmvShort: 亿/万/原值', () => {
  assert.equal(fmtGmvShort(150000000), '1.50亿');
  assert.equal(fmtGmvShort(2345600), '234.6万');
  assert.equal(fmtGmvShort(9800), '9800');
  assert.equal(fmtGmvShort(0), '0');
  assert.equal(fmtGmvShort(null), '0');
});

test('fmtDeltaArrow: 正/负/null', () => {
  assert.match(fmtDeltaArrow(0.032), /up.*▲3\.2%/);
  assert.match(fmtDeltaArrow(-0.015), /down.*▼1\.5%/);
  assert.equal(fmtDeltaArrow(null), '');
  assert.equal(fmtDeltaArrow(undefined), '');
});

test('anomalyDots: 0-3 填充', () => {
  const d0 = anomalyDots(0);
  assert.equal((d0.match(/filled/g) || []).length, 0);
  const d2 = anomalyDots(2);
  assert.equal((d2.match(/filled/g) || []).length, 2);
  const d3 = anomalyDots(3);
  assert.equal((d3.match(/filled/g) || []).length, 3);
});

test('anomalyDots: 超限夹紧到 3', () => {
  const d5 = anomalyDots(5);
  assert.equal((d5.match(/filled/g) || []).length, 3);
});

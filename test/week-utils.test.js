'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isoWeekToRange, isoWeekToRangeStr } = require('../src/week-utils');

test('2026-W27 → 2026-06-29 ~ 2026-07-05', () => {
  const { monday, sunday } = isoWeekToRange('2026-W27');
  assert.equal(monday, '2026-06-29');
  assert.equal(sunday, '2026-07-05');
});

test('2026-W01 → 2025-12-29 ~ 2026-01-04', () => {
  // 2026-01-04 is Sunday of W01; Monday is 2025-12-29
  const { monday, sunday } = isoWeekToRange('2026-W01');
  assert.equal(monday, '2025-12-29');
  assert.equal(sunday, '2026-01-04');
});

test('2026-W26 → 2026-06-22 ~ 2026-06-28', () => {
  const { monday, sunday } = isoWeekToRange('2026-W26');
  assert.equal(monday, '2026-06-22');
  assert.equal(sunday, '2026-06-28');
});

test('2025-W01 → 2024-12-30 ~ 2025-01-05', () => {
  const { monday, sunday } = isoWeekToRange('2025-W01');
  assert.equal(monday, '2024-12-30');
  assert.equal(sunday, '2025-01-05');
});

test('2024-W52 → 2024-12-23 ~ 2024-12-29', () => {
  // 2024 has 52 weeks (starts on Monday)
  const { monday, sunday } = isoWeekToRange('2024-W52');
  assert.equal(monday, '2024-12-23');
  assert.equal(sunday, '2024-12-29');
});

test('2020-W53 → 2020-12-28 ~ 2021-01-03（闰年 53 周）', () => {
  // 2020 is a leap year with 53 ISO weeks
  const { monday, sunday } = isoWeekToRange('2020-W53');
  assert.equal(monday, '2020-12-28');
  assert.equal(sunday, '2021-01-03');
});

test('2024-W01 → 2024-01-01 ~ 2024-01-07（闰年 W01）', () => {
  const { monday, sunday } = isoWeekToRange('2024-W01');
  assert.equal(monday, '2024-01-01');
  assert.equal(sunday, '2024-01-07');
});

test('isoWeekToRangeStr 格式化', () => {
  const str = isoWeekToRangeStr('2026-W27');
  assert.equal(str, '2026-06-29 ~ 2026-07-05');
});

test('无效格式抛 Error', () => {
  assert.throws(() => isoWeekToRange('2026W27'), /Invalid ISO week format/);
  assert.throws(() => isoWeekToRange('W27'), /Invalid ISO week format/);
});

test('week 超范围抛 Error', () => {
  assert.throws(() => isoWeekToRange('2026-W00'), /Week out of range/);
  assert.throws(() => isoWeekToRange('2026-W54'), /Week out of range/);
});

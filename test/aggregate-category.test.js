'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCategoryLayer } = require('../src/aggregate/category');

const FIX_DIR = path.join(__dirname, 'fixtures');
const categoryCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));

test('返回 5 个品类，字段形状完整', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
  assert.equal(categories.length, 5);
  for (const c of categories) {
    assert.ok('category' in c);
    assert.ok('tier' in c);
    assert.ok('board' in c);
    assert.ok('status' in c);
    assert.ok('confidence' in c);
    assert.ok('lastWeekGmv' in c);
    assert.ok('cur' in c);
    assert.ok('delta' in c);
  }
});

test('cur：转化率用 calcRates 重算（验证 evaRate = evaUv/jkuv）', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
  const drone = categories.find((c) => c.category === '无人机');
  // jkuv=1000, evaUv=500 → evaRate=0.5
  assert.equal(drone.cur.evaRate, 0.5);
  // orderUv=125, evaUv=500 → orderRate=0.25
  assert.equal(drone.cur.orderRate, 0.25);
});

test('拍立得 evaRate = 1.0（jkuv=100, evaUv=100）', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
  const polaroid = categories.find((c) => c.category === '拍立得');
  assert.equal(polaroid.cur.evaRate, 1);
  assert.equal(polaroid.cur.jkuv, 100);
  assert.equal(polaroid.cur.evaUv, 100);
});

test('已下线品类 delta 为 null', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
  const camera = categories.find((c) => c.category === '运动相机');
  assert.equal(camera.status, '已下线');
  assert.equal(camera.delta, null);
});

test('在售品类 delta 正常计算环比', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
  const drone = categories.find((c) => c.category === '无人机');
  // W27 orderRate=0.25, W26 orderRate=0.2 → delta=(0.25-0.2)/0.2=0.25
  assert.ok(Math.abs(drone.delta.orderRate - 0.25) < 1e-9);
});

test('prevWeek 为 null：在售品类 delta 也为 null', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', null);
  for (const c of categories) {
    assert.equal(c.delta, null);
  }
});

test('week 找不到 cache 行：cur 全字段 null', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W99', '2026-W26');
  for (const c of categories) {
    assert.equal(c.cur.jkuv, null);
    assert.equal(c.cur.evaRate, null);
  }
});

test('taxonomy 元数据透传（board/confidence/lastWeekGmv）', () => {
  const categories = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
  const billiard = categories.find((c) => c.category === '台球杆');
  assert.equal(billiard.board, '运动娱乐');
  assert.equal(billiard.confidence, '高');
  assert.equal(billiard.lastWeekGmv, 500000);
});

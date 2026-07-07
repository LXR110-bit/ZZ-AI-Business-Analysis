'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCategoryLayer } = require('../src/aggregate/category');
const { buildTierLayer } = require('../src/aggregate/tier');

const FIX_DIR = path.join(__dirname, 'fixtures');
const categoryCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-cache.json'), 'utf8'));
const taxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'category-taxonomy.json'), 'utf8'));

const categoriesW27 = buildCategoryLayer(categoryCache, taxonomy, '2026-W27', '2026-W26');
const categoriesW26 = buildCategoryLayer(categoryCache, taxonomy, '2026-W26', null);

test('返回 3 个 tier，排序稳定', () => {
  const tiers = buildTierLayer(categoriesW27, categoriesW26);
  assert.equal(tiers.length, 3);
  const tierNames = tiers.map((t) => t.tier);
  assert.ok(tierNames.includes('发展'));
  assert.ok(tierNames.includes('孵化'));
  assert.ok(tierNames.includes('种子'));
});

test('发展层 cur：含已下线品类（无人机+运动相机）求和', () => {
  const tiers = buildTierLayer(categoriesW27, categoriesW26);
  const dev = tiers.find((t) => t.tier === '发展');
  // 无人机 jkuv=1000 + 运动相机 jkuv=180 = 1180
  assert.equal(dev.cur.jkuv, 1180);
  // 无人机 evaUv=500 + 运动相机 evaUv=90 = 590
  assert.equal(dev.cur.evaUv, 590);
  // evaRate = 590/1180 = 0.5
  assert.equal(dev.cur.evaRate, 0.5);
});

test('孵化层 cur：台球杆+拍立得求和，转化率重算', () => {
  const tiers = buildTierLayer(categoriesW27, categoriesW26);
  const incubate = tiers.find((t) => t.tier === '孵化');
  // 台球杆 jkuv=800 + 拍立得 jkuv=100 = 900
  assert.equal(incubate.cur.jkuv, 900);
  // 台球杆 evaUv=400 + 拍立得 evaUv=100 = 500
  assert.equal(incubate.cur.evaUv, 500);
  // evaRate = 500/900 = 5/9
  assert.ok(Math.abs(incubate.cur.evaRate - 5 / 9) < 1e-9);
  // orderUv = 100+20 = 120, orderRate = 120/500 = 0.24
  assert.equal(incubate.cur.orderUv, 120);
  assert.ok(Math.abs(incubate.cur.orderRate - 0.24) < 1e-9);
});

test('发展层 delta：排除已下线（只用无人机）算环比', () => {
  const tiers = buildTierLayer(categoriesW27, categoriesW26);
  const dev = tiers.find((t) => t.tier === '发展');
  // W27 无人机: orderRate = 125/500 = 0.25
  // W26 无人机: orderRate = 100/500 = 0.2
  // delta = (0.25 - 0.2) / 0.2 = 0.25
  assert.ok(Math.abs(dev.delta.orderRate - 0.25) < 1e-9);
});

test('种子层（显卡单品类）cur/delta 验证', () => {
  const tiers = buildTierLayer(categoriesW27, categoriesW26);
  const seed = tiers.find((t) => t.tier === '种子');
  assert.equal(seed.cur.jkuv, 2000);
  assert.equal(seed.cur.gmv, 1200000);
  // W27 orderRate = 250/1000 = 0.25, W26 orderRate = 200/1000 = 0.2
  // delta = (0.25-0.2)/0.2 = 0.25
  assert.ok(Math.abs(seed.delta.orderRate - 0.25) < 1e-9);
});

test('categoryLayerPrev 为 null：所有 tier 的 delta 为 null', () => {
  const tiers = buildTierLayer(categoriesW27, null);
  for (const t of tiers) {
    assert.equal(t.delta, null);
  }
});

test('空品类列表：返回空数组', () => {
  const tiers = buildTierLayer([], []);
  assert.equal(tiers.length, 0);
});

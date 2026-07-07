'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildModelTierLayer, buildAllModelTierLayers } = require('../src/aggregate/model');

const FIX_DIR = path.join(__dirname, 'fixtures');
const modelCache = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-cache.json'), 'utf8'));
const modelTaxonomy = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'model-taxonomy.json'), 'utf8'));

test('buildModelTierLayer：无人机按 旗舰/入门 分组，数量正确', () => {
  const result = buildModelTierLayer(modelCache, modelTaxonomy, '无人机', '2026-W27', '2026-W26');
  assert.equal(result.length, 2);
  const tiers = result.map((r) => r.modelTier).sort();
  assert.deepEqual(tiers, ['入门', '旗舰']);
});

test('buildModelTierLayer：旗舰组 cur 为 DJI Mini 4 Pro + DJI Air 3 求和', () => {
  const result = buildModelTierLayer(modelCache, modelTaxonomy, '无人机', '2026-W27', '2026-W26');
  const flagship = result.find((r) => r.modelTier === '旗舰');
  // W27: Mini 4 Pro jkuv=450 + Air 3 jkuv=300 = 750
  assert.equal(flagship.cur.jkuv, 750);
  // Mini 4 Pro gmv=250000 + Air 3 gmv=150000 = 400000
  assert.equal(flagship.cur.gmv, 400000);
});

test('buildModelTierLayer：入门组 cur 为 Pocket 3 单独', () => {
  const result = buildModelTierLayer(modelCache, modelTaxonomy, '无人机', '2026-W27', '2026-W26');
  const entry = result.find((r) => r.modelTier === '入门');
  assert.equal(entry.cur.jkuv, 250);
  assert.equal(entry.cur.gmv, 200000);
});

test('buildModelTierLayer：各组 cur 求和等于品类总量', () => {
  const result = buildModelTierLayer(modelCache, modelTaxonomy, '无人机', '2026-W27', '2026-W26');
  const totalGmv = result.reduce((s, r) => s + r.cur.gmv, 0);
  // 品类 W27 gmv = 600000
  assert.equal(totalGmv, 600000);
});

test('buildModelTierLayer：delta 正确计算环比', () => {
  const result = buildModelTierLayer(modelCache, modelTaxonomy, '无人机', '2026-W27', '2026-W26');
  const entry = result.find((r) => r.modelTier === '入门');
  // Pocket 3 W26: evaUv=100, jkuv=200 → evaRate=0.5
  // Pocket 3 W27: evaUv=130, jkuv=250 → evaRate=0.52
  // delta.evaRate = (0.52 - 0.5) / 0.5 = 0.04
  assert.ok(entry.delta != null);
  assert.ok(Math.abs(entry.delta.evaRate - 0.04) < 1e-10);
});

test('buildModelTierLayer：prevWeek 为 null → delta 全为 null', () => {
  const result = buildModelTierLayer(modelCache, modelTaxonomy, '无人机', '2026-W27', null);
  for (const tier of result) {
    assert.equal(tier.delta, null);
  }
});

test('buildModelTierLayer：modelCache 为 null → 返回空数组', () => {
  const result = buildModelTierLayer(null, modelTaxonomy, '无人机', '2026-W27', '2026-W26');
  assert.deepEqual(result, []);
});

test('buildModelTierLayer：未匹配 taxonomy 的机型归入 "未分组"', () => {
  // 创建一个额外机型不在 taxonomy 里
  const extraCache = {
    rows: [
      ...modelCache.rows,
      { week: '2026-W27', category: '无人机', modelName: 'Unknown X', jkuv: 50, evaUv: 20, evaCnt: 20, orderUv: 5, orderCnt: 5, shipCnt: 5, signCnt: 4, qcCnt: 3, dealCnt: 2, returnCnt: 0, gmv: 20000 },
    ],
  };
  const result = buildModelTierLayer(extraCache, modelTaxonomy, '无人机', '2026-W27', null);
  const ungrouped = result.find((r) => r.modelTier === '未分组');
  assert.ok(ungrouped != null);
  assert.equal(ungrouped.cur.gmv, 20000);
});

test('buildAllModelTierLayers：3 品类全部返回', () => {
  const categories = ['无人机', '台球杆', '显卡'];
  const result = buildAllModelTierLayers(modelCache, modelTaxonomy, categories, '2026-W27', '2026-W26');
  assert.equal(Object.keys(result).length, 3);
  assert.ok(result['无人机'].length > 0);
  assert.ok(result['台球杆'].length > 0);
  assert.ok(result['显卡'].length > 0);
});

test('buildAllModelTierLayers：显卡分为 高端/中端', () => {
  const result = buildAllModelTierLayers(modelCache, modelTaxonomy, ['显卡'], '2026-W27', '2026-W26');
  const tiers = result['显卡'].map((r) => r.modelTier).sort();
  assert.deepEqual(tiers, ['中端', '高端']);
});

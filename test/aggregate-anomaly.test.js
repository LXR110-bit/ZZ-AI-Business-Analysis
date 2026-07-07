'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectAnomalyModels, detectAllAnomalies, DEFAULT_THRESHOLDS } = require('../src/aggregate/anomaly');

// 构造可控的 fixture：品类 "测试品类" 含 3 机型
const modelCache = {
  rows: [
    // W26
    { week: '2026-W26', category: '测试品类', modelName: 'A', jkuv: 500, evaUv: 250, evaCnt: 250, orderUv: 50, orderCnt: 50, shipCnt: 50, signCnt: 45, qcCnt: 40, dealCnt: 25, returnCnt: 2, gmv: 200000 },
    { week: '2026-W26', category: '测试品类', modelName: 'B', jkuv: 300, evaUv: 150, evaCnt: 150, orderUv: 30, orderCnt: 30, shipCnt: 30, signCnt: 27, qcCnt: 24, dealCnt: 15, returnCnt: 1, gmv: 300000 },
    { week: '2026-W26', category: '测试品类', modelName: 'C', jkuv: 200, evaUv: 100, evaCnt: 100, orderUv: 20, orderCnt: 20, shipCnt: 20, signCnt: 18, qcCnt: 16, dealCnt: 10, returnCnt: 1, gmv: 10000 },
    // W27: A 涨 60% (+120000), B 跌 33% (-100000), C 涨很多但占比太小
    { week: '2026-W27', category: '测试品类', modelName: 'A', jkuv: 600, evaUv: 300, evaCnt: 300, orderUv: 60, orderCnt: 60, shipCnt: 60, signCnt: 54, qcCnt: 48, dealCnt: 30, returnCnt: 3, gmv: 320000 },
    { week: '2026-W27', category: '测试品类', modelName: 'B', jkuv: 200, evaUv: 100, evaCnt: 100, orderUv: 20, orderCnt: 20, shipCnt: 20, signCnt: 18, qcCnt: 16, dealCnt: 10, returnCnt: 1, gmv: 200000 },
    { week: '2026-W27', category: '测试品类', modelName: 'C', jkuv: 50, evaUv: 25, evaCnt: 25, orderUv: 5, orderCnt: 5, shipCnt: 5, signCnt: 4, qcCnt: 3, dealCnt: 2, returnCnt: 0, gmv: 30000 },
  ],
};

// 降低阈值便于测试触发
const lowThresholds = { minGmvShare: 0.05, minAbsGmvDelta: 50000, minPctGmvDelta: 0.20 };

test('双条件满足 → 检出异动', () => {
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', lowThresholds);
  // A: abs=120000 ≥ 50000, pct=0.6 ≥ 0.20 → 检出
  // B: abs=-100000 ≥ 50000, pct=-0.333 ≥ 0.20 → 检出
  assert.equal(result.length, 2);
});

test('结果按 |absChange| 降序排列', () => {
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', lowThresholds);
  // A: |120000|, B: |100000|
  assert.equal(result[0].modelName, 'A');
  assert.equal(result[1].modelName, 'B');
});

test('direction 字段正确', () => {
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', lowThresholds);
  const a = result.find((r) => r.modelName === 'A');
  const b = result.find((r) => r.modelName === 'B');
  assert.equal(a.direction, 'up');
  assert.equal(b.direction, 'down');
});

test('absChange 和 pctChange 数值正确', () => {
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', lowThresholds);
  const a = result.find((r) => r.modelName === 'A');
  assert.equal(a.curGmv, 320000);
  assert.equal(a.prevGmv, 200000);
  assert.equal(a.absChange, 120000);
  assert.ok(Math.abs(a.pctChange - 0.6) < 1e-10);
});

test('占比过滤：C 占比 < 5% 不触发（即使环比大）', () => {
  // C: W27 gmv=30000, total=550000, share=5.45%... 刚超 5%
  // 提高 minGmvShare 到 10% 来验证过滤
  const strictShare = { ...lowThresholds, minGmvShare: 0.10 };
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', strictShare);
  const c = result.find((r) => r.modelName === 'C');
  assert.equal(c, undefined);
});

test('绝对值不满足 → 不触发', () => {
  const highAbs = { ...lowThresholds, minAbsGmvDelta: 200000 };
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', highAbs);
  // A: 120000 < 200000, B: 100000 < 200000
  assert.equal(result.length, 0);
});

test('百分比不满足 → 不触发', () => {
  const highPct = { ...lowThresholds, minPctGmvDelta: 0.70 };
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', highPct);
  // A: 0.6 < 0.70, B: 0.333 < 0.70
  assert.equal(result.length, 0);
});

test('prevWeek 为 null → 返回空数组', () => {
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', null, lowThresholds);
  assert.deepEqual(result, []);
});

test('modelCache 为 null → 返回空数组', () => {
  const result = detectAnomalyModels(null, '测试品类', '2026-W27', '2026-W26', lowThresholds);
  assert.deepEqual(result, []);
});

test('cur 包含完整漏斗字段', () => {
  const result = detectAnomalyModels(modelCache, '测试品类', '2026-W27', '2026-W26', lowThresholds);
  const a = result[0];
  assert.ok('jkuv' in a.cur);
  assert.ok('evaRate' in a.cur);
  assert.ok('orderRate' in a.cur);
  assert.ok('gmv' in a.cur);
});

test('detectAllAnomalies：多品类批量检测', () => {
  const result = detectAllAnomalies(modelCache, ['测试品类', '不存在品类'], '2026-W27', '2026-W26', lowThresholds);
  assert.equal(Object.keys(result).length, 2);
  assert.ok(result['测试品类'].length > 0);
  assert.deepEqual(result['不存在品类'], []);
});

test('DEFAULT_THRESHOLDS 导出值合理', () => {
  assert.equal(DEFAULT_THRESHOLDS.minGmvShare, 0.05);
  assert.equal(DEFAULT_THRESHOLDS.minAbsGmvDelta, 50000);
  assert.equal(DEFAULT_THRESHOLDS.minPctGmvDelta, 0.20);
});

'use strict';

/**
 * Level 5：机型分层漏斗。
 *
 * 在品类内按用户定义的 modelTier 标签分组，求和漏斗指标。
 */

const { sumCounts, calcRates, calcDelta } = require('./funnel');

/**
 * 为单个品类构建机型分层数据。
 * @param {{rows:Array}} modelCache  含 modelName 的行级缓存
 * @param {{rows:Array<{category,modelName,modelTier}>}} modelTaxonomy
 * @param {string} category
 * @param {string} week
 * @param {string|null} prevWeek
 * @returns {Array<{modelTier:string, cur:Record, delta:Record|null}>}
 */
function buildModelTierLayer(modelCache, modelTaxonomy, category, week, prevWeek) {
  if (!modelCache || !modelCache.rows) return [];

  // 建立 category|modelName → modelTier 映射
  const tierMap = {};
  if (modelTaxonomy && modelTaxonomy.rows) {
    for (const row of modelTaxonomy.rows) {
      if (row.category === category) {
        tierMap[row.modelName] = row.modelTier;
      }
    }
  }

  // 按 modelTier 分组当周行
  const curRows = modelCache.rows.filter((r) => r.category === category && r.week === week);
  const curGroups = groupByTier(curRows, tierMap);

  // 按 modelTier 分组上周行
  let prevGroups = null;
  if (prevWeek) {
    const prevRows = modelCache.rows.filter((r) => r.category === category && r.week === prevWeek);
    if (prevRows.length > 0) {
      prevGroups = groupByTier(prevRows, tierMap);
    }
  }

  // 汇总每个 tier
  const tiers = [...new Set(Object.keys(curGroups).concat(prevGroups ? Object.keys(prevGroups) : []))];
  tiers.sort();

  return tiers.map((tier) => {
    const curSums = curGroups[tier] ? sumCounts(curGroups[tier]) : null;
    const curRates = curSums ? calcRates(curSums) : null;
    const cur = curSums ? { ...curSums, ...curRates } : null;

    let delta = null;
    if (prevGroups && prevGroups[tier]) {
      const prevSums = sumCounts(prevGroups[tier]);
      const prevRates = calcRates(prevSums);
      if (curRates) {
        delta = calcDelta(curRates, prevRates);
      }
    }

    return { modelTier: tier, cur, delta };
  });
}

/**
 * 为所有品类构建机型分层数据。
 * @param {{rows:Array}} modelCache
 * @param {{rows:Array}} modelTaxonomy
 * @param {string[]} categories  品类名列表
 * @param {string} week
 * @param {string|null} prevWeek
 * @returns {Object<string, Array<{modelTier, cur, delta}>>}
 */
function buildAllModelTierLayers(modelCache, modelTaxonomy, categories, week, prevWeek) {
  const result = {};
  for (const cat of categories) {
    result[cat] = buildModelTierLayer(modelCache, modelTaxonomy, cat, week, prevWeek);
  }
  return result;
}

/**
 * 内部：按 modelTier 分组行。
 */
function groupByTier(rows, tierMap) {
  const groups = {};
  for (const row of rows) {
    const tier = tierMap[row.modelName] || '未分组';
    if (!groups[tier]) groups[tier] = [];
    groups[tier].push(row);
  }
  return groups;
}

module.exports = { buildModelTierLayer, buildAllModelTierLayers };

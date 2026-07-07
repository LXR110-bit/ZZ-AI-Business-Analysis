'use strict';

/**
 * Level 6：异动机型检测。
 *
 * 在品类内检测 GMV 绝对变化 + 环比百分比 同时超阈值的机型。
 */

const { sumCounts, calcRates } = require('./funnel');

const DEFAULT_THRESHOLDS = {
  minGmvShare: 0.05,       // 品类内 GMV 占比 < 5% 跳过
  minAbsGmvDelta: 50000,   // 绝对值变化 < 5W 跳过
  minPctGmvDelta: 0.20,    // 环比 < 20% 跳过
};

/**
 * 检测单品类内的异动机型。
 * @param {{rows:Array}} modelCache
 * @param {string} category
 * @param {string} week
 * @param {string|null} prevWeek
 * @param {object} [thresholds]
 * @returns {Array<{category, modelName, curGmv, prevGmv, absChange, pctChange, direction, cur}>}
 */
function detectAnomalyModels(modelCache, category, week, prevWeek, thresholds) {
  if (!modelCache || !modelCache.rows || !prevWeek) return [];

  const opts = { ...DEFAULT_THRESHOLDS, ...thresholds };

  const curRows = modelCache.rows.filter((r) => r.category === category && r.week === week);
  const prevRows = modelCache.rows.filter((r) => r.category === category && r.week === prevWeek);

  if (curRows.length === 0 || prevRows.length === 0) return [];

  // 品类当周总 GMV（用于计算占比）
  const totalGmv = curRows.reduce((s, r) => s + (Number(r.gmv) || 0), 0);
  if (totalGmv === 0) return [];

  // 上周按 modelName 索引
  const prevMap = {};
  for (const row of prevRows) {
    prevMap[row.modelName] = row;
  }

  const anomalies = [];

  for (const row of curRows) {
    const curGmv = Number(row.gmv) || 0;
    const share = curGmv / totalGmv;

    // 占比过滤
    if (share < opts.minGmvShare) continue;

    const prev = prevMap[row.modelName];
    if (!prev) continue; // 新机型无法计算环比，跳过

    const prevGmv = Number(prev.gmv) || 0;
    const absChange = curGmv - prevGmv;
    const pctChange = prevGmv === 0 ? null : absChange / prevGmv;

    if (pctChange == null) continue;

    // 双条件：绝对值 AND 百分比 同时满足
    if (Math.abs(absChange) >= opts.minAbsGmvDelta && Math.abs(pctChange) >= opts.minPctGmvDelta) {
      const curSums = sumCounts([row]);
      const curRates = calcRates(curSums);
      anomalies.push({
        category,
        modelName: row.modelName,
        curGmv,
        prevGmv,
        absChange,
        pctChange,
        direction: absChange > 0 ? 'up' : 'down',
        cur: { ...curSums, ...curRates },
      });
    }
  }

  // 按 |absChange| 降序
  anomalies.sort((a, b) => Math.abs(b.absChange) - Math.abs(a.absChange));

  return anomalies;
}

/**
 * 检测所有品类的异动机型。
 * @param {{rows:Array}} modelCache
 * @param {string[]} categories
 * @param {string} week
 * @param {string|null} prevWeek
 * @param {object} [thresholds]
 * @returns {Object<string, Array>}
 */
function detectAllAnomalies(modelCache, categories, week, prevWeek, thresholds) {
  const result = {};
  for (const cat of categories) {
    result[cat] = detectAnomalyModels(modelCache, cat, week, prevWeek, thresholds);
  }
  return result;
}

module.exports = { detectAnomalyModels, detectAllAnomalies, DEFAULT_THRESHOLDS };

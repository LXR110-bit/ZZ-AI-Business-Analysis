'use strict';

const { buildCategoryLayer } = require('./category');
const { buildTierLayer } = require('./tier');
const { buildBoardLayer } = require('./board');

/**
 * 四层聚合整合入口。
 *
 * @param {object} opts
 * @param {{rows:Array}} opts.categoryCache  品类漏斗缓存
 * @param {{rows:Array}} opts.taxonomy       品类分层映射
 * @param {string} opts.week                 当周标识
 * @param {string|null} opts.prevWeek        上周标识
 * @param {{rows:Array<{week:string,gmv:number}>}|null} [opts.boardBenchmark]  可选对账基准
 * @returns {{board, tiers, categories}}
 */
function buildFourLayerPayload({ categoryCache, taxonomy, week, prevWeek, boardBenchmark }) {
  // 品类层
  const categoriesCur = buildCategoryLayer(categoryCache, taxonomy, week, prevWeek);
  const categoriesPrev = prevWeek
    ? buildCategoryLayer(categoryCache, taxonomy, prevWeek, null)
    : null;

  // tier 层
  const tiers = buildTierLayer(categoriesCur, categoriesPrev);

  // 大盘层
  const board = buildBoardLayer(categoriesCur, categoriesPrev, boardBenchmark || null, week);

  return { board, tiers, categories: categoriesCur };
}

module.exports = { buildFourLayerPayload };

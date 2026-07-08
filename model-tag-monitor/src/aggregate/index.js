'use strict';

const { buildCategoryLayer } = require('./category');
const { buildTierLayer } = require('./tier');
const { buildBoardLayer } = require('./board');
const { buildBoardPenetrationLayer } = require('./board-penetration');
const { buildModelTierLayer } = require('./model');
const { detectAnomalyModels } = require('./anomaly');

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

/**
 * 六层聚合整合入口。
 *
 * Level 1: 大盘渗透层 (board-penetration)
 * Level 2: 大盘漏斗层 (board)
 * Level 3: Tier 聚合层 (tier)
 * Level 4: 品类漏斗层 (category)
 * Level 5: 机型分层层 (model)
 * Level 6: 异动检测层 (anomaly)
 *
 * @param {object} opts
 * @param {{rows:Array}} opts.categoryCache      品类漏斗缓存
 * @param {{rows:Array}} opts.taxonomy           品类分层映射
 * @param {string} opts.week                     当周标识
 * @param {string|null} opts.prevWeek            上周标识
 * @param {{rows:Array<{week:string,gmv:number}>}|null} [opts.boardBenchmark]
 * @param {{rows:Array}|null} [opts.boardMetrics]       大盘 DAU 等
 * @param {{rows:Array}|null} [opts.modelCache]         机型漏斗缓存
 * @param {{rows:Array}|null} [opts.modelTaxonomy]      机型分层映射
 * @param {object} [opts.anomalyThresholds]             异动检测阈值
 * @returns {{penetration, board, tiers, categories, models, anomalies}}
 */
function buildSixLayerPayload({
  categoryCache, taxonomy, week, prevWeek,
  boardBenchmark, boardMetrics, modelCache, modelTaxonomy, anomalyThresholds,
}) {
  // Level 4: 品类层
  const categoriesCur = buildCategoryLayer(categoryCache, taxonomy, week, prevWeek);
  const categoriesPrev = prevWeek
    ? buildCategoryLayer(categoryCache, taxonomy, prevWeek, null)
    : null;

  // Level 3: Tier 层
  const tiers = buildTierLayer(categoriesCur, categoriesPrev);

  // Level 2: 大盘漏斗层
  const board = buildBoardLayer(categoriesCur, categoriesPrev, boardBenchmark || null, week);

  // Level 1: 大盘渗透层
  const penetration = buildBoardPenetrationLayer(
    boardMetrics || null, week, prevWeek, board.cur
  );

  // Level 5 & 6: 机型层 & 异动层
  const onlineCategories = categoriesCur
    .filter((c) => c.status !== '已下线')
    .map((c) => c.category);

  const models = {};
  const anomalies = {};
  for (const cat of onlineCategories) {
    models[cat] = buildModelTierLayer(modelCache || null, modelTaxonomy || null, cat, week, prevWeek);
    anomalies[cat] = detectAnomalyModels(modelCache || null, cat, week, prevWeek, anomalyThresholds);
  }

  return { penetration, board, tiers, categories: categoriesCur, models, anomalies };
}

module.exports = { buildFourLayerPayload, buildSixLayerPayload };

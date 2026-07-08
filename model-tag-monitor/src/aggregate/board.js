'use strict';

const { sumCounts, calcRates, calcDelta } = require('./funnel');

const RECONCILIATION_THRESHOLD = 0.05;

/**
 * 大盘层聚合：所有品类求和重算（与 tier 层对称但不分组）。
 * 已下线品类：cur 含全部，delta 排除已下线后求和再算环比。
 * 可选对账：如果传入 benchmark 且当周有对应行，则与品类求和 GMV 比对。
 *
 * @param {Array} categories  buildCategoryLayer 当周输出
 * @param {Array|null} categoriesPrev  buildCategoryLayer 上周输出
 * @param {{rows:Array<{week:string,gmv:number}>}|null} boardBenchmark  可选对账基准
 * @param {string} week  当周标识（用于定位 benchmark 行）
 * @returns {{cur, delta, reconciliation}}
 */
function buildBoardLayer(categories, categoriesPrev, boardBenchmark, week) {
  const cats = categories || [];

  // cur：全量（含已下线）
  const allCurRows = cats.map((c) => c.cur);
  const curSums = sumCounts(allCurRows);
  const cur = { ...curSums, ...calcRates(curSums) };

  // delta：排除已下线
  let delta = { evaRate: null, orderRate: null, shipRate: null, dealRate: null };
  if (categoriesPrev) {
    const activeCur = cats.filter((c) => c.status !== '已下线').map((c) => c.cur);
    const activeCurSums = sumCounts(activeCur);
    const activeCurRates = calcRates(activeCurSums);
    const activePrev = categoriesPrev.filter((c) => c.status !== '已下线').map((c) => c.cur);
    const activePrevSums = sumCounts(activePrev);
    const activePrevRates = calcRates(activePrevSums);
    delta = calcDelta(activeCurRates, activePrevRates);
  }

  // reconciliation
  const computedGmv = cur.gmv || 0;
  const benchmarkRow = boardBenchmark && week
    ? (boardBenchmark.rows || []).find((r) => r.week === week)
    : null;
  const benchmarkAvailable = benchmarkRow != null;
  const benchmarkGmv = benchmarkAvailable ? benchmarkRow.gmv : null;
  let diffPct = null;
  let alert = false;
  if (benchmarkAvailable && benchmarkGmv !== 0) {
    diffPct = (computedGmv - benchmarkGmv) / benchmarkGmv;
    alert = Math.abs(diffPct) > RECONCILIATION_THRESHOLD;
  }

  return { cur, delta, reconciliation: { benchmarkAvailable, benchmarkGmv, computedGmv, diffPct, alert } };
}

module.exports = { buildBoardLayer, RECONCILIATION_THRESHOLD };

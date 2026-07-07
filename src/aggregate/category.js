'use strict';

const { calcRates, calcDelta } = require('./funnel');

/**
 * 品类层聚合：从 category-cache + taxonomy 构建每个品类的 cur/delta。
 *
 * cur：直接读 category-cache 当周行的 11 计数字段，转化率重新用 calcRates 计算
 *     （而非直接读 cache 里的 evaRate 等字段，保证与 tier/board 层用同一套公式）。
 * delta：已下线品类不算环比（返回 null）；在售品类用当周/上周转化率算环比。
 *
 * @param {{rows:Array}} categoryCache
 * @param {{rows:Array}} taxonomy
 * @param {string} week 当周
 * @param {string|null} prevWeek 上周，null 表示没有上周数据
 * @returns {Array<{category,tier,board,status,confidence,lastWeekGmv,cur,delta}>}
 */
function buildCategoryLayer(categoryCache, taxonomy, week, prevWeek) {
  const cacheRows = (categoryCache && categoryCache.rows) || [];
  const taxRows = (taxonomy && taxonomy.rows) || [];

  return taxRows.map((tax) => {
    const curRow = cacheRows.find((r) => r.week === week && r.category === tax.category);
    const prevRow = prevWeek ? cacheRows.find((r) => r.week === prevWeek && r.category === tax.category) : null;

    const cur = buildCur(curRow);
    const delta = buildDelta(cur, prevRow, tax.status);

    return {
      category: tax.category,
      tier: tax.tier,
      board: tax.board,
      status: tax.status,
      confidence: tax.confidence,
      lastWeekGmv: tax.lastWeekGmv,
      cur,
      delta,
    };
  });
}

const COUNT_KEYS = ['jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv'];

function buildCur(row) {
  if (!row) {
    const out = {};
    for (const k of COUNT_KEYS) out[k] = null;
    return { ...out, evaRate: null, orderRate: null, shipRate: null, dealRate: null };
  }
  const counts = {};
  for (const k of COUNT_KEYS) counts[k] = row[k] === undefined ? null : row[k];
  const rates = calcRates(counts);
  return { ...counts, ...rates };
}

function buildDelta(cur, prevRow, status) {
  if (status === '已下线') return null;
  if (!prevRow) return null;
  const prevCounts = {};
  for (const k of COUNT_KEYS) prevCounts[k] = prevRow[k] === undefined ? null : prevRow[k];
  const prevRates = calcRates(prevCounts);
  const curRates = { evaRate: cur.evaRate, orderRate: cur.orderRate, shipRate: cur.shipRate, dealRate: cur.dealRate };
  return calcDelta(curRates, prevRates);
}

module.exports = { buildCategoryLayer };

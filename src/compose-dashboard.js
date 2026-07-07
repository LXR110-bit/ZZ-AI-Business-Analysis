'use strict';

const { buildSixLayerPayload } = require('./aggregate/index');
const { buildCategoryLayer } = require('./aggregate/category');
const { sumCounts, calcRates } = require('./aggregate/funnel');
const { isoWeekToRangeStr } = require('./week-utils');

const RATE_KEYS = ['evaRate', 'orderRate', 'shipRate', 'dealRate'];

/**
 * 精简输出层：将六层聚合结果转换为前端 dashboard 契约格式。
 *
 * delta 定义：当周值 - 上周值（绝对差），非百分比变化率。
 * anomalyScore：4 个 rate 中下降超 5 百分点的个数，cap 3。
 *
 * @param {object} opts  同 buildSixLayerPayload 参数
 * @returns {object} 前端契约 JSON
 */
function composeDashboard(opts) {
  const { categoryCache, taxonomy, week, prevWeek } = opts;

  // 六层聚合
  const payload = buildSixLayerPayload(opts);

  // 上周品类层（用于算绝对差 delta）
  const categoriesPrev = prevWeek
    ? buildCategoryLayer(categoryCache, taxonomy, prevWeek, null)
    : null;

  // --- board ---
  const boardCur = slimCur(payload.board.cur);
  const boardDelta = calcAbsDeltaFromCategories(payload.categories, categoriesPrev, null);

  // --- tiers ---
  const tiers = composeTiers(payload.tiers, payload.categories, categoriesPrev);

  // --- categories ---
  const categories = composeCategories(payload.categories, categoriesPrev);

  return {
    week,
    weekRange: isoWeekToRangeStr(week),
    syncedAt: (categoryCache && categoryCache.syncedAt) || null,
    board: { cur: boardCur, delta: boardDelta },
    tiers,
    categories,
    reconciliation: payload.board.reconciliation,
  };
}

// ─── helpers ───────────────────────────────────────────────────────

/**
 * 精简 cur：只保留 gmv + 4 rates。
 */
function slimCur(cur) {
  if (!cur) return { gmv: null, evaRate: null, orderRate: null, shipRate: null, dealRate: null };
  return {
    gmv: cur.gmv ?? null,
    evaRate: cur.evaRate ?? null,
    orderRate: cur.orderRate ?? null,
    shipRate: cur.shipRate ?? null,
    dealRate: cur.dealRate ?? null,
  };
}

/**
 * 计算绝对差 delta（当周 - 上周）。
 * @param {Array} curCategories 当周品类列表（用于筛选范围）
 * @param {Array|null} prevCategories 上周品类列表
 * @param {string|null} filterTier 若非 null，只取该 tier 的品类
 */
function calcAbsDeltaFromCategories(curCategories, prevCategories, filterTier) {
  if (!prevCategories) return { gmv: null, evaRate: null, orderRate: null, shipRate: null, dealRate: null };

  // 筛选在售品类
  const curOnline = curCategories.filter((c) => c.status !== '已下线' && (!filterTier || c.tier === filterTier));
  const prevMap = {};
  for (const c of prevCategories) prevMap[c.category] = c;

  // 当周求和
  const curCounts = sumFromCategories(curOnline);
  const curRates = calcRates(curCounts);

  // 上周对应品类求和
  const prevOnline = curOnline
    .map((c) => prevMap[c.category])
    .filter(Boolean);
  const prevCounts = sumFromCategories(prevOnline);
  const prevRates = calcRates(prevCounts);

  // 绝对差
  const delta = { gmv: curCounts.gmv - prevCounts.gmv };
  for (const k of RATE_KEYS) {
    if (curRates[k] == null || prevRates[k] == null) {
      delta[k] = null;
    } else {
      delta[k] = curRates[k] - prevRates[k];
    }
  }
  return delta;
}

/**
 * 从品类列表的 cur 求和计数字段。
 */
function sumFromCategories(categories) {
  const COUNT_KEYS = ['jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv'];
  const sums = {};
  for (const k of COUNT_KEYS) sums[k] = 0;
  for (const c of categories) {
    if (!c.cur) continue;
    for (const k of COUNT_KEYS) sums[k] += (c.cur[k] || 0);
  }
  return sums;
}

/**
 * 组装 tiers 精简输出。
 */
function composeTiers(rawTiers, curCategories, prevCategories) {
  return rawTiers.map((t) => {
    const categoryCount = curCategories.filter((c) => c.tier === t.tier && c.status !== '已下线').length;
    const cur = slimCur(t.cur);
    const delta = calcAbsDeltaFromCategories(curCategories, prevCategories, t.tier);
    return { tier: t.tier, cur: { ...cur, categoryCount }, delta };
  });
}

/**
 * 组装 categories 精简输出 + anomalyScore。
 */
function composeCategories(curCategories, prevCategories) {
  const prevMap = {};
  if (prevCategories) {
    for (const c of prevCategories) prevMap[c.category] = c;
  }

  return curCategories.map((c) => {
    const cur = slimCur(c.cur);
    let delta = null;
    let anomalyScore = 0;

    if (c.status !== '已下线' && prevCategories) {
      const prev = prevMap[c.category];
      if (prev && prev.cur) {
        const prevRates = {
          evaRate: prev.cur.evaRate,
          orderRate: prev.cur.orderRate,
          shipRate: prev.cur.shipRate,
          dealRate: prev.cur.dealRate,
        };
        delta = { gmv: (c.cur.gmv || 0) - (prev.cur.gmv || 0) };
        for (const k of RATE_KEYS) {
          if (c.cur[k] == null || prevRates[k] == null) {
            delta[k] = null;
          } else {
            delta[k] = c.cur[k] - prevRates[k];
          }
        }
        // anomalyScore: 下降超 5 百分点 → +1，cap 3
        anomalyScore = calcAnomalyScore(delta);
      } else {
        delta = { gmv: null, evaRate: null, orderRate: null, shipRate: null, dealRate: null };
      }
    }

    return {
      category: c.category,
      tier: c.tier,
      board: c.board,
      status: c.status,
      cur,
      delta,
      anomalyScore,
    };
  });
}

/**
 * anomalyScore：4 个 rate delta 中，<= -0.05 的个数，cap 3。
 */
function calcAnomalyScore(delta) {
  if (!delta) return 0;
  let score = 0;
  for (const k of RATE_KEYS) {
    if (delta[k] != null && delta[k] <= -0.05) {
      score++;
    }
  }
  return Math.min(score, 3);
}

module.exports = { composeDashboard };

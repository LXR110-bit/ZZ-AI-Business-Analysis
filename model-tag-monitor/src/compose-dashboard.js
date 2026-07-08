'use strict';

const { buildSixLayerPayload } = require('./aggregate/index');
const { buildCategoryLayer } = require('./aggregate/category');
const { COUNT_KEYS, calcRates } = require('./aggregate/funnel');
const { isoWeekToRangeStr } = require('./week-utils');

const RATE_KEYS = ['evaRate', 'orderRate', 'shipRate', 'dealRate'];
const TREND_KEYS = ['conditionUv', 'jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv'];

/**
 * 将六层聚合结果转换为前端 dashboard v2 契约。
 * v1.4.0 约定：
 * - rate delta 为百分点绝对差；
 * - count/GMV 趋势统一放到 trend[key].deltaPct；
 * - 同时保留 v1 dashboard 常用字段，避免旧入口完全断裂。
 */
function composeDashboard(opts) {
  const { categoryCache, taxonomy, week, prevWeek } = opts;
  const weeks = getWeeks(categoryCache);
  const payload = buildSixLayerPayload(opts);
  const categoriesPrev = prevWeek
    ? buildCategoryLayer(categoryCache, taxonomy, prevWeek, null)
    : null;

  const boardCur = slimCur(payload.board.cur);
  const boardDelta = calcAbsDeltaFromCategories(payload.categories, categoriesPrev, null);
  const categories = composeCategories(payload.categories, categoriesPrev);
  const tiers = composeTiers(payload.tiers, payload.categories, categoriesPrev, categories);
  const board = { cur: boardCur, delta: boardDelta };
  const kpiCards = buildKpiCards(board, payload.penetration);

  const result = {
    version: '1.4.0',
    week,
    prevWeek: prevWeek || null,
    weeks,
    weekWindow: weeks,
    weekRange: safeWeekRange(week),
    syncedAt: (categoryCache && categoryCache.syncedAt) || null,
    source: (categoryCache && categoryCache.source) || null,
    board,
    kpiCards,
    penetration: payload.penetration,
    tiers,
    categories,
    insights: buildInsights({ week, prevWeek, board, tiers, categories }),
    reconciliation: payload.board.reconciliation,
  };

  return attachV1Compatibility(result, categories, categoryCache);
}

function getWeeks(categoryCache) {
  const explicit = categoryCache && Array.isArray(categoryCache.weeks) ? categoryCache.weeks : null;
  if (explicit && explicit.length) return explicit.slice().sort();
  return [...new Set(((categoryCache && categoryCache.rows) || []).map((r) => r.week).filter(Boolean))].sort();
}

function safeWeekRange(week) {
  try { return isoWeekToRangeStr(week); } catch (e) { return ''; }
}

function slimCur(cur) {
  const out = {};
  for (const k of COUNT_KEYS) out[k] = cur ? (cur[k] ?? null) : null;
  if ((out.conditionUv == null || out.conditionUv === 0) && out.jkuv != null) out.conditionUv = out.jkuv;
  for (const k of RATE_KEYS) out[k] = cur ? (cur[k] ?? null) : null;
  return out;
}

function calcAbsDeltaFromCategories(curCategories, prevCategories, filterTier) {
  if (!prevCategories) return { gmv: null, evaRate: null, orderRate: null, shipRate: null, dealRate: null };

  const curOnline = curCategories.filter((c) => c.status !== '已下线' && (!filterTier || c.tier === filterTier));
  const prevMap = {};
  for (const c of prevCategories) prevMap[c.category] = c;

  const curCounts = sumFromCategories(curOnline);
  const curRates = calcRates(curCounts);
  const prevOnline = curOnline.map((c) => prevMap[c.category]).filter(Boolean);
  const prevCounts = sumFromCategories(prevOnline);
  const prevRates = calcRates(prevCounts);

  const delta = { gmv: curCounts.gmv - prevCounts.gmv };
  for (const k of TREND_KEYS) {
    if (k !== 'gmv') delta[k] = (curCounts[k] || 0) - (prevCounts[k] || 0);
  }
  for (const k of RATE_KEYS) {
    delta[k] = curRates[k] == null || prevRates[k] == null ? null : curRates[k] - prevRates[k];
  }
  return delta;
}

function sumFromCategories(categories) {
  const sums = {};
  for (const k of COUNT_KEYS) sums[k] = 0;
  for (const c of categories) {
    if (!c.cur) continue;
    for (const k of COUNT_KEYS) sums[k] += Number(c.cur[k]) || 0;
  }
  if (!sums.conditionUv && sums.jkuv) sums.conditionUv = sums.jkuv;
  return sums;
}

function composeTiers(rawTiers, curCategories, prevCategories, composedCategories) {
  return rawTiers.map((t) => {
    const categoryCount = curCategories.filter((c) => c.tier === t.tier && c.status !== '已下线').length;
    const cur = slimCur(t.cur);
    const delta = calcAbsDeltaFromCategories(curCategories, prevCategories, t.tier);
    const trend = aggregateTrend(composedCategories.filter((c) => c.tier === t.tier));
    return { tier: t.tier, cur: { ...cur, categoryCount }, delta, trend };
  });
}

function composeCategories(curCategories, prevCategories) {
  const prevMap = {};
  if (prevCategories) for (const c of prevCategories) prevMap[c.category] = c;

  return curCategories.map((c) => {
    const cur = slimCur(c.cur);
    let delta = null;
    let anomalyScore = 0;
    let trend = buildTrend(cur, null);

    if (c.status !== '已下线' && prevCategories) {
      const prev = prevMap[c.category];
      if (prev && prev.cur) {
        const prevCur = slimCur(prev.cur);
        delta = { gmv: (cur.gmv || 0) - (prevCur.gmv || 0) };
        for (const k of RATE_KEYS) delta[k] = cur[k] == null || prevCur[k] == null ? null : cur[k] - prevCur[k];
        anomalyScore = calcAnomalyScore(delta);
        trend = buildTrend(cur, prevCur);
      } else {
        delta = { gmv: null, evaRate: null, orderRate: null, shipRate: null, dealRate: null };
      }
    }

    return {
      category: c.category,
      tier: c.tier,
      board: c.board,
      secondaryCategory: c.board,
      status: c.status,
      confidence: c.confidence,
      lastWeekGmv: c.lastWeekGmv,
      cur,
      delta,
      trend,
      anomalyScore,
    };
  });
}

function buildTrend(cur, prev) {
  const out = {};
  for (const k of TREND_KEYS) {
    const c = cur ? numberOrNull(k === 'conditionUv' && cur[k] == null ? cur.jkuv : cur[k]) : null;
    const p = prev ? numberOrNull(k === 'conditionUv' && prev[k] == null ? prev.jkuv : prev[k]) : null;
    const delta = c == null || p == null ? null : c - p;
    const deltaPct = delta == null || !p ? null : delta / p;
    out[k] = { cur: c, prev: p, delta, deltaPct, direction: delta == null ? null : (delta >= 0 ? 'up' : 'down') };
  }
  return out;
}

function aggregateTrend(categories) {
  const sums = {};
  for (const key of TREND_KEYS) sums[key] = { cur: 0, prev: 0, hasPrev: false, hasCur: false };
  for (const c of categories) {
    for (const key of TREND_KEYS) {
      const item = c.trend && c.trend[key];
      if (!item) continue;
      if (item.cur != null) { sums[key].cur += Number(item.cur) || 0; sums[key].hasCur = true; }
      if (item.prev != null) { sums[key].prev += Number(item.prev) || 0; sums[key].hasPrev = true; }
    }
  }
  const out = {};
  for (const key of TREND_KEYS) {
    const s = sums[key];
    const cur = s.hasCur ? s.cur : null;
    const prev = s.hasPrev ? s.prev : null;
    const delta = cur == null || prev == null ? null : cur - prev;
    out[key] = { cur, prev, delta, deltaPct: delta == null || !prev ? null : delta / prev, direction: delta == null ? null : (delta >= 0 ? 'up' : 'down') };
  }
  return out;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function calcAnomalyScore(delta) {
  if (!delta) return 0;
  let score = 0;
  for (const k of RATE_KEYS) if (delta[k] != null && delta[k] <= -0.05) score++;
  return Math.min(score, 3);
}

function pctDelta(cur, prev) {
  if (cur == null || prev == null || prev === 0) return null;
  return (cur - prev) / prev;
}

function buildKpiCards(board, penetration) {
  const cur = board.cur || {};
  const p = penetration || {};
  const d = p.delta || {};
  const avgPrice = cur.dealCnt > 0 ? cur.gmv / cur.dealCnt : null;
  const prevGmv = cur.gmv != null && board.delta && board.delta.gmv != null ? cur.gmv - board.delta.gmv : null;
  const prevDeal = trendPrevFromDelta(cur.dealCnt, board, 'dealCnt');
  const prevAvgPrice = prevGmv != null && prevDeal > 0 ? prevGmv / prevDeal : null;
  const supplementCards = [
    { key: 'appDau', label: 'APP DAU', value: p.appDau, delta: d.appDau ?? null, deltaPct: pctDelta(p.appDau, p.appDau != null && d.appDau != null ? p.appDau - d.appDau : null), note: 'APP 日均 DAU' },
    { key: 'recycleEntranceUv', label: '回收入口UV', value: p.recycleEntranceUv, delta: d.recycleEntranceUv ?? null, deltaPct: pctDelta(p.recycleEntranceUv, p.recycleEntranceUv != null && d.recycleEntranceUv != null ? p.recycleEntranceUv - d.recycleEntranceUv : null), note: '回收入口日均 UV' },
  ].filter((card) => hasMetricValue(card.value));

  return supplementCards.concat([
    { key: 'evaUv', label: '估价UV', value: cur.evaUv, deltaPct: trendPctFromBoard(cur.evaUv, board, 'evaUv'), note: '日切片品类维度估价UV去重汇总' },
    { key: 'shipCnt', label: '发货数', value: cur.shipCnt, deltaPct: trendPctFromBoard(cur.shipCnt, board, 'shipCnt'), note: '发货订单数日均' },
    { key: 'dealCnt', label: '成交订单', value: cur.dealCnt, deltaPct: trendPctFromBoard(cur.dealCnt, board, 'dealCnt'), note: '成交订单量日均' },
    { key: 'gmv', label: '成交GMV', value: cur.gmv, delta: board.delta && board.delta.gmv, deltaPct: pctDelta(cur.gmv, prevGmv), note: '成交订单 GMV 日均' },
    { key: 'avgPrice', label: '客单价', value: avgPrice, deltaPct: pctDelta(avgPrice, prevAvgPrice), note: '成交GMV / 成交订单量' },
  ]);
}

function hasMetricValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function trendPrevFromDelta(curValue, board, key) {
  if (!board || !board.delta || board.delta[key] == null || curValue == null) return null;
  return Number(curValue) - Number(board.delta[key]);
}

function trendPctFromBoard(curValue, board, key) {
  if (!board || !board.delta || board.delta[key] == null || curValue == null) return null;
  const prev = Number(curValue) - Number(board.delta[key]);
  return pctDelta(Number(curValue), prev);
}

function buildInsights({ week, prevWeek, board, tiers, categories }) {
  const topTier = tiers.slice().sort((a, b) => (b.cur.gmv || 0) - (a.cur.gmv || 0))[0];
  const alertCats = categories.filter((c) => (c.anomalyScore || 0) > 0).sort((a, b) => (b.anomalyScore || 0) - (a.anomalyScore || 0)).slice(0, 3);
  const gmv = board.cur && board.cur.gmv;
  return {
    board: `${week}${prevWeek ? ` 较 ${prevWeek}` : ''}：成交GMV ${formatWan(gmv)}，${topTier ? `${topTier.tier}层贡献最高` : '分层数据待补齐'}，异常品类 ${alertCats.length} 个。`,
    tiers: Object.fromEntries(tiers.map((t) => [t.tier, `${t.tier}层覆盖 ${t.cur.categoryCount || 0} 个在售品类，成交GMV ${formatWan(t.cur.gmv)}。`])),
    secondaryCategories: buildSecondaryInsightMap(categories),
    categories: buildCategoryInsightMap(categories),
    category: alertCats.length ? `重点关注：${alertCats.map((c) => c.category).join('、')}。` : '当前筛选下暂无显著异常品类。',
    monitor: alertCats.length ? `建议优先复盘 ${alertCats[0].category} 等品类的估价完成率、下单UV、发货数与成交GMV。` : '监测页本期不生成机型级 AI 分析，可继续查看结构化异动明细。',
  };
}

function buildSecondaryInsightMap(categories) {
  const groups = {};
  for (const c of categories || []) {
    if (!c || c.status === '已下线') continue;
    const secondary = c.secondaryCategory || c.board || '未归类';
    if (!groups[secondary]) groups[secondary] = [];
    groups[secondary].push(c);
  }
  const out = {};
  for (const [secondary, list] of Object.entries(groups)) {
    const gmv = list.reduce((sum, c) => sum + ((c.cur && Number(c.cur.gmv)) || 0), 0);
    const top = list.slice().sort((a, b) => ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0)).slice(0, 3).map((c) => c.category).join('、') || '待补充';
    const alert = list.filter((c) => (c.anomalyScore || 0) > 0).sort((a, b) => (b.anomalyScore || 0) - (a.anomalyScore || 0)).slice(0, 3).map((c) => c.category).join('、') || '暂无显著异常';
    out[secondary] = `${secondary}二级类目覆盖 ${list.length} 个在售品类，成交GMV ${formatWan(gmv)}；贡献品类：${top}；拖累/波动关注：${alert}。`;
  }
  return out;
}

function buildCategoryInsightMap(categories) {
  const out = {};
  for (const c of categories || []) {
    if (!c || !c.category) continue;
    const cur = c.cur || {};
    const delta = c.delta || {};
    const risk = (c.anomalyScore || 0) >= 2 ? '高' : ((c.anomalyScore || 0) === 1 ? '中' : '低');
    const orderRateDelta = delta.orderRate == null ? '待补' : `${delta.orderRate >= 0 ? '+' : ''}${(delta.orderRate * 100).toFixed(1)}pct`;
    out[c.category] = `${c.category}（${c.tier || '未分层'} / ${c.secondaryCategory || c.board || '未归类'}）成交GMV ${formatWan(cur.gmv)}，下单率变化 ${orderRateDelta}，异常风险${risk}；建议复盘估价完成、下单UV、发货与成交链路。`;
  }
  return out;
}

function mergeBusinessOverviewInsights(result, cached) {
  if (!result || !cached || typeof cached !== 'object') return result;
  if (cached.week !== result.week) return result;
  const cachedInsights = cached.insights;
  if (!cachedInsights || typeof cachedInsights !== 'object') return result;

  const warnings = Array.isArray(cached.warnings)
    ? cached.warnings.filter(Boolean).map(String)
    : [];
  const baseInsights = result.insights || {};
  const mergedInsights = {
    ...baseInsights,
    ...cachedInsights,
    secondaryCategories: {
      ...((baseInsights.secondaryCategories && typeof baseInsights.secondaryCategories === 'object') ? baseInsights.secondaryCategories : {}),
      ...((cachedInsights.secondaryCategories && typeof cachedInsights.secondaryCategories === 'object') ? cachedInsights.secondaryCategories : {}),
    },
    categories: {
      ...((baseInsights.categories && typeof baseInsights.categories === 'object') ? baseInsights.categories : {}),
      ...((cachedInsights.categories && typeof cachedInsights.categories === 'object') ? cachedInsights.categories : {}),
    },
    warnings,
    generatedAt: cached.generatedAt || null,
    generatedBy: cached.generatedBy || null,
    mode: cached.mode || 'ai',
    inputHash: cached.inputHash || null,
  };
  return {
    ...result,
    insights: mergedInsights,
  };
}

function formatWan(v) {
  const n = Number(v) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

function attachV1Compatibility(result, categories, categoryCache) {
  const rows = (categoryCache && categoryCache.rows) || [];
  const gmvTrend = result.weeks.map((w) => {
    const sum = rows.filter((r) => r.week === w).reduce((acc, r) => acc + (Number(r.gmv) || 0), 0);
    return { week: w, gmv: Math.round(sum) };
  });
  const catGmv = categories.map((c) => ({ name: c.category, count: 1, gmv: Math.round(Number(c.cur && c.cur.gmv) || 0) })).sort((a, b) => b.gmv - a.gmv);
  const gmvGrandTotal = catGmv.reduce((s, x) => s + x.gmv, 0);
  const top6 = catGmv.slice(0, 6);
  return {
    ...result,
    meta: { syncedAt: result.syncedAt, latestWeek: result.week, weekRange: result.weekRange, totalWeeks: result.weeks.length },
    kpi: { totalModels: null, totalCategories: categories.length, watchCount: categories.filter((c) => c.anomalyScore > 0).length, watchDelta: null, watchPrev: null, upCount: null, upDeltaLabel: '品类级异常预警' },
    gmvTrend,
    watchByCategory: top6,
    watchCategoryStats: { gmvGrandTotal, totalCategories: catGmv.length, top6GmvSum: top6.reduce((s, x) => s + x.gmv, 0), top6GmvPct: gmvGrandTotal > 0 ? Math.round((top6.reduce((s, x) => s + x.gmv, 0) / gmvGrandTotal) * 1000) / 10 : 0 },
    topRows: categories.filter((c) => c.anomalyScore > 0).slice(0, 10).map((c, i) => ({ rank: i + 1, modelName: c.category, category: c.board, orderRate: c.cur.orderRate, deltaRaw: c.delta && c.delta.orderRate, gmv: Math.round(Number(c.cur.gmv) || 0) })),
  };
}

module.exports = { composeDashboard, buildTrend, mergeBusinessOverviewInsights };

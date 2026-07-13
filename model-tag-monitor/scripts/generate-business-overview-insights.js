#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const store = require('../src/store');
const APP_VERSION = require('../package.json').version;

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function flag(name, envName) {
  const key = envName || name.replace(/-/g, '_').toUpperCase();
  return process.argv.includes(`--${name}`) || process.env[key] === '1';
}

const apiBase = String(arg('api-base', process.env.API_BASE || 'http://127.0.0.1:8848')).replace(/\/+$/, '');
const dashboardFile = arg('dashboard-file', process.env.BUSINESS_OVERVIEW_DASHBOARD_FILE || '');
const outName = arg('out-name', process.env.BUSINESS_OVERVIEW_CACHE_NAME || 'business-overview-insights.json');
const strategyFile = arg('strategy-file', process.env.BUSINESS_OVERVIEW_STRATEGY_FILE || '');
const timeoutMs = Number(arg('timeout-ms', process.env.BUSINESS_OVERVIEW_AI_TIMEOUT_MS || '240000'));
const aiEnabled = process.env.BUSINESS_OVERVIEW_AI_ENABLED === '1';
const allowFinalRefresh = flag('allow-final-refresh', 'BUSINESS_OVERVIEW_ALLOW_FINAL_REFRESH');
const repoRoot = path.resolve(__dirname, '..', '..');
const schemaPath = path.join(__dirname, 'business-overview-insights.schema.json');
const STRATEGY_WARNING = '未配置上周策略/预判，暂无法检核兑现';
const REQUIRED_TIERS = ['发展', '孵化', '种子'];
const COUNT_FIELDS = ['conditionUv', 'jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv'];
const RATE_FIELDS = ['evaRate', 'orderRate', 'shipRate', 'dealRate'];

const AI_METRIC_LABEL_REPLACEMENTS = [
  [/\bconditionUv\b/g, '机况UV'],
  [/\bjkuv\b/g, '机况UV'],
  [/\bevaUv\b/g, '估价UV'],
  [/\borderUv\b/g, '下单UV'],
  [/\bshipCnt\b/g, '发货数'],
  [/\bdealCnt\b/g, '成交订单'],
  [/\bgmv\b/g, '成交GMV'],
  [/\bevaRate\b/g, '估价完成率'],
  [/\borderRate\b/g, '下单率'],
  [/\bshipRate\b/g, '发货率'],
  [/\bdealRate\b/g, '成交率'],
  [/\breturnRate\b/g, '退回率'],
];

function localizeMetricLabels(text) {
  let out = String(text || '');
  for (const [pattern, label] of AI_METRIC_LABEL_REPLACEMENTS) out = out.replace(pattern, label);
  out = out.replace(/([+\-−]?\s*\d+(?:\.\d+)?)\s*(?:pct|pp)\b/gi, '$1个百分点');
  return out;
}

function localizeInsightMap(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const k = String(key || '').trim();
    const v = localizeMetricLabels(value).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

const DEFAULT_CODEX_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

async function getJson(apiPath, timeout = 300000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(`${apiBase}${apiPath}`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadDashboard() {
  if (!dashboardFile) return getJson('/api/dashboard', 300000);
  const payload = JSON.parse(fs.readFileSync(dashboardFile, 'utf8'));
  if (payload && payload.current && typeof payload.current === 'object') return payload.current;
  return payload;
}

function readStrategy() {
  if (strategyFile && fs.existsSync(strategyFile)) return fs.readFileSync(strategyFile, 'utf8').trim();
  return String(process.env.BUSINESS_OVERVIEW_LAST_WEEK_STRATEGIES || '').trim();
}

function hashInput(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function formatWan(v) {
  const n = Number(v) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getCategoryName(c) {
  return String(c && (c.category || c.name) || '').trim();
}

function getSecondaryName(c) {
  return String(c && (c.secondaryCategory || c.board) || '未归类').trim() || '未归类';
}

function slimCur(cur) {
  const out = {};
  const src = cur || {};
  for (const key of COUNT_FIELDS) {
    const value = key === 'conditionUv' && src[key] == null ? src.jkuv : src[key];
    out[key] = numberOrNull(value);
  }
  for (const key of RATE_FIELDS) out[key] = numberOrNull(src[key]);
  return out;
}

function slimDelta(delta) {
  if (!delta || typeof delta !== 'object') return null;
  const out = {};
  for (const key of ['gmv', ...RATE_FIELDS]) out[key] = numberOrNull(delta[key]);
  return out;
}

function slimTrend(trend) {
  const src = trend || {};
  const out = {};
  for (const key of ['conditionUv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv']) {
    const item = src[key] || {};
    out[key] = {
      delta: numberOrNull(item.delta),
      deltaPct: numberOrNull(item.deltaPct),
      direction: item.direction || null,
    };
  }
  return out;
}

function slimCategory(c) {
  const secondaryCategory = getSecondaryName(c);
  return {
    category: getCategoryName(c),
    tier: String(c && c.tier || ''),
    secondaryCategory,
    board: secondaryCategory,
    status: c && c.status,
    cur: slimCur(c && c.cur),
    delta: slimDelta(c && c.delta),
    trend: slimTrend(c && c.trend),
    anomalyScore: Number(c && c.anomalyScore) || 0,
  };
}

function onlineCategories(categories) {
  return (categories || []).filter((c) => c && c.status !== '已下线');
}

function sumCur(categories) {
  const out = {};
  for (const key of COUNT_FIELDS) out[key] = 0;
  for (const c of categories || []) {
    const cur = c.cur || {};
    for (const key of COUNT_FIELDS) out[key] += Number(cur[key]) || 0;
  }
  if (!out.conditionUv && out.jkuv) out.conditionUv = out.jkuv;
  return out;
}

function trendScore(c) {
  const trend = (c && c.trend) || {};
  const delta = (c && c.delta) || {};
  let score = Number(c && c.anomalyScore) || 0;
  for (const key of ['gmv', ...RATE_FIELDS]) {
    const raw = key === 'gmv' ? ((trend.gmv || {}).deltaPct ?? delta.gmv) : delta[key];
    const n = Number(raw);
    if (Number.isFinite(n) && n < 0) score += Math.abs(n);
  }
  return score;
}

function opportunityScore(c) {
  const cur = (c && c.cur) || {};
  const trend = (c && c.trend) || {};
  const gmvTrend = Number((trend.gmv || {}).deltaPct);
  return (Number(cur.gmv) || 0) * (Number.isFinite(gmvTrend) && gmvTrend > 0 ? 1 + gmvTrend : 1);
}

function pickCategoryNames(categories, sorter, limit = 5) {
  return (categories || [])
    .slice()
    .sort(sorter)
    .slice(0, limit)
    .map((c) => c.category)
    .filter(Boolean);
}

function summarizeCategoryGroup(categories) {
  const list = onlineCategories(categories);
  const byGmv = (a, b) => ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0);
  const byRisk = (a, b) => trendScore(b) - trendScore(a);
  const byOpportunity = (a, b) => opportunityScore(b) - opportunityScore(a);
  return {
    categoryCount: list.length,
    cur: sumCur(list),
    topCategories: pickCategoryNames(list, byGmv, 5),
    dragCategories: pickCategoryNames(list.filter((c) => trendScore(c) > 0), byRisk, 5),
    opportunityCategories: pickCategoryNames(list, byOpportunity, 5),
    anomalyCategories: pickCategoryNames(list.filter((c) => (c.anomalyScore || 0) > 0), byRisk, 5),
  };
}

function groupBy(items, keyFn) {
  const out = {};
  for (const item of items || []) {
    const key = keyFn(item);
    if (!out[key]) out[key] = [];
    out[key].push(item);
  }
  return out;
}

function summarizeSecondaryCategories(categories) {
  const groups = groupBy(onlineCategories(categories), (c) => c.secondaryCategory || c.board || '未归类');
  return Object.entries(groups)
    .map(([secondaryCategory, list]) => {
      const base = summarizeCategoryGroup(list);
      const tierCounts = {};
      for (const c of list) tierCounts[c.tier || '未分层'] = (tierCounts[c.tier || '未分层'] || 0) + 1;
      return { secondaryCategory, tierCounts, ...base };
    })
    .sort((a, b) => ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0));
}

function summarizeTiers(dashboardTiers, categories) {
  const byTier = groupBy(onlineCategories(categories), (c) => c.tier || '未分层');
  const tierMap = {};
  for (const t of dashboardTiers || []) tierMap[t.tier] = t;
  return REQUIRED_TIERS.map((tier) => {
    const raw = tierMap[tier] || {};
    const list = byTier[tier] || [];
    const group = summarizeCategoryGroup(list);
    return {
      tier,
      cur: {
        ...group.cur,
        ...slimCur(raw.cur),
        categoryCount: numberOrNull(raw.cur && raw.cur.categoryCount) ?? list.length,
      },
      delta: slimDelta(raw.delta),
      trend: slimTrend(raw.trend),
      topCategories: group.topCategories,
      dragCategories: group.dragCategories,
      opportunityCategories: group.opportunityCategories,
      anomalyCategories: group.anomalyCategories,
      secondaryCategories: summarizeSecondaryCategories(list).map((s) => s.secondaryCategory),
    };
  });
}

function summarizeDashboard(dashboard) {
  const categories = (dashboard.categories || [])
    .map(slimCategory)
    .filter((c) => c.category)
    .slice()
    .sort((a, b) => ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0));
  const secondaryCategories = summarizeSecondaryCategories(categories);
  const tiers = summarizeTiers(dashboard.tiers || [], categories);

  return {
    version: dashboard.version,
    week: dashboard.week,
    prevWeek: dashboard.prevWeek || '',
    weekRange: dashboard.weekRange || '',
    syncedAt: dashboard.syncedAt || '',
    analysisStatus: normalizeAnalysisStatus(dashboard.analysisStatus),
    board: dashboard.board || {},
    kpiCards: dashboard.kpiCards || [],
    tiers,
    secondaryCategories,
    categories,
    topCategories: categories.slice(0, 20),
  };
}

function normalizeAnalysisStatus(status) {
  if (!status || typeof status !== 'object') return null;
  return {
    state: status.state || null,
    label: status.label || null,
    cadence: status.cadence || null,
    description: status.description || null,
    isRolling: status.isRolling === true || status.state === 'rolling',
    weekStart: status.weekStart || null,
    weekEnd: status.weekEnd || null,
    asOfDate: status.asOfDate || null,
    timezone: status.timezone || 'Asia/Shanghai',
    syncedAt: status.syncedAt || null,
  };
}

function isRollingDashboard(dashboard) {
  const status = normalizeAnalysisStatus(dashboard && dashboard.analysisStatus);
  return Boolean(status && (status.isRolling || status.state === 'rolling'));
}

function attachCacheAnalysisStatus(cache, dashboard) {
  const status = normalizeAnalysisStatus(dashboard && dashboard.analysisStatus);
  if (!status) return cache;
  return {
    ...cache,
    analysisStatus: {
      ...status,
      generatedAt: cache.generatedAt || null,
      generatedBy: cache.generatedBy || null,
      mode: cache.mode || null,
      inputHash: cache.inputHash || null,
    },
  };
}


function businessOverviewCacheName(week) {
  const safeWeek = String(week || '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
  return safeWeek ? `business-overview-insights-${safeWeek}.json` : 'business-overview-insights.json';
}

function cacheNamesForWeek(week, primaryName = outName) {
  const weekName = businessOverviewCacheName(week);
  return [...new Set([weekName, primaryName].filter(Boolean))];
}

function readExistingAiCacheForWeek(week, primaryName = outName) {
  for (const name of cacheNamesForWeek(week, primaryName)) {
    const cache = store.readJSON(name, null);
    if (isReusableAiCache(cache, week)) return { name, cache };
  }
  return null;
}

function isFinalCacheFreshForDashboard(cache, summary) {
  if (!cache || !summary) return false;
  const expectedStatus = normalizeAnalysisStatus(summary.analysisStatus);
  const actualStatus = normalizeAnalysisStatus(cache.analysisStatus);
  if (expectedStatus && expectedStatus.state && actualStatus && actualStatus.state !== expectedStatus.state) return false;
  const expectedHash = hashInput(summary);
  return Boolean(cache.inputHash && cache.inputHash === expectedHash);
}

function writeCacheForWeek(cache, primaryName = outName) {
  const names = cacheNamesForWeek(cache && cache.week, primaryName);
  for (const name of names) store.writeJSON(name, cache);
  return names;
}

function cleanInsightMap(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [key, value] of Object.entries(map)) {
    const k = String(key || '').trim();
    const v = localizeMetricLabels(value).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function formatSignedWan(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '环比待补';
  return `${n >= 0 ? '+' : '-'}${formatWan(Math.abs(n))}`;
}

function formatSignedPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '待补';
  const abs = Math.abs(n);
  if (abs < 0.0005) return '持平';
  return `${n > 0 ? '上升' : '下降'} ${(abs * 100).toFixed(1)} 个百分点`;
}

function fallbackSecondaryCategoryInsights(summary) {
  const out = {};
  for (const s of summary.secondaryCategories || []) {
    const drags = (s.dragCategories || []).slice(0, 3).join('、') || '暂无显著拖累';
    const opportunities = (s.opportunityCategories || []).slice(0, 3).join('、') || '待观察';
    out[s.secondaryCategory] = `${s.secondaryCategory}二级类目覆盖 ${s.categoryCount || 0} 个在售品类，成交GMV ${formatWan(s.cur && s.cur.gmv)}；主要拖累：${drags}；机会/需下钻品类：${opportunities}。`;
  }
  return out;
}


function categoryQualityAction(c) {
  const anomaly = Number(c && c.anomalyScore) || 0;
  const gmvDeltaPct = Number(c && c.trend && c.trend.gmv && c.trend.gmv.deltaPct);
  const orderRateDelta = Number(c && c.delta && c.delta.orderRate);
  const dealRateDelta = Number(c && c.delta && c.delta.dealRate);
  const hasRisk = anomaly > 0
    || (Number.isFinite(gmvDeltaPct) && gmvDeltaPct <= -0.05)
    || (Number.isFinite(orderRateDelta) && orderRateDelta <= -0.01)
    || (Number.isFinite(dealRateDelta) && dealRateDelta <= -0.01);
  const hasOpportunity = (Number.isFinite(gmvDeltaPct) && gmvDeltaPct >= 0.05)
    || (Number.isFinite(orderRateDelta) && orderRateDelta >= 0.01)
    || (Number.isFinite(dealRateDelta) && dealRateDelta >= 0.01);
  const hasUncertainty = !Number.isFinite(gmvDeltaPct) || !Number.isFinite(orderRateDelta);
  if (hasRisk) return '行动计划：优先下钻异常链路，定位估价、下单、发货、成交中的主要断点。';
  if (hasOpportunity) return '行动计划：保留当前有效承接，复盘增长来源，确认是否可复制放大。';
  if (hasUncertainty) return '观察计划：补齐波动口径后再判断，不强行制定动作。';
  return '当前无显著风险，维持观察，无需额外动作。';
}

function fallbackCategoryInsights(summary) {
  const out = {};
  for (const c of summary.categories || []) {
    const gmvDelta = c.trend && c.trend.gmv && c.trend.gmv.delta != null
      ? formatSignedWan(c.trend.gmv.delta)
      : formatSignedWan(c.delta && c.delta.gmv);
    const orderRateDelta = formatSignedPct(c.delta && c.delta.orderRate);
    const risk = (c.anomalyScore || 0) >= 2 ? '高' : ((c.anomalyScore || 0) === 1 ? '中' : '低');
    out[c.category] = `${c.category}（${c.tier || '未分层'} / ${c.secondaryCategory || '未归类'}）成交GMV ${formatWan(c.cur && c.cur.gmv)}，GMV变化 ${gmvDelta}，下单率变化 ${orderRateDelta}，影响风险${risk}；${categoryQualityAction(c)}`;
  }
  return out;
}

function fallbackInsights(dashboard, warnings, extraWarning) {
  const rawExisting = dashboard.insights && typeof dashboard.insights === 'object' ? dashboard.insights : {};
  // `/api/dashboard` may already contain a cached AI insight for the same week.
  // When AI is disabled or fails, do not re-label stale AI copy as deterministic.
  const existing = isGeneratedInsight(rawExisting) ? {} : rawExisting;
  const summary = summarizeDashboard(dashboard);
  const fallbackTiers = Object.fromEntries((dashboard.tiers || []).map((t) => {
    const cur = t.cur || {};
    return [t.tier, `${t.tier}层覆盖 ${cur.categoryCount || 0} 个在售品类，成交GMV ${formatWan(cur.gmv)}。`];
  }));
  const tiers = { ...fallbackTiers, ...((existing.tiers && typeof existing.tiers === 'object') ? existing.tiers : {}) };
  for (const tier of REQUIRED_TIERS) if (!tiers[tier]) tiers[tier] = `${tier}层暂无自动洞察。`;
  const secondaryCategories = {
    ...fallbackSecondaryCategoryInsights(summary),
    ...cleanInsightMap(existing.secondaryCategories),
  };
  const categories = {
    ...fallbackCategoryInsights(summary),
    ...cleanInsightMap(existing.categories),
  };
  const topTier = (dashboard.tiers || []).slice().sort((a, b) => ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0))[0];
  const board = dashboard.board && dashboard.board.cur ? dashboard.board.cur : {};
  const cache = {
    version: APP_VERSION,
    week: dashboard.week,
    prevWeek: dashboard.prevWeek || '',
    generatedAt: new Date().toISOString(),
    generatedBy: 'business_overview_deterministic',
    mode: 'deterministic',
    inputHash: hashInput(summary),
    insights: {
      board: existing.board || `${dashboard.week}：成交GMV ${formatWan(board.gmv)}，${topTier ? `${topTier.tier}层贡献最高` : '分层数据待补齐'}。`,
      tiers,
      secondaryCategories,
      categories,
      category: existing.category || '按当前层识别品类异动原因、建议关注指标和需要复盘的核心/波动品类。',
      monitor: existing.monitor || '监测页本期不生成机型级 AI 分析，可继续查看结构化异动明细。',
    },
    warnings: extraWarning ? warnings.concat(extraWarning) : warnings,
  };
  return attachCacheAnalysisStatus(cache, dashboard);
}


function isReusableAiCache(cache, expectedWeek = null) {
  return Boolean(
    cache
    && typeof cache === 'object'
    && cache.week
    && (!expectedWeek || cache.week === expectedWeek)
    && cache.mode === 'ai'
    && cache.generatedBy === 'codex-cli-read-only'
    && cache.insights
    && typeof cache.insights === 'object'
  );
}

function isGeneratedInsight(insights) {
  if (!insights || typeof insights !== 'object') return false;
  return Boolean(insights.generatedBy || insights.mode || insights.inputHash || insights.generatedAt);
}

function buildPrompt(summary, strategy, warnings) {
  return [
    '你是转转回收经营分析助手。请基于输入的 dashboard 周日均数据，输出给数据看板展示的经营分析洞察。',
    '要求：',
    '1. 只输出 JSON，必须符合 output schema。',
    '2. 所有判断只能来自 <dashboard_summary> 里的结构化数据；不要自由查数，不要编造策略、竞对或行情事实。',
    '3. insights.board 是大盘概览，必须覆盖风险等级、链路判断、量价判断、关键拖累/机会。',
    '4. insights.tiers 必须包含且只按 发展/孵化/种子 三个 key 输出，每个 value 覆盖该层表现、核心问题、风险/机会判断；只有存在风险、机会或不确定性时才给计划。',
    '5. insights.secondaryCategories 是数组，每项为 { name, insight }，name 必须覆盖 dashboard_summary.secondaryCategories[].secondaryCategory；insight 覆盖贡献、波动、拖累、机会和是否需要下钻；无显著风险时写维持观察，不要硬给动作。',
    '6. insights.categories 是数组，每项为 { name, insight }，name 必须覆盖 dashboard_summary.categories[].category；insight 覆盖影响度、风险/机会原因、可解决度；只有有风险/机会/不确定性时才给建设性计划，无显著风险时明确维持观察或无需额外动作。',
    '7. insights.category 是兼容旧字段，可写全局/当前筛选品类概览；insights.monitor 本期只写监测页总提示或明确空态，不输出机型级 AI 分析。',
    '8. 建议必须有洞察和计划：说明为什么做、先查哪条链路、预期验证什么；禁止泛泛写“建议复盘”。如果没有风险或机会，不必给建议。',
    '9. 如果上周策略为空，warnings 必须包含“未配置上周策略/预判，暂无法检核兑现”。',
    '10. 如果 dashboard_summary.analysisStatus.state=rolling，必须明确这是未结束周的滚动分析，结论按当前已同步数据判断；不要写成周结冻结。',
    '11. 如果 dashboard_summary.analysisStatus.state=final，必须按已结束周固定结论表达，不要提示每日滚动更新。',
    '12. 对外展示必须使用中文业务指标名，禁止输出结构化字段名：orderRate 写作下单率，shipRate 写作发货率，dealRate 写作成交率，evaRate 写作估价完成率，conditionUv/jkuv 写作机况UV，evaUv 写作估价UV；pct/pp 写作百分点。',
    '',
    '<last_week_strategies>',
    strategy || '',
    '</last_week_strategies>',
    '<required_warnings>',
    JSON.stringify(warnings, null, 2),
    '</required_warnings>',
    '<dashboard_summary>',
    JSON.stringify(summary, null, 2),
    '</dashboard_summary>',
  ].join('\n');
}

function parseJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty Codex output');
  try { return JSON.parse(raw); } catch (_) { /* try fenced/body extraction */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('Codex output is not JSON');
}

function expectedInsightKeys(summary, field) {
  if (field === 'secondaryCategories') {
    return [...new Set(((summary && summary.secondaryCategories) || []).map((s) => s.secondaryCategory).filter(Boolean))];
  }
  if (field === 'categories') {
    return [...new Set(((summary && summary.categories) || []).map((c) => c.category).filter(Boolean))];
  }
  return [];
}

function cleanInsightArray(items) {
  const out = {};
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const k = String(item.name || item.key || item.secondaryCategory || item.category || '').trim();
    const v = localizeMetricLabels(item.insight || item.value || item.text).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

function normalizeInsightCollection(insights, field) {
  if (Array.isArray(insights[field])) return cleanInsightArray(insights[field]);
  if (insights[field] && typeof insights[field] === 'object') return cleanInsightMap(insights[field]);
  return null;
}

function validateInsightMap(insights, field, expectedKeys) {
  const out = normalizeInsightCollection(insights, field);
  if (!out) throw new Error(`AI insights.${field} missing`);
  for (const key of expectedKeys || []) {
    if (typeof out[key] !== 'string' || !out[key].trim()) {
      throw new Error(`AI insights.${field}.${key} missing`);
    }
  }
  return out;
}

function normalizeAiCache(aiResult, dashboard, summary, warnings) {
  if (!aiResult || typeof aiResult !== 'object' || !aiResult.insights) {
    throw new Error('AI result missing insights');
  }
  const insights = aiResult.insights;
  for (const key of ['board', 'category', 'monitor']) {
    if (typeof insights[key] !== 'string' || !insights[key].trim()) throw new Error(`AI insights.${key} missing`);
  }
  if (!insights.tiers || typeof insights.tiers !== 'object') throw new Error('AI insights.tiers missing');
  for (const tier of REQUIRED_TIERS) {
    if (typeof insights.tiers[tier] !== 'string' || !insights.tiers[tier].trim()) {
      throw new Error(`AI insights.tiers.${tier} missing`);
    }
  }
  const secondaryCategories = validateInsightMap(insights, 'secondaryCategories', expectedInsightKeys(summary, 'secondaryCategories'));
  const categories = validateInsightMap(insights, 'categories', expectedInsightKeys(summary, 'categories'));
  const normalizedInsights = {
    board: localizeMetricLabels(insights.board).trim(),
    tiers: Object.fromEntries(REQUIRED_TIERS.map((tier) => [tier, localizeMetricLabels(insights.tiers[tier]).trim()])),
    secondaryCategories: localizeInsightMap(secondaryCategories),
    categories: localizeInsightMap(categories),
    category: localizeMetricLabels(insights.category).trim(),
    monitor: localizeMetricLabels(insights.monitor).trim(),
  };
  const aiWarnings = Array.isArray(aiResult.warnings) ? aiResult.warnings.filter(Boolean).map(String) : [];
  const mergedWarnings = [...new Set(warnings.concat(aiWarnings))];
  const cache = {
    version: APP_VERSION,
    week: dashboard.week,
    prevWeek: dashboard.prevWeek || '',
    generatedAt: new Date().toISOString(),
    generatedBy: 'codex-cli-read-only',
    mode: 'ai',
    inputHash: hashInput(summary),
    insights: normalizedInsights,
    warnings: mergedWarnings,
  };
  return attachCacheAnalysisStatus(cache, dashboard);
}

function buildCodexEnv(source = process.env) {
  const allow = new Set(DEFAULT_CODEX_ENV_ALLOWLIST);
  String(source.BUSINESS_OVERVIEW_CODEX_ENV_ALLOW || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((key) => allow.add(key));

  const out = {};
  for (const key of allow) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}



function summarizeErrorMessage(error, maxLen = 240) {
  const raw = String((error && error.message) || error || '').replace(/\u001b\[[0-9;]*m/g, '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('user'))
    .filter((line) => !line.startsWith('<dashboard_summary>'))
    .filter((line) => !line.startsWith('{'))
    .filter((line) => !line.startsWith('"'));
  let msg = lines.find((line) => line.includes('invalid_json_schema'))
    || lines.find((line) => line.startsWith('ERROR:'))
    || lines.find((line) => line.includes('codex exec failed'))
    || lines[0]
    || raw;
  msg = msg.replace(/\s+/g, ' ').trim();
  if (msg.length > maxLen) msg = `${msg.slice(0, maxLen - 1)}…`;
  return msg || 'unknown error';
}

function runCodex(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-overview-'));
  const lastMessage = path.join(dir, 'last-message.json');
  const args = [
    'exec',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--cd', repoRoot,
    '--output-schema', schemaPath,
    '--output-last-message', lastMessage,
    '-',
  ];
  const proc = spawnSync('codex', args, {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: buildCodexEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) throw new Error(`codex exec failed rc=${proc.status}: ${String(proc.stderr || proc.stdout).slice(0, 1000)}`);
  if (!fs.existsSync(lastMessage)) throw new Error('codex did not write --output-last-message');
  return parseJsonText(fs.readFileSync(lastMessage, 'utf8'));
}

async function main() {
  const dashboard = await loadDashboard();
  const strategy = readStrategy();
  const warnings = strategy ? [] : [STRATEGY_WARNING];
  const summary = summarizeDashboard(dashboard);
  const rolling = isRollingDashboard(dashboard);
  const existing = readExistingAiCacheForWeek(dashboard.week);

  // 已结束周的 AI 结论默认冻结：即使生产脚本打开 AI，也不覆盖 W27 这类周结文件。
  // 当前未结束周（如 W28）则按每日刷新滚动重算。
  if (existing && !rolling && !allowFinalRefresh && isFinalCacheFreshForDashboard(existing.cache, summary)) {
    const refreshed = attachCacheAnalysisStatus(existing.cache, dashboard);
    const written = writeCacheForWeek(refreshed);
    console.log(JSON.stringify({
      ok: true,
      mode: refreshed.mode,
      aiEnabled,
      preserved: true,
      refreshedAnalysisStatus: true,
      out: written.map((name) => store.filePath(name)),
      week: refreshed.week,
      dashboardWeek: dashboard.week,
      analysisState: (summary.analysisStatus && summary.analysisStatus.state) || null,
      cacheAnalysisState: (refreshed.analysisStatus && refreshed.analysisStatus.state) || null,
      warnings: refreshed.warnings || [],
    }, null, 2));
    return;
  }

  let cache;
  if (!aiEnabled) {
    cache = fallbackInsights(dashboard, warnings);
    const written = writeCacheForWeek(cache);
    console.log(JSON.stringify({ ok: true, mode: cache.mode, aiEnabled: false, preserved: false, out: written.map((name) => store.filePath(name)), week: cache.week, analysisState: (cache.analysisStatus && cache.analysisStatus.state) || null, warnings: cache.warnings }, null, 2));
    return;
  }

  try {
    const aiResult = runCodex(buildPrompt(summary, strategy, warnings));
    cache = normalizeAiCache(aiResult, dashboard, summary, warnings);
  } catch (e) {
    cache = fallbackInsights(dashboard, warnings, `AI生成失败，已降级为确定性洞察：${summarizeErrorMessage(e)}`);
  }
  const written = writeCacheForWeek(cache);
  console.log(JSON.stringify({ ok: true, mode: cache.mode, out: written.map((name) => store.filePath(name)), week: cache.week, analysisState: (cache.analysisStatus && cache.analysisStatus.state) || null, warnings: cache.warnings }, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[business-overview] failed:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = {
  businessOverviewCacheName,
  buildCodexEnv,
  buildPrompt,
  fallbackInsights,
  isGeneratedInsight,
  isReusableAiCache,
  isRollingDashboard,
  localizeMetricLabels,
  normalizeAiCache,
  readExistingAiCacheForWeek,
  summarizeDashboard,
  summarizeErrorMessage,
};

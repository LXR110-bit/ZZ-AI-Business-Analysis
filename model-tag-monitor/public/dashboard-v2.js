// dashboard-v2.js — 概览页 v2 四层渲染逻辑
// 依赖 app.js 中的全局函数: escapeHtml, escapeAttr, fmtRate, fmtInt, $, $$, readUrlState, writeUrlState, drillTo

// ---- 格式化工具 ----
function fmtGmvShort(v) {
  var n = Number(v) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}

function fmtCountShort(v) {
  if (v === null || v === undefined || v === '') return '-';
  var n = Number(v);
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return Math.round(n).toLocaleString('zh-CN');
}

function fmtCountFull(v) {
  if (v === null || v === undefined || v === '') return '-';
  var n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return Math.round(n).toLocaleString('zh-CN');
}

function fmtDeltaPlain(v) {
  if (v === null || v === undefined) return '-';
  var n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return (n > 0 ? '+' : '') + (n * 100).toFixed(1) + '%';
}

function fmtDeltaArrow(v) {
  if (v === null || v === undefined) return '';
  var n = Number(v);
  if (!Number.isFinite(n)) return '';
  var sign = n >= 0 ? '▲' : '▼';
  var cls = n >= 0 ? 'up' : 'down';
  return '<span class="dash-ts-delta ' + cls + '">' + sign + (Math.abs(n) * 100).toFixed(1) + '%</span>';
}

function fmtTrendPill(trend) {
  if (!trend || trend.deltaPct === null || trend.deltaPct === undefined) return '';
  var n = Number(trend.deltaPct);
  if (!Number.isFinite(n)) return '';
  var dir = n >= 0 ? 'up' : 'down';
  var strong = Math.abs(n) >= 0.1 ? ' strong' : '';
  var arrow = n >= 0 ? '↑' : '↓';
  return '<span class="dash-trend-pill ' + dir + strong + '" title="周环比：' + escapeAttr(fmtDeltaPlain(n)) + '；上周 ' + escapeAttr(fmtCountShort(trend.prev)) + '">' +
    arrow + Math.abs(n * 100).toFixed(1) + '%' +
  '</span>';
}

var _dashboardInsights = {};

function renderInsightWarnings(insights) {
  var warnings = insights && Array.isArray(insights.warnings) ? insights.warnings : [];
  if (!warnings.length) return '';
  return '<div class="dash-insight-warnings">' + warnings.map(function(w) {
    return '<div class="dash-insight-warning">⚠️ ' + escapeHtml(w) + '</div>';
  }).join('') + '</div>';
}

function anomalyDots(score) {
  var s = Math.min(Math.max(score || 0, 0), 3);
  var html = '<span class="dash-anomaly-dots">';
  for (var i = 0; i < 3; i++) {
    html += '<span class="dash-anomaly-dot' + (i < s ? ' filled' : '') + '"></span>';
  }
  html += '</span>';
  return html;
}

function dashEscapeHtml(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


var DASH_INSIGHT_METRIC_LABELS = [
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
  [/\breturnRate\b/g, '退回率']
];

function localizeDashInsightMetricLabels(text) {
  var out = String(text || '');
  DASH_INSIGHT_METRIC_LABELS.forEach(function(pair) {
    out = out.replace(pair[0], pair[1]);
  });
  return out.replace(/([+\-−]?\s*\d+(?:\.\d+)?)\s*(?:pct|pp)\b/gi, '$1个百分点');
}

function pushInsightToken(tokens, html) {
  var id = tokens.length;
  tokens.push(html);
  return '__DASH_INSIGHT_TOKEN_' + new Array(id + 2).join('A') + '__';
}

function renderRichInsightInline(text) {
  var tokens = [];
  var raw = localizeDashInsightMetricLabels(text);
  raw = raw.replace(/([+↑]\s*\d+(?:,\d{3})*(?:\.\d+)?\s*(?:%|pct|pp|个百分点|万|亿)?)/g, function(m) {
    return pushInsightToken(tokens, '<span class="dash-insight-trend up">' + dashEscapeHtml(m) + '</span>');
  });
  raw = raw.replace(/([\-−↓]\s*\d+(?:,\d{3})*(?:\.\d+)?\s*(?:%|pct|pp|个百分点|万|亿)?)/g, function(m) {
    return pushInsightToken(tokens, '<span class="dash-insight-trend down">' + dashEscapeHtml(m) + '</span>');
  });
  raw = raw.replace(/(风险等级|中等风险|高风险|低风险|风险|链路判断|量价判断|量跌价升|量升价稳|量价双升|关键拖累|关键机会|行动计划|观察计划|计划|核心问题|核心观测|波动关注|大盘概览|GMV日均|成交GMV|估价UV|APP DAU|入口UV|回收入口UV|成交订单|成交量|发货数|客单价|估价率|下单率|发货率|成交率|异常品类|发展层|孵化层|种子层|滚动分析|周结冻结|拖累|机会|建议)([:：]?)/g, function(m, key, colon) {
    return pushInsightToken(tokens, '<strong class="dash-insight-key">' + dashEscapeHtml(key + (colon || '')) + '</strong>');
  });
  raw = raw.replace(/(\d+(?:,\d{3})*(?:\.\d+)?\s*(?:万|亿|%|pct|pp|个百分点)?)/g, function(m) {
    return pushInsightToken(tokens, '<span class="dash-insight-num">' + dashEscapeHtml(m) + '</span>');
  });
  var html = dashEscapeHtml(raw);
  tokens.forEach(function(tokenHtml, i) {
    html = html.replace(new RegExp('__DASH_INSIGHT_TOKEN_' + new Array(i + 2).join('A') + '__', 'g'), tokenHtml);
  });
  return html;
}

function splitInsightText(text) {
  var raw = localizeDashInsightMetricLabels(text).trim();
  if (!raw) return [];
  return raw
    .replace(/([。；;])\s*/g, '$1\n')
    .split(/\n+/)
    .map(function(x) { return x.trim(); })
    .filter(Boolean);
}

function renderRichInsightHtml(text) {
  var parts = splitInsightText(text);
  if (!parts.length) return '<div class="dash-insight-rich"><p>暂无自动洞察。</p></div>';
  return '<div class="dash-insight-rich">' + parts.map(function(part) {
    return '<p>' + renderRichInsightInline(part) + '</p>';
  }).join('') + '</div>';
}

// ---- Meta 行 ----
function renderAnalysisStatusBadges(d) {
  var status = (d && d.analysisStatus) || {};
  var insights = (d && d.insights) || {};
  var state = status.state || (status.isRolling ? 'rolling' : '');
  var label = status.label || (state === 'rolling' ? '滚动分析' : (state === 'final' ? '周结冻结' : '分析状态待确认'));
  var cadence = status.cadence || '';
  var desc = status.description || '';
  var statusCls = state === 'rolling' ? ' rolling' : (state === 'final' ? ' final' : '');
  var html = '<span class="dash-meta-badge dash-meta-status' + statusCls + '" title="' + escapeAttr(desc) + '">' +
    escapeHtml(label + (cadence ? ' · ' + cadence : '')) +
  '</span>';

  var mode = status.mode || insights.mode || '';
  if (mode) {
    var generatedAt = status.generatedAt || insights.generatedAt || '';
    var generatedBy = status.generatedBy || insights.generatedBy || '';
    var modeLabel = mode === 'ai' ? 'AI分析' : (mode === 'deterministic' ? '规则兜底' : mode);
    var modeCls = mode === 'ai' ? ' ai' : (mode === 'deterministic' ? ' deterministic' : '');
    var modeTitle = [generatedBy, generatedAt ? new Date(generatedAt).toLocaleString('zh-CN') : ''].filter(Boolean).join(' · ');
    html += '<span class="dash-meta-badge dash-meta-mode' + modeCls + '" title="' + escapeAttr(modeTitle) + '">' +
      escapeHtml(modeLabel) +
    '</span>';
  }
  return html;
}

function renderDashboardMetaV2(d) {
  var t = d.syncedAt ? new Date(d.syncedAt).toLocaleString('zh-CN') : '-';
  var weeks = (window.dashboardWeeks || []).slice();
  if (d.week && weeks.indexOf(d.week) < 0) weeks.push(d.week);
  weeks = (typeof sortWeekValues === 'function')
    ? sortWeekValues(weeks, true)
    : weeks.filter(Boolean).sort().reverse();
  var options = weeks.map(function(w) {
    return '<option value="' + escapeAttr(w) + '"' + (w === d.week ? ' selected' : '') + '>' + escapeHtml(w) + '</option>';
  }).join('');
  $('#dashMeta').innerHTML =
    '<label class="dash-week-control"><span>目标周</span><select id="dashWeek">' + options + '</select></label>' +
    (d.weekRange ? '<span class="dash-meta-sep">·</span><span>' + escapeHtml(d.weekRange) + '</span>' : '') +
    '<span class="dash-meta-sep">·</span>' +
    '<span>同步于 ' + escapeHtml(t) + '</span>' +
    renderAnalysisStatusBadges(d) +
    '<span class="dash-meta-badge" title="本页周维度经营指标均按周日均展示，不能按周汇总口径解读">口径：周日均，非周汇总</span>';
  var sel = $('#dashWeek');
  if (sel) {
    sel.value = d.week || '';
    sel.addEventListener('change', function() {
      writeUrlState({ tab: 'dashboard', week: sel.value || '', secondary: '', category: '' });
      refreshDashboard();
    });
  }
}

// ---- 洞察概览占位（后续由数据分析 Agent 生成） ----
function renderDashboardOverviewV2(d) {
  var el = $('#dashBoardOverview');
  if (!el) return;
  _dashboardInsights = (d && d.insights) || {};
  var status = (d && d.analysisStatus) || {};
  var statusText = status.description
    ? '<div class="dash-insight-meta">' + escapeHtml(status.description) + '</div>'
    : '';
  el.innerHTML =
    '<div class="dash-insight-title">大盘概览</div>' +
    '<div class="dash-insight-body">' + renderRichInsightHtml(_dashboardInsights.board || '真实数据已接入，暂无自动洞察。') + '</div>' +
    statusText +
    renderInsightWarnings(_dashboardInsights);
}

function renderTierOverview(tiers, activeTier) {
  var el = $('#dashTierOverview');
  if (!el) return;
  var model = buildTierOverviewModel(_dashboardInsights, activeTier);
  el.innerHTML =
    '<div class="dash-insight-title">' + escapeHtml(model.title) + '</div>' +
    '<div class="dash-insight-body">' + renderRichInsightHtml(model.body) + '</div>';
}

function buildTierOverviewModel(insights, activeTier) {
  var tier = activeTier || '发展';
  var tierInsights = (insights && insights.tiers) || {};
  return {
    title: tier + '概览',
    body: tierInsights[tier] || ('暂无' + tier + '层自动洞察。'),
  };
}

// ---- 大盘 KPI 卡 ----
function renderBoardKpi(payload) {
  var cards = (payload && Array.isArray(payload.kpiCards) && payload.kpiCards.length)
    ? payload.kpiCards
    : buildBoardKpiFromPayload(payload || {});
  cards = cards.filter(function(item) { return item && item.value !== null && item.value !== undefined && item.value !== ''; });
  $('#dashBoardKpi').innerHTML = cards.map(function(item) {
    var delta = item.deltaPct;
    if (delta === undefined || delta === null) delta = item.deltaRate;
    var hasDelta = delta !== null && delta !== undefined && Number.isFinite(Number(delta));
    var up = hasDelta && Number(delta) >= 0;
    var value = item.key === 'gmv' ? fmtGmvShort(item.value) : fmtCountFull(item.value);
    return '<div class="dash-kpi">' +
      '<div class="dash-kpi-label">' + escapeHtml(item.label || item.key || '-') + '</div>' +
      '<div class="dash-kpi-value">' + escapeHtml(value) + '</div>' +
      '<div class="dash-kpi-sub"><span class="' + (hasDelta ? (up ? 'dash-delta-up' : 'dash-delta-down') : 'dash-delta-neutral') + '">环比 ' + escapeHtml(fmtDeltaPlain(delta)) + '</span></div>' +
      '<div class="dash-kpi-note">口径：' + escapeHtml(item.note || '-') + '</div>' +
    '</div>';
  }).join('');
}

function buildBoardKpiFromPayload(payload) {
  var board = payload.board || {};
  var cur = board.cur || {};
  var penetration = payload.penetration || {};
  var avgPrice = cur.dealCnt ? (cur.gmv || 0) / cur.dealCnt : null;
  return [
    { key: 'appDau', label: 'APP DAU', value: penetration.appDau, deltaPct: null, note: 'APP 日均 DAU' },
    { key: 'recycleEntranceUv', label: '回收入口UV', value: penetration.recycleEntranceUv, deltaPct: null, note: '回收入口日均 UV' },
    { key: 'evaUv', label: '估价UV', value: cur.evaUv, deltaPct: null, note: '日切片品类维度估价UV去重汇总' },
    { key: 'shipCnt', label: '发货数', value: cur.shipCnt, deltaPct: null, note: '发货订单数日均' },
    { key: 'dealCnt', label: '成交订单', value: cur.dealCnt, deltaPct: null, note: '成交订单量日均' },
    { key: 'gmv', label: '成交GMV', value: cur.gmv, deltaPct: null, note: '成交订单 GMV 日均' },
    { key: 'avgPrice', label: '客单价', value: avgPrice, deltaPct: null, note: '成交GMV / 成交订单量' },
  ];
}

function safeDiv(num, den) {
  var n = Number(num);
  var d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

// ---- 胶囊 Tab 状态 ----
function setActiveTierTab(tier) {
  $$('#dashTierTabs .dash-tier-tab').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.tier === tier);
  });
}

// ---- Tier 汇总条 ----
function renderTierSummary(tiers, activeTier, categories) {
  var t = null;
  for (var i = 0; i < tiers.length; i++) {
    if (tiers[i].tier === activeTier) { t = tiers[i]; break; }
  }
  if (!t) {
    $('#dashTierSummary').innerHTML = '';
    return;
  }
  var c = t.cur || {};
  var tierTrend = buildTierTrend(categories || [], activeTier);
  // 用户确认该层不要“聚合UV”，顺序对齐经营漏斗：
  // 机况UV → 估价UV → 下单UV → 发货数 → 成交订单量。
  var items = [
    { key: 'conditionUv', label: '机况UV', value: fmtCountShort(c.conditionUv != null ? c.conditionUv : c.jkuv), note: '进入机况页去重 UV' },
    { key: 'evaUv', label: '估价UV', value: fmtCountShort(c.evaUv), note: '日切片品类维度估价UV去重汇总' },
    { key: 'orderUv', label: '下单UV', value: fmtCountShort(c.orderUv), note: '进入下单页去重 UV' },
    { key: 'shipCnt', label: '发货数', value: fmtCountShort(c.shipCnt), note: '发货订单数日均' },
    { key: 'dealCnt', label: '成交订单量', value: fmtCountShort(c.dealCnt), note: '成交订单量日均' },
    { key: 'gmv', label: '成交GMV', value: fmtGmvShort(c.gmv), note: '成交订单 GMV 日均' },
  ];
  $('#dashTierSummary').innerHTML = items.map(function(it) {
    return '<div class="dash-ts-item" title="口径：' + escapeAttr(it.note) + '">' +
      '<span class="dash-ts-label">' + escapeHtml(it.label) + '</span>' +
      '<span class="dash-ts-value">' + escapeHtml(it.value) + '</span>' +
      fmtTrendPill(tierTrend[it.key]) +
    '</div>';
  }).join('');
}

function buildTierTrend(categories, activeTier) {
  var sums = {};
  (categories || []).forEach(function(c) {
    if (c.tier !== activeTier) return;
    var trend = c.trend || {};
    ['conditionUv', 'jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv'].forEach(function(k) {
      var item = trend[k];
      if (!item) return;
      if (!sums[k]) sums[k] = { cur: 0, prev: 0 };
      sums[k].cur += Number(item.cur) || 0;
      sums[k].prev += Number(item.prev) || 0;
    });
  });
  var out = {};
  Object.keys(sums).forEach(function(k) {
    var s = sums[k];
    if (s.prev) out[k] = { cur: s.cur, prev: s.prev, delta: s.cur - s.prev, deltaPct: (s.cur - s.prev) / s.prev };
  });
  return out;
}

// ---- 二级类目汇总/筛选 ----
function getSecondaryCategoryName(c) {
  return String(c && (c.secondaryCategory || c.board) || '未归类');
}

function getActiveSecondaryFilter(categories, activeTier) {
  var selected = '';
  try { selected = readUrlState().secondary || ''; } catch (e) { selected = ''; }
  if (!selected) return '';
  var exists = (categories || []).some(function(c) {
    return c.tier === activeTier && getSecondaryCategoryName(c) === selected;
  });
  return exists ? selected : '';
}

function getActiveCategoryFilter(categories, activeTier, selectedSecondary) {
  var selected = '';
  try { selected = readUrlState().category || ''; } catch (e) { selected = ''; }
  if (!selected) return '';
  var exists = (categories || []).some(function(c) {
    return c.tier === activeTier &&
      (!selectedSecondary || getSecondaryCategoryName(c) === selectedSecondary) &&
      categoryName(c) === selected;
  });
  return exists ? selected : '';
}

function emptySecondaryMetric() {
  return {
    categoryCount: 0,
    conditionUv: 0,
    jkuv: 0,
    evaUv: 0,
    orderUv: 0,
    shipCnt: 0,
    dealCnt: 0,
    gmv: 0,
    trendSums: {}
  };
}

function addSecondaryMetric(sum, c) {
  var cur = c.cur || {};
  var trend = c.trend || {};
  sum.categoryCount += 1;
  sum.conditionUv += Number(cur.conditionUv != null ? cur.conditionUv : cur.jkuv) || 0;
  sum.jkuv += Number(cur.jkuv) || 0;
  sum.evaUv += Number(cur.evaUv) || 0;
  sum.orderUv += Number(cur.orderUv) || 0;
  sum.shipCnt += Number(cur.shipCnt) || 0;
  sum.dealCnt += Number(cur.dealCnt) || 0;
  sum.gmv += Number(cur.gmv) || 0;
  ['conditionUv', 'jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv'].forEach(function(k) {
    var item = trend[k];
    if (!item) return;
    if (!sum.trendSums[k]) sum.trendSums[k] = { cur: 0, prev: 0 };
    sum.trendSums[k].cur += Number(item.cur) || 0;
    sum.trendSums[k].prev += Number(item.prev) || 0;
  });
}

function buildSecondaryGroups(categories, activeTier) {
  var map = {};
  (categories || []).forEach(function(c) {
    if (c.tier !== activeTier) return;
    var name = getSecondaryCategoryName(c);
    if (!map[name]) map[name] = emptySecondaryMetric();
    addSecondaryMetric(map[name], c);
  });
  return Object.keys(map).map(function(name) {
    var cur = map[name];
    var trend = {};
    Object.keys(cur.trendSums || {}).forEach(function(k) {
      var s = cur.trendSums[k];
      if (s.prev) trend[k] = { cur: s.cur, prev: s.prev, delta: s.cur - s.prev, deltaPct: (s.cur - s.prev) / s.prev };
    });
    return { name: name, cur: cur, trend: trend };
  });
}

var _secondarySortKey = 'gmv';
var _secondarySortAsc = false;

var DASH_SECONDARY_DEFAULT_COLS = ['name', 'categoryCount', 'conditionUv', 'evaUv', 'evaCompletionRate', 'orderUv', 'shipCnt', 'dealCnt', 'gmv'];
var DASH_SECONDARY_COLUMNS = [
  { key: 'name', label: '二级类目', cls: '', note: '品类映射表「二级板块」/ 二级类目' },
  { key: 'categoryCount', label: '品类数', cls: 'num', note: '该二级类目下的品类数量' },
  { key: 'conditionUv', label: '机况UV', cls: 'num', note: '进入机况页去重 UV' },
  { key: 'evaUv', label: '估价UV', cls: 'num', note: '日切片品类维度估价UV去重汇总' },
  { key: 'evaCompletionRate', label: '估价完成率', cls: 'num', note: '估价UV / 机况UV' },
  { key: 'orderUv', label: '下单UV', cls: 'num', note: '进入下单页去重 UV' },
  { key: 'shipCnt', label: '发货数', cls: 'num', note: '发货订单数日均' },
  { key: 'dealCnt', label: '成交订单量', cls: 'num', note: '成交订单量日均' },
  { key: 'gmv', label: '成交GMV', cls: 'num', note: '成交订单 GMV 日均' },
];

function getSecondaryColumnByKey(key) {
  for (var i = 0; i < DASH_SECONDARY_COLUMNS.length; i++) {
    if (DASH_SECONDARY_COLUMNS[i].key === key) return DASH_SECONDARY_COLUMNS[i];
  }
  return null;
}

function getSelectedSecondaryColumns() {
  var keys = null;
  try {
    keys = JSON.parse(localStorage.getItem('dashSecondaryColumns') || 'null');
  } catch (e) {
    keys = null;
  }
  if (!Array.isArray(keys) || !keys.length) keys = DASH_SECONDARY_DEFAULT_COLS.slice();
  keys = keys.filter(function(k) { return !!getSecondaryColumnByKey(k); });
  return keys.length ? keys : DASH_SECONDARY_DEFAULT_COLS.slice();
}

function setSelectedSecondaryColumns(keys) {
  try {
    localStorage.setItem('dashSecondaryColumns', JSON.stringify(keys));
  } catch (e) {}
}

function toggleSecondaryColumnPicker() {
  var picker = $('#dashSecondaryColumnPicker');
  if (!picker) return;
  renderSecondaryColumnPicker();
  picker.classList.toggle('hidden');
}

function renderSecondaryColumnPicker() {
  var picker = $('#dashSecondaryColumnPicker');
  if (!picker) return;
  var selected = getSelectedSecondaryColumns();
  var selectedMap = {};
  selected.forEach(function(k) { selectedMap[k] = true; });
  picker.innerHTML =
    '<div class="dash-column-picker-title">勾选汇总指标</div>' +
    DASH_SECONDARY_COLUMNS.map(function(col) {
      var checked = selectedMap[col.key] ? ' checked' : '';
      var disabled = col.key === 'name' ? ' disabled' : '';
      return '<label class="dash-column-option">' +
        '<input type="checkbox" value="' + escapeAttr(col.key) + '"' + checked + disabled + ' />' +
        '<span>' + escapeHtml(col.label) + '</span>' +
      '</label>';
    }).join('');
  $$('#dashSecondaryColumnPicker input[type="checkbox"]').forEach(function(input) {
    input.addEventListener('change', function() {
      var next = $$('#dashSecondaryColumnPicker input[type="checkbox"]')
        .filter(function(el) { return el.checked || el.value === 'name'; })
        .map(function(el) { return el.value; });
      if (next.indexOf('name') < 0) next.unshift('name');
      setSelectedSecondaryColumns(next);
      renderSecondaryCategorySummary(_lastDashCategories, _lastDashTier);
      renderSecondaryColumnPicker();
    });
  });
}

function renderSecondaryCategorySummary(categories, activeTier) {
  var section = $('#dashSecondarySection');
  var thead = $('#dashSecondaryTable thead');
  var tbody = $('#dashSecondaryTable tbody');
  var select = $('#dashSecondaryFilter');
  if (!section || !thead || !tbody || !select) return;
  var groups = buildSecondaryGroups(categories, activeTier);
  var selected = getActiveSecondaryFilter(categories, activeTier);

  select.innerHTML = '<option value="">全部二级类目</option>' + groups.map(function(g) {
    return '<option value="' + escapeAttr(g.name) + '"' + (g.name === selected ? ' selected' : '') + '>' +
      escapeHtml(g.name) + '（' + g.cur.categoryCount + '）</option>';
  }).join('');
  select.value = selected;
  select.onchange = function() {
    writeUrlState({ secondary: select.value || '', category: '' });
    renderSecondaryCategorySummary(_lastDashCategories, _lastDashTier);
    renderCategoryTable(_lastDashCategories, _lastDashTier);
  };

  var picker = $('#dashSecondaryColumnPicker');
  if (picker && !picker.classList.contains('hidden')) renderSecondaryColumnPicker();

  var cols = getSelectedSecondaryColumns().map(getSecondaryColumnByKey).filter(Boolean);
  if (cols.length && cols[0].key !== 'name') {
    cols.unshift(getSecondaryColumnByKey('name'));
  }

  groups.sort(function(a, b) {
    var va = getSecondarySortValue(a, _secondarySortKey);
    var vb = getSecondarySortValue(b, _secondarySortKey);
    if (typeof va === 'string' || typeof vb === 'string') {
      va = String(va || '');
      vb = String(vb || '');
      return _secondarySortAsc ? va.localeCompare(vb, 'zh') : vb.localeCompare(va, 'zh');
    }
    return _secondarySortAsc ? va - vb : vb - va;
  });

  thead.innerHTML = '<tr>' + cols.map(function(col) {
    var note = col.note || '';
    var info = note ? ' <span class="dash-th-info" title="' + escapeAttr(note) + '">ⓘ</span>' : '';
    var arrow = _secondarySortKey === col.key ? (_secondarySortAsc ? ' ↑' : ' ↓') : '';
    return '<th class="' + col.cls + '" data-sort="' + escapeAttr(col.key) + '" title="' + escapeAttr(note) + '">' + escapeHtml(col.label) + arrow + info + '</th>';
  }).join('') + '</tr>';

  if (!groups.length) {
    tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="dash-empty">该层暂无二级类目</td></tr>';
    return;
  }

  tbody.innerHTML = groups.map(function(g) {
    var active = g.name === selected ? ' class="active"' : '';
    return '<tr' + active + ' data-secondary="' + escapeAttr(g.name) + '">' +
      cols.map(function(col) { return renderSecondaryCell(g, col); }).join('') +
    '</tr>';
  }).join('');

  $$('#dashSecondaryTable tbody tr[data-secondary]').forEach(function(row) {
    row.addEventListener('click', function() {
      var value = row.dataset.secondary || '';
      writeUrlState({ secondary: value === selected ? '' : value, category: '' });
      renderSecondaryCategorySummary(_lastDashCategories, _lastDashTier);
      renderCategoryTable(_lastDashCategories, _lastDashTier);
    });
  });
  $$('#dashSecondaryTable thead th[data-sort]').forEach(function(th) {
    th.addEventListener('click', function() {
      var key = th.dataset.sort;
      if (_secondarySortKey === key) {
        _secondarySortAsc = !_secondarySortAsc;
      } else {
        _secondarySortKey = key;
        _secondarySortAsc = key === 'name';
      }
      renderSecondaryCategorySummary(_lastDashCategories, _lastDashTier);
    });
  });
}

function getSecondarySortValue(g, key) {
  if (key === 'name') return g.name || '';
  if (key === 'evaCompletionRate') return safeDiv(g.cur.evaUv, g.cur.conditionUv) || 0;
  return Number(g.cur[key]) || 0;
}

function renderSecondaryCell(g, col) {
  if (col.key === 'name') {
    return '<td class="dash-secondary-name-cell">' + escapeHtml(g.name) + '</td>';
  }
  if (col.key === 'categoryCount') {
    return '<td class="num">' + escapeHtml(fmtCountFull(g.cur.categoryCount)) + '</td>';
  }
  if (col.key === 'gmv') {
    return '<td class="num">' + escapeHtml(fmtGmvShort(g.cur.gmv)) + fmtTrendPill(g.trend && g.trend.gmv) + '</td>';
  }
  if (col.key === 'evaCompletionRate') {
    return '<td class="num">' + escapeHtml(fmtRate(safeDiv(g.cur.evaUv, g.cur.conditionUv))) + '</td>';
  }
  return '<td class="num">' + escapeHtml(fmtCountShort(g.cur[col.key])) + fmtTrendPill(g.trend && g.trend[col.key]) + '</td>';
}

function renderCategoryOverview(categories, activeTier) {
  var el = $('#dashCategoryOverview');
  if (!el) return;
  categories = categories || [];
  var selectedSecondary = getActiveSecondaryFilter(categories, activeTier);
  var selectedCategory = getActiveCategoryFilter(categories, activeTier, selectedSecondary);
  var overview = buildCategoryOverviewModel(categories, activeTier, selectedSecondary, _dashboardInsights, selectedCategory);
  if (overview.empty) {
    el.innerHTML =
      '<div class="dash-insight-title">' + escapeHtml(overview.title) + '</div>' +
      '<div class="dash-insight-body">' + renderRichInsightHtml(overview.body) + '</div>';
    return;
  }
  var tagsHtml = overview.showTags === false ? '' : (
    '<div class="dash-insight-tags">' +
      '<span>核心观测品类：' + escapeHtml(overview.coreCategories.join('、') || '待筛选') + '</span>' +
      '<span>波动关注品类：' + escapeHtml(overview.volatileCategories.join('、') || '待筛选') + '</span>' +
      '<span>建议指标：' + escapeHtml(overview.suggestionMetrics.join('、') || '成交GMV') + '</span>' +
    '</div>'
  );
  el.innerHTML =
    '<div class="dash-insight-title">' + escapeHtml(overview.title) + '</div>' +
    '<div class="dash-insight-body">' + renderRichInsightHtml(overview.body) + '</div>' +
    tagsHtml;
}

function filterCategoryOverviewList(categories, activeTier, selectedSecondary) {
  var tier = activeTier || '发展';
  var secondary = selectedSecondary || '';
  return (categories || []).filter(function(c) {
    return c.tier === tier && (!secondary || getSecondaryCategoryName(c) === secondary);
  });
}

function buildCategoryOverviewModel(categories, activeTier, selectedSecondary, insights, selectedCategory) {
  var tier = activeTier || '发展';
  var secondary = selectedSecondary || '';
  var category = selectedCategory || '';
  var context = tier + (secondary ? ' / ' + secondary : ' / 全部二级类目');
  var contextText = tier + (secondary ? ' · ' + secondary : ' · 全部二级类目');
  var aiOverview = buildAiCategoryOverviewModel(tier, secondary, category, insights);
  if (aiOverview) return aiOverview;
  var list = filterCategoryOverviewList(categories, tier, secondary);
  if (!list.length) {
    return {
      empty: true,
      title: '品类简述概览 · ' + context,
      body: '当前筛选：' + contextText + '。该筛选下暂无品类，不展示其他层级或二级类目的全局洞察。',
      coreCategories: [],
      volatileCategories: [],
      suggestionMetrics: [],
      filteredCount: 0,
      totalGmv: 0,
    };
  }
  var byGmv = list.slice().sort(function(a, b) { return ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0); });
  var byDeal = list.slice().sort(function(a, b) { return ((b.cur && b.cur.dealCnt) || 0) - ((a.cur && a.cur.dealCnt) || 0); });
  var core = byGmv.slice(0, 3).map(categoryName).filter(Boolean);
  var volatile = list
    .filter(function(c) { return (c.anomalyScore || 0) > 0 || categoryVolatilityScore(c) > 0; })
    .sort(function(a, b) {
      var scoreDiff = (b.anomalyScore || 0) - (a.anomalyScore || 0);
      return scoreDiff || categoryVolatilityScore(b) - categoryVolatilityScore(a);
    })
    .slice(0, 3)
    .map(categoryName)
    .filter(Boolean);
  if (!volatile.length) volatile = byDeal.slice(0, 3).map(categoryName).filter(Boolean);
  var totalGmv = list.reduce(function(sum, c) { return sum + ((c.cur && Number(c.cur.gmv)) || 0); }, 0);
  var suggestionMetrics = buildCategorySuggestionMetrics(list);
  return {
    empty: false,
    title: '品类简述概览 · ' + context,
    body: '当前筛选：' + contextText + '。覆盖 ' + list.length + ' 个品类，成交GMV ' + fmtGmvShort(totalGmv) +
      '；核心观测品类 ' + (core.join('、') || '待筛选') +
      '；波动关注品类 ' + (volatile.join('、') || '待筛选') + '。',
    coreCategories: core,
    volatileCategories: volatile,
    suggestionMetrics: suggestionMetrics,
    filteredCount: list.length,
    totalGmv: totalGmv,
  };
}

function getInsightMap(insights, key) {
  var map = insights && insights[key];
  return map && typeof map === 'object' ? map : {};
}

function buildAiCategoryOverviewModel(tier, secondary, category, insights) {
  if (!insights || typeof insights !== 'object') return null;
  var context = tier + (secondary ? ' / ' + secondary : ' / 全部二级类目');
  if (category) {
    var categoryMap = getInsightMap(insights, 'categories');
    var categoryBody = categoryMap[category];
    return {
      empty: !categoryBody,
      title: '品类简述概览 · ' + context + ' / ' + category,
      body: categoryBody || ('当前筛选：' + tier + ' · ' + (secondary || '全部二级类目') + ' · ' + category + '。该品类暂无自动洞察，不展示其他品类、二级类目或层级的洞察。'),
      coreCategories: [],
      volatileCategories: [],
      suggestionMetrics: [],
      filteredCount: categoryBody ? 1 : 0,
      totalGmv: 0,
      showTags: false,
      source: categoryBody ? 'ai-category' : 'empty-category',
    };
  }
  if (secondary) {
    var secondaryMap = getInsightMap(insights, 'secondaryCategories');
    var secondaryBody = secondaryMap[secondary];
    return {
      empty: !secondaryBody,
      title: '二级类目概览 · ' + tier + ' / ' + secondary,
      body: secondaryBody || ('当前筛选：' + tier + ' · ' + secondary + '。该二级类目暂无自动洞察，不展示其他二级类目、品类或层级的洞察。'),
      coreCategories: [],
      volatileCategories: [],
      suggestionMetrics: [],
      filteredCount: 0,
      totalGmv: 0,
      showTags: false,
      source: secondaryBody ? 'ai-secondary' : 'empty-secondary',
    };
  }
  if (typeof insights.category === 'string' && insights.category.trim()) {
    return {
      empty: false,
      title: '品类简述概览 · ' + context,
      body: insights.category,
      coreCategories: [],
      volatileCategories: [],
      suggestionMetrics: [],
      filteredCount: 0,
      totalGmv: 0,
      showTags: false,
      source: 'compat-category',
    };
  }
  return null;
}

function categoryName(c) {
  return String(c && (c.category || c.name) || '').trim();
}

function categoryVolatilityScore(c) {
  var score = 0;
  var trend = (c && c.trend) || {};
  var delta = (c && c.delta) || {};
  ['evaRate', 'orderRate', 'shipRate', 'dealRate', 'gmv'].forEach(function(k) {
    var d = Number(delta[k]);
    if (Number.isFinite(d)) score += Math.abs(d);
    var t = trend[k] || {};
    var pct = Number(t.deltaPct);
    if (Number.isFinite(pct)) score += Math.abs(pct);
  });
  return score;
}

function buildCategorySuggestionMetrics(list) {
  var candidates = [
    { key: 'evaRate', trendKey: 'evaUv', label: '估价完成率' },
    { key: 'orderUv', trendKey: 'orderUv', label: '下单UV' },
    { key: 'shipCnt', trendKey: 'shipCnt', label: '发货数' },
    { key: 'dealCnt', trendKey: 'dealCnt', label: '成交订单量' },
    { key: 'gmv', trendKey: 'gmv', label: '成交GMV' },
  ];
  var scored = candidates.map(function(m) {
    var score = 0;
    var available = false;
    (list || []).forEach(function(c) {
      var cur = (c && c.cur) || {};
      var delta = (c && c.delta) || {};
      var trend = (c && c.trend) || {};
      if (cur[m.key] !== undefined || cur[m.trendKey] !== undefined) available = true;
      var d = Number(delta[m.key]);
      if (Number.isFinite(d) && d < 0) score += Math.abs(d);
      var pct = Number((trend[m.trendKey] || {}).deltaPct);
      if (Number.isFinite(pct) && pct < 0) score += Math.abs(pct);
    });
    return { label: m.label, score: score, available: available };
  });
  var highlighted = scored
    .filter(function(m) { return m.score > 0; })
    .sort(function(a, b) { return b.score - a.score; })
    .slice(0, 3)
    .map(function(m) { return m.label; });
  if (highlighted.length) return highlighted;
  return scored
    .filter(function(m) { return m.available; })
    .slice(0, 3)
    .map(function(m) { return m.label; });
}

// ---- 品类表格 ----
var _catSortKey = 'gmv';
var _catSortAsc = false;
var _lastDashCategories = [];
var _lastDashTier = '发展';
var _lastDashSecondary = '';

var DASH_CAT_DEFAULT_COLS = ['board', 'category', 'conditionUv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv'];
var DASH_CAT_COLUMNS = [
  { key: 'board', label: '二级类目', cls: '', note: '品类映射表「二级板块」' },
  { key: 'category', label: '品类', cls: '', note: '品类映射表「三级品类」/ 明细品类名' },
  { key: 'conditionUv', label: '机况UV', cls: 'num', note: '进入机况页去重 UV' },
  { key: 'evaUv', label: '估价UV', cls: 'num', note: '日切片品类维度估价UV去重汇总' },
  { key: 'orderUv', label: '下单UV', cls: 'num', note: '进入下单页去重 UV' },
  { key: 'shipCnt', label: '发货数', cls: 'num', note: '发货订单数日均' },
  { key: 'dealCnt', label: '成交订单量', cls: 'num', note: '成交订单量日均' },
  { key: 'gmv', label: '成交GMV', cls: 'num', note: '成交订单 GMV 日均' },
  { key: 'dealRate', label: '成交率', cls: 'num', note: '成交订单量 / 估价UV' },
  { key: 'orderRate', label: '下单率', cls: 'num', note: '下单UV / 估价UV' },
  { key: 'shipRate', label: '发货率', cls: 'num', note: '发货数 / 估价UV' },
  { key: 'status', label: '状态', cls: '', note: '品类映射表「业务状态」' },
  { key: 'anomalyScore', label: '异常', cls: 'num', note: '转化率下降超过阈值的异常评分' },
];

function getColumnByKey(key) {
  for (var i = 0; i < DASH_CAT_COLUMNS.length; i++) {
    if (DASH_CAT_COLUMNS[i].key === key) return DASH_CAT_COLUMNS[i];
  }
  return null;
}

function getSelectedDashboardColumns() {
  var keys = null;
  try {
    keys = JSON.parse(localStorage.getItem('dashCategoryColumns') || 'null');
  } catch (e) {
    keys = null;
  }
  if (!Array.isArray(keys) || !keys.length) keys = DASH_CAT_DEFAULT_COLS.slice();
  keys = keys.filter(function(k) { return !!getColumnByKey(k); });
  return keys.length ? keys : DASH_CAT_DEFAULT_COLS.slice();
}

function setSelectedDashboardColumns(keys) {
  try {
    localStorage.setItem('dashCategoryColumns', JSON.stringify(keys));
  } catch (e) {}
}

function toggleDashboardColumnPicker() {
  var picker = $('#dashColumnPicker');
  if (!picker) return;
  renderDashboardColumnPicker();
  picker.classList.toggle('hidden');
}

function renderDashboardColumnPicker() {
  var picker = $('#dashColumnPicker');
  if (!picker) return;
  var selected = getSelectedDashboardColumns();
  var selectedMap = {};
  selected.forEach(function(k) { selectedMap[k] = true; });
  picker.innerHTML =
    '<div class="dash-column-picker-title">勾选展示字段</div>' +
    DASH_CAT_COLUMNS.map(function(col) {
      var checked = selectedMap[col.key] ? ' checked' : '';
      return '<label class="dash-column-option">' +
        '<input type="checkbox" value="' + escapeAttr(col.key) + '"' + checked + ' />' +
        '<span>' + escapeHtml(col.label) + '</span>' +
      '</label>';
    }).join('');
  $$('#dashColumnPicker input[type="checkbox"]').forEach(function(input) {
    input.addEventListener('change', function() {
      var next = $$('#dashColumnPicker input[type="checkbox"]')
        .filter(function(el) { return el.checked; })
        .map(function(el) { return el.value; });
      if (!next.length) {
        input.checked = true;
        next = [input.value];
      }
      setSelectedDashboardColumns(next);
      renderCategoryTable(_lastDashCategories, _lastDashTier);
      renderDashboardColumnPicker();
    });
  });
}

function renderCategoryTable(categories, activeTier) {
  categories = categories || [];
  _lastDashCategories = categories;
  _lastDashTier = activeTier || '发展';
  var selectedSecondary = getActiveSecondaryFilter(categories, activeTier);
  _lastDashSecondary = selectedSecondary;
  var titleEl = $('#dashCategoryTitle');
  if (titleEl) {
    titleEl.textContent = selectedSecondary ? ('品类明细 · ' + selectedSecondary) : '品类明细';
  }
  renderCategoryOverview(categories, activeTier);
  var filtered = categories.filter(function(c) {
    return c.tier === activeTier && (!selectedSecondary || getSecondaryCategoryName(c) === selectedSecondary);
  });

  // 排序
  filtered.sort(function(a, b) {
    var va, vb;
    if (_catSortKey === 'category' || _catSortKey === 'board' || _catSortKey === 'status') {
      va = String(a[_catSortKey] || '');
      vb = String(b[_catSortKey] || '');
      return _catSortAsc ? va.localeCompare(vb, 'zh') : vb.localeCompare(va, 'zh');
    }
    if (_catSortKey === 'anomalyScore') {
      va = a.anomalyScore || 0; vb = b.anomalyScore || 0;
    } else {
      va = (a.cur && a.cur[_catSortKey]) || 0;
      vb = (b.cur && b.cur[_catSortKey]) || 0;
    }
    return _catSortAsc ? va - vb : vb - va;
  });

  var thead = $('#dashCategoryTable thead');
  var tbody = $('#dashCategoryTable tbody');

  // 表头
  var cols = getSelectedDashboardColumns().map(getColumnByKey).filter(Boolean);

  thead.innerHTML = '<tr>' + cols.map(function(col) {
    var arrow = _catSortKey === col.key ? (_catSortAsc ? ' ↑' : ' ↓') : '';
    var note = col.note || '';
    var info = note ? ' <span class="dash-th-info" title="' + escapeAttr(note) + '">ⓘ</span>' : '';
    return '<th class="' + col.cls + '" data-sort="' + col.key + '" title="' + escapeAttr(note) + '">' + escapeHtml(col.label) + arrow + info + '</th>';
  }).join('') + '</tr>';

  // 行
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="dash-empty">' + (selectedSecondary ? '该二级类目暂无品类' : '该层暂无品类') + '</td></tr>';
  } else {
    tbody.innerHTML = filtered.map(function(c) {
      var rowCls = (c.anomalyScore >= 2) ? ' class="dash-row-alert"' : '';
      var cells = cols.map(function(col) { return renderCategoryCell(c, col); }).join('');
      return '<tr' + rowCls + ' data-category="' + escapeAttr(c.category) + '">' + cells + '</tr>';
    }).join('');
  }

  // 表头排序事件
  $$('#dashCategoryTable thead th').forEach(function(th) {
    th.addEventListener('click', function() {
      var key = th.dataset.sort;
      if (_catSortKey === key) {
        _catSortAsc = !_catSortAsc;
      } else {
        _catSortKey = key;
        _catSortAsc = key === 'category';
      }
      renderCategoryTable(categories, activeTier);
    });
  });

  // 行点击 drillTo
  $$('#dashCategoryTable tbody tr[data-category]').forEach(function(tr) {
    tr.addEventListener('click', function() {
      drillTo({ tab: 'monitor', category: tr.dataset.category, view: 'pool', from: 'dashboard' });
    });
  });
}

function renderCategoryCell(c, col) {
  if (col.key === 'category') return '<td>' + escapeHtml(c.category) + '</td>';
  if (col.key === 'board') return '<td>' + escapeHtml(c.board || c.secondaryCategory || '') + '</td>';
  if (col.key === 'status') return '<td>' + escapeHtml(c.status || '') + '</td>';
  if (col.key === 'anomalyScore') return '<td class="num">' + anomalyDots(c.anomalyScore) + '</td>';
  if (col.key === 'gmv') {
    var dGmv = c.delta ? fmtDeltaArrow(c.delta.gmv) : '';
    return '<td class="num">' + fmtGmvShort(c.cur.gmv) + ' ' + (fmtTrendPill(c.trend && c.trend.gmv) || dGmv) + '</td>';
  }
  if (isCountKey(col.key)) {
    var countVal = c.cur[col.key];
    if (col.key === 'conditionUv' && countVal == null) countVal = c.cur.jkuv;
    return '<td class="num">' + fmtCountShort(countVal) + fmtTrendPill(c.trend && c.trend[col.key]) + '</td>';
  }
  var val = c.cur[col.key];
  var delta = c.delta ? fmtDeltaArrow(c.delta[col.key]) : '';
  return '<td class="num">' + fmtRate(val) + ' ' + delta + '</td>';
}

function isCountKey(key) {
  return ['aggregationUv', 'brandPageUv', 'modelPageUv', 'conditionUv', 'jkuv', 'evaUv', 'orderUv', 'orderCnt', 'shipCnt', 'dealCnt'].indexOf(key) >= 0;
}

// ---- 导出纯函数供 Node 测试 ----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fmtGmvShort: fmtGmvShort,
    fmtCountShort: fmtCountShort,
    fmtDeltaArrow: fmtDeltaArrow,
    renderAnalysisStatusBadges: renderAnalysisStatusBadges,
    renderRichInsightHtml: renderRichInsightHtml,
    localizeDashInsightMetricLabels: localizeDashInsightMetricLabels,
    anomalyDots: anomalyDots,
    buildTierOverviewModel: buildTierOverviewModel,
    buildCategoryOverviewModel: buildCategoryOverviewModel,
    buildAiCategoryOverviewModel: buildAiCategoryOverviewModel,
    filterCategoryOverviewList: filterCategoryOverviewList,
  };
}

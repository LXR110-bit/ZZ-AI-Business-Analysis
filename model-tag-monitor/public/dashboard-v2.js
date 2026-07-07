// dashboard-v2.js — 概览页 v2 四层渲染逻辑
// 依赖 app.js 中的全局函数: escapeHtml, escapeAttr, fmtRate, fmtInt, $, $$, readUrlState, writeUrlState, drillTo

// ---- 格式化工具 ----
function fmtGmvShort(v) {
  var n = Number(v) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}

function fmtDeltaArrow(v) {
  if (v === null || v === undefined) return '';
  var n = Number(v);
  if (!Number.isFinite(n)) return '';
  var sign = n >= 0 ? '▲' : '▼';
  var cls = n >= 0 ? 'up' : 'down';
  return '<span class="dash-ts-delta ' + cls + '">' + sign + (Math.abs(n) * 100).toFixed(1) + '%</span>';
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

// ---- Meta 行 ----
function renderDashboardMetaV2(d) {
  var t = d.syncedAt ? new Date(d.syncedAt).toLocaleString('zh-CN') : '-';
  $('#dashMeta').innerHTML =
    '<span class="dash-meta-week">' + escapeHtml(d.week || '-') + '</span>' +
    (d.weekRange ? '<span class="dash-meta-sep">·</span><span>' + escapeHtml(d.weekRange) + '</span>' : '') +
    '<span class="dash-meta-sep">·</span>' +
    '<span>同步于 ' + escapeHtml(t) + '</span>';
}

// ---- 大盘 KPI 卡 ----
function renderBoardKpi(board) {
  var c = board.cur;
  var d = board.delta;
  var cards = [
    { label: 'GMV', value: fmtGmvShort(c.gmv), delta: fmtDeltaArrow(d.gmv) },
    { label: '估价率', value: fmtRate(c.evaRate), delta: fmtDeltaArrow(d.evaRate) },
    { label: '下单率', value: fmtRate(c.orderRate), delta: fmtDeltaArrow(d.orderRate) },
    { label: '成交率', value: fmtRate(c.dealRate), delta: fmtDeltaArrow(d.dealRate) },
  ];
  $('#dashBoardKpi').innerHTML = cards.map(function(item) {
    return '<div class="dash-kpi">' +
      '<div class="dash-kpi-label">' + escapeHtml(item.label) + '</div>' +
      '<div class="dash-kpi-value">' + escapeHtml(item.value) + '</div>' +
      '<div class="dash-kpi-sub">' + item.delta + '</div>' +
    '</div>';
  }).join('');
}

// ---- 胶囊 Tab 状态 ----
function setActiveTierTab(tier) {
  $$('#dashTierTabs .dash-tier-tab').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.tier === tier);
  });
}

// ---- Tier 汇总条 ----
function renderTierSummary(tiers, activeTier) {
  var t = null;
  for (var i = 0; i < tiers.length; i++) {
    if (tiers[i].tier === activeTier) { t = tiers[i]; break; }
  }
  if (!t) {
    $('#dashTierSummary').innerHTML = '';
    return;
  }
  var c = t.cur;
  var d = t.delta;
  var items = [
    { label: '品类数', value: String(c.categoryCount || 0), delta: '' },
    { label: 'GMV', value: fmtGmvShort(c.gmv), delta: fmtDeltaArrow(d.gmv) },
    { label: '估价率', value: fmtRate(c.evaRate), delta: fmtDeltaArrow(d.evaRate) },
    { label: '下单率', value: fmtRate(c.orderRate), delta: fmtDeltaArrow(d.orderRate) },
    { label: '成交率', value: fmtRate(c.dealRate), delta: fmtDeltaArrow(d.dealRate) },
  ];
  $('#dashTierSummary').innerHTML = items.map(function(it) {
    return '<div class="dash-ts-item">' +
      '<span class="dash-ts-label">' + escapeHtml(it.label) + '</span>' +
      '<span class="dash-ts-value">' + escapeHtml(it.value) + '</span>' +
      it.delta +
    '</div>';
  }).join('');
}

// ---- 品类表格 ----
var _catSortKey = 'gmv';
var _catSortAsc = false;

function renderCategoryTable(categories, activeTier) {
  var mode = ($('#dashViewToggle') || {}).dataset && $('#dashViewToggle').dataset.mode || 'compact';
  var filtered = categories.filter(function(c) { return c.tier === activeTier; });

  // 排序
  filtered.sort(function(a, b) {
    var va, vb;
    if (_catSortKey === 'category') {
      va = a.category; vb = b.category;
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
  var compactCols = [
    { key: 'category', label: '品类', cls: '' },
    { key: 'gmv', label: 'GMV', cls: 'num' },
    { key: 'evaRate', label: '估价率', cls: 'num' },
    { key: 'orderRate', label: '下单率', cls: 'num' },
    { key: 'dealRate', label: '成交率', cls: 'num' },
    { key: 'anomalyScore', label: '异常', cls: 'num' },
  ];
  var detailCols = [
    { key: 'category', label: '品类', cls: '' },
    { key: 'board', label: '看板', cls: '' },
    { key: 'status', label: '状态', cls: '' },
    { key: 'gmv', label: 'GMV', cls: 'num' },
    { key: 'evaRate', label: '估价率', cls: 'num' },
    { key: 'orderRate', label: '下单率', cls: 'num' },
    { key: 'shipRate', label: '发货率', cls: 'num' },
    { key: 'dealRate', label: '成交率', cls: 'num' },
    { key: 'anomalyScore', label: '异常', cls: 'num' },
  ];
  var cols = mode === 'detail' ? detailCols : compactCols;

  thead.innerHTML = '<tr>' + cols.map(function(col) {
    var arrow = _catSortKey === col.key ? (_catSortAsc ? ' ↑' : ' ↓') : '';
    return '<th class="' + col.cls + '" data-sort="' + col.key + '">' + escapeHtml(col.label) + arrow + '</th>';
  }).join('') + '</tr>';

  // 行
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="' + cols.length + '" class="dash-empty">该层暂无品类</td></tr>';
  } else {
    tbody.innerHTML = filtered.map(function(c) {
      var rowCls = (c.anomalyScore >= 2) ? ' class="dash-row-alert"' : '';
      var cells = cols.map(function(col) {
        if (col.key === 'category') return '<td>' + escapeHtml(c.category) + '</td>';
        if (col.key === 'board') return '<td>' + escapeHtml(c.board || '') + '</td>';
        if (col.key === 'status') return '<td>' + escapeHtml(c.status || '') + '</td>';
        if (col.key === 'anomalyScore') return '<td class="num">' + anomalyDots(c.anomalyScore) + '</td>';
        if (col.key === 'gmv') {
          var dGmv = c.delta ? fmtDeltaArrow(c.delta.gmv) : '';
          return '<td class="num">' + fmtGmvShort(c.cur.gmv) + ' ' + dGmv + '</td>';
        }
        // rate 列
        var val = c.cur[col.key];
        var delta = c.delta ? fmtDeltaArrow(c.delta[col.key]) : '';
        return '<td class="num">' + fmtRate(val) + ' ' + delta + '</td>';
      }).join('');
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

// ---- 导出纯函数供 Node 测试 ----
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { fmtGmvShort: fmtGmvShort, fmtDeltaArrow: fmtDeltaArrow, anomalyDots: anomalyDots };
}

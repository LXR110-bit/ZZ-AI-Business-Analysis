// 前端应用
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

// ---- 通用工具 ----
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function getUserName() {
  return localStorage.getItem('userName') || '';
}
function setUserName(v) {
  localStorage.setItem('userName', v || '');
}

async function api(url, opts = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-User': getUserName() || 'anonymous', ...(opts.headers || {}) };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`${res.status} ${err}`);
  }
  return res.json();
}

function fmtInt(v) {
  if (v === null || v === undefined || v === '') return '-';
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function fmtRate(v) {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return (n * 100).toFixed(2) + '%';
}

function fmtDelta(v) {
  if (v === null || v === undefined) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const sign = n > 0 ? '+' : '';
  return sign + (n * 100).toFixed(1) + '%';
}

function keyOf(cat, model) { return `${cat}||${model}`; }

// ---- 全局状态 ----
const state = {
  meta: null,
  tags: {},
  vocab: null,
  rules: null,
  monitor: null,
};

// ---- Tab 切换 ----
function activateTab(name, opts = {}) {
  if (!$('#page-' + name)) return;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.page').forEach((p) => p.classList.toggle('hidden', p.id !== 'page-' + name));
  if (name === 'dashboard') refreshDashboard();
  if (name === 'monitor') refreshMonitor();
  if (name === 'tags') refreshTagsPage();
  if (name === 'rules') fillRulesForm();
  if (name === 'logs') refreshLogs();
  if (!opts.skipUrl) writeUrlState({ tab: name });
}

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    // 用户手动切 tab：清掉 dashboard 传下来的 highlight/from
    clearDashboardContext();
    activateTab(name);
  });
});

// ---- 初始化 ----
async function init() {
  $('#userName').value = getUserName();
  $('#userName').addEventListener('change', (e) => setUserName(e.target.value));

  $('#btnSync').addEventListener('click', doSync);
  $('#btnExport').addEventListener('click', doExport);
  $('#fileImport').addEventListener('change', doImport);
  // 监测页：改任意 filter 立即生效；确认按钮作为手动刷新入口
  // 手改任一 filter 都会断掉 dashboard 传下来的 highlight/from
  const applyMonitor = () => {
    clearDashboardContext();
    markFilterApplied('monitor');
    refreshMonitor();
    writeUrlState({
      tab: 'monitor',
      week: $('#monitorWeek').value || null,
      category: $('#monitorCategory').value || null,
      view: $('#monitorView').value || null,
      trend: $('#monitorTrend').value || null,
    });
  };
  $('#btnMonitorRun').addEventListener('click', applyMonitor);
  ['monitorCategory', 'monitorWeek', 'monitorView', 'monitorTrend'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.addEventListener('change', applyMonitor);
  });
  // 面包屑
  $('#crumbBack').addEventListener('click', () => {
    clearDashboardContext();
    activateTab('dashboard');
  });
  $('#crumbClear').addEventListener('click', () => {
    clearDashboardContext();
    refreshMonitor();
  });

  // 标签管理页：品类改立即生效；搜索框输入时暂缓，回车或点确认应用
  const applyTags = () => { markFilterApplied('tags'); refreshTagsPage(); };
  $('#btnTagsRun').addEventListener('click', applyTags);
  $('#tagsCategory').addEventListener('change', applyTags);
  $('#tagsSearch').addEventListener('input', () => markFilterDirty('tags'));
  $('#tagsSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTags();
  });
  $('#btnEditVocab').addEventListener('click', openVocabModal);

  $('#rulesForm').addEventListener('submit', saveRules);

  $('#btnModalCancel').addEventListener('click', () => $('#modalTag').classList.add('hidden'));
  $('#btnModalSave').addEventListener('click', saveTagModal);
  $('#btnVocabCancel').addEventListener('click', () => $('#modalVocab').classList.add('hidden'));
  $('#btnVocabSave').addEventListener('click', saveVocab);
  $('#btnVocabAddCat').addEventListener('click', () => addVocabCat('', ''));

  await loadMeta();
  await loadTags();
  await loadVocab();
  await loadRules();

  // 根据 URL 决定初始 tab；先把 select 预填成 URL 参数（monitor 页需要）
  const st = readUrlState();
  applyStateToMonitorSelects(st);
  activateTab(st.tab || 'dashboard', { skipUrl: true });

  // popstate：前进后退时同步 UI
  window.addEventListener('popstate', () => {
    const s = readUrlState();
    applyStateToMonitorSelects(s);
    activateTab(s.tab || 'dashboard', { skipUrl: true });
  });
}

async function loadMeta() {
  try {
    state.meta = await api('/api/meta');
    updateMetaBar();
  } catch (e) {
    toast('加载 meta 失败: ' + e.message);
  }
}

function updateMetaBar() {
  const m = state.meta;
  if (!m || !m.synced) {
    $('#meta').textContent = '尚未同步数据';
    return;
  }
  const t = new Date(m.syncedAt);
  const src = m.source?.title ? `${m.source.title} / ${m.source.sheetTitle || ''}`.replace(/\s\/\s$/, '') : '';
  $('#meta').textContent = `${src ? src + ' · ' : ''}${m.rowCount} 行 · ${m.categories.length} 品类 · ${m.weeks.length} 周 · 同步于 ${t.toLocaleString('zh-CN')}`;

  // 填充 select
  const wSel = $('#monitorWeek');
  wSel.innerHTML = m.weeks.map((w) => `<option value="${w}">${w}</option>`).join('');
  wSel.value = m.weeks[m.weeks.length - 1] || '';

  const cSel = $('#monitorCategory');
  cSel.innerHTML = '<option value="">全部品类</option>' + m.categories.map((c) => `<option value="${c}">${c}</option>`).join('');

  const tcSel = $('#tagsCategory');
  tcSel.innerHTML = m.categories.map((c) => `<option value="${c}">${c}</option>`).join('');
}

async function loadTags() {
  state.tags = await api('/api/tags');
}
async function loadVocab() {
  state.vocab = await api('/api/tag-vocab');
}
async function loadRules() {
  state.rules = await api('/api/rules');
}

// ---- 同步 ----
async function doSync() {
  if (!confirm('从飞书拉最新数据?此操作会覆盖本地缓存。')) return;
  const btn = $('#btnSync');
  btn.disabled = true;
  btn.textContent = '同步中...';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    toast(`同步完成:${r.rows} 行 · ${r.categories} 品类 · ${r.weeks} 周`);
    await loadMeta();
    refreshMonitor();
  } catch (e) {
    toast('同步失败: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '同步飞书数据';
  }
}

// ---- 监测结果 ----
async function refreshMonitor() {
  const m = state.meta;
  if (!m || !m.synced) {
    $('#monitorTable thead').innerHTML = '';
    $('#monitorTable tbody').innerHTML = '<tr><td colspan="99">尚未同步数据,请先点顶部"同步飞书数据"。</td></tr>';
    $('#monitorSummary').textContent = '';
    return;
  }
  // loading 态:响应体积较大(压缩前约 2.8MB),提前给用户反馈
  $('#monitorTable thead').innerHTML = '';
  $('#monitorTable tbody').innerHTML = '<tr><td colspan="99" style="padding:24px;text-align:center;color:#888">正在计算监测结果…</td></tr>';
  $('#monitorSummary').textContent = '加载中…';
  try {
    const w = ($('#monitorWeek') && $('#monitorWeek').value) || '';
    const qs = w ? `?week=${encodeURIComponent(w)}` : '';
    const t0 = Date.now();
    state.monitor = await api('/api/monitor' + qs);
    console.log('[monitor] 加载耗时', Date.now() - t0, 'ms');
  } catch (e) {
    $('#monitorTable tbody').innerHTML = `<tr><td colspan="99" style="padding:24px;text-align:center;color:#c33">监测失败: ${e.message}</td></tr>`;
    $('#monitorSummary').textContent = '';
    toast('监测失败: ' + e.message);
    return;
  }
  renderMonitor();
  updateBreadcrumb();
  handleHighlightAfterRender();
}

function renderMonitor() {
  const r = state.monitor;
  if (!r) return;
  const cat = $('#monitorCategory').value;
  const view = $('#monitorView').value;
  const trend = ($('#monitorTrend') && $('#monitorTrend').value) || '';
  const list = view === 'watch' ? r.watchList : r.pool;
  let filtered = cat ? list.filter((x) => x.category === cat) : list;
  if (trend === 'up') {
    filtered = filtered.filter((x) => x.delta && typeof x.delta.orderRate === 'number' && x.delta.orderRate > 0);
  } else if (trend === 'down') {
    filtered = filtered.filter((x) => x.delta && typeof x.delta.orderRate === 'number' && x.delta.orderRate < 0);
  }

  const rates = r.rules.rates;

  // ---- KPI 概览 ----
  const total = r.pool.length;
  const watchAll = r.watchList.length;
  const waveCnt = r.watchList.filter((x) => (x.flags || []).some((f) => f.type === 'wave')).length;
  const trendCnt = r.watchList.filter((x) => (x.flags || []).some((f) => f.type === 'trend')).length;
  const downTrendCnt = r.watchList.filter((x) => (x.flags || []).some((f) => f.type === 'trend' && f.direction === 'down')).length;

  $('#monitorSummary').innerHTML = `
    <div class="kpi-row">
      <div class="kpi">
        <span class="kpi-label">目标周</span>
        <span class="kpi-value mono">${r.targetWeek || '-'}</span>
        ${r.prevWeek ? `<span class="kpi-sub">对比 ${r.prevWeek}</span>` : ''}
      </div>
      <div class="kpi">
        <span class="kpi-label">监测池</span>
        <span class="kpi-value mono">${total}</span>
        <span class="kpi-sub">机型</span>
      </div>
      <div class="kpi ${watchAll ? 'kpi-warn' : ''}">
        <span class="kpi-label">需关注</span>
        <span class="kpi-value mono">${watchAll}</span>
        <span class="kpi-sub">共 ${total ? Math.round((watchAll / total) * 100) : 0}%</span>
      </div>
      <div class="kpi ${waveCnt ? 'kpi-warn' : ''}">
        <span class="kpi-label">大幅波动</span>
        <span class="kpi-value mono">${waveCnt}</span>
        <span class="kpi-sub">周环比超阈</span>
      </div>
      <div class="kpi ${downTrendCnt ? 'kpi-danger' : ''}">
        <span class="kpi-label">连续下滑</span>
        <span class="kpi-value mono">${downTrendCnt}</span>
        <span class="kpi-sub">同向 ${r.rules.trendWeeks}+ 周</span>
      </div>
    </div>
  `;

  const thead = $('#monitorTable thead');
  thead.innerHTML = `
    <tr class="head-group">
      <th colspan="3" class="grp grp-basic">机型信息</th>
      <th colspan="7" class="grp grp-vol">用量 &amp; 成交</th>
      <th colspan="${rates.length}" class="grp grp-rate">关键转化率（周环比 / 趋势）</th>
      <th colspan="2" class="grp grp-flag">异常 &amp; 操作</th>
    </tr>
    <tr>
      <th class="row-status" aria-label="状态"></th>
      <th>品类</th>
      <th>机型</th>
      <th class="num" title="周汇总 / 已收到天数">估价UV<sub class="mut">/日</sub></th>
      <th class="num" title="周日均">机况UV<sub class="mut">/日</sub></th>
      <th class="num" title="周日均">下单UV<sub class="mut">/日</sub></th>
      <th class="num" title="周日均">发货<sub class="mut">/日</sub></th>
      <th class="num" title="周日均">质检<sub class="mut">/日</sub></th>
      <th class="num" title="周日均">成交<sub class="mut">/日</sub></th>
      <th class="num" title="周日均 GMV">GMV<sub class="mut">/日</sub></th>
      ${rates.map((x) => `<th class="rate">${x.name}</th>`).join('')}
      <th>关注原因 &amp; 标签</th>
      <th>操作</th>
    </tr>
  `;
  const tbody = $('#monitorTable tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="99" class="empty-cell">没有匹配的机型 · 换个视图或先做一次「同步飞书数据」</td></tr>`;
  } else {
    tbody.innerHTML = filtered
      .map((row) => renderMonitorRow(row, rates, r.rules.waveThreshold))
      .join('');
    $$('#monitorTable button.edit-tag').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openTagModal(b.dataset.cat, b.dataset.model);
      });
    });
    $$('#monitorTable tbody tr[data-model-id]').forEach((tr) => {
      tr.addEventListener('click', () => {
        openModelDrawer({ category: tr.dataset.category, modelName: tr.dataset.modelName });
      });
    });
  }
}

function renderMonitorRow(row, rates, waveThreshold) {
  const cur = row.cur || {};
  const delta = row.delta || {};
  const trend = row.trend || {};

  // 行级严重度：有连续下滑 = danger, 有波动 = warn, 无 = normal
  const flags = row.flags || [];
  const hasDownTrend = flags.some((f) => f.type === 'trend' && f.direction === 'down');
  const hasUpTrend = flags.some((f) => f.type === 'trend' && f.direction === 'up');
  const hasWave = flags.some((f) => f.type === 'wave');
  let sev = 'ok';
  if (hasDownTrend) sev = 'danger';
  else if (hasWave || hasUpTrend) sev = 'warn';

  const flagsHtml = flags
    .map((f) => {
      if (f.type === 'wave') return `<span class="chip watch" title="周环比波动">⚡ ${escapeHtml(f.name)} ${fmtDelta(f.delta)}</span>`;
      if (f.type === 'trend') {
        const dirCls = f.direction === 'down' ? 'core' : 'long';
        const arrow = f.direction === 'up' ? '↑' : '↓';
        return `<span class="chip ${dirCls}" title="连续同向">${arrow} ${escapeHtml(f.name)} 连续${f.weeks || ''}周</span>`;
      }
      return '';
    })
    .join('');
  const tagsHtml = (row.tags || []).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('');
  const flagAndTag = `
    <div class="flag-cell">
      ${flagsHtml || '<span class="chip ok">正常</span>'}
      ${tagsHtml ? `<div class="tag-line">${tagsHtml}</div>` : ''}
    </div>
  `;

  const rateCells = rates
    .map(({ key }) => {
      const rate = cur[key];
      const d = delta[key];
      const t = trend[key];
      let cls = 'rate';
      const strongWave = typeof d === 'number' && Math.abs(d) >= waveThreshold;
      if (strongWave) cls += d < 0 ? ' warn-down' : ' warn-up';
      if (t === 'up') cls += ' trend-up';
      if (t === 'down') cls += ' trend-down';
      const deltaStr = typeof d === 'number'
        ? ` <span class="${d > 0 ? 'delta-up' : 'delta-down'}">${fmtDelta(d)}</span>`
        : '';
      return `<td class="${cls}">${fmtRate(rate)}${deltaStr}</td>`;
    })
    .join('');
  const modelId = cur.modelId || '';
  return `
    <tr class="row-${sev}" data-model-id="${escapeAttr(modelId)}" data-model-name="${escapeAttr(row.modelName)}" data-category="${escapeAttr(row.category)}">
      <td class="row-status" aria-label="严重度"></td>
      <td class="cat-cell">${escapeHtml(row.category)}</td>
      <td class="model-cell"><strong>${escapeHtml(row.modelName)}</strong></td>
      <td class="num">${fmtInt(cur.evaUv)}</td>
      <td class="num">${fmtInt(cur.jkuv)}</td>
      <td class="num">${fmtInt(cur.orderUv)}</td>
      <td class="num">${fmtInt(cur.shipCnt)}</td>
      <td class="num">${fmtInt(cur.qcCnt)}</td>
      <td class="num">${fmtInt(cur.dealCnt)}</td>
      <td class="num">${fmtInt(cur.gmv)}</td>
      ${rateCells}
      <td>${flagAndTag}</td>
      <td><button class="edit-tag" data-cat="${escapeAttr(row.category)}" data-model="${escapeAttr(row.modelName)}">打标签 →</button></td>
    </tr>
  `;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ---- 标签管理页 ----
function refreshTagsPage() {
  const m = state.meta;
  if (!m || !m.synced) {
    $('#tagsTable thead').innerHTML = '';
    $('#tagsTable tbody').innerHTML = '<tr><td colspan="99">尚未同步数据。</td></tr>';
    return;
  }
  const cat = $('#tagsCategory').value || m.categories[0];
  const kw = ($('#tagsSearch').value || '').trim().toLowerCase();
  // 从 monitor pool 里的机型无法覆盖全量,直接用元数据 + 按当前周汇总
  // 简化:从 state.monitor.pool 里取,若没有就调 /api/data
  fetch(`/api/data?category=${encodeURIComponent(cat)}`)
    .then((r) => r.json())
    .then((d) => {
      // 只取每个机型最新周
      const weeksSorted = (m.weeks || []).slice().sort();
      const latest = weeksSorted[weeksSorted.length - 1];
      const modelMap = new Map();
      for (const row of d.rows) {
        const cur = modelMap.get(row.modelName);
        if (!cur || row.week > cur.week) modelMap.set(row.modelName, row);
      }
      const rows = [...modelMap.values()]
        .filter((r) => !kw || r.modelName.toLowerCase().includes(kw))
        .sort((a, b) => (b.evaUv || 0) - (a.evaUv || 0));

      const thead = $('#tagsTable thead');
      thead.innerHTML = `<tr>
        <th>机型</th><th>最新周</th><th class="num">估价UV<sub class="mut">/日</sub></th><th class="num">下单UV<sub class="mut">/日</sub></th><th class="num">成交量<sub class="mut">/日</sub></th>
        <th>标签</th><th>备注</th><th>操作</th>
      </tr>`;
      const tbody = $('#tagsTable tbody');
      tbody.innerHTML = rows
        .map((r) => {
          const k = keyOf(cat, r.modelName);
          const t = state.tags[k] || { tags: [], note: '' };
          return `<tr>
            <td>${escapeHtml(r.modelName)}</td>
            <td>${r.week}</td>
            <td class="num">${fmtInt(r.evaUv)}</td>
            <td class="num">${fmtInt(r.orderUv)}</td>
            <td class="num">${fmtInt(r.dealCnt)}</td>
            <td>${(t.tags || []).map((x) => `<span class="chip">${escapeHtml(x)}</span>`).join('') || '<span class="chip empty-chip">未打标</span>'}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;color:var(--c-text-2);">${escapeHtml(t.note || '')}</td>
            <td><button class="edit-tag" data-cat="${escapeAttr(cat)}" data-model="${escapeAttr(r.modelName)}">打标签 →</button></td>
          </tr>`;
        })
        .join('') || `<tr><td colspan="99" style="text-align:center;padding:20px;color:#9ca3af;">该品类下无机型</td></tr>`;
      $$('#tagsTable button.edit-tag').forEach((b) => {
        b.addEventListener('click', () => openTagModal(b.dataset.cat, b.dataset.model));
      });
      $('#tagsSummary').textContent = `${cat}: ${rows.length} 个机型 (仅显示最新周有数据的)`;
    })
    .catch((e) => toast('加载失败: ' + e.message));
}

// ---- 标签编辑弹层 ----
let modalCtx = null;
function openTagModal(cat, model) {
  modalCtx = { cat, model };
  $('#modalTagTitle').textContent = `${cat} · ${model}`;
  const key = keyOf(cat, model);
  const cur = state.tags[key] || { tags: [], note: '' };
  const selected = new Set(cur.tags || []);
  const v = state.vocab || {};
  const groups = [
    { title: '生命周期', options: v.lifecycle || [] },
    { title: '价格段', options: v.price || [] },
    { title: '核心度', options: v.core || [] },
    { title: `${cat} 自定义`, options: (v.custom && v.custom[cat]) || [] },
  ];
  const box = $('#modalTagGroups');
  box.innerHTML = groups
    .map(
      (g) => `<div>
      <div class="group-title">${g.title}</div>
      <div class="options">
        ${g.options.length
          ? g.options.map((o) => `<button type="button" class="tag-opt${selected.has(o) ? ' selected' : ''}" data-tag="${escapeAttr(o)}">${escapeHtml(o)}</button>`).join('')
          : '<span style="color:#d1d5db;font-size:12px;">(空)</span>'}
      </div>
    </div>`
    )
    .join('');
  $$('#modalTagGroups .tag-opt').forEach((btn) => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'));
  });
  $('#modalTagNote').value = cur.note || '';
  $('#modalTag').classList.remove('hidden');
}

async function saveTagModal() {
  if (!modalCtx) return;
  const tags = $$('#modalTagGroups .tag-opt.selected').map((b) => b.dataset.tag);
  const note = $('#modalTagNote').value;
  const key = keyOf(modalCtx.cat, modalCtx.model);
  try {
    await api('/api/tags/' + encodeURIComponent(key), {
      method: 'PUT',
      body: JSON.stringify({ tags, note }),
    });
    state.tags[key] = { tags, note };
    toast('已保存');
    $('#modalTag').classList.add('hidden');
    // 刷新当前页
    if (!$('#page-monitor').classList.contains('hidden')) renderMonitor();
    if (!$('#page-tags').classList.contains('hidden')) refreshTagsPage();
  } catch (e) {
    toast('保存失败: ' + e.message);
  }
}

// ---- 标签字典 ----
function openVocabModal() {
  const v = state.vocab || {};
  $$('#modalVocab .vocab-groups textarea').forEach((ta) => {
    const k = ta.dataset.key;
    ta.value = (v[k] || []).join('\n');
  });
  // 灌品类建议(来自元数据)
  try {
    const dl = $('#modelListSuggest');
    if (dl) {
      const cats = (state.meta && state.meta.categories) || [];
      dl.innerHTML = cats.map((c) => `<option value="${escapeAttr(c)}"></option>`).join('');
    }
  } catch {}
  const box = $('#vocabCustom');
  box.innerHTML = '';
  const cats = Object.keys(v.custom || {});
  if (!cats.length) addVocabCat('', '');
  else cats.forEach((c) => addVocabCat(c, (v.custom[c] || []).join('\n')));
  $('#modalVocab').classList.remove('hidden');
}

function addVocabCat(name, text) {
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.innerHTML = `
    <input class="cat-name" placeholder="品类名（如 iPhone / iPad）" list="modelListSuggest" value="${escapeAttr(name)}" />
    <textarea class="cat-tags" rows="2" placeholder="每行一个标签，例如：核心机、40系、旧品">${escapeHtml(text)}</textarea>
    <span class="del" title="删除">×</span>
  `;
  row.querySelector('.del').addEventListener('click', () => row.remove());
  $('#vocabCustom').appendChild(row);
}

async function saveVocab() {
  const v = {};
  $$('#modalVocab .vocab-groups textarea').forEach((ta) => {
    v[ta.dataset.key] = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
  });
  const custom = {};
  $$('#vocabCustom .cat-row').forEach((row) => {
    const name = row.querySelector('.cat-name').value.trim();
    if (!name) return;
    const list = row.querySelector('.cat-tags').value.split('\n').map((s) => s.trim()).filter(Boolean);
    custom[name] = list;
  });
  v.custom = custom;
  try {
    const r = await api('/api/tag-vocab', { method: 'PUT', body: JSON.stringify(v) });
    state.vocab = r.vocab;
    toast('字典已保存');
    $('#modalVocab').classList.add('hidden');
  } catch (e) {
    toast('保存失败: ' + e.message);
  }
}

// ---- 规则 ----
function fillRulesForm() {
  const r = state.rules || {};
  const f = $('#rulesForm');
  f.elements['poolTopN'].value = r.poolTopN ?? 20;
  f.elements['waveThreshold'].value = r.waveThreshold ?? 0.1;
  f.elements['trendWeeks'].value = r.trendWeeks ?? 3;
  f.elements['minEvaUv'].value = r.minEvaUv ?? 15;
}

async function saveRules(e) {
  e.preventDefault();
  const f = e.target;
  const body = {
    poolTopN: Number(f.elements['poolTopN'].value),
    waveThreshold: Number(f.elements['waveThreshold'].value),
    trendWeeks: Number(f.elements['trendWeeks'].value),
    minEvaUv: Number(f.elements['minEvaUv'].value),
  };
  try {
    const r = await api('/api/rules', { method: 'PUT', body: JSON.stringify(body) });
    state.rules = r.rules;
    toast('规则已保存');
  } catch (e) {
    toast('保存失败: ' + e.message);
  }
}

// ---- 导入导出 ----
async function doExport() {
  const [tags, vocab, rules] = await Promise.all([
    api('/api/tags'),
    api('/api/tag-vocab'),
    api('/api/rules'),
  ]);
  const bundle = { version: 1, exportedAt: new Date().toISOString(), tags, vocab, rules };
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `model-tag-config-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function doImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const bundle = JSON.parse(reader.result);
      if (!bundle.tags && !bundle.vocab && !bundle.rules) throw new Error('文件格式不对');
      if (!confirm(`导入配置(合并模式)?\n标签: ${Object.keys(bundle.tags || {}).length} 个机型\n字典/规则一并导入`)) return;
      if (bundle.tags) await api('/api/tags/import', { method: 'POST', body: JSON.stringify({ data: bundle.tags, mode: 'merge' }) });
      if (bundle.vocab) await api('/api/tag-vocab', { method: 'PUT', body: JSON.stringify(bundle.vocab) });
      if (bundle.rules) await api('/api/rules', { method: 'PUT', body: JSON.stringify(bundle.rules) });
      await loadTags();
      await loadVocab();
      await loadRules();
      toast('导入完成');
      refreshMonitor();
    } catch (err) {
      toast('导入失败: ' + err.message);
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

// ---- 日志 ----
async function refreshLogs() {
  const logs = await api('/api/logs?limit=200');
  const tbody = $('#logsTable tbody');
  tbody.innerHTML = logs
    .map((l) => `<tr>
      <td>${l.ts ? new Date(l.ts).toLocaleString('zh-CN') : '-'}</td>
      <td>${escapeHtml(l.user || '-')}</td>
      <td>${escapeHtml(l.action || '-')}</td>
      <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(JSON.stringify({ ...l, ts: undefined, user: undefined, action: undefined }))}</td>
    </tr>`)
    .join('') || '<tr><td colspan="4" style="text-align:center;color:#9ca3af;padding:20px;">暂无日志</td></tr>';
}

// ---- 筛选态：dirty / applied ----
function markFilterDirty(scope) {
  const btn = document.getElementById(scope === 'monitor' ? 'btnMonitorRun' : 'btnTagsRun');
  if (btn) { btn.classList.add('is-dirty'); btn.textContent = '确认 →'; }
}
function markFilterApplied(scope) {
  const btn = document.getElementById(scope === 'monitor' ? 'btnMonitorRun' : 'btnTagsRun');
  if (btn) { btn.classList.remove('is-dirty'); btn.textContent = '确认'; }
}

// ============================================================================
// 概览页 · dashboard
// ============================================================================
let dashState = null;

async function refreshDashboard() {
  const wrap = $('#dashKpiRow');
  const line = $('#dashLineWrap');
  const donut = $('#dashDonutWrap');
  const topTb = $('#dashTopTable tbody');
  const meta = $('#dashMeta');
  try {
    if (!state.meta || !state.meta.synced) {
      meta.innerHTML = '';
      wrap.innerHTML = '';
      line.innerHTML = '';
      donut.innerHTML = '';
      topTb.innerHTML = `<tr><td colspan="5" class="dash-empty">尚未同步数据 · 请先点顶部「同步飞书数据」</td></tr>`;
      return;
    }
    const d = await api('/api/dashboard');
    dashState = d;
    renderDashboardMeta(d);
    renderDashboardKpi(d);
    renderDashboardLine(d);
    renderDashboardDonut(d);
    renderDashboardTop(d);
  } catch (e) {
    console.error('[dashboard] failed', e);
    topTb.innerHTML = `<tr><td colspan="5" class="dash-empty">加载失败: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function renderDashboardMeta(d) {
  const t = d.meta.syncedAt ? new Date(d.meta.syncedAt).toLocaleString('zh-CN') : '-';
  $('#dashMeta').innerHTML = `
    <span class="dash-meta-week">${escapeHtml(d.meta.latestWeek || '-')}</span>
    ${d.meta.weekRange ? `<span class="dash-meta-sep">·</span><span>${escapeHtml(d.meta.weekRange)}</span>` : ''}
    <span class="dash-meta-sep">·</span>
    <span>共 ${d.meta.totalWeeks} 周历史</span>
    <span class="dash-meta-sep">·</span>
    <span>同步于 ${escapeHtml(t)}</span>
    <button class="dash-meta-cta" id="dashEnterMonitor">进入监测详情 →</button>
  `;
  $('#dashEnterMonitor').addEventListener('click', () => {
    drillTo({ tab: 'monitor', week: d.meta.latestWeek, view: 'watch', from: 'dashboard' });
  });
}

function renderDashboardDonut(d) {
  const wrap = $('#dashDonutWrap');
  const items = d.watchByCategory || [];
  if (!items.length) { wrap.innerHTML = '<div class="dash-empty">暂无数据</div>'; return; }
  // 所有汇总均由后端 watchCategoryStats 提供，前端只格式化与绘制
  const stats = d.watchCategoryStats || {};
  const gmvGrandTotal = Number(stats.gmvGrandTotal) || 0;
  const top6GmvSum = Number(stats.top6GmvSum) || 0;
  const top6Pct = Number(stats.top6GmvPct) || 0;
  const totalCats = Number(stats.totalCategories) || items.length;
  const grandTotal = (d.kpi && d.kpi.totalModels) || 0;
  const fmtGmv = (v) => {
    const n = Number(v) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n));
  };
  const palette = ['#3b82f6', '#22d3ee', '#8b5cf6', '#f59e0b', '#10b981', '#f472b6'];
  const R = 60, C = 74, STROKE = 22;
  const circ = 2 * Math.PI * R;
  let offset = 0;
  const arcs = items.map((it, i) => {
    // 弧长按 Top 6 GMV 归一化（top6GmvSum 分母），6 段填满圆环、视觉平衡
    const gmv = Number(it.gmv) || 0;
    const len = top6GmvSum > 0 ? (gmv / top6GmvSum) * circ : circ / items.length;
    const gap = 2; // 分段留缝
    const dash = `${Math.max(0.1, len - gap)} ${circ - Math.max(0.1, len - gap)}`;
    const seg = `<circle class="donut-arc" data-cat="${escapeAttr(it.name)}" cx="${C}" cy="${C}" r="${R}"
      stroke="${palette[i % palette.length]}" stroke-dasharray="${dash}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 ${C} ${C})"><title>${escapeHtml(it.name)} · GMV ${fmtGmv(gmv)} · ${it.count} 机型</title></circle>`;
    offset += len;
    return seg;
  }).join('');
  const legend = items.map((it, i) => `
    <div class="dash-legend-item" data-cat="${escapeAttr(it.name)}" title="${escapeAttr(it.name)} · GMV ${fmtGmv(it.gmv)} · ${it.count} 机型">
      <span class="dash-legend-swatch" style="background:${palette[i % palette.length]}"></span>
      <span class="dash-legend-name">${escapeHtml(it.name)}</span>
      <span class="dash-legend-count">${fmtGmv(it.gmv)}</span>
    </div>
  `).join('');
  wrap.innerHTML = `
    <svg class="dash-donut-svg" viewBox="0 0 148 148">
      ${arcs}
      <text class="dash-donut-center-num" x="74" y="74" text-anchor="middle">${grandTotal}</text>
      <text class="dash-donut-center-label" x="74" y="92" text-anchor="middle">覆盖机型（全池）</text>
    </svg>
    <div class="dash-donut-foot">Top 6 品类占全盘 GMV ${top6Pct.toFixed(1)}%（${fmtGmv(top6GmvSum)} / ${fmtGmv(gmvGrandTotal)}） · 共 ${totalCats} 品类</div>
    <div class="dash-legend">${legend}</div>
  `;
  const go = (cat) => drillTo({ tab: 'monitor', week: d.meta.latestWeek, category: cat, view: 'pool', from: 'dashboard' });
  $$('#dashDonutWrap .donut-arc').forEach((el) => el.addEventListener('click', () => go(el.dataset.cat)));
  $$('#dashDonutWrap .dash-legend-item').forEach((el) => el.addEventListener('click', () => go(el.dataset.cat)));
}

function renderDashboardTop(d) {
  const tb = $('#dashTopTable tbody');
  const rows = d.topRows || [];
  if (!rows.length) {
    tb.innerHTML = `<tr><td colspan="5" class="dash-empty">当前周次没有异常机型</td></tr>`;
    return;
  }
  tb.innerHTML = rows.map((r) => `
    <tr data-model-id="${escapeAttr(r.modelId)}" data-category="${escapeAttr(r.category)}">
      <td class="dash-rank">${r.rank}</td>
      <td class="dash-model">${escapeHtml(r.modelName)}<span class="dash-cat">${escapeHtml(r.category)}</span></td>
      <td class="dash-num">${fmtRate(r.orderRate)}</td>
      <td class="dash-delta"><span class="dash-delta-pill ${r.deltaDir}">${escapeHtml(r.deltaLabel)}</span></td>
      <td class="dash-arrow">→</td>
    </tr>
  `).join('');
  $$('#dashTopTable tbody tr').forEach((tr) => {
    tr.addEventListener('click', () => drillTo({
      tab: 'monitor', week: d.meta.latestWeek, category: tr.dataset.category,
      view: 'pool', highlight: tr.dataset.modelId, from: 'dashboard',
    }));
  });
}

function renderDashboardLine(d) {
  const wrap = $('#dashLineWrap');
  const data = d.gmvTrend || [];
  if (!data.length) { wrap.innerHTML = '<div class="dash-empty">暂无数据</div>'; return; }
  const W = 640, H = 190, pad = { l: 44, r: 16, t: 18, b: 26 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const values = data.map((p) => p.gmv);
  const vMax = Math.max(...values, 1);
  const vMin = Math.min(...values);
  const yRange = Math.max(vMax - vMin, vMax * 0.1, 1);
  const yTop = vMax + yRange * 0.18;
  const yBot = Math.max(0, vMin - yRange * 0.05);
  const x = (i) => pad.l + (data.length === 1 ? iw / 2 : (iw * i) / (data.length - 1));
  const y = (v) => pad.t + ih - ((v - yBot) / (yTop - yBot)) * ih;
  const pts = data.map((p, i) => ({ ...p, x: x(i), y: y(p.gmv) }));
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${path} L${pts[pts.length - 1].x.toFixed(1)},${pad.t + ih} L${pts[0].x.toFixed(1)},${pad.t + ih} Z`;
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => yBot + ((yTop - yBot) * i) / ticks);
  const fmtY = (v) => v >= 1e8 ? (v / 1e8).toFixed(1) + '亿' : v >= 1e4 ? (v / 1e4).toFixed(1) + '万' : String(Math.round(v));
  const gridSvg = yTicks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`).join('');
  const yAxis = yTicks.map((v) => `<text x="${pad.l - 8}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${fmtY(v)}</text>`).join('');
  const xAxis = pts.map((p) => `<text x="${p.x.toFixed(1)}" y="${H - pad.b + 16}" text-anchor="middle">${escapeHtml(p.week.replace(/^\d{4}-/, ''))}</text>`).join('');
  const dots = pts.map((p, i) => {
    const isLast = i === pts.length - 1;
    return `<circle class="dot ${isLast ? 'dot-latest' : ''}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${isLast ? 5 : 4}" data-week="${escapeAttr(p.week)}" data-gmv="${p.gmv}"><title>${escapeHtml(p.week)} · GMV ${fmtInt(p.gmv)}</title></circle>`;
  }).join('');
  const last = pts[pts.length - 1];
  wrap.innerHTML = `
    <svg class="dash-line-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs><linearGradient id="dashLineGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/>
      </linearGradient></defs>
      <g class="grid">${gridSvg}</g>
      <path class="area-fill" d="${area}"/>
      <path class="line-path" d="${path}"/>
      <g class="axis">${yAxis}${xAxis}</g>
      <text class="value-label" x="${(last.x + 6).toFixed(1)}" y="${(last.y - 8).toFixed(1)}">${fmtY(last.gmv)}</text>
      ${dots}
    </svg>
  `;
  $$('#dashLineWrap .dot').forEach((c) => {
    c.addEventListener('click', () => drillTo({ tab: 'monitor', week: c.dataset.week, view: 'watch', from: 'dashboard' }));
  });
}

function renderDashboardKpi(d) {
  const k = d.kpi;
  const watchDeltaStr = k.watchDelta === 0
    ? '与上周持平'
    : (k.watchDelta > 0
      ? `<span class="dash-delta-up">+${k.watchDelta}</span> 较上周`
      : `<span class="dash-delta-down">${k.watchDelta}</span> 较上周`);
  const cards = [
    { key: 'total',  label: '覆盖机型', value: k.totalModels, unit: '个', sub: `${k.totalCategories} 个品类`, act: { view: 'pool' } },
    { key: 'watch',  label: '需关注机型', value: k.watchCount, unit: '个', sub: watchDeltaStr, act: { view: 'watch' } },
    { key: 'up',     label: '周环比上涨', value: k.upCount, unit: '个', sub: 'orderRate ↑', act: { view: 'pool', trend: 'up' } },
    { key: 'week',   label: '最新周次', value: d.meta.latestWeek || '-', unit: '', sub: d.meta.weekRange || `第 ${d.meta.totalWeeks} 周`, act: { view: 'watch' } },
  ];
  $('#dashKpiRow').innerHTML = cards.map((c) => `
    <div class="dash-kpi" data-key="${c.key}" role="button" tabindex="0">
      <div class="dash-kpi-label">${escapeHtml(c.label)}</div>
      <div class="dash-kpi-value">${escapeHtml(String(c.value))}${c.unit ? `<span class="dash-unit">${c.unit}</span>` : ''}</div>
      <div class="dash-kpi-sub">${c.sub}</div>
    </div>
  `).join('');
  $$('#dashKpiRow .dash-kpi').forEach((el) => {
    const key = el.dataset.key;
    const conf = cards.find((c) => c.key === key);
    const go = () => drillTo({ tab: 'monitor', week: d.meta.latestWeek, from: 'dashboard', ...conf.act });
    el.addEventListener('click', go);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

// ============================================================================
// URL 状态 · 下钻 · 面包屑 · 高亮
// ============================================================================
function readUrlState() {
  const p = new URLSearchParams(location.search);
  return {
    tab: p.get('tab') || '',
    week: p.get('week') || '',
    category: p.get('category') || '',
    view: p.get('view') || '',
    trend: p.get('trend') || '',
    highlight: p.get('highlight') || '',
    from: p.get('from') || '',
  };
}
function writeUrlState(patch) {
  const cur = readUrlState();
  const next = { ...cur, ...patch };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) p.set(k, v);
  const qs = p.toString();
  const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
  history.pushState({}, '', url);
}
function applyStateToMonitorSelects(s) {
  if (s.week && $('#monitorWeek')) {
    const w = $('#monitorWeek');
    if ([...w.options].some((o) => o.value === s.week)) w.value = s.week;
  }
  if (s.category !== undefined && $('#monitorCategory')) $('#monitorCategory').value = s.category || '';
  if (s.view && $('#monitorView')) $('#monitorView').value = s.view;
  if ($('#monitorTrend')) $('#monitorTrend').value = s.trend || '';
}

function drillTo(opts) {
  const patch = {
    tab: 'monitor',
    week: opts.week || '',
    category: opts.category || '',
    view: opts.view || 'watch',
    trend: opts.trend || '',
    highlight: opts.highlight || '',
    from: opts.from || 'dashboard',
  };
  writeUrlState(patch);
  applyStateToMonitorSelects(patch);
  activateTab('monitor', { skipUrl: true });
}

function clearDashboardContext() {
  const s = readUrlState();
  if (s.highlight || s.from) writeUrlState({ highlight: '', from: '' });
  const crumb = $('#monitorCrumb');
  if (crumb) crumb.classList.add('hidden');
}

function updateBreadcrumb() {
  const s = readUrlState();
  const crumb = $('#monitorCrumb');
  if (!crumb) return;
  if (s.from === 'dashboard') {
    const parts = [];
    if (s.week) parts.push(`周次 ${s.week}`);
    if (s.category) parts.push(`品类「${s.category}」`);
    if (s.view === 'watch') parts.push('仅需关注');
    else if (s.view === 'pool') parts.push('TOP N 全量');
    if (s.trend === 'up') parts.push('趋势 ↑');
    else if (s.trend === 'down') parts.push('趋势 ↓');
    if (s.highlight) parts.push(`定位机型 #${s.highlight}`);
    $('#crumbDesc').textContent = '从概览下钻 · ' + (parts.join(' · ') || '全部');
    crumb.classList.remove('hidden');
  } else {
    crumb.classList.add('hidden');
  }
}

function handleHighlightAfterRender() {
  const s = readUrlState();
  if (!s.highlight) return;
  const rows = $$('#monitorTable tbody tr[data-model-id]');
  const hit = rows.find((tr) => tr.dataset.modelId === s.highlight);
  if (!hit) {
    toast(`目标机型 #${s.highlight} 不在当前筛选结果里，试试切到「TOP N 全量」`, 4200);
    return;
  }
  hit.classList.add('row-highlight');
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => hit.classList.remove('row-highlight'), 3200);
}

// ---- 机型详情侧边抽屉 ----
const RATE_LABELS = {
  evaRate: '估价完成率', orderRate: '估价下单率', shipRate: '下单发货率',
  dealRate: '发货成交率', returnRate: '成交退款率',
};
const FIELD_LABELS = {
  jkuv: '进入UV', evaUv: '估价UV', orderUv: '下单UV', orderCnt: '订单数',
  shipCnt: '发货数', signCnt: '签约数', qcCnt: '质检数', dealCnt: '成交数',
  returnCnt: '退款数', gmv: 'GMV', evaCnt: '估价次数', avgPrice: '客单价',
  daysReceived: '收件天数',
};

function findModelRow(category, modelName) {
  const r = state.monitor;
  if (!r) return null;
  const list = [...(r.pool || []), ...(r.watchList || [])];
  return list.find((x) => x.category === category && x.modelName === modelName) || null;
}
function findFlagsFor(category, modelName) {
  const wl = state.monitor && state.monitor.watchList;
  const row = wl && wl.find((x) => x.category === category && x.modelName === modelName);
  return (row && row.flags) || [];
}

function fmtDeltaCell(d) {
  if (d === null || d === undefined) return '<span class="delta na">—</span>';
  if (typeof d !== 'number' || !isFinite(d)) return '<span class="delta na">—</span>';
  const abs = Math.abs(d);
  const label = abs >= 1 ? `${(1 + abs).toFixed(1)}×` : `${(abs * 100).toFixed(1)}%`;
  const cls = d >= 0 ? 'up' : 'down';
  const arrow = d >= 0 ? '↑' : '↓';
  return `<span class="delta ${cls}">${arrow} ${label}</span>`;
}
function fmtTrendArrow(t) {
  if (t === 'up') return '<span class="trend-arrow up">连升</span>';
  if (t === 'down') return '<span class="trend-arrow down">连降</span>';
  return '';
}

function openModelDrawer({ category, modelName }) {
  const row = findModelRow(category, modelName);
  if (!row) {
    toast(`找不到机型 ${category}/${modelName} 的最新数据`, 3200);
    return;
  }
  const cur = row.cur || {};
  const prev = row.prev || {};
  const delta = row.delta || {};
  const trend = row.trend || {};
  const flags = findFlagsFor(category, modelName);
  const flaggedMetrics = new Set(flags.map((f) => f.metric));

  $('#drawerEyebrow').textContent = `${category} · ${cur.week || '—'}`;
  $('#drawerTitle').textContent = modelName;
  $('#drawerTags').innerHTML = (row.tags || [])
    .map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')
    || '<span class="tag-chip" style="color:var(--c-text-3)">未打标签</span>';

  const rateRows = Object.entries(RATE_LABELS).map(([key, label]) => {
    const curV = cur[key];
    const prevV = prev[key];
    const dv = delta[key];
    const tv = trend[key];
    const hasFlag = flaggedMetrics.has(key);
    return `
      <tr class="${hasFlag ? 'has-flag' : ''}">
        <td>${label}${hasFlag ? ' <span class="flag-type wave" style="padding:1px 5px;font-size:10px;border-radius:4px;background:#fef3c7;color:#92400e;">告警</span>' : ''}</td>
        <td>${fmtRate(curV)}</td>
        <td>${fmtRate(prevV)}</td>
        <td>${fmtDeltaCell(dv)}${fmtTrendArrow(tv)}</td>
      </tr>`;
  }).join('');

  const fieldsHtml = Object.entries(FIELD_LABELS).map(([key, label]) => {
    const c = cur[key];
    const p = prev[key];
    return `
      <div class="drawer-field">
        <span class="k">${label}</span>
        <span class="v">${c === null || c === undefined ? '—' : fmtInt(c)}</span>
        <span class="p">${p === null || p === undefined ? '' : `前周 ${fmtInt(p)}`}</span>
      </div>`;
  }).join('');

  const flagsHtml = flags.length
    ? flags.map((f) => {
        const val = typeof f.delta === 'number'
          ? fmtDeltaCell(f.delta)
          : (f.direction === 'up' ? '<span class="delta up">连升</span>' : '<span class="delta down">连降</span>');
        return `
          <div class="drawer-flag-item">
            <span class="flag-type ${escapeAttr(f.type)}">${escapeHtml(f.type)}</span>
            <span class="flag-name">${escapeHtml(f.name || RATE_LABELS[f.metric] || f.metric)}</span>
            <span class="flag-value">${val}</span>
          </div>`;
      }).join('')
    : '<div class="drawer-flag-item" style="color:var(--c-text-3)">当前周无告警</div>';

  $('#drawerBody').innerHTML = `
    <section class="drawer-section">
      <div class="drawer-section-head">
        <h3 class="drawer-section-title">5 项转化率</h3>
        <span class="drawer-section-sub">${cur.week || ''} vs ${prev.week || '—'}</span>
      </div>
      <table class="drawer-rates">
        <thead><tr><th>指标</th><th>本周</th><th>前周</th><th>变化</th></tr></thead>
        <tbody>${rateRows}</tbody>
      </table>
    </section>

    <section class="drawer-section">
      <div class="drawer-section-head">
        <h3 class="drawer-section-title">告警明细</h3>
        <span class="drawer-section-sub">${flags.length} 项</span>
      </div>
      <div class="drawer-flags">${flagsHtml}</div>
    </section>

    <section class="drawer-section">
      <div class="drawer-section-head">
        <h3 class="drawer-section-title">运营指标（本周 · 前周）</h3>
        <span class="drawer-section-sub">共 ${Object.keys(FIELD_LABELS).length} 项</span>
      </div>
      <div class="drawer-fields">${fieldsHtml}</div>
    </section>
  `;

  $('#modelDrawer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeModelDrawer() {
  $('#modelDrawer').classList.add('hidden');
  document.body.style.overflow = '';
}
document.addEventListener('click', (ev) => {
  if (ev.target.closest('[data-drawer-close]')) closeModelDrawer();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#modelDrawer').classList.contains('hidden')) closeModelDrawer();
});

// ---- 启动 ----
init();

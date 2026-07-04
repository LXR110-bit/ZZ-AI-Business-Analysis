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
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const name = tab.dataset.tab;
    $$('.page').forEach((p) => p.classList.add('hidden'));
    $('#page-' + name).classList.remove('hidden');
    if (name === 'monitor') refreshMonitor();
    if (name === 'tags') refreshTagsPage();
    if (name === 'rules') fillRulesForm();
    if (name === 'logs') refreshLogs();
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
  const applyMonitor = () => { markFilterApplied('monitor'); refreshMonitor(); };
  $('#btnMonitorRun').addEventListener('click', applyMonitor);
  ['monitorCategory', 'monitorWeek', 'monitorView'].forEach((id) => {
    $('#' + id).addEventListener('change', applyMonitor);
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
  refreshMonitor();
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
}

function renderMonitor() {
  const r = state.monitor;
  if (!r) return;
  const cat = $('#monitorCategory').value;
  const view = $('#monitorView').value;
  const list = view === 'watch' ? r.watchList : r.pool;
  const filtered = cat ? list.filter((x) => x.category === cat) : list;

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
      b.addEventListener('click', () => openTagModal(b.dataset.cat, b.dataset.model));
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
  return `
    <tr class="row-${sev}">
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

// ---- 启动 ----
init();

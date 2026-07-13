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

let _appStarted = false;

function setAccessError(message) {
  const el = $('#accessError');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

function showAccessGate() {
  $('#accessGate')?.classList.remove('hidden');
  const shell = $('#appShell');
  if (shell) {
    shell.classList.add('hidden');
    shell.setAttribute('aria-hidden', 'true');
  }
  const nameInput = $('#accessName');
  const codeInput = $('#accessCode');
  if (nameInput) nameInput.value = '';
  if (codeInput) codeInput.value = '';
  nameInput?.focus();
}

function showAppShell() {
  $('#accessGate')?.classList.add('hidden');
  const shell = $('#appShell');
  if (shell) {
    shell.classList.remove('hidden');
    shell.setAttribute('aria-hidden', 'false');
  }
}

async function readAccessError(res) {
  try {
    const data = await res.json();
    return data.error || `门禁校验失败(${res.status})`;
  } catch {
    return `门禁校验失败(${res.status})`;
  }
}

async function hasServerAccess() {
  try {
    const res = await fetch('/api/access/status', { cache: 'no-store' });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.ok;
  } catch {
    return false;
  }
}

async function clearServerAccess() {
  try {
    await fetch('/api/access/logout', { method: 'POST', cache: 'no-store' });
  } catch {
    // 即使清理请求失败，也保持前端门禁可见，避免静默进入。
  }
}

async function startAppOnce() {
  if (_appStarted) return;
  _appStarted = true;
  await init();
}

async function handleAccessSubmit(e) {
  e.preventDefault();
  const name = ($('#accessName')?.value || '').trim();
  const code = $('#accessCode')?.value || '';
  if (!name && !code.trim()) {
    setAccessError('请输入姓名和门禁码');
    $('#accessName')?.focus();
    return;
  }
  if (!name) {
    setAccessError('请输入姓名');
    $('#accessName')?.focus();
    return;
  }
  if (!code.trim()) {
    setAccessError('请输入门禁码');
    $('#accessCode')?.focus();
    return;
  }

  const btn = $('.access-submit');
  if (btn) btn.disabled = true;
  setAccessError('');
  try {
    const res = await fetch('/api/access/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, code: code.trim() }),
    });
    if (!res.ok) {
      setAccessError(await readAccessError(res));
      $('#accessCode')?.focus();
      return;
    }
    setUserName(name);
    const userNameInput = $('#userName');
    if (userNameInput) userNameInput.value = name;
    const codeInput = $('#accessCode');
    if (codeInput) codeInput.value = '';
    showAppShell();
    await startAppOnce();
  } catch (err) {
    setAccessError('门禁服务暂不可用，请稍后重试');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function bootAccessGate() {
  const form = $('#accessForm');
  if (!form) {
    await startAppOnce();
    return;
  }
  form.addEventListener('submit', handleAccessSubmit);
  await clearServerAccess();
  showAccessGate();
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

function compareWeekValue(a, b) {
  const ma = String(a || '').match(/^(\d{4})-W(\d{1,2})$/);
  const mb = String(b || '').match(/^(\d{4})-W(\d{1,2})$/);
  if (ma && mb) {
    const ya = Number(ma[1]);
    const yb = Number(mb[1]);
    if (ya !== yb) return ya - yb;
    return Number(ma[2]) - Number(mb[2]);
  }
  return String(a || '').localeCompare(String(b || ''), 'zh-CN', { numeric: true });
}

function sortWeekValues(weeks, desc = false) {
  const list = Array.from(new Set((weeks || []).filter(Boolean)));
  list.sort(compareWeekValue);
  return desc ? list.reverse() : list;
}

function latestWeekValue(weeks) {
  const list = sortWeekValues(weeks || []);
  return list[list.length - 1] || '';
}

const UNTAGGED_VALUE = '未打标';
const UNTAGGED_LABEL = '未打标';
const BATCH_KEEP_VALUE = '__keep__';
const BASE_TAG_DIMENSIONS = [
  { key: 'core', label: '核心度' },
  { key: 'lifecycle', label: '生命周期' },
  { key: 'price', label: '价格段' },
];
const TAG_SUMMARY_METRICS = ['jkuv', 'evaUv', 'orderUv', 'shipCnt', 'qcCnt', 'dealCnt', 'gmv', 'returnCnt'];
const MONITOR_METRICS_STORAGE_KEY = 'monitorVisibleRateMetricsV1';

function uniqStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const v = String(item || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function stableDimIdFromName(name, idx = 0) {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return slug || `dim-${idx + 1}`;
}

function makeCustomDimId(name) {
  const base = stableDimIdFromName(name || 'dim', 0).replace(/-1$/, '') || 'dim';
  return `${base}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function normalizeVocab(raw = {}) {
  const custom = {};
  const rawCustom = raw && raw.custom && typeof raw.custom === 'object' ? raw.custom : {};
  for (const [category, dimsOrOptions] of Object.entries(rawCustom)) {
    const cat = String(category || '').trim();
    if (!cat) continue;
    if (Array.isArray(dimsOrOptions) && dimsOrOptions.every((x) => typeof x === 'string')) {
      custom[cat] = [{ id: 'legacy', name: '自定义', options: uniqStrings(dimsOrOptions) }];
      continue;
    }
    const dims = Array.isArray(dimsOrOptions) ? dimsOrOptions : [];
    custom[cat] = dims
      .map((dim, idx) => {
        const name = String(dim && dim.name ? dim.name : '').trim() || `自定义维度${idx + 1}`;
        return {
          id: String((dim && dim.id) || stableDimIdFromName(name, idx)).trim(),
          name,
          options: uniqStrings(dim && dim.options),
        };
      })
      .filter((dim) => dim.id && dim.name);
  }
  return {
    lifecycle: uniqStrings(raw.lifecycle || ['新品', '主流', '长尾', '淘汰']),
    price: uniqStrings(raw.price || ['高价段', '中价段', '低价段']),
    core: uniqStrings(raw.core || ['核心', '非核心', '观察']),
    custom,
  };
}

function customDimKey(category, id) {
  return `custom:${category}:${id}`;
}

function getKnownCategories() {
  return (state.meta && Array.isArray(state.meta.categories)) ? state.meta.categories : [];
}

function renderCategoryDatalist() {
  const dl = $('#categorySuggest');
  if (!dl) return;
  dl.innerHTML = getKnownCategories().map((c) => `<option value="${escapeAttr(c)}"></option>`).join('');
}

function resolveMonitorCategory(opts = {}) {
  const input = $('#monitorCategory');
  const value = String((input && input.value) || '').trim();
  if (!value) return '';
  const cats = getKnownCategories();
  if (cats.length && !cats.includes(value)) {
    if (opts.toastOnInvalid) toast('请从品类搜索建议中选择一个已有品类，或清空为全部品类');
    if (input) input.value = '';
    return '';
  }
  return value;
}

function buildDimensionDefsForCategory(category) {
  const vocab = normalizeVocab(state.vocab || {});
  const defs = BASE_TAG_DIMENSIONS.map((d) => ({ ...d, options: vocab[d.key] || [] }));
  const customDims = (vocab.custom && vocab.custom[category]) || [];
  for (const dim of customDims) {
    defs.push({
      key: customDimKey(category, dim.id),
      label: dim.name,
      options: dim.options || [],
      categoryScoped: true,
    });
  }
  return defs;
}

function resolveMonitorRequestDimension(category) {
  const requested = String(state.monitorTagDimension || ($('#monitorTagDimension') && $('#monitorTagDimension').value) || 'core').trim() || 'core';
  const cat = String(category || '').trim();
  const validDims = cat
    ? buildDimensionDefsForCategory(cat)
    : BASE_TAG_DIMENSIONS.map((d) => ({ ...d, categoryScoped: false }));
  if (validDims.some((d) => d.key === requested)) return requested;
  state.monitorTagDimension = 'core';
  clearMonitorTagFilters();
  return 'core';
}

function buildMonitorRequestParams() {
  const params = new URLSearchParams();
  const week = ($('#monitorWeek') && $('#monitorWeek').value) || '';
  const category = resolveMonitorCategory();
  const tagDimension = resolveMonitorRequestDimension(category);
  if (week) params.set('week', week);
  if (category) params.set('category', category);
  if (tagDimension) params.set('tagDimension', tagDimension);
  return params;
}

function getMonitorTagDimensions() {
  const r = state.monitor || {};
  const fromApi = Array.isArray(r.tagDimensions)
    ? r.tagDimensions
        .map((d) => ({
          key: String(d && d.key ? d.key : '').trim(),
          label: String(d && d.label ? d.label : d && d.key ? d.key : '').trim(),
          categoryScoped: !!(d && d.categoryScoped),
        }))
        .filter((d) => d.key)
    : [];
  if (fromApi.length) return fromApi;
  const cat = ($('#monitorCategory') && $('#monitorCategory').value) || '';
  const defs = BASE_TAG_DIMENSIONS.map((d) => ({ ...d, categoryScoped: false }));
  if (cat) {
    for (const dim of ((normalizeVocab(state.vocab || {}).custom || {})[cat] || [])) {
      defs.push({ key: customDimKey(cat, dim.id), label: `${cat} · ${dim.name}`, categoryScoped: true });
    }
  }
  return defs;
}

function normalizeDimensions(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, v] of Object.entries(input)) {
    const key = String(k || '').trim();
    const val = String(v || '').trim();
    if (key && val) out[key] = val;
  }
  return out;
}

function inferLegacyDimensions(tags, category) {
  const out = {};
  const legacy = uniqStrings(tags || []);
  if (!legacy.length) return out;
  const defs = buildDimensionDefsForCategory(category);
  for (const tag of legacy) {
    const hit = defs.find((d) => !out[d.key] && (d.options || []).includes(tag));
    if (hit) out[hit.key] = tag;
  }
  return out;
}

function getEntryDimensions(entry, category) {
  const direct = normalizeDimensions(entry && entry.dimensions);
  if (Object.keys(direct).length) return direct;
  return inferLegacyDimensions(entry && entry.tags, category);
}

function getRowTagEntry(row) {
  if (!row) return {};
  const key = keyOf(row.category, row.modelName);
  const local = state.tags && state.tags[key];
  if (local && typeof local === 'object') return local;
  return {
    dimensions: row.dimensions || {},
    tags: Array.isArray(row.tags) ? row.tags : [],
    note: row.note || '',
  };
}

function getModelTagEntry(category, modelName, row) {
  const local = state.tags && state.tags[keyOf(category, modelName)];
  if (local && typeof local === 'object') return local;
  if (row) return getRowTagEntry(row);
  return {};
}

function dimensionValueForRow(row, dimensionKey) {
  const dims = getEntryDimensions(getRowTagEntry(row), row.category);
  return String(dims[dimensionKey] || '').trim();
}

function normalizeGroupValue(value) {
  const v = String(value || '').trim();
  return v && v !== UNTAGGED_LABEL ? v : UNTAGGED_VALUE;
}

function groupLabel(value) {
  return normalizeGroupValue(value) === UNTAGGED_VALUE ? UNTAGGED_LABEL : String(value || '').trim();
}

function flattenDimensionValues(dimensions) {
  return Object.values(normalizeDimensions(dimensions));
}

function clearMonitorTagFilters() {
  state.monitorTagFilters = {};
  state.monitorTagGroupValue = null;
}

function getActiveMonitorTagFilters() {
  const filters = state.monitorTagFilters || {};
  return Object.entries(filters)
    .map(([dimension, value]) => ({ dimension, value: normalizeGroupValue(value) }))
    .filter((x) => x.dimension && x.value);
}

function currentMonitorTagFilterValue(dimensionKey) {
  const value = state.monitorTagFilters && state.monitorTagFilters[dimensionKey];
  return value ? normalizeGroupValue(value) : '';
}

function setCurrentMonitorTagFilter(dimensionKey, value) {
  if (!dimensionKey) return;
  const filters = { ...(state.monitorTagFilters || {}) };
  const normalized = normalizeGroupValue(value);
  if (filters[dimensionKey] && normalizeGroupValue(filters[dimensionKey]) === normalized) {
    delete filters[dimensionKey];
  } else {
    filters[dimensionKey] = normalized;
  }
  state.monitorTagFilters = filters;
  state.monitorTagGroupValue = filters[dimensionKey] || null;
}

function applyMonitorTagFilters(rows, opts = {}) {
  const excludeDimension = opts.excludeDimension || '';
  const filters = getActiveMonitorTagFilters().filter((f) => f.dimension !== excludeDimension);
  if (!filters.length) return Array.isArray(rows) ? rows.slice() : [];
  return (rows || []).filter((row) => filters.every((f) => normalizeGroupValue(dimensionValueForRow(row, f.dimension)) === f.value));
}

function getMonitorDimensionLabel(dimensionKey) {
  const dims = getMonitorTagDimensions();
  const hit = dims.find((d) => d.key === dimensionKey);
  if (hit) return hit.label || hit.key;
  return dimensionKey;
}

function monitorRateList(rules) {
  return Array.isArray(rules && rules.rates) ? rules.rates : [
    { key: 'evaRate', name: '估价完成率' },
    { key: 'orderRate', name: '估价下单率' },
    { key: 'shipRate', name: '估价发货率' },
    { key: 'dealRate', name: '估价成交率' },
    { key: 'returnRate', name: '质检退回率' },
  ];
}

function loadMonitorMetricKeys(allRates) {
  if (state.monitorMetricKeys !== null) return state.monitorMetricKeys;
  let keys = [];
  try {
    keys = JSON.parse(localStorage.getItem(MONITOR_METRICS_STORAGE_KEY) || '[]');
  } catch {
    keys = [];
  }
  const allowed = new Set((allRates || []).map((r) => r.key));
  state.monitorMetricKeys = Array.isArray(keys) ? keys.filter((k) => allowed.has(k)) : [];
  if (!state.monitorMetricKeys.length) state.monitorMetricKeys = (allRates || []).map((r) => r.key);
  return state.monitorMetricKeys;
}

function getVisibleMonitorRates(allRates) {
  const selected = new Set(loadMonitorMetricKeys(allRates));
  const visible = (allRates || []).filter((r) => selected.has(r.key));
  return visible.length ? visible : (allRates || []);
}

function saveMonitorMetricKeys(keys) {
  state.monitorMetricKeys = keys;
  localStorage.setItem(MONITOR_METRICS_STORAGE_KEY, JSON.stringify(keys));
}

function renderTagChips(category, modelName, row, opts = {}) {
  const entry = getModelTagEntry(category, modelName, row);
  const dims = getEntryDimensions(entry, category);
  const defs = buildDimensionDefsForCategory(category);
  const chipClass = opts.chipClass || 'chip';
  const chips = [];
  const rendered = new Set();
  for (const def of defs) {
    const value = dims[def.key];
    if (!value) continue;
    rendered.add(def.key);
    const label = opts.compact ? '' : `<b>${escapeHtml(def.label)}:</b> `;
    chips.push(`<span class="${chipClass} tag-dim-chip" title="${escapeAttr(def.label)}">${label}${escapeHtml(value)}</span>`);
  }
  for (const [key, value] of Object.entries(dims)) {
    if (rendered.has(key) || !value) continue;
    const label = opts.compact ? '' : `<b>${escapeHtml(key)}:</b> `;
    chips.push(`<span class="${chipClass} tag-dim-chip" title="${escapeAttr(key)}">${label}${escapeHtml(value)}</span>`);
  }
  if (!chips.length && Array.isArray(entry.tags) && entry.tags.length) {
    chips.push(...entry.tags.map((t) => `<span class="${chipClass} legacy-tag-chip">${escapeHtml(t)}</span>`));
  }
  if (!chips.length && opts.includeUntagged) {
    chips.push(`<span class="${chipClass} empty-chip">${UNTAGGED_LABEL}</span>`);
  }
  return chips.join('');
}

function countTaggedDimensions(row) {
  return Object.keys(getEntryDimensions(getRowTagEntry(row), row.category)).length;
}

// ---- 全局状态 ----
const state = {
  meta: null,
  tags: {},
  vocab: null,
  rules: null,
  monitor: null,
  monitorCache: {},
  monitorTagDimension: 'core',
  monitorTagGroupValue: null,
  monitorTagFilters: {},
  monitorMetricKeys: null,
};

let _monitorSortKey = '';
let _monitorSortAsc = false;

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
    resolveMonitorCategory({ toastOnInvalid: true });
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
  const monitorCategory = $('#monitorCategory');
  if (monitorCategory) {
    monitorCategory.addEventListener('input', () => markFilterDirty('monitor'));
    monitorCategory.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        clearMonitorTagFilters();
        applyMonitor(ev);
      }
    });
    monitorCategory.addEventListener('change', (ev) => {
      clearMonitorTagFilters();
      applyMonitor(ev);
    });
  }
  const monitorWeek = $('#monitorWeek');
  if (monitorWeek) monitorWeek.addEventListener('change', (ev) => {
    clearMonitorTagFilters();
    applyMonitor(ev);
  });
  ['monitorView', 'monitorTrend'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.addEventListener('change', applyMonitor);
  });
  const monitorTagDimension = $('#monitorTagDimension');
  if (monitorTagDimension) {
    monitorTagDimension.addEventListener('change', () => {
      state.monitorTagDimension = monitorTagDimension.value || 'core';
      state.monitorTagGroupValue = currentMonitorTagFilterValue(state.monitorTagDimension) || null;
      refreshMonitor();
    });
  }
  const btnMonitorTagFilters = $('#btnMonitorTagFilters');
  if (btnMonitorTagFilters) btnMonitorTagFilters.addEventListener('click', openMonitorTagFiltersModal);
  const btnMonitorTagCombo = $('#btnMonitorTagCombo');
  if (btnMonitorTagCombo) btnMonitorTagCombo.addEventListener('click', openMonitorTagFiltersModal);
  const btnMonitorTagFiltersCancel = $('#btnMonitorTagFiltersCancel');
  if (btnMonitorTagFiltersCancel) btnMonitorTagFiltersCancel.addEventListener('click', () => $('#modalMonitorTagFilters').classList.add('hidden'));
  const btnMonitorTagFiltersReset = $('#btnMonitorTagFiltersReset');
  if (btnMonitorTagFiltersReset) btnMonitorTagFiltersReset.addEventListener('click', resetMonitorTagFilters);
  const btnMonitorTagFiltersSave = $('#btnMonitorTagFiltersSave');
  if (btnMonitorTagFiltersSave) btnMonitorTagFiltersSave.addEventListener('click', saveMonitorTagFiltersModal);
  $('#btnMonitorMetrics').addEventListener('click', openMonitorMetricsModal);
  $('#btnMonitorMetricsCancel').addEventListener('click', () => $('#modalMonitorMetrics').classList.add('hidden'));
  $('#btnMonitorMetricsReset').addEventListener('click', resetMonitorMetrics);
  $('#btnMonitorMetricsSave').addEventListener('click', saveMonitorMetricsModal);
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
  $('#btnBatchTags').addEventListener('click', openBatchTagModal);
  $('#tagsCategory').addEventListener('change', applyTags);
  $('#tagsCategory').addEventListener('input', () => markFilterDirty('tags'));
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

  // v2: Tier Tab 点击
  $$('#dashTierTabs .dash-tier-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tier = btn.dataset.tier;
      writeUrlState({ tier, secondary: '', category: '' });
      refreshDashboard();
    });
  });
  // v2: 精简/详细切换
  const toggle = $('#dashViewToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      if (typeof toggleDashboardColumnPicker === 'function') toggleDashboardColumnPicker();
    });
  }
  const secondaryToggle = $('#dashSecondaryColumnToggle');
  if (secondaryToggle) {
    secondaryToggle.addEventListener('click', () => {
      if (typeof toggleSecondaryColumnPicker === 'function') toggleSecondaryColumnPicker();
    });
  }
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
    window.dashboardWeeks = [];
    return;
  }
  const t = new Date(m.syncedAt);
  const src = m.source?.title ? `${m.source.title} / ${m.source.sheetTitle || ''}`.replace(/\s\/\s$/, '') : '';
  $('#meta').textContent = `${src ? src + ' · ' : ''}${m.rowCount} 行 · ${m.categories.length} 品类 · ${m.weeks.length} 周 · 同步于 ${t.toLocaleString('zh-CN')}`;
  window.dashboardWeeks = sortWeekValues(m.dashboardWeeks || m.weeks || []);

  // 填充 select
  const wSel = $('#monitorWeek');
  const weeks = sortWeekValues(m.weeks || []);
  wSel.innerHTML = weeks.map((w) => `<option value="${escapeAttr(w)}">${escapeHtml(w)}</option>`).join('');
  wSel.value = latestWeekValue(weeks);

  const cSel = $('#monitorCategory');
  if (cSel) {
    cSel.setAttribute('list', 'categorySuggest');
    const cur = String(cSel.value || '').trim();
    if (cur && !m.categories.includes(cur)) cSel.value = '';
  }

  const tcSel = $('#tagsCategory');
  renderCategoryDatalist();
  if (tcSel) {
    const cur = tcSel.value;
    tcSel.value = m.categories.includes(cur) ? cur : (m.categories[0] || '');
  }
}

async function loadTags() {
  const tags = await api('/api/tags');
  state.tags = tags && typeof tags === 'object' ? tags : {};
}
async function loadVocab() {
  state.vocab = normalizeVocab(await api('/api/tag-vocab'));
}
async function loadRules() {
  state.rules = await api('/api/rules');
}

// ---- 同步 ----
async function doSync() {
  if (!confirm('同步最新数据? 此操作会覆盖本地缓存。')) return;
  const btn = $('#btnSync');
  btn.disabled = true;
  btn.textContent = '同步中...';
  try {
    const r = await api('/api/sync', { method: 'POST' });
    state.monitorCache = {};
    toast(`同步完成:${r.rows} 行 · ${r.categories} 品类 · ${r.weeks} 周`);
    await loadMeta();
    refreshMonitor();
  } catch (e) {
    toast('同步失败: ' + e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '同步数据';
  }
}

// ---- 监测结果 ----
async function refreshMonitor() {
  const m = state.meta;
  if (!m || !m.synced) {
    $('#monitorTable thead').innerHTML = '';
    $('#monitorTable tbody').innerHTML = '<tr><td colspan="99">尚未同步数据,请先点顶部「同步数据」。</td></tr>';
    $('#monitorSummary').textContent = '';
    $('#monitorTagInsightOverview').innerHTML = '';
    $('#monitorInsightOverview').innerHTML = '';
    renderMonitorTagAggregation({ key: 'core', label: '核心度' }, [], 0);
    return;
  }
  const params = buildMonitorRequestParams();
  const cacheKey = params.toString() || '__latest__';
  if (state.monitorCache && state.monitorCache[cacheKey]) {
    state.monitor = state.monitorCache[cacheKey];
    renderMonitor();
    updateBreadcrumb();
    handleHighlightAfterRender();
    return;
  }

  // loading 态:响应体积较大且服务端会重新计算监测池，首次加载提前给用户反馈
  $('#monitorTable thead').innerHTML = '';
  $('#monitorTable tbody').innerHTML = '<tr><td colspan="99" style="padding:24px;text-align:center;color:#888">正在计算监测结果…</td></tr>';
  $('#monitorSummary').textContent = '加载中…';
  $('#monitorTagInsightOverview').innerHTML = '';
  $('#monitorInsightOverview').innerHTML = '';
  renderMonitorTagAggregation({ key: 'core', label: '核心度' }, [], 0);
  try {
    const qs = params.toString() ? `?${params.toString()}` : '';
    const t0 = Date.now();
    state.monitor = await api('/api/monitor' + qs);
    if (state.monitor && state.monitor.error) throw new Error(state.monitor.error);
    state.monitorCache[cacheKey] = state.monitor;
    console.log('[monitor] 加载耗时', Date.now() - t0, 'ms');
  } catch (e) {
    $('#monitorTable tbody').innerHTML = `<tr><td colspan="99" style="padding:24px;text-align:center;color:#c33">监测失败: ${e.message}</td></tr>`;
    $('#monitorSummary').textContent = '';
    $('#monitorTagInsightOverview').innerHTML = '';
    renderMonitorTagAggregation({ key: 'core', label: '核心度' }, [], 0);
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
  const view = $('#monitorView').value;
  const trend = ($('#monitorTrend') && $('#monitorTrend').value) || '';
  const tagDim = syncMonitorTagDimensionSelect();
  state.monitorTagGroupValue = currentMonitorTagFilterValue(tagDim.key) || null;
  const fullRows = getMonitorFullRows();
  const aggregationBaseRows = applyMonitorTagFilters(fullRows, { excludeDimension: tagDim.key });
  const hasFilters = getActiveMonitorTagFilters().length > 0;
  const tagGroups = hasFilters
    ? buildFilteredTagSummaryGroups(aggregationBaseRows, tagDim)
    : getServerTagSummaryGroups(tagDim.key);
  const fullModelCount = hasFilters
    ? aggregationBaseRows.length
    : tagGroups.reduce((sum, g) => sum + (Number(g.modelCount) || 0), 0);
  renderMonitorTagAggregation(tagDim, tagGroups, fullModelCount);
  renderMonitorTagInsight(tagDim, tagGroups, fullModelCount);

  const detailBaseRows = applyMonitorTagFilters(fullRows);
  let filtered = filterMonitorDetailRows(detailBaseRows, view, trend);
  filtered = sortMonitorRows(filtered);

  const rules = r.rules || {};
  const allRates = monitorRateList(rules);
  const rates = getVisibleMonitorRates(allRates);

  // ---- KPI 概览 ----
  const total = fullModelCount || detailBaseRows.length;
  const detailTotal = detailBaseRows.length;
  const watchRows = detailBaseRows.filter((x) => (x.flags || []).length);
  const watchAll = watchRows.length;
  const waveCnt = watchRows.filter((x) => (x.flags || []).some((f) => f.type === 'wave')).length;
  const downTrendCnt = watchRows.filter((x) => (x.flags || []).some((f) => f.type === 'trend' && f.direction === 'down')).length;
  const filterLabel = getActiveMonitorTagFilters()
    .map((f) => `${getMonitorDimensionLabel(f.dimension)}=${groupLabel(f.value)}`)
    .join(' · ');

  $('#monitorSummary').innerHTML = `
    <div class="kpi-row">
      <div class="kpi">
        <span class="kpi-label">目标周</span>
        <span class="kpi-value mono">${r.targetWeek || '-'}</span>
        ${r.prevWeek ? `<span class="kpi-sub">对比 ${r.prevWeek}</span>` : ''}
      </div>
      <div class="kpi">
        <span class="kpi-label">全量机型</span>
        <span class="kpi-value mono">${total}</span>
        <span class="kpi-sub">服务端全量聚合</span>
      </div>
      <div class="kpi">
        <span class="kpi-label">当前明细</span>
        <span class="kpi-value mono">${detailTotal}</span>
        <span class="kpi-sub">${escapeHtml(filterLabel || '全部标签组')}</span>
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
        <span class="kpi-sub">同向 ${rules.trendWeeks || '-'}+ 周</span>
      </div>
    </div>
  `;

  const focusModels = filtered
    .filter((x) => (x.flags || []).length)
    .slice()
    .sort((a, b) => (b.flags || []).length - (a.flags || []).length || ((b.cur && b.cur.evaUv) || 0) - ((a.cur && a.cur.evaUv) || 0))
    .slice(0, 3)
    .map((x) => x.modelName);
  $('#monitorInsightOverview').innerHTML = `
    <div class="analysis-title">机型分析概览</div>
    <div class="analysis-body">待数据分析 Agent 输出：识别本周机型异动原因、影响最大的转化率/成交指标，并给出需要优先打标或复盘的机型。</div>
    <div class="analysis-tags">
      <span>建议关注：${escapeHtml(trend === 'down' ? '连续下滑机型' : '大幅波动机型')}</span>
      <span>重点指标：估价完成率、下单率、发货率、成交率、GMV</span>
      <span>候选机型：${escapeHtml(focusModels.join('、') || '待筛选')}</span>
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
      ${monitorSortableTh('category', '品类', '', '按品类排序')}
      ${monitorSortableTh('modelName', '机型', '', '按机型名称排序')}
      ${monitorSortableTh('jkuv', '机况UV<sub class="mut">/日</sub>', 'num', '周日均')}
      ${monitorSortableTh('evaUv', '估价UV<sub class="mut">/日</sub>', 'num', '周日均')}
      ${monitorSortableTh('orderUv', '下单UV<sub class="mut">/日</sub>', 'num', '周日均')}
      ${monitorSortableTh('shipCnt', '发货<sub class="mut">/日</sub>', 'num', '周日均')}
      ${monitorSortableTh('qcCnt', '质检<sub class="mut">/日</sub>', 'num', '周日均')}
      ${monitorSortableTh('dealCnt', '成交<sub class="mut">/日</sub>', 'num', '周日均')}
      ${monitorSortableTh('gmv', 'GMV<sub class="mut">/日</sub>', 'num', '周日均 GMV')}
      ${rates.map((x) => monitorSortableTh('rate:' + x.key, x.name, 'rate', '按当前转化率排序；单元格内同时展示周环比')).join('')}
      ${monitorSortableTh('flags', '关注原因 &amp; 标签', '', '按异常/标签数量排序')}
      <th>操作</th>
    </tr>
  `;
  $$('#monitorTable thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (_monitorSortKey === key) {
        _monitorSortAsc = !_monitorSortAsc;
      } else {
        _monitorSortKey = key;
        _monitorSortAsc = key === 'category' || key === 'modelName';
      }
      renderMonitor();
    });
  });
  const tbody = $('#monitorTable tbody');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="99" class="empty-cell">没有匹配的机型 · 换个视图或先做一次「同步数据」</td></tr>`;
  } else {
    tbody.innerHTML = filtered
      .map((row) => renderMonitorRow(row, rates, rules.waveThreshold || 0.1))
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

function syncMonitorTagDimensionSelect() {
  const dims = getMonitorTagDimensions();
  const fallback = dims.find((d) => d.key === 'core') || dims[0] || { key: 'core', label: '核心度' };
  if (!dims.some((d) => d.key === state.monitorTagDimension)) {
    state.monitorTagDimension = fallback.key;
    clearMonitorTagFilters();
  }
  const sel = $('#monitorTagDimension');
  if (sel) {
    sel.innerHTML = dims.map((d) => `<option value="${escapeAttr(d.key)}">${escapeHtml(d.label || d.key)}</option>`).join('');
    sel.value = state.monitorTagDimension;
  }
  return dims.find((d) => d.key === state.monitorTagDimension) || fallback;
}

function normalizeTagSummaryGroup(group) {
  const value = normalizeGroupValue(group && group.value);
  return {
    ...(group || {}),
    value,
    label: (group && group.label) || groupLabel(value),
    modelCount: Number(group && group.modelCount) || 0,
    categoryCount: Number(group && group.categoryCount) || 0,
    cur: (group && group.cur) || {},
    watchCount: Number(group && group.watchCount) || 0,
    downTrendCount: Number(group && group.downTrendCount) || 0,
    models: Array.isArray(group && group.models) ? group.models : [],
  };
}

function getServerTagSummaryGroups(dimensionKey) {
  const summary = state.monitor && state.monitor.tagSummary;
  if (!summary || !Array.isArray(summary.groups)) return [];
  const wanted = String(dimensionKey || '').trim();
  if (wanted && summary.dimension && summary.dimension !== wanted) return [];
  return summary.groups.map(normalizeTagSummaryGroup);
}

function getMonitorFullRows() {
  const r = state.monitor || {};
  return Array.isArray(r.tagModels)
    ? r.tagModels.slice()
    : (Array.isArray(r.pool) ? r.pool.slice() : []);
}

function buildFilteredTagSummaryGroups(rows, dimension) {
  const clientGroups = buildTagSummaryForRows(rows, dimension).map(normalizeTagSummaryGroup);
  const serverGroups = getServerTagSummaryGroups(dimension && dimension.key);
  if (!serverGroups.length) return clientGroups;
  const clientByValue = new Map(clientGroups.map((g) => [normalizeGroupValue(g.value), g]));
  const merged = serverGroups.map((serverGroup) => {
    const value = normalizeGroupValue(serverGroup.value);
    return clientByValue.get(value) || {
      ...serverGroup,
      value,
      modelCount: 0,
      categoryCount: 0,
      cur: {},
      watchCount: 0,
      downTrendCount: 0,
      models: [],
    };
  });
  for (const group of clientGroups) {
    if (!merged.some((g) => normalizeGroupValue(g.value) === normalizeGroupValue(group.value))) merged.push(group);
  }
  return merged;
}

function filterMonitorDetailRows(rows, view, trend) {
  let filtered = Array.isArray(rows) ? rows.slice() : [];
  if (view === 'watch') {
    filtered = filtered.filter((x) => (x.flags || []).length);
  }
  if (trend === 'up') {
    filtered = filtered.filter((x) => x.delta && typeof x.delta.orderRate === 'number' && x.delta.orderRate > 0);
  } else if (trend === 'down') {
    filtered = filtered.filter((x) => x.delta && typeof x.delta.orderRate === 'number' && x.delta.orderRate < 0);
  }
  return filtered;
}

function emptyTagSummaryGroup(dimension, value) {
  return {
    dimension,
    value,
    label: groupLabel(value),
    modelCount: 0,
    categoryCount: 0,
    cur: {},
    watchCount: 0,
    downTrendCount: 0,
    models: [],
    _categories: new Set(),
  };
}

function buildTagSummaryForRows(rows, dimension) {
  const dimKey = dimension && dimension.key ? dimension.key : 'core';
  const apiLabelMap = new Map();
  const apiSummary = state.monitor && state.monitor.tagSummary;
  if (apiSummary && apiSummary.dimension === dimKey && Array.isArray(apiSummary.groups)) {
    for (const g of apiSummary.groups) apiLabelMap.set(normalizeGroupValue(g.value), g.label || groupLabel(g.value));
  }
  const map = new Map();
  for (const row of rows || []) {
    const value = normalizeGroupValue(dimensionValueForRow(row, dimKey));
    if (!map.has(value)) map.set(value, emptyTagSummaryGroup(dimKey, value));
    const group = map.get(value);
    group.label = apiLabelMap.get(value) || group.label;
    group.models.push(row);
    group.modelCount += 1;
    if (row.category) group._categories.add(row.category);
    const cur = row.cur || {};
    for (const key of TAG_SUMMARY_METRICS) {
      const n = Number(cur[key]);
      if (Number.isFinite(n)) group.cur[key] = (group.cur[key] || 0) + n;
    }
    if ((row.flags || []).length) group.watchCount += 1;
    if ((row.flags || []).some((f) => f.type === 'trend' && f.direction === 'down')) group.downTrendCount += 1;
  }
  const groups = [...map.values()].map((g) => {
    g.categoryCount = g._categories.size;
    delete g._categories;
    const c = g.cur;
    c.evaRate = c.jkuv ? c.evaUv / c.jkuv : null;
    c.orderRate = c.evaUv ? c.orderUv / c.evaUv : null;
    c.shipRate = c.evaUv ? c.shipCnt / c.evaUv : null;
    c.dealRate = c.evaUv ? c.dealCnt / c.evaUv : null;
    c.returnRate = c.qcCnt && Number.isFinite(c.returnCnt) ? c.returnCnt / c.qcCnt : null;
    return g;
  });
  groups.sort((a, b) => b.modelCount - a.modelCount || String(a.label).localeCompare(String(b.label), 'zh-CN', { numeric: true }));
  return groups;
}

function sumGroupMetric(groups, key) {
  return (groups || []).reduce((sum, group) => sum + (Number(group && group.cur && group.cur[key]) || 0), 0);
}

function groupShare(group, total, key = 'orderUv') {
  const value = Number(group && group.cur && group.cur[key]) || 0;
  return total > 0 ? value / total : null;
}

function renderMonitorTagInsight(dimension, groups, rowCount) {
  const el = $('#monitorTagInsightOverview');
  if (!el) return;
  const totalOrder = sumGroupMetric(groups, 'orderUv');
  const totalGmv = sumGroupMetric(groups, 'gmv');
  const nonZeroGroups = (groups || []).filter((g) => (Number(g.modelCount) || 0) > 0);
  const topOrderGroup = nonZeroGroups.slice().sort((a, b) => (Number(b.cur && b.cur.orderUv) || 0) - (Number(a.cur && a.cur.orderUv) || 0))[0];
  const topWatchGroup = nonZeroGroups.slice().sort((a, b) => (Number(b.watchCount) || 0) - (Number(a.watchCount) || 0))[0];
  const untagged = (groups || []).find((g) => normalizeGroupValue(g.value) === UNTAGGED_VALUE);
  const activeFilters = getActiveMonitorTagFilters();
  const topOrderShare = topOrderGroup ? groupShare(topOrderGroup, totalOrder, 'orderUv') : null;
  const untaggedShare = untagged ? groupShare(untagged, totalOrder, 'orderUv') : null;
  const filterText = activeFilters.length
    ? `当前已交叉筛选 ${activeFilters.map((f) => `${getMonitorDimensionLabel(f.dimension)}=${groupLabel(f.value)}`).join('、')}。`
    : '当前未限定标签筛选。';
  const topOrderText = topOrderGroup
    ? `「${topOrderGroup.label}」贡献下单UV ${fmtInt(topOrderGroup.cur && topOrderGroup.cur.orderUv)}，占该维度 ${fmtRate(topOrderShare)}，覆盖 ${fmtInt(topOrderGroup.modelCount)} 个机型。`
    : '当前维度暂无可分析的下单分布。';
  const untaggedText = untagged
    ? `未打标下单占比 ${fmtRate(untaggedShare)}，机型 ${fmtInt(untagged.modelCount)} 个。`
    : '';
  const watchText = topWatchGroup && topWatchGroup.watchCount
    ? `需关注最集中在「${topWatchGroup.label}」：${fmtInt(topWatchGroup.watchCount)} 个机型。`
    : '当前标签维度暂无明显关注集中组。';

  el.innerHTML = `
    <div class="analysis-title">标签维度分析</div>
    <div class="analysis-body">按「${escapeHtml(dimension.label || dimension.key)}」分析 ${fmtInt(rowCount)} 个机型的漏斗贡献：${escapeHtml(topOrderText)} ${escapeHtml(untaggedText)} ${escapeHtml(watchText)}</div>
    <div class="analysis-tags">
      <span>下单UV总量：${fmtInt(totalOrder)}</span>
      <span>GMV总量：${fmtInt(totalGmv)}</span>
      <span>${escapeHtml(filterText)}</span>
    </div>
  `;
}

function renderMonitorTagAggregation(dimension, groups, rowCount) {
  const panel = $('#monitorTagAggregation');
  const table = $('#monitorTagSummaryTable');
  if (!panel || !table) return;
  const hint = $('#monitorTagAggHint');
  if (hint) {
    hint.textContent = `按「${dimension.label || dimension.key}」聚合服务端全量 ${rowCount} 个机型；点击标签值后，下方机型表进入该组，视图/趋势只影响明细表。`;
  }
  const drill = $('#monitorTagGroupDrill');
  const activeValue = currentMonitorTagFilterValue(dimension.key);
  const active = groups.find((g) => normalizeGroupValue(g.value) === activeValue);
  if (drill) {
    const filters = getActiveMonitorTagFilters();
    if (filters.length) {
      const chips = filters.map((f) => `
        <span class="tag-filter-chip">
          <b>${escapeHtml(getMonitorDimensionLabel(f.dimension))}</b>
          <span>= ${escapeHtml(groupLabel(f.value))}</span>
          <button type="button" class="clear-tag-filter" data-dim="${escapeAttr(f.dimension)}" aria-label="移除筛选">×</button>
        </span>
      `).join('');
      drill.innerHTML = `
        <div class="tag-filter-main">
          <span>已筛选：</span>
          ${chips}
          ${active ? `<span class="tag-filter-count">当前维度命中 ${fmtInt(active.modelCount)} 个机型</span>` : ''}
        </div>
        <button type="button" id="btnClearTagGroup">清除全部</button>
      `;
      drill.classList.remove('hidden');
      $$('#monitorTagGroupDrill .clear-tag-filter').forEach((btn) => {
        btn.addEventListener('click', () => {
          const dim = btn.dataset.dim;
          if (state.monitorTagFilters) delete state.monitorTagFilters[dim];
          state.monitorTagGroupValue = currentMonitorTagFilterValue(dimension.key) || null;
          renderMonitor();
        });
      });
      const clearAll = $('#btnClearTagGroup');
      if (clearAll) clearAll.addEventListener('click', () => {
        clearMonitorTagFilters();
        refreshMonitor();
      });
    } else {
      drill.classList.add('hidden');
      drill.innerHTML = '';
    }
  }
  const totalOrderUv = sumGroupMetric(groups, 'orderUv');
  table.querySelector('thead').innerHTML = `
    <tr>
      <th>标签值</th>
      <th class="num">机型 / 品类</th>
      <th class="num">估价UV<sub class="mut">/日</sub></th>
      <th class="num">下单UV<sub class="mut">/日</sub></th>
      <th class="num">成交量<sub class="mut">/日</sub></th>
      <th class="num">GMV<sub class="mut">/日</sub></th>
      <th class="num">下单率</th>
      <th class="num">成交率</th>
      <th class="num">下单占比</th>
      <th class="num">需关注</th>
      <th class="num">连续下滑</th>
    </tr>
  `;
  table.querySelector('tbody').innerHTML = groups.length
    ? groups.map((g, idx) => `
      <tr class="${normalizeGroupValue(g.value) === activeValue ? 'selected' : ''}">
        <td>
          <button type="button" class="tag-group-btn tag-color-${idx % 6} ${normalizeGroupValue(g.value) === activeValue ? 'is-active' : ''}" data-dim="${escapeAttr(dimension.key)}" data-value="${escapeAttr(g.value)}">
            ${escapeHtml(g.label)}
          </button>
        </td>
        <td class="num">${fmtInt(g.modelCount)} / ${fmtInt(g.categoryCount)}</td>
        <td class="num">${fmtInt(g.cur.evaUv)}</td>
        <td class="num">${fmtInt(g.cur.orderUv)}</td>
        <td class="num">${fmtInt(g.cur.dealCnt)}</td>
        <td class="num">${fmtInt(g.cur.gmv)}</td>
        <td class="num">${fmtRate(g.cur.orderRate)}</td>
        <td class="num">${fmtRate(g.cur.dealRate)}</td>
        <td class="num">${fmtRate(groupShare(g, totalOrderUv, 'orderUv'))}</td>
        <td class="num ${g.watchCount ? 'warn-text' : ''}">${fmtInt(g.watchCount)}</td>
        <td class="num ${g.downTrendCount ? 'down-text' : ''}">${fmtInt(g.downTrendCount)}</td>
      </tr>
    `).join('')
    : '<tr><td colspan="99" class="empty-cell">当前筛选下没有可聚合的机型</td></tr>';
  $$('#monitorTagSummaryTable .tag-group-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = normalizeGroupValue(btn.dataset.value);
      setCurrentMonitorTagFilter(btn.dataset.dim || dimension.key, value);
      renderMonitor();
    });
  });
}

function monitorSortableTh(key, labelHtml, cls = '', title = '') {
  const arrow = _monitorSortKey === key ? (_monitorSortAsc ? ' ↑' : ' ↓') : '';
  return `<th class="${cls}" data-sort="${escapeAttr(key)}" title="${escapeAttr(title)}">${labelHtml}${arrow}</th>`;
}

function sortMonitorRows(rows) {
  const list = (rows || []).slice();
  if (!_monitorSortKey) return list;
  list.sort((a, b) => compareMonitorValues(monitorSortValue(a, _monitorSortKey), monitorSortValue(b, _monitorSortKey), _monitorSortAsc));
  return list;
}

function monitorSortValue(row, key) {
  if (!row) return null;
  const cur = row.cur || {};
  if (key === 'category') return row.category || '';
  if (key === 'modelName') return row.modelName || '';
  if (key === 'flags') return (row.flags || []).length + countTaggedDimensions(row) * 0.01;
  if (key.startsWith('rate:')) return cur[key.slice(5)];
  return cur[key];
}

function compareMonitorValues(a, b, asc) {
  const aMissing = a === null || a === undefined || a === '' || (typeof a === 'number' && !Number.isFinite(a));
  const bMissing = b === null || b === undefined || b === '' || (typeof b === 'number' && !Number.isFinite(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  if (typeof a === 'string' || typeof b === 'string') {
    const r = String(a).localeCompare(String(b), 'zh');
    return asc ? r : -r;
  }
  const r = Number(a) - Number(b);
  return asc ? r : -r;
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
  const tagsHtml = renderTagChips(row.category, row.modelName, row, { compact: true });
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
      <td class="num">${fmtInt(cur.jkuv)}</td>
      <td class="num">${fmtInt(cur.evaUv)}</td>
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

function openMonitorMetricsModal() {
  const allRates = monitorRateList(state.rules || (state.monitor && state.monitor.rules) || {});
  const selected = new Set(loadMonitorMetricKeys(allRates));
  const box = $('#monitorMetricOptions');
  box.innerHTML = allRates.map((rate) => `
    <label class="metric-check">
      <input type="checkbox" value="${escapeAttr(rate.key)}" ${selected.has(rate.key) ? 'checked' : ''} />
      <span>${escapeHtml(rate.name)}</span>
    </label>
  `).join('');
  $('#modalMonitorMetrics').classList.remove('hidden');
}

function saveMonitorMetricsModal() {
  const allRates = monitorRateList(state.rules || (state.monitor && state.monitor.rules) || {});
  const allowed = new Set(allRates.map((r) => r.key));
  const keys = $$('#monitorMetricOptions input[type="checkbox"]:checked')
    .map((input) => input.value)
    .filter((key) => allowed.has(key));
  if (!keys.length) {
    toast('至少保留一个关键转化率指标');
    return;
  }
  saveMonitorMetricKeys(keys);
  $('#modalMonitorMetrics').classList.add('hidden');
  renderMonitor();
}

function resetMonitorMetrics() {
  const allRates = monitorRateList(state.rules || (state.monitor && state.monitor.rules) || {});
  saveMonitorMetricKeys(allRates.map((r) => r.key));
  openMonitorMetricsModal();
  renderMonitor();
}

function getConfiguredMonitorTagOptions(dimensionKey) {
  const category = resolveMonitorCategory();
  const vocab = normalizeVocab(state.vocab || {});
  const defs = category
    ? buildDimensionDefsForCategory(category)
    : BASE_TAG_DIMENSIONS.map((d) => ({ ...d, options: vocab[d.key] || [] }));
  const hit = defs.find((d) => d.key === dimensionKey);
  return uniqStrings(hit && hit.options);
}

function getMonitorTagFilterOptions(dimension, rows) {
  const dimKey = dimension && dimension.key;
  const configured = getConfiguredMonitorTagOptions(dimKey);
  const present = uniqStrings((rows || []).map((row) => dimensionValueForRow(row, dimKey)).filter(Boolean));
  const ordered = [];
  const push = (value) => {
    const normalized = normalizeGroupValue(value);
    if (!normalized || ordered.some((x) => x.value === normalized)) return;
    ordered.push({ value: normalized, label: groupLabel(normalized) });
  };
  push(UNTAGGED_VALUE);
  configured.forEach(push);
  present
    .filter((value) => !configured.includes(value))
    .sort((a, b) => String(a).localeCompare(String(b), 'zh-CN', { numeric: true }))
    .forEach(push);
  const active = currentMonitorTagFilterValue(dimKey);
  if (active) push(active);
  return ordered;
}

function openMonitorTagFiltersModal() {
  syncMonitorTagDimensionSelect();
  renderMonitorTagFilterOptions();
  $('#modalMonitorTagFilters').classList.remove('hidden');
}

function renderMonitorTagFilterOptions() {
  const box = $('#monitorTagFilterOptions');
  if (!box) return;
  const dims = getMonitorTagDimensions();
  const rows = getMonitorFullRows();
  if (!dims.length) {
    box.innerHTML = '<div class="empty-cell">暂无可筛选的标签维度</div>';
    return;
  }
  box.innerHTML = dims.map((dim) => {
    const selected = currentMonitorTagFilterValue(dim.key);
    const options = getMonitorTagFilterOptions(dim, rows);
    return `
      <label class="tag-filter-row">
        <span class="tag-filter-label">${escapeHtml(dim.label || dim.key)}</span>
        <select class="tag-filter-select" data-dim="${escapeAttr(dim.key)}">
          <option value="">不筛选</option>
          ${options.map((opt) => `
            <option value="${escapeAttr(opt.value)}" ${opt.value === selected ? 'selected' : ''}>${escapeHtml(opt.label)}</option>
          `).join('')}
        </select>
      </label>
    `;
  }).join('');
}

function saveMonitorTagFiltersModal() {
  const dims = getMonitorTagDimensions();
  const validDims = new Set(dims.map((d) => d.key));
  const filters = {};
  $$('#monitorTagFilterOptions .tag-filter-select').forEach((select) => {
    const dimKey = select.dataset.dim;
    if (!dimKey || !validDims.has(dimKey) || !select.value) return;
    filters[dimKey] = normalizeGroupValue(select.value);
  });
  state.monitorTagFilters = filters;
  state.monitorTagGroupValue = currentMonitorTagFilterValue(state.monitorTagDimension) || null;
  $('#modalMonitorTagFilters').classList.add('hidden');
  renderMonitor();
  const count = Object.keys(filters).length;
  toast(count ? `已应用 ${count} 个标签筛选` : '已清空标签筛选');
}

function resetMonitorTagFilters() {
  clearMonitorTagFilters();
  renderMonitorTagFilterOptions();
  if (state.monitor) renderMonitor();
  toast('已清空标签筛选');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// ---- 标签管理页 ----
function resolveTagsCategory() {
  const cats = getKnownCategories();
  const input = $('#tagsCategory');
  const value = String((input && input.value) || '').trim();
  if (value && cats.includes(value)) return value;
  const fallback = cats[0] || value || '';
  if (input && input.value !== fallback) {
    if (value && cats.length) toast('请从品类搜索建议中选择一个已有品类');
    input.value = fallback;
  }
  return fallback;
}

function refreshTagsPage() {
  const m = state.meta;
  if (!m || !m.synced) {
    $('#tagsTable thead').innerHTML = '';
    $('#tagsTable tbody').innerHTML = '<tr><td colspan="99">尚未同步数据。</td></tr>';
    return;
  }
  const cat = resolveTagsCategory();
  if (!cat) {
    $('#tagsTable thead').innerHTML = '';
    $('#tagsTable tbody').innerHTML = '<tr><td colspan="99">暂无可选品类。</td></tr>';
    return;
  }
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
        <th><input type="checkbox" id="tagsSelectAll" title="全选当前列表" /></th><th>机型</th><th>最新周</th><th class="num">估价UV<sub class="mut">/日</sub></th><th class="num">下单UV<sub class="mut">/日</sub></th><th class="num">成交量<sub class="mut">/日</sub></th>
        <th>标签</th><th>备注</th><th>操作</th>
      </tr>`;
      const tbody = $('#tagsTable tbody');
      tbody.innerHTML = rows
        .map((r) => {
          const k = keyOf(cat, r.modelName);
          const t = state.tags[k] || { tags: [], note: '' };
          return `<tr>
            <td><input type="checkbox" class="tag-row-check" data-model="${escapeAttr(r.modelName)}" /></td>
            <td>${escapeHtml(r.modelName)}</td>
            <td>${r.week}</td>
            <td class="num">${fmtInt(r.evaUv)}</td>
            <td class="num">${fmtInt(r.orderUv)}</td>
            <td class="num">${fmtInt(r.dealCnt)}</td>
            <td>${renderTagChips(cat, r.modelName, r, { includeUntagged: true })}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;color:var(--c-text-2);">${escapeHtml(t.note || '')}</td>
            <td><button class="edit-tag" data-cat="${escapeAttr(cat)}" data-model="${escapeAttr(r.modelName)}">打标签 →</button></td>
          </tr>`;
        })
        .join('') || `<tr><td colspan="99" style="text-align:center;padding:20px;color:#9ca3af;">该品类下无机型</td></tr>`;
      $$('#tagsTable button.edit-tag').forEach((b) => {
        b.addEventListener('click', () => openTagModal(b.dataset.cat, b.dataset.model));
      });
      const all = $('#tagsSelectAll');
      if (all) {
        all.addEventListener('change', () => {
          $$('#tagsTable .tag-row-check').forEach((ck) => { ck.checked = all.checked; });
        });
      }
      $('#tagsSummary').textContent = `${cat}: ${rows.length} 个机型 (仅显示最新周有数据的)`;
    })
    .catch((e) => toast('加载失败: ' + e.message));
}

// ---- 标签编辑弹层 ----
let modalCtx = null;
function openBatchTagModal() {
  const cat = resolveTagsCategory();
  const models = $$('#tagsTable .tag-row-check')
    .filter((ck) => ck.checked)
    .map((ck) => ck.dataset.model)
    .filter(Boolean);
  if (!models.length) {
    toast('请先勾选要批量标记的机型');
    return;
  }
  openTagModal(cat, models[0], { batchModels: models });
}

function openTagModal(cat, model) {
  const opts = arguments[2] || {};
  const isBatch = !!(opts.batchModels && opts.batchModels.length);
  modalCtx = isBatch ? { cat, model, models: opts.batchModels, isBatch: true } : { cat, model, isBatch: false };
  $('#modalTagTitle').textContent = isBatch ? `${cat} · 批量编辑 ${opts.batchModels.length} 个机型` : `${cat} · ${model}`;
  const key = keyOf(cat, model);
  const cur = isBatch ? { dimensions: {}, note: '' } : (state.tags[key] || { dimensions: {}, tags: [], note: '' });
  const curDimensions = getEntryDimensions(cur, cat);
  const defs = buildDimensionDefsForCategory(cat);
  const box = $('#modalTagGroups');
  box.innerHTML = defs.map((def, idx) => renderTagDimensionEditor(def, idx, curDimensions[def.key], isBatch)).join('');
  $('#modalTagNote').value = cur.note || '';
  $('#modalTagNote').placeholder = isBatch ? '批量编辑时留空则不改备注' : '';
  $('#modalTag').classList.remove('hidden');
}

function renderTagDimensionEditor(def, idx, selectedValue, isBatch) {
  const name = `tag-dim-${idx}`;
  const options = Array.isArray(def.options) ? def.options : [];
  const radios = [];
  if (isBatch) {
    radios.push(`
      <label class="tag-radio keep-radio">
        <input type="radio" name="${escapeAttr(name)}" value="${BATCH_KEEP_VALUE}" checked />
        <span>保持不变</span>
      </label>
    `);
  }
  radios.push(`
    <label class="tag-radio">
      <input type="radio" name="${escapeAttr(name)}" value="" ${!isBatch && !selectedValue ? 'checked' : ''} />
      <span>${UNTAGGED_LABEL}</span>
    </label>
  `);
  for (const option of options) {
    radios.push(`
      <label class="tag-radio">
        <input type="radio" name="${escapeAttr(name)}" value="${escapeAttr(option)}" ${!isBatch && selectedValue === option ? 'checked' : ''} />
        <span>${escapeHtml(option)}</span>
      </label>
    `);
  }
  return `
    <div class="tag-dimension" data-dim-key="${escapeAttr(def.key)}">
      <div class="group-title">${escapeHtml(def.label || def.key)}</div>
      <div class="options tag-radio-list">
        ${radios.join('') || '<span style="color:#d1d5db;font-size:12px;">(空)</span>'}
      </div>
    </div>
  `;
}

function collectModalDimensionPatch() {
  const patch = {};
  $$('#modalTagGroups .tag-dimension').forEach((group) => {
    const key = group.dataset.dimKey;
    const checked = group.querySelector('input[type="radio"]:checked');
    if (!key || !checked) return;
    patch[key] = checked.value;
  });
  return patch;
}

async function saveTagModal() {
  if (!modalCtx) return;
  const patch = collectModalDimensionPatch();
  const note = $('#modalTagNote').value;
  try {
    const models = modalCtx.models && modalCtx.models.length ? modalCtx.models : [modalCtx.model];
    const updatesDimensions = Object.values(patch).some((v) => v !== BATCH_KEEP_VALUE);
    const updatesNote = !modalCtx.isBatch || note.trim() !== '';
    if (modalCtx.isBatch && !updatesDimensions && !updatesNote) {
      toast('请选择要批量修改的维度，或填写备注');
      return;
    }
    for (const model of models) {
      const key = keyOf(modalCtx.cat, model);
      const before = state.tags[key] || {};
      const dimensions = modalCtx.isBatch ? { ...getEntryDimensions(before, modalCtx.cat) } : {};
      for (const [dimKey, value] of Object.entries(patch)) {
        if (value === BATCH_KEEP_VALUE) continue;
        if (value) dimensions[dimKey] = value;
        else delete dimensions[dimKey];
      }
      const nextNote = updatesNote ? note : (before.note || '');
      await api('/api/tags/' + encodeURIComponent(key), {
        method: 'PUT',
        body: JSON.stringify({ dimensions, note: nextNote }),
      });
      state.tags[key] = { dimensions, note: nextNote };
    }
    state.monitorCache = {};
    toast(models.length > 1 ? `已批量保存 ${models.length} 个机型` : '已保存');
    $('#modalTag').classList.add('hidden');
    // 刷新当前页
    if (!$('#page-monitor').classList.contains('hidden')) refreshMonitor();
    if (!$('#page-tags').classList.contains('hidden')) refreshTagsPage();
  } catch (e) {
    toast('保存失败: ' + e.message);
  }
}

// ---- 标签字典 ----
function openVocabModal() {
  const v = normalizeVocab(state.vocab || {});
  state.vocab = v;
  $$('#modalVocab .vocab-groups textarea').forEach((ta) => {
    const k = ta.dataset.key;
    ta.value = (v[k] || []).join('\n');
  });
  renderCategoryDatalist();
  const box = $('#vocabCustom');
  box.innerHTML = '';
  const cats = Object.keys(v.custom || {});
  if (!cats.length) addVocabCat('', []);
  else cats.forEach((c) => addVocabCat(c, v.custom[c] || []));
  $('#modalVocab').classList.remove('hidden');
}

function addVocabCat(name, dims) {
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.innerHTML = `
    <div class="cat-row-head">
      <label>品类
        <input class="cat-name" placeholder="搜索并选择品类" list="categorySuggest" value="${escapeAttr(name)}" autocomplete="off" />
      </label>
      <div class="cat-row-actions">
        <button type="button" class="add-dim">+ 维度</button>
        <button type="button" class="del">删除品类</button>
      </div>
    </div>
    <div class="cat-dims"></div>
  `;
  row.querySelector('.del').addEventListener('click', () => row.remove());
  row.querySelector('.add-dim').addEventListener('click', () => addVocabDim(row.querySelector('.cat-dims'), { id: makeCustomDimId('dim'), name: '', options: [] }));
  $('#vocabCustom').appendChild(row);
  const dimBox = row.querySelector('.cat-dims');
  const normalizedDims = Array.isArray(dims) ? dims : [];
  if (normalizedDims.length) normalizedDims.forEach((dim) => addVocabDim(dimBox, dim));
  else addVocabDim(dimBox, { id: makeCustomDimId('dim'), name: '', options: [] });
  const input = row.querySelector('.cat-name');
  if (!name && input) input.focus();
}

function addVocabDim(container, dim) {
  const id = String((dim && dim.id) || makeCustomDimId(dim && dim.name)).trim();
  const row = document.createElement('div');
  row.className = 'cat-dim-row';
  row.dataset.dimId = id;
  row.innerHTML = `
    <input class="dim-name" placeholder="维度名称，例如：A/B层、系列、货源层级" value="${escapeAttr((dim && dim.name) || '')}" />
    <textarea class="dim-options" rows="2" placeholder="每行一个选项，例如：A层&#10;B层&#10;C层">${escapeHtml(((dim && dim.options) || []).join('\n'))}</textarea>
    <button type="button" class="del-dim" title="删除维度">×</button>
  `;
  row.querySelector('.del-dim').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

async function saveVocab() {
  const v = {};
  $$('#modalVocab .vocab-groups textarea').forEach((ta) => {
    v[ta.dataset.key] = uniqStrings(ta.value.split('\n'));
  });
  const custom = {};
  const known = new Set(getKnownCategories());
  const seenCats = new Set();
  let invalid = '';
  $$('#vocabCustom .cat-row').forEach((row) => {
    row.classList.remove('has-error');
    const name = row.querySelector('.cat-name').value.trim();
    if (!name) return;
    if (known.size && !known.has(name)) {
      row.classList.add('has-error');
      invalid = `品类「${name}」不在当前数据品类里，请从搜索建议中选择`;
      return;
    }
    if (seenCats.has(name)) {
      row.classList.add('has-error');
      invalid = `品类「${name}」重复配置，请合并到同一张卡片`;
      return;
    }
    seenCats.add(name);
    const dims = [];
    const usedIds = new Set();
    row.querySelectorAll('.cat-dim-row').forEach((dimRow, idx) => {
      dimRow.classList.remove('has-error');
      const dimName = dimRow.querySelector('.dim-name').value.trim();
      const options = uniqStrings(dimRow.querySelector('.dim-options').value.split('\n'));
      if (!dimName && !options.length) return;
      if (!dimName || !options.length) {
        dimRow.classList.add('has-error');
        invalid = '每个自定义维度都需要填写维度名称和至少一个选项';
        return;
      }
      let id = String(dimRow.dataset.dimId || stableDimIdFromName(dimName, idx)).trim();
      while (usedIds.has(id)) id = `${id}-${idx + 1}`;
      usedIds.add(id);
      dims.push({ id, name: dimName, options });
    });
    if (dims.length) custom[name] = dims;
  });
  if (invalid) {
    toast(invalid, 4200);
    return;
  }
  v.custom = custom;
  try {
    const r = await api('/api/tag-vocab', { method: 'PUT', body: JSON.stringify(v) });
    state.vocab = normalizeVocab((r && r.vocab) || v);
    state.monitorCache = {};
    toast('字典已保存');
    $('#modalVocab').classList.add('hidden');
    if (!$('#page-monitor').classList.contains('hidden')) refreshMonitor();
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
    state.monitorCache = {};
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
      if (!confirm(`导入设置(合并模式)?\n标签: ${Object.keys(bundle.tags || {}).length} 个机型\n字典/规则一并导入`)) return;
      if (bundle.tags) await api('/api/tags/import', { method: 'POST', body: JSON.stringify({ data: bundle.tags, mode: 'merge' }) });
      if (bundle.vocab) await api('/api/tag-vocab', { method: 'PUT', body: JSON.stringify(bundle.vocab) });
      if (bundle.rules) await api('/api/rules', { method: 'PUT', body: JSON.stringify(bundle.rules) });
      state.monitorCache = {};
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
async function refreshDashboard() {
  const meta = $('#dashMeta');
  const boardKpi = $('#dashBoardKpi');
  const boardOverview = $('#dashBoardOverview');
  const tierOverview = $('#dashTierOverview');
  const tierSummary = $('#dashTierSummary');
  const catThead = $('#dashCategoryTable thead');
  const catTbody = $('#dashCategoryTable tbody');
  try {
    if (!state.meta || !state.meta.synced) {
      meta.innerHTML = '';
      if (boardOverview) boardOverview.innerHTML = '';
      boardKpi.innerHTML = '';
      if (tierOverview) tierOverview.innerHTML = '';
      tierSummary.innerHTML = '';
      catThead.innerHTML = '';
      catTbody.innerHTML = '<tr><td colspan="99" class="dash-empty">尚未同步数据 · 请先点顶部「同步数据」</td></tr>';
      return;
    }
    const weeks = sortWeekValues(state.meta.dashboardWeeks || state.meta.weeks || []);
    const urlWeek = readUrlState().week || '';
    const selectedWeek = (!urlWeek || weeks.indexOf(urlWeek) >= 0) ? (urlWeek || latestWeekValue(weeks)) : latestWeekValue(weeks);
    const qs = selectedWeek ? '?week=' + encodeURIComponent(selectedWeek) : '';
    const d = await api('/api/dashboard' + qs);
    if (!d || !d.board) {
      catTbody.innerHTML = '<tr><td colspan="99" class="dash-empty">数据组装中，请稍后刷新</td></tr>';
      return;
    }
    renderDashboardMetaV2(d);
    renderDashboardOverviewV2(d);
    renderBoardKpi(d);
    const curTier = readUrlState().tier || '发展';
    setActiveTierTab(curTier);
    renderTierOverview(d.tiers, curTier);
    renderTierSummary(d.tiers, curTier, d.categories);
    if (typeof renderSecondaryCategorySummary === 'function') renderSecondaryCategorySummary(d.categories, curTier);
    renderCategoryTable(d.categories, curTier);
  } catch (e) {
    console.error('[dashboard-v2] failed', e);
    catTbody.innerHTML = '<tr><td colspan="99" class="dash-empty">加载失败: ' + escapeHtml(e.message) + '</td></tr>';
  }
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
    tier: p.get('tier') || '',
    secondary: p.get('secondary') || '',
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
  $('#drawerTags').innerHTML = renderTagChips(category, modelName, row, { includeUntagged: true, chipClass: 'tag-chip' });

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
bootAccessGate();

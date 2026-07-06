// Express 主服务
const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const feishu = require('./feishu');
const { sync } = require('./sync');
const { monitor, DEFAULT_RULES } = require('./monitor');
const { getDashboard, getDashboardFromUpstream, invalidateDashboardCache, normalizeMonitor } = require('./dashboard');
const { createProxy } = require('./proxy');

const app = express();
const PORT = process.env.PORT || 8848;
const UPSTREAM = (process.env.PROXY_UPSTREAM || '').trim();

// gzip 压缩所有响应(monitor 结果约 2.8MB → 压缩后约 400KB)
app.use(compression());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// 代理模式：/api/* → PROXY_UPSTREAM（/api/dashboard 例外，见 EXCLUDE_PATHS）
// /api/monitor 挂 responseRewrite 归一化 trend，兜底 Node 版 wave.js calcTrend `{}` bug
const proxy = createProxy(UPSTREAM, {
  responseRewrite: {
    '/api/monitor': (obj) => normalizeMonitor(obj),
  },
});
if (proxy) {
  app.use(proxy);
  console.log(`[proxy] mode=upstream target=${UPSTREAM}`);
} else {
  console.log('[proxy] mode=local (set PROXY_UPSTREAM to enable)');
}

// 简单的用户识别:从 header 拿 X-User,前端设置一次存 localStorage
function getUser(req) {
  return String(req.headers['x-user'] || 'anonymous').slice(0, 32);
}

// ---- 数据同步 ----
let syncing = false;
app.post('/api/sync', async (req, res) => {
  if (syncing) return res.status(409).json({ error: '正在同步中,请稍候' });
  syncing = true;
  const user = getUser(req);
  try {
    const result = await sync();
    invalidateDashboardCache();
    store.appendLog({ action: 'sync-manual', user, ...result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[/api/sync] 失败:', e);
    res.status(500).json({ error: e.message });
  } finally {
    syncing = false;
  }
});

// ---- 元数据 ----
app.get('/api/meta', (req, res) => {
  const cache = store.readJSON('cache.json', null);
  if (!cache) return res.json({ synced: false });
  res.json({
    synced: true,
    syncedAt: cache.syncedAt,
    categories: cache.categories,
    weeks: cache.weeks,
    rowCount: cache.rows.length,
    source: cache.source,
  });
});

// ---- 拿原始数据(可按品类/周筛选)----
app.get('/api/data', (req, res) => {
  const cache = store.readJSON('cache.json', null);
  if (!cache) return res.json({ rows: [] });
  const { category, week } = req.query;
  let rows = cache.rows;
  if (category) rows = rows.filter((r) => r.category === category);
  if (week) rows = rows.filter((r) => r.week === week);
  res.json({ rows, syncedAt: cache.syncedAt });
});

// ---- 标签 ----
// tags.json 结构: { "category||modelName": { tags: ["核心", "40系"], note: "..." } }
app.get('/api/tags', (req, res) => {
  const tags = store.readJSON('tags.json', {});
  res.json(tags);
});

app.put('/api/tags/:key', (req, res) => {
  const user = getUser(req);
  const { key } = req.params;
  const { tags = [], note = '' } = req.body || {};
  if (!key.includes('||')) return res.status(400).json({ error: 'key 格式应为 category||modelName' });
  const all = store.readJSON('tags.json', {});
  const before = all[key];
  all[key] = { tags: Array.isArray(tags) ? tags.map(String) : [], note: String(note || '') };
  store.writeJSON('tags.json', all);
  store.appendLog({ action: 'tag-update', user, key, before, after: all[key] });
  res.json({ ok: true, tags: all[key] });
});

// 批量导入(合并/覆盖)
app.post('/api/tags/import', (req, res) => {
  const user = getUser(req);
  const { data, mode = 'merge' } = req.body || {};
  if (!data || typeof data !== 'object') return res.status(400).json({ error: '缺少 data 对象' });
  let all = mode === 'replace' ? {} : store.readJSON('tags.json', {});
  let count = 0;
  for (const [k, v] of Object.entries(data)) {
    if (!k.includes('||')) continue;
    all[k] = {
      tags: Array.isArray(v?.tags) ? v.tags.map(String) : [],
      note: String(v?.note || ''),
    };
    count++;
  }
  store.writeJSON('tags.json', all);
  store.appendLog({ action: 'tag-import', user, mode, count });
  res.json({ ok: true, count });
});

// ---- 标签字典(可选标签集合)----
// tagVocab.json 结构:
// { lifecycle: ["新品","主流","长尾","淘汰"], price: ["高","中","低"], core: ["核心","非核心","观察"], custom: { "组装机": ["高端","入门"], ... } }
const DEFAULT_TAG_VOCAB = {
  lifecycle: ['新品', '主流', '长尾', '淘汰'],
  price: ['高价段', '中价段', '低价段'],
  core: ['核心', '非核心', '观察'],
  custom: {},
};

app.get('/api/tag-vocab', (req, res) => {
  const v = store.readJSON('tag-vocab.json', DEFAULT_TAG_VOCAB);
  res.json(v);
});

app.put('/api/tag-vocab', (req, res) => {
  const user = getUser(req);
  const body = req.body || {};
  const v = {
    lifecycle: Array.isArray(body.lifecycle) ? body.lifecycle.map(String) : DEFAULT_TAG_VOCAB.lifecycle,
    price: Array.isArray(body.price) ? body.price.map(String) : DEFAULT_TAG_VOCAB.price,
    core: Array.isArray(body.core) ? body.core.map(String) : DEFAULT_TAG_VOCAB.core,
    custom: body.custom && typeof body.custom === 'object' ? body.custom : {},
  };
  store.writeJSON('tag-vocab.json', v);
  store.appendLog({ action: 'vocab-update', user });
  res.json({ ok: true, vocab: v });
});

// ---- 规则 ----
app.get('/api/rules', (req, res) => {
  const r = store.readJSON('rules.json', DEFAULT_RULES);
  res.json(r);
});

app.put('/api/rules', (req, res) => {
  const user = getUser(req);
  const body = req.body || {};
  const cur = store.readJSON('rules.json', DEFAULT_RULES);
  const next = {
    ...cur,
    ...body,
    rates: DEFAULT_RULES.rates, // rates 固定不让改
  };
  store.writeJSON('rules.json', next);
  invalidateDashboardCache();
  store.appendLog({ action: 'rules-update', user, next });
  res.json({ ok: true, rules: next });
});

// ---- 监测 ----
// 数据源模式（无 PROXY_UPSTREAM）：Node 版 wave.js calcTrend 有 {} 泄漏 bug，
// 这里做消费端归一化兜底（对齐 Python wave.py 契约：5 项 rate 补齐、非法值归 null）。
// 代理模式下同样的归一化挂在 proxy responseRewrite 钩子（见上文 createProxy），
// 两个入口都要包，保持前端契约统一。
app.get('/api/monitor', (req, res) => {
  const cache = store.readJSON('cache.json', null);
  if (!cache) return res.json({ error: '尚未同步数据,请先点"同步数据"' });
  const rules = store.readJSON('rules.json', DEFAULT_RULES);
  const tagsMap = {};
  const tagsAll = store.readJSON('tags.json', {});
  for (const [k, v] of Object.entries(tagsAll)) tagsMap[k] = v.tags || [];
  const result = monitor(cache, rules, tagsMap, { week: req.query.week || null });
  // 归一化 + 强禁缓存
  // - 剥 ETag/Last-Modified：body 被归一化改写，上游/express 默认 ETag 已失去意义
  // - Cache-Control 三连：no-store 禁存 + no-cache 强制回源 + must-revalidate 兜底
  // 注意：用 res.end(JSON) 而非 res.json()，绕过 express send() 内部的 ETag 重生成
  //       （res.json → res.send，send 里会调 generateETag 覆盖 removeHeader）
  const body = JSON.stringify(normalizeMonitor(result));
  res.removeHeader('ETag');
  res.removeHeader('Last-Modified');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.end(body);
});

// ---- 概览 ----
app.get('/api/dashboard', async (req, res) => {
  try {
    const d = UPSTREAM ? await getDashboardFromUpstream(UPSTREAM) : getDashboard();
    if (!d) return res.status(503).json({ error: '尚未同步数据' });
    res.json(d);
  } catch (e) {
    console.error('[/api/dashboard] failed:', e);
    res.status(502).json({ error: 'dashboard 组装失败', detail: e.message });
  }
});

// ---- 操作日志 ----
app.get('/api/logs', (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  res.json(store.readLogs(limit));
});

// ---- 健康检查 ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
});

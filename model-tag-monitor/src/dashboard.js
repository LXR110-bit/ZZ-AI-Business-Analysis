// 概览页数据聚合
// 从 cache.json + rules.json + tags.json + monitor() 结果计算：
//   - KPI 卡：覆盖机型、本周异常机型、周环比上涨机型、最新周次
//   - GMV 5 周趋势
//   - 覆盖机型按品类分布（环形）
//   - Top 10 机型（异常最强，按 orderRate 变化幅度降序）
//
// 缓存：内存里保存一份，key = syncedAt + rulesHash + tagsHash + latestWeek
// TTL 60s。任何 sync / rules 更新走 invalidate。

const store = require('./store');
const { monitor, DEFAULT_RULES } = require('./monitor');

let cache = null; // { key, expireAt, payload }
const TTL_MS = 60 * 1000;

// 契约里 trend / delta 的 5 项 rate keys
const RATE_KEYS = ['evaRate', 'orderRate', 'shipRate', 'dealRate', 'returnRate'];

/**
 * 归一化 trend：契约说 5 rate 全在，取值 "up" | "down" | null。
 * Node 版 wave.js 的 calcTrend 存在部分/全部字段泄漏为 undefined 或整对象为 {} 的 bug
 *（Python 版 wave.py 显式初始化 out = {k: None} 是正确参考）。
 * 前端归一化层保护，等 Node 版修好后可保留（防御未来上游变更）。
 */
function normalizeTrend(trend) {
  const out = {};
  const src = trend || {};
  for (const k of RATE_KEYS) {
    const v = src[k];
    out[k] = v === 'up' || v === 'down' ? v : null;
  }
  return out;
}

// pool / watchList item 层归一化：只碰 trend，其他字段透传
function normalizeMonitorItem(item) {
  if (!item) return item;
  return { ...item, trend: normalizeTrend(item.trend) };
}

// monitor 整体归一化：pool + watchList 逐项过 trend
function normalizeMonitor(mr) {
  if (!mr || typeof mr !== 'object') return mr;
  return {
    ...mr,
    pool: Array.isArray(mr.pool) ? mr.pool.map(normalizeMonitorItem) : [],
    watchList: Array.isArray(mr.watchList) ? mr.watchList.map(normalizeMonitorItem) : [],
  };
}

function invalidate() {
  cache = null;
}

function hashObj(o) {
  try {
    return JSON.stringify(o).length + ':' + Object.keys(o || {}).length;
  } catch {
    return '0';
  }
}

// mock/线上都有 week 字段 "2025-W27"；给面板一个易读的"MM-DD ~ MM-DD"
function weekRangeLabel(rows, week) {
  const hit = rows.find((r) => r.week === week && (r.startDate || r.endDate));
  if (!hit) return '';
  const trim = (d) => String(d || '').replace(/^\d{4}-/, '');
  const s = trim(hit.startDate);
  const e = trim(hit.endDate);
  if (s && e) return `${s} ~ ${e}`;
  return s || e || '';
}

// 生成概览负载
function build() {
  const c = store.readJSON('cache.json', null);
  if (!c || !c.rows || !c.rows.length) return null;
  const rules = store.readJSON('rules.json', DEFAULT_RULES);
  const tagsMap = {};
  const tagsAll = store.readJSON('tags.json', {});
  for (const [k, v] of Object.entries(tagsAll)) tagsMap[k] = v.tags || [];

  const weeks = (c.weeks || []).slice().sort();
  const latestWeek = weeks[weeks.length - 1];
  const prevWeek = weeks[weeks.length - 2] || null;

  // 走一遍 monitor 拿到 pool / watchList
  const mr = monitor(c, rules, tagsMap, { week: latestWeek });
  const prevMr = prevWeek ? monitor(c, rules, tagsMap, { week: prevWeek }) : null;

  // ---- KPI ----
  const totalModels = mr.pool.length;
  const categories = [...new Set(mr.pool.map((p) => p.category))];
  const watchCount = mr.watchList.length;
  const watchPrev = prevMr ? prevMr.watchList.length : watchCount;
  const watchDelta = watchCount - watchPrev;

  // 周环比上涨机型：orderRate delta > 0
  const upCount = mr.pool.filter((p) => p.delta && typeof p.delta.orderRate === 'number' && p.delta.orderRate > 0).length;

  // ---- GMV 5 周趋势 ----
  const lastN = weeks.slice(-5);
  const gmvByWeek = new Map(lastN.map((w) => [w, 0]));
  for (const row of c.rows) {
    if (gmvByWeek.has(row.week)) {
      gmvByWeek.set(row.week, gmvByWeek.get(row.week) + (Number(row.gmv) || 0));
    }
  }
  const gmvTrend = lastN.map((w) => ({ week: w, gmv: Math.round(gmvByWeek.get(w) || 0) }));

  // ---- 覆盖机型按品类分布：Top6 按品类 GMV 汇总取，count 一并带上做 tooltip ----
  const catAgg = new Map(); // name → { count, gmv }
  for (const p of mr.pool) {
    const cur = catAgg.get(p.category) || { count: 0, gmv: 0 };
    cur.count += 1;
    cur.gmv += Number(p?.cur?.gmv) || 0;
    catAgg.set(p.category, cur);
  }
  const catAll = [...catAgg.entries()].map(([name, v]) => ({ name, count: v.count, gmv: Math.round(v.gmv) }));
  const gmvGrandTotal = catAll.reduce((s, x) => s + x.gmv, 0);
  const watchByCategory = catAll
    .sort((a, b) => b.gmv - a.gmv || b.count - a.count)
    .slice(0, 6);
  const top6GmvSum = watchByCategory.reduce((s, x) => s + x.gmv, 0);
  const watchCategoryStats = {
    gmvGrandTotal,
    totalCategories: catAll.length,
    top6GmvSum,
    top6GmvPct: gmvGrandTotal > 0 ? Math.round((top6GmvSum / gmvGrandTotal) * 1000) / 10 : 0,
  };

  // ---- Top 10 异常机型：按 orderRate delta 绝对值降序，稳定用 gmv 兜底 ----
  const rankable = mr.pool
    .filter((p) => p.delta && typeof p.delta.orderRate === 'number')
    .map((p) => {
      const d = p.delta.orderRate;
      return {
        modelId: p.cur.modelId || '',
        modelName: p.modelName,
        category: p.category,
        orderRate: p.cur.orderRate,
        deltaRaw: d,
        gmv: Math.round(Number(p.cur.gmv) || 0),
      };
    })
    .sort((a, b) => Math.abs(b.deltaRaw) - Math.abs(a.deltaRaw) || b.gmv - a.gmv);

  const topRows = rankable.slice(0, 10).map((row, i) => {
    const d = row.deltaRaw;
    const dir = d >= 0 ? 'up' : 'down';
    const magnitude = Math.abs(d);
    // 展示为倍数（× 表示）：0.4523 -> ↑ 45.23%, 大于 100% 时用 ×
    let label;
    if (magnitude >= 1) label = `${dir === 'up' ? '↑' : '↓'} ${magnitude.toFixed(2)}×`;
    else label = `${dir === 'up' ? '↑' : '↓'} ${(magnitude * 100).toFixed(2)}%`;
    return {
      rank: i + 1,
      modelId: row.modelId,
      modelName: row.modelName,
      category: row.category,
      orderRate: row.orderRate,
      deltaLabel: label,
      deltaDir: dir,
      gmv: row.gmv,
    };
  });

  const upLabel = upCount >= totalModels / 2 ? 'orderRate 周环比上涨' : '异常预警';

  return {
    meta: {
      syncedAt: c.syncedAt,
      latestWeek,
      weekRange: weekRangeLabel(c.rows, latestWeek),
      totalWeeks: weeks.length,
    },
    kpi: {
      totalModels,
      totalCategories: categories.length,
      watchCount,
      watchDelta,
      watchPrev,
      upCount,
      upDeltaLabel: upLabel,
    },
    gmvTrend,
    watchByCategory,
    watchCategoryStats,
    topRows,
  };
}

function getDashboard() {
  const now = Date.now();
  if (cache && cache.expireAt > now) return cache.payload;
  const payload = build();
  if (!payload) return null;
  // 生成 key 便于旁路调试
  const key = payload.meta.syncedAt + '|' + payload.meta.latestWeek;
  cache = { key, expireAt: now + TTL_MS, payload };
  return payload;
}

// ---- 代理模式：从上游服务组装 payload ----
// GMV 预热缓存：week → sum(gmv)。启动时后台异步填，dashboard 请求先返回，命中就画上
const gmvCache = new Map();
let gmvPrewarmSig = null; // 上一次预热的 syncedAt|weeks，syncedAt 变才重新拉
let gmvPrewarmRunning = false;

async function prewarmGmv(upstreamBase, weeks, syncedAt) {
  const base = String(upstreamBase || '').replace(/\/+$/, '');
  const sig = syncedAt + '|' + weeks.join(',');
  if (sig === gmvPrewarmSig || gmvPrewarmRunning) return;
  gmvPrewarmRunning = true;
  console.log(`[dashboard/prewarm] start weeks=${weeks.join(',')}`);
  try {
    for (const w of weeks) {
      if (gmvCache.has(w) && gmvPrewarmSig === sig) continue;
      const t0 = Date.now();
      try {
        const resp = await fetchJson(`${base}/api/data?week=${encodeURIComponent(w)}`, 600000);
        let sum = 0;
        for (const row of resp.rows || []) sum += Number(row.gmv) || 0;
        gmvCache.set(w, Math.round(sum));
        // 命中一周就把 dashboard cache 失效，让下次请求带上新数据
        cache = null;
        console.log(`[dashboard/prewarm] week=${w} rows=${(resp.rows || []).length} gmv=${Math.round(sum)} took=${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        console.warn(`[dashboard/prewarm] week=${w} failed: ${e.message}`);
      }
    }
    gmvPrewarmSig = sig;
    console.log(`[dashboard/prewarm] done`);
  } finally {
    gmvPrewarmRunning = false;
  }
}


// 上游契约 v1.0（详见 /api/monitor 返回）：
//   { targetWeek, prevWeek, weeks, pool, watchList, rules }
//   pool[i] = { category, modelName, tags, cur, prev, delta, trend }
//     cur 24 字段（含 week/startDate/endDate/modelId/modelName + 15 计数 + daysReceived + 5 rate）
//     delta 5 rate；null 表示分母为 0（无法计算）
//     trend "up" | "down" | null
async function fetchJson(url, timeoutMs = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function buildFromUpstream(upstreamBase) {
  const base = String(upstreamBase || '').replace(/\/+$/, '');
  if (!base) return null;

  // 1) meta + monitor 并发
  const [meta, mr] = await Promise.all([
    fetchJson(`${base}/api/meta`),
    fetchJson(`${base}/api/monitor`),
  ]);
  if (!meta.synced) return null;

  return composeDashboard({ meta, monitor: mr, gmvCache });
}

/**
 * 纯函数：把 upstream /api/meta + /api/monitor 响应聚合成 dashboard payload。
 * 不做任何 IO，不读全局 cache；gmvCache 走参数注入（Map 或 {has, get} 形态）。
 * 契约文档：docs/superpowers/handoffs/data_to_frontend_contract.md
 *
 * @param {Object} args
 * @param {{synced:boolean, syncedAt:string, weeks:string[], rowCount?:number, categories?:string[]}} args.meta
 * @param {{targetWeek:string, prevWeek:string|null, weeks:string[], pool:Array, watchList:Array, rules?:Object}} args.monitor
 * @param {Map<string,number>|{has:(w:string)=>boolean, get:(w:string)=>number}} [args.gmvCache]
 * @returns {Object|null} dashboard payload；meta.synced=false 返回 null
 */
function composeDashboard({ meta, monitor, gmvCache }) {
  if (!meta || !meta.synced) return null;
  const mr = normalizeMonitor(monitor || {});
  const cacheGet = gmvCache && typeof gmvCache.has === 'function' && typeof gmvCache.get === 'function'
    ? gmvCache
    : { has: () => false, get: () => undefined };

  const weeks = (meta.weeks || []).slice().sort();
  const latestWeek = mr.targetWeek || weeks[weeks.length - 1];
  const pool = Array.isArray(mr.pool) ? mr.pool : [];
  const watchList = Array.isArray(mr.watchList) ? mr.watchList : [];

  // 2) 5 周 GMV：命中预热缓存优先；缺的周退回 pool 的 cur/prev（覆盖 latest 和 prev）
  const lastN = weeks.slice(-5);
  const gmvTrend = lastN.map((w) => {
    if (cacheGet.has(w)) return { week: w, gmv: cacheGet.get(w) };
    let sum = 0;
    let hit = false;
    for (const p of pool) {
      if (p.cur && p.cur.week === w && typeof p.cur.gmv === 'number') { sum += p.cur.gmv; hit = true; }
      else if (p.prev && p.prev.week === w && typeof p.prev.gmv === 'number') { sum += p.prev.gmv; hit = true; }
    }
    return { week: w, gmv: hit ? Math.round(sum) : null };
  });

  // 3) KPI
  const totalModels = pool.length;
  const categories = [...new Set(pool.map((p) => p.category))];
  const watchCount = watchList.length;
  const upCount = pool.filter((p) => p.delta && typeof p.delta.orderRate === 'number' && p.delta.orderRate > 0).length;
  const upLabel = upCount >= totalModels / 2 ? 'orderRate 周环比上涨' : '异常预警';

  // 4) 品类分布（Top6，按品类 GMV 汇总取）
  const catAgg = new Map();
  for (const p of pool) {
    const cur = catAgg.get(p.category) || { count: 0, gmv: 0 };
    cur.count += 1;
    cur.gmv += Number(p?.cur?.gmv) || 0;
    catAgg.set(p.category, cur);
  }
  const catAll = [...catAgg.entries()].map(([name, v]) => ({ name, count: v.count, gmv: Math.round(v.gmv) }));
  const gmvGrandTotal = catAll.reduce((s, x) => s + x.gmv, 0);
  const watchByCategory = catAll
    .sort((a, b) => b.gmv - a.gmv || b.count - a.count)
    .slice(0, 6);
  const top6GmvSum = watchByCategory.reduce((s, x) => s + x.gmv, 0);
  const watchCategoryStats = {
    gmvGrandTotal,
    totalCategories: catAll.length,
    top6GmvSum,
    top6GmvPct: gmvGrandTotal > 0 ? Math.round((top6GmvSum / gmvGrandTotal) * 1000) / 10 : 0,
  };

  // 5) Top10 异常机型（按 |delta.orderRate| 降序，同值按 gmv 降序）
  const rankable = pool
    .filter((p) => p.delta && typeof p.delta.orderRate === 'number')
    .map((p) => ({
      modelId: (p.cur && p.cur.modelId) || '',
      modelName: p.modelName,
      category: p.category,
      orderRate: p.cur && p.cur.orderRate,
      deltaRaw: p.delta.orderRate,
      gmv: Math.round(Number(p.cur && p.cur.gmv) || 0),
    }))
    .sort((a, b) => Math.abs(b.deltaRaw) - Math.abs(a.deltaRaw) || b.gmv - a.gmv);
  const topRows = rankable.slice(0, 10).map((row, i) => {
    const d = row.deltaRaw;
    const dir = d >= 0 ? 'up' : 'down';
    const magnitude = Math.abs(d);
    const label = magnitude >= 1
      ? `${dir === 'up' ? '↑' : '↓'} ${magnitude.toFixed(2)}×`
      : `${dir === 'up' ? '↑' : '↓'} ${(magnitude * 100).toFixed(2)}%`;
    return {
      rank: i + 1,
      modelId: row.modelId,
      modelName: row.modelName,
      category: row.category,
      orderRate: row.orderRate,
      deltaLabel: label,
      deltaDir: dir,
      gmv: row.gmv,
    };
  });

  // 6) week 区间 label：从 pool 里挑一个 cur.week === latestWeek 的
  const sample = pool.find((p) => p.cur && p.cur.week === latestWeek && (p.cur.startDate || p.cur.endDate));
  let weekRange = '';
  if (sample && sample.cur) {
    const trim = (d) => String(d || '').replace(/^\d{4}-/, '');
    const s = trim(sample.cur.startDate);
    const e = trim(sample.cur.endDate);
    weekRange = s && e ? `${s} ~ ${e}` : s || e || '';
  }

  return {
    meta: {
      syncedAt: meta.syncedAt,
      latestWeek,
      weekRange,
      totalWeeks: weeks.length,
    },
    kpi: {
      totalModels,
      totalCategories: categories.length,
      watchCount,
      watchDelta: 0, // 上游单次 monitor 只给当前周；prev watchList 拿不到，展示 0
      watchPrev: watchCount,
      upCount,
      upDeltaLabel: upLabel,
    },
    gmvTrend,
    watchByCategory,
    watchCategoryStats,
    topRows,
    _source: 'upstream',
  };
}

async function getDashboardFromUpstream(upstreamBase) {
  const now = Date.now();
  if (cache && cache.expireAt > now && cache.mode === 'upstream') return cache.payload;
  const payload = await buildFromUpstream(upstreamBase);
  if (!payload) return null;
  // 触发后台 GMV 预热（不 await；下一次请求或几分钟后就能命中真数据）
  const lastN = Array.from({ length: 5 }, (_, i) => i)
    .map((_, i) => payload.gmvTrend[i]?.week)
    .filter(Boolean);
  prewarmGmv(upstreamBase, lastN, payload.meta.syncedAt).catch((e) => console.warn('[prewarm] error:', e.message));
  const key = payload.meta.syncedAt + '|' + payload.meta.latestWeek + '|upstream';
  cache = { key, expireAt: now + TTL_MS, payload, mode: 'upstream' };
  return payload;
}

module.exports = { getDashboard, getDashboardFromUpstream, composeDashboard, invalidateDashboardCache: invalidate, normalizeTrend, normalizeMonitor };

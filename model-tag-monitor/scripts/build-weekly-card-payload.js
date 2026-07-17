#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const APP_VERSION = require('../package.json').version;
const { monitor, DEFAULT_RULES } = require('../src/monitor');
const { DEFAULT_TAG_VOCAB, normalizeTagsStore, normalizeTagVocab } = require('../src/tagging');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const apiBase = String(arg('api-base', process.env.API_BASE || 'http://127.0.0.1:8848')).replace(/\/+$/, '');
const out = arg('out', process.env.PAYLOAD_OUT || 'weekly-card-payload.json');
const dashboardUrl = arg('dashboard-url', process.env.DASHBOARD_URL || 'http://47.84.94.234:8848/?tab=dashboard');
const reportUrl = arg('report-url', process.env.REPORT_URL || dashboardUrl);
const dashboardFile = arg('dashboard-file', process.env.DASHBOARD_FILE || '');
const dataDir = arg('data-dir', process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const apiCookie = String(process.env.API_COOKIE || '').trim();

async function getJson(pathname, timeoutMs = 300000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (apiCookie) headers.Cookie = apiCookie;
    const res = await fetch(`${apiBase}${pathname}`, { headers, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}: ${text.slice(0, 500)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function pct(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  return `${Number(v) > 0 ? '+' : ''}${(Number(v) * 100).toFixed(1)}%`;
}

function rate(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '-';
  return `${(Number(v) * 100).toFixed(1)}%`;
}

function anomalyFromMonitor(monitor) {
  return (monitor.watchList || [])
    .filter((p) => p && p.delta && typeof p.delta.orderRate === 'number')
    .sort((a, b) => Math.abs(b.delta.orderRate) - Math.abs(a.delta.orderRate))
    .slice(0, 3)
    .map((p, idx) => ({
      rank: idx + 1,
      name: p.modelName || p.category || '-',
      metric_current: `下单率 ${rate(p.cur && p.cur.orderRate)}`,
      metric_prev: `下单率 ${rate(p.prev && p.prev.orderRate)}`,
      delta_label: `(${pct(p.delta.orderRate)})`,
      hypothesis: buildHypothesis(p),
    }));
}

function anomalyFromDashboard(dashboard) {
  return (dashboard.categories || [])
    .filter((c) => c.anomalyScore > 0)
    .sort((a, b) => (b.anomalyScore || 0) - (a.anomalyScore || 0) || ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0))
    .slice(0, 3)
    .map((c, idx) => ({
      rank: idx + 1,
      name: c.category || '-',
      metric_current: `成交GMV ${formatWan(c.cur && c.cur.gmv)}`,
      metric_prev: `上周 ${formatWan(c.trend && c.trend.gmv && c.trend.gmv.prev)}`,
      delta_label: c.trend && c.trend.gmv ? `(${pct(c.trend.gmv.deltaPct)})` : '',
      hypothesis: `品类 ${c.board || c.secondaryCategory || ''} 转化/成交波动，建议进入看板复盘`,
    }));
}

function buildHypothesis(p) {
  const flags = (p.flags || [])
    .slice(0, 2)
    .map((f) => localizeMetricLabel(f.name || f.metric || f.type))
    .filter(Boolean)
    .join('、');
  if (flags) return `${flags}触发异动，建议进入监测详情查看机型链路`;
  return '指标波动较大，建议进入监测详情查看机型链路';
}

function localizeMetricLabel(value) {
  const labels = {
    conditionUv: '机况UV',
    jkuv: '机况UV',
    evaUv: '估价UV',
    orderUv: '下单UV',
    shipCnt: '发货数',
    dealCnt: '成交订单',
    gmv: '成交GMV',
    evaRate: '估价完成率',
    orderRate: '下单率',
    shipRate: '发货率',
    dealRate: '成交率',
    returnRate: '退回率',
  };
  return labels[value] || value;
}

function formatWan(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(Math.round(n));
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function buildOfflineMonitor(week) {
  const cache = readJson(path.join(dataDir, 'cache.json'), null);
  if (!cache || !Array.isArray(cache.rows) || !cache.rows.length) return null;
  const rules = readJson(path.join(dataDir, 'rules.json'), DEFAULT_RULES);
  const tagVocab = normalizeTagVocab(readJson(path.join(dataDir, 'tag-vocab.json'), DEFAULT_TAG_VOCAB));
  const tagsMap = normalizeTagsStore(readJson(path.join(dataDir, 'tags.json'), {}), { vocab: tagVocab });
  return monitor(cache, rules, tagsMap, { week: week || null, tagVocab });
}

(async function main() {
  const dashboard = dashboardFile
    ? JSON.parse(fs.readFileSync(dashboardFile, 'utf8'))
    : await getJson('/api/dashboard', 300000);
  let monitor = null;
  try {
    monitor = dashboardFile
      ? buildOfflineMonitor(dashboard.week || '')
      : await getJson(`/api/monitor?week=${encodeURIComponent(dashboard.week || '')}`, 600000);
  } catch (e) {
    console.warn(`[build-weekly-card-payload] monitor unavailable, fallback to dashboard categories: ${e.message}`);
  }

  const watchCount = monitor && Array.isArray(monitor.watchList)
    ? monitor.watchList.length
    : (dashboard.categories || []).filter((c) => c.anomalyScore > 0).length;
  const total = monitor && Array.isArray(monitor.pool)
    ? monitor.pool.length
    : (dashboard.kpi && dashboard.kpi.totalCategories) || (dashboard.categories || []).length;

  const deltaPct = dashboard.kpiCards && dashboard.kpiCards.find((c) => c.key === 'gmv')
    ? dashboard.kpiCards.find((c) => c.key === 'gmv').deltaPct
    : null;
  const top = monitor ? anomalyFromMonitor(monitor) : anomalyFromDashboard(dashboard);

  const payload = {
    version: dashboard.version || APP_VERSION,
    week: dashboard.week,
    prev_week: dashboard.prevWeek || '',
    week_range: dashboard.weekRange || '',
    total,
    watch_count: watchCount,
    delta: deltaPct == null ? '-' : Math.abs(deltaPct * 100).toFixed(1) + '%',
    delta_symbol: deltaPct == null ? '' : (deltaPct >= 0 ? '+' : '-'),
    report_url: reportUrl,
    dashboard_url: dashboardUrl,
    top_anomalies: top,
  };
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, out, week: payload.week, total: payload.total, watch_count: payload.watch_count, top: payload.top_anomalies.length }, null, 2));
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});

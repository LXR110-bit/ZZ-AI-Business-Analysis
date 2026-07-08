#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_VERSION = process.env.EXPECTED_VERSION || '1.2.1';
const EXPECTED_WEEKS = (process.env.TARGET_WEEKS || '2026-W19,2026-W20,2026-W21,2026-W22,2026-W23,2026-W24,2026-W25,2026-W26,2026-W27,2026-W28')
  .split(',')
  .map((w) => w.trim())
  .filter(Boolean);
const TREND_KEYS = ['conditionUv', 'jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv'];

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(arg('data-dir', process.env.DATA_DIR || path.join(root, 'data')));
const apiBase = String(arg('api-base', process.env.API_BASE || 'http://127.0.0.1:8848')).replace(/\/+$/, '');
const onlineBase = arg('online-base', process.env.ONLINE_BASE || '');
const skipApi = process.argv.includes('--skip-api');

function fail(msg) {
  throw new Error(msg);
}

function readJson(file) {
  const p = path.join(dataDir, file);
  if (!fs.existsSync(p)) fail(`missing data file: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function weeksFromRows(rows) {
  return [...new Set((rows || []).map((r) => r.week).filter(Boolean))].sort();
}

function assertWeeks(label, weeks) {
  const got = JSON.stringify((weeks || []).slice().sort());
  const expected = JSON.stringify(EXPECTED_WEEKS);
  if (got !== expected) fail(`${label} weeks mismatch: ${got} != ${expected}`);
}

function assertTruthy(label, value) {
  if (!value) fail(`${label} missing/empty`);
}

async function getJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) fail(`${base}${pathname} HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function validateDashboard(label, d) {
  if (d.version !== EXPECTED_VERSION) fail(`${label} version mismatch: ${d.version}`);
  assertWeeks(`${label}.weeks`, d.weeks || d.weekWindow || []);
  if (d.week !== EXPECTED_WEEKS[EXPECTED_WEEKS.length - 1]) fail(`${label} latest week mismatch: ${d.week}`);
  assertTruthy(`${label}.board`, d.board && d.board.cur);
  assertTruthy(`${label}.tiers`, Array.isArray(d.tiers) && d.tiers.length);
  assertTruthy(`${label}.categories`, Array.isArray(d.categories) && d.categories.length);
  assertTruthy(`${label}.kpiCards`, Array.isArray(d.kpiCards) && d.kpiCards.length === 6);
  const sample = d.categories.find((c) => c.trend && c.status !== '已下线') || d.categories[0];
  for (const key of TREND_KEYS) {
    if (!sample.trend || !sample.trend[key] || !Object.prototype.hasOwnProperty.call(sample.trend[key], 'deltaPct')) {
      fail(`${label}.categories trend missing key=${key} sample=${sample.category}`);
    }
  }
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== EXPECTED_VERSION) fail(`package version mismatch: ${pkg.version}`);

  const cache = readJson('cache.json');
  assertWeeks('cache.json', cache.weeks || weeksFromRows(cache.rows));
  assertTruthy('cache.json rows', Array.isArray(cache.rows) && cache.rows.length);

  const category = readJson('category-cache.json');
  assertWeeks('category-cache.json', category.weeks || weeksFromRows(category.rows));
  assertTruthy('category-cache.json rows', Array.isArray(category.rows) && category.rows.length);

  const taxonomy = readJson('category-taxonomy.json');
  assertTruthy('category-taxonomy.json rows', Array.isArray(taxonomy.rows) && taxonomy.rows.length);

  const result = {
    ok: true,
    version: pkg.version,
    dataDir,
    expectedWeeks: EXPECTED_WEEKS,
    local: {
      cacheRows: cache.rows.length,
      categoryRows: category.rows.length,
      taxonomyRows: taxonomy.rows.length,
    },
  };

  if (!skipApi) {
    const meta = await getJson(apiBase, '/api/meta');
    assertWeeks(`${apiBase}/api/meta`, meta.weeks || []);
    const dashboard = await getJson(apiBase, '/api/dashboard');
    validateDashboard(`${apiBase}/api/dashboard`, dashboard);
    result.api = { base: apiBase, metaRows: meta.rowCount, dashboardWeek: dashboard.week, categories: dashboard.categories.length };
  }

  if (onlineBase) {
    const online = await getJson(String(onlineBase).replace(/\/+$/, ''), '/api/dashboard');
    validateDashboard(`${onlineBase}/api/dashboard`, online);
    result.online = { base: onlineBase, dashboardWeek: online.week, categories: online.categories.length };
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(`[validate-release] ${e.message}`);
  process.exit(1);
});

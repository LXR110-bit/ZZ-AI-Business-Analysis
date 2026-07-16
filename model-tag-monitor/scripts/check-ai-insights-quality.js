#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { collectStringFindings } = require('./quality-text');

const REQUIRED_TIERS = ['发展', '孵化', '种子'];

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function businessOverviewCacheName(week) {
  const safeWeek = String(week || '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
  return safeWeek ? `business-overview-insights-${safeWeek}.json` : 'business-overview-insights.json';
}

function loadDashboard(args) {
  if (!args['dashboard-file']) return null;
  return JSON.parse(fs.readFileSync(args['dashboard-file'], 'utf8'));
}

function resolveCacheFile(args, dashboard) {
  if (args['cache-file']) return path.resolve(args['cache-file']);
  const dataDir = path.resolve(args['data-dir'] || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const week = args.week || (dashboard && dashboard.week) || '';
  const candidates = [businessOverviewCacheName(week), 'business-overview-insights.json']
    .filter(Boolean)
    .map((name) => path.join(dataDir, name));
  return candidates.find((file) => fs.existsSync(file)) || candidates[0];
}

function normalizeMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function expectedSecondaryCategories(dashboard) {
  return [...new Set((dashboard && dashboard.categories || [])
    .filter((c) => c && c.status !== '已下线')
    .map((c) => c.secondaryCategory || c.board)
    .filter(Boolean))];
}

function expectedCategories(dashboard) {
  return [...new Set((dashboard && dashboard.categories || [])
    .map((c) => c && c.category)
    .filter(Boolean))];
}

function validateAiInsightsQuality(cache, options = {}) {
  const dashboard = options.dashboard || null;
  const errors = [];
  const warnings = [];

  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return { ok: false, state: 'invalid', errors: ['AI cache must be an object'], warnings };
  }
  const expectedWeek = options.week || (dashboard && dashboard.week) || '';
  if (expectedWeek && cache.week !== expectedWeek) errors.push(`cache.week mismatch: expected ${expectedWeek}, got ${cache.week || '<missing>'}`);
  for (const key of ['version', 'week', 'generatedAt', 'generatedBy', 'mode', 'inputHash', 'insights']) {
    if (!(key in cache)) errors.push(`cache.${key} missing`);
  }
  if (!['ai', 'aiwan_loop', 'deterministic'].includes(cache.mode)) errors.push(`cache.mode invalid: ${cache.mode || '<missing>'}`);
  if (options.requireAi && !['ai', 'aiwan_loop'].includes(cache.mode)) errors.push(`cache.mode must be ai or aiwan_loop when --require-ai is set; got ${cache.mode || '<missing>'}`);
  if (cache.mode === 'deterministic') warnings.push('AI cache is deterministic fallback; allowed but should be reviewed if BUSINESS_OVERVIEW_AI_ENABLED=1');

  const insights = cache.insights;
  if (!insights || typeof insights !== 'object' || Array.isArray(insights)) {
    errors.push('cache.insights must be an object');
  } else {
    for (const key of ['board', 'tiers', 'secondaryCategories', 'categories', 'category', 'monitor']) {
      if (!(key in insights)) errors.push(`cache.insights.${key} missing`);
    }
    for (const key of ['board', 'category', 'monitor']) {
      if (typeof insights[key] !== 'string' || !insights[key].trim()) errors.push(`cache.insights.${key} must be a non-empty string`);
    }
    const tiers = normalizeMap(insights.tiers);
    for (const tier of REQUIRED_TIERS) {
      if (typeof tiers[tier] !== 'string' || !tiers[tier].trim()) errors.push(`cache.insights.tiers.${tier} missing`);
    }
    const secondary = normalizeMap(insights.secondaryCategories);
    for (const key of expectedSecondaryCategories(dashboard)) {
      if (typeof secondary[key] !== 'string' || !secondary[key].trim()) errors.push(`cache.insights.secondaryCategories.${key} missing`);
    }
    const categories = normalizeMap(insights.categories);
    for (const key of expectedCategories(dashboard)) {
      if (typeof categories[key] !== 'string' || !categories[key].trim()) errors.push(`cache.insights.categories.${key} missing`);
    }
  }

  if (dashboard && dashboard.analysisStatus) {
    const expectedState = dashboard.analysisStatus.state;
    const actualState = cache.analysisStatus && cache.analysisStatus.state;
    if (expectedState && actualState && expectedState !== actualState) {
      errors.push(`cache.analysisStatus.state mismatch: expected ${expectedState}, got ${actualState}`);
    } else if (expectedState && !actualState) {
      warnings.push('cache.analysisStatus.state missing; dashboard has analysisStatus');
    }
  }

  const forbidden = collectStringFindings(cache.insights || {}, { rootPath: 'cache.insights' });
  if (forbidden.length) {
    for (const item of forbidden) {
      errors.push(`forbidden technical token(s) ${item.tokens.join(',')} at ${item.path}: ${item.snippet}`);
    }
  }

  return {
    ok: errors.length === 0,
    state: errors.length === 0 ? 'pass' : 'invalid',
    week: cache.week || null,
    mode: cache.mode || null,
    generatedBy: cache.generatedBy || null,
    forbiddenFindings: forbidden,
    errors,
    warnings,
  };
}

function main() {
  const args = parseArgs();
  const dashboard = loadDashboard(args);
  const cacheFile = resolveCacheFile(args, dashboard);
  if (!cacheFile || !fs.existsSync(cacheFile)) throw new Error(`AI cache file not found: ${cacheFile || '<missing>'}`);
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const result = validateAiInsightsQuality(cache, { dashboard, week: args.week, requireAi: Boolean(args['require-ai']) });
  result.cacheFile = cacheFile;
  const text = JSON.stringify(result, null, 2);
  if (args.out) fs.writeFileSync(args.out, `${text}\n`, 'utf8');
  process.stdout.write(`${text}\n`);
  process.exit(result.ok ? 0 : 10);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

module.exports = {
  businessOverviewCacheName,
  validateAiInsightsQuality,
};

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  copyFileAtomic,
  ensureReleaseLayout,
  parseArgs,
  readJSON,
  updateManifest,
  writeJSONAtomic,
  writeStatus,
} = require('./release-utils');

function usage() {
  return [
    'Usage: build-release-data.js --release-dir DIR --import-dir DIR --target-weeks W1,W2 --run-id ID',
    'Optional: --source-data-dir DIR --coverage-file FILE --version VERSION',
  ].join('\n');
}

function copyDurableRuntimeFiles(sourceDataDir, dataDir) {
  if (!sourceDataDir || !fs.existsSync(sourceDataDir)) return [];
  const copied = [];
  for (const name of ['rules.json', 'tags.json', 'tag-vocab.json']) {
    const src = path.join(sourceDataDir, name);
    if (!fs.existsSync(src)) continue;
    copyFileAtomic(src, path.join(dataDir, name));
    copied.push(name);
  }
  return copied;
}

function businessOverviewCacheName(week) {
  const safeWeek = String(week || '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
  return safeWeek ? `business-overview-insights-${safeWeek}.json` : 'business-overview-insights.json';
}

function readJsonFromData(dataDir, name, fallback = null) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) return fallback;
  return readJSON(file, fallback);
}

function writeDashboard(dataDir, targetWeek = '') {
  const { composeDashboard, mergeBusinessOverviewInsights } = require('../src/compose-dashboard');
  const categoryCache = readJsonFromData(dataDir, 'category-cache.json');
  const taxonomy = readJsonFromData(dataDir, 'category-taxonomy.json');
  const boardMetrics = readJsonFromData(dataDir, 'board-metrics.json');
  if (!categoryCache || !taxonomy || !Array.isArray(categoryCache.rows) || !categoryCache.rows.length) {
    throw new Error('release data missing category-cache/category-taxonomy for dashboard compose');
  }
  const weeks = (categoryCache.weeks && categoryCache.weeks.length
    ? categoryCache.weeks
    : [...new Set(categoryCache.rows.map((r) => r.week).filter(Boolean))]
  ).slice().sort();
  const week = targetWeek || weeks[weeks.length - 1] || '';
  const prevWeek = weeks[weeks.indexOf(week) - 1] || null;
  if (!week) throw new Error('release category cache has no target week');
  const cachedInsights = readJsonFromData(dataDir, businessOverviewCacheName(week))
    || readJsonFromData(dataDir, 'business-overview-insights.json');
  const dashboard = mergeBusinessOverviewInsights(
    composeDashboard({ categoryCache, taxonomy, boardMetrics, week, prevWeek }),
    cachedInsights
  );
  writeJSONAtomic(path.join(dataDir, 'dashboard.json'), dashboard);
  return { week, prevWeek, weeks, categories: dashboard.categories.length };
}

async function main() {
  const args = parseArgs();
  const releaseDir = path.resolve(args['release-dir'] || '');
  const importDir = path.resolve(args['import-dir'] || '');
  const runId = args['run-id'] || '';
  const targetWeeks = args['target-weeks'] || process.env.TARGET_WEEKS || '';
  const sourceDataDir = args['source-data-dir']
    ? path.resolve(args['source-data-dir'])
    : path.join(__dirname, '..', 'data', 'current');
  if (!releaseDir || releaseDir === path.resolve('.')) throw new Error(usage());
  if (!importDir || !fs.existsSync(importDir)) throw new Error(`import dir not found: ${importDir || '<missing>'}`);
  if (!runId) throw new Error('run id is required');
  if (!targetWeeks) throw new Error('target weeks are required');

  ensureReleaseLayout(releaseDir);
  const dataDir = path.join(releaseDir, 'data');
  const targetWeek = String(targetWeeks).split(',').map((w) => w.trim()).filter(Boolean).slice(-1)[0] || '';

  process.env.DATA_DIR = dataDir;
  process.env.IMPORT_DIR = importDir;
  process.env.TARGET_WEEKS = targetWeeks;

  if (args['dashboard-only']) {
    const dashboard = writeDashboard(dataDir, targetWeek);
    updateManifest(releaseDir, {
      build: {
        ...(readJSON(path.join(releaseDir, 'manifest.json'), {}).build || {}),
        dashboard,
        dashboard_composed_at: new Date().toISOString(),
      },
    });
    console.log(JSON.stringify({ ok: true, releaseDir, dataDir, dashboard, dashboardOnly: true }, null, 2));
    return;
  }

  writeStatus(releaseDir, { stage: 'build', status: 'running', message: 'building release data offline' });
  const copiedRuntimeFiles = copyDurableRuntimeFiles(sourceDataDir, dataDir);

  const modelSync = require('../src/sync');
  const taxonomySync = require('../src/taxonomy-sync');
  const categorySync = require('../src/category-sync');
  const boardSync = require('../src/board-sync');

  const result = {
    model: await modelSync.sync(),
    taxonomy: taxonomySync.sync(),
    category: categorySync.sync(),
    board: boardSync.sync({ importsDir: importDir }),
  };
  const dashboard = writeDashboard(dataDir, targetWeek);

  const manifestPatch = {
    status: 'building',
    target_week: dashboard.week,
    target_weeks: String(targetWeeks).split(',').map((w) => w.trim()).filter(Boolean),
    build: {
      run_id: runId,
      source_data_dir: sourceDataDir,
      copied_runtime_files: copiedRuntimeFiles,
      result,
      dashboard,
      built_at: new Date().toISOString(),
    },
  };
  if (args['coverage-file']) manifestPatch.coverageFile = args['coverage-file'];
  if (args.version) manifestPatch.version = args.version;
  updateManifest(releaseDir, manifestPatch);
  writeStatus(releaseDir, { stage: 'build', status: 'success', message: `built dashboard ${dashboard.week}` });

  console.log(JSON.stringify({
    ok: true,
    releaseDir,
    dataDir,
    runId,
    targetWeeks,
    copiedRuntimeFiles,
    result,
    dashboard,
  }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[build-release-data] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  businessOverviewCacheName,
  copyDurableRuntimeFiles,
  writeDashboard,
};

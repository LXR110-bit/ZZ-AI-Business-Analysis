'use strict';

const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const { composeDashboard, mergeBusinessOverviewInsights } = require('./compose-dashboard');
const { normalizeBoardMetricRecord } = require('./board-sync');
const APP_VERSION = require('../package.json').version;
const AIWAN_GENERATED_BY = `aiwan-v${APP_VERSION}-loop`;
const DISPLAY_CONTRACT = 'dashboard-business-overview-insights-map/v1';

function businessOverviewCacheName(week) {
  const safeWeek = String(week || '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
  return safeWeek ? `business-overview-insights-${safeWeek}.json` : 'business-overview-insights.json';
}

function publishAiwanInsightsFromValidate(record) {
  const cache = buildAiwanBusinessOverviewInsights(record);
  const name = businessOverviewCacheName(cache.week);
  const projection = buildDashboardProjection(record, cache);
  // Prepare and validate every object before the first write. dashboard.json is
  // written last, so static-page consumers either see the old complete release
  // or the new complete release, never a partially composed dashboard.
  if (projection.bundle) {
    store.writeJSON('category-cache.json', projection.bundle.categoryCache);
    store.writeJSON('category-taxonomy.json', projection.bundle.categoryTaxonomy);
    store.writeJSON('board-metrics.json', projection.bundle.boardMetrics);
  }
  store.writeJSON(name, cache);
  store.writeJSON('business-overview-insights.json', cache);
  store.writeJSON('dashboard.json', projection.dashboard);
  store.appendLog({
    action: 'aiwan-insights-bridge-published',
    run_id: record.run_id,
    week: cache.week,
    status: record.status,
    revision: record.revision,
    cache_name: name,
    dashboard_analysis_key: projection.dashboard.analysisStatus.analysis_key,
    dashboard_data_end_date: projection.dashboard.analysisStatus.data_end_date,
    dashboard_base_revision: projection.dashboard.analysisStatus.base_revision,
  });
  return { name, cache, dashboard: projection.dashboard };
}

function buildAiwanBusinessOverviewInsights(record = {}) {
  const payload = objectOrEmpty(record.payload);
  const processed = objectOrEmpty(payload.processed_data);
  const analysis = objectOrEmpty(payload.analysis_result);
  const validation = objectOrEmpty(payload.validation_result);
  const displayInsights = objectOrEmpty(analysis.display_insights);
  if (analysis.display_contract !== DISPLAY_CONTRACT) {
    throw new Error(`analysis_result.display_contract must be ${DISPLAY_CONTRACT}`);
  }
  validateDisplayInsights(displayInsights);
  const warnings = uniqueStrings([
    ...arrayOrEmpty(record.warnings),
    ...arrayOrEmpty(analysis.warnings),
    ...arrayOrEmpty(validation.warnings),
    ...arrayOrEmpty(validation.issues),
    ...arrayOrEmpty(displayInsights.warnings),
  ]);

  const generatedAt = new Date().toISOString();
  const publicationStatus = record.publication_status || record.publicationStatus || null;
  const deliveryState = publicationStatus === 'late_published'
    ? 'late_published'
    : (record.deliveryState || record.delivery_state || 'base_published');
  return {
    version: APP_VERSION,
    week: record.week || processed.week || analysis.week || validation.week || null,
    prevWeek: processed.prevWeek || processed.prev_week || analysis.prevWeek || analysis.prev_week || '',
    insights: {
      board: displayInsights.board,
      tiers: displayInsights.tiers,
      secondaryCategories: displayInsights.secondaryCategories,
      categories: displayInsights.categories,
      category: displayInsights.category,
      monitor: displayInsights.monitor,
    },
    warnings,
    generatedAt,
    generatedBy: AIWAN_GENERATED_BY,
    mode: 'aiwan_loop',
    inputHash: `aiwan:${record.run_id || ''}:${record.revision || 0}`,
    analysisStatus: {
      state: 'rolling',
      source: AIWAN_GENERATED_BY,
      run_id: record.run_id || null,
      status: record.status || null,
      revision: record.revision || null,
      written_at: record.written_at || null,
      generatedAt,
      generatedBy: AIWAN_GENERATED_BY,
      mode: 'aiwan_loop',
      analysis_key: record.analysis_key || null,
      data_end_date: record.data_end_date || null,
      base_revision: record.base_revision == null ? null : Number(record.base_revision),
      base_started_at: record.base_started_at || null,
      base_published_at: record.base_published_at || generatedAt,
      base_sla_deadline: record.base_sla_deadline || null,
      model_sla_deadline: record.model_sla_deadline || null,
      model_enrichment_mode: record.model_enrichment_mode || 'disabled',
      deliveryState,
      publication_status: publicationStatus || (deliveryState === 'late_published' ? 'late_published' : 'published'),
    },
  };
}

function buildDashboardProjection(record, cache) {
  const payload = objectOrEmpty(record.payload);
  const rawBundle = objectOrEmpty(payload.publication_bundle);
  const supplied = Object.keys(rawBundle).length > 0;
  const categoryCache = supplied ? requireObject(rawBundle.category_cache, 'publication_bundle.category_cache') : store.readJSON('category-cache.json', null);
  const categoryTaxonomy = supplied ? requireObject(rawBundle.category_taxonomy, 'publication_bundle.category_taxonomy') : store.readJSON('category-taxonomy.json', null);
  if (!categoryCache || !categoryTaxonomy) throw new Error('dashboard publication requires category cache and taxonomy');
  if (!Array.isArray(categoryCache.rows) || !categoryCache.rows.length) throw new Error('publication_bundle.category_cache.rows must be non-empty');
  const weeks = Array.isArray(categoryCache.weeks) && categoryCache.weeks.length
    ? categoryCache.weeks.map(String).sort()
    : [...new Set(categoryCache.rows.map((row) => row && row.week).filter(Boolean).map(String))].sort();
  if (!weeks.includes(cache.week)) throw new Error(`publication bundle does not contain target week ${cache.week}`);
  const index = weeks.indexOf(cache.week);
  const prevWeek = cache.prevWeek || (index > 0 ? weeks[index - 1] : null);
  const boardMetrics = resolveBoardMetricsBundle(record, cache.week);
  const generatedAt = cache.generatedAt;
  const normalizedCategoryCache = { ...categoryCache, weeks, syncedAt: generatedAt };
  let dashboard = composeDashboard({
    categoryCache: normalizedCategoryCache,
    taxonomy: categoryTaxonomy,
    boardMetrics,
    week: cache.week,
    prevWeek,
    analysisNow: generatedAt,
  });
  dashboard = mergeBusinessOverviewInsights(dashboard, cache);
  const publicationMetadata = Object.fromEntries(
    Object.entries(cache.analysisStatus || {}).filter(([, value]) => value != null)
  );
  dashboard = {
    ...dashboard,
    syncedAt: generatedAt,
    analysisStatus: { ...(dashboard.analysisStatus || {}), ...publicationMetadata },
  };
  if (supplied) {
    for (const key of ['analysis_key', 'data_end_date', 'base_revision']) {
      if (dashboard.analysisStatus[key] == null) throw new Error(`dashboard publication missing analysisStatus.${key}`);
    }
  }
  return {
    dashboard,
    bundle: supplied ? { categoryCache: normalizedCategoryCache, categoryTaxonomy, boardMetrics } : null,
  };
}

function resolveBoardMetricsBundle(record, targetWeek) {
  const payload = objectOrEmpty(record.payload);
  const rawBundle = objectOrEmpty(payload.publication_bundle);
  const supplied = Object.keys(rawBundle).length > 0;
  const primary = supplied
    ? requireObject(rawBundle.board_metrics, 'publication_bundle.board_metrics')
    : store.readJSON('board-metrics.json', {});
  const attempted = tryNormalizeBoardMetricsBundle(primary, targetWeek);
  if (attempted.ok) return attempted.value;

  const fallback = rebuildBoardMetricsFromProcessed(payload.processed_data, targetWeek);
  if (fallback) {
    const retried = tryNormalizeBoardMetricsBundle(fallback, targetWeek);
    if (retried.ok) return retried.value;
  }

  throw attempted.error;
}

function tryNormalizeBoardMetricsBundle(value, targetWeek) {
  try {
    return { ok: true, value: normalizeBoardMetricsBundle(value, { targetWeek }) };
  } catch (error) {
    return { ok: false, error };
  }
}

function rebuildBoardMetricsFromProcessed(processed, targetWeek) {
  const artifacts = objectOrEmpty(processed && processed.artifacts);
  const processDirValue = artifacts.process_dir || artifacts.processDir || '';
  if (!processDirValue) return null;
  const processDir = path.resolve(String(processDirValue));
  const candidateDirs = [
    processDir,
    path.join(processDir, 'imports'),
    path.join(processDir, 'cache'),
    path.join(processDir, 'read_exports'),
    path.join(processDir, 'read_artifacts', 'raw'),
  ];
  const rows = [];
  const seenFiles = new Set();
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!/^sqldau.*\.(csv|tsv)$/i.test(file)) continue;
      const full = path.join(dir, file);
      if (seenFiles.has(full)) continue;
      seenFiles.add(full);
      rows.push(...readBoardMetricRowsFromTabularFile(full));
    }
  }
  if (!rows.length) return null;
  const normalizedRows = rows
    .map((row) => normalizeBoardMetricRecord(row))
    .filter((row) => row.week);
  if (!normalizedRows.length) return null;
  const weeks = [...new Set(normalizedRows.map((row) => row.week))].sort();
  return {
    syncedAt: new Date().toISOString(),
    version: '1.6.44-zloop',
    source: {
      script: 'sqldau',
      grain: 'week_daily_average',
      recoveredFrom: 'processed_data.artifacts.process_dir',
      targetWeeks: weeks,
    },
    weeks,
    rows: normalizedRows,
  };
}

function readBoardMetricRowsFromTabularFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headerLine = lines.shift();
  const delimiter = headerLine.includes('\t') && !headerLine.includes(',') ? '\t' : ',';
  const headers = splitTabularLine(headerLine, delimiter);
  return lines.map((line) => {
    const values = splitTabularLine(line, delimiter);
    const row = {};
    for (let i = 0; i < headers.length; i += 1) {
      row[headers[i]] = values[i] ?? '';
    }
    return row;
  });
}

function splitTabularLine(line, delimiter) {
  return String(line || '')
    .split(delimiter)
    .map((value) => String(value || '').trim());
}

function normalizeBoardMetricsBundle(value, { targetWeek = '' } = {}) {
  const boardMetrics = requireObject(value, 'publication_bundle.board_metrics');
  if (!Array.isArray(boardMetrics.rows)) return boardMetrics;
  if (!boardMetrics.rows.length) return { ...boardMetrics, rows: [], weeks: [] };

  const rows = boardMetrics.rows
    .map((row) => normalizeBoardMetricRecord(objectOrEmpty(row)))
    .filter((row) => row.week);
  if (!rows.length) throw new Error('publication_bundle.board_metrics.rows contains no valid week');

  const weeks = [...new Set(rows.map((row) => row.week))].sort();
  if (targetWeek) {
    const target = rows.find((row) => row.week === targetWeek);
    if (!target) throw new Error(`publication_bundle.board_metrics missing target week ${targetWeek}`);
    for (const field of ['appDau', 'recycleEntranceUv']) {
      const number = Number(target[field]);
      if (!Number.isFinite(number) || number <= 0) {
        throw new Error(`publication_bundle.board_metrics ${targetWeek}.${field} must be positive`);
      }
    }
  }
  return { ...boardMetrics, weeks, rows };
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value;
}

function validateDisplayInsights(insights) {
  if (!insights || typeof insights !== 'object' || Array.isArray(insights)) {
    throw new Error('analysis_result.display_insights is required for dashboard bridge');
  }
  for (const key of ['board', 'category', 'monitor']) {
    if (typeof insights[key] !== 'string' || !insights[key].trim()) {
      throw new Error(`analysis_result.display_insights.${key} must be a non-empty string`);
    }
  }
  const tiers = objectOrEmpty(insights.tiers);
  for (const tier of ['发展', '孵化', '种子']) {
    if (typeof tiers[tier] !== 'string' || !tiers[tier].trim()) {
      throw new Error(`analysis_result.display_insights.tiers.${tier} must be a non-empty string`);
    }
  }
  for (const key of ['secondaryCategories', 'categories']) {
    if (!insights[key] || typeof insights[key] !== 'object' || Array.isArray(insights[key])) {
      throw new Error(`analysis_result.display_insights.${key} must be an object map`);
    }
  }
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values) {
  return [...new Set(values.map((v) => String(v || '').trim()).filter(Boolean))];
}

module.exports = {
  DISPLAY_CONTRACT,
  businessOverviewCacheName,
  buildAiwanBusinessOverviewInsights,
  buildDashboardProjection,
  normalizeBoardMetricsBundle,
  publishAiwanInsightsFromValidate,
};

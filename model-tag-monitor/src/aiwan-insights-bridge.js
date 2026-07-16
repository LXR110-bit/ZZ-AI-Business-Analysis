'use strict';

const store = require('./store');
const APP_VERSION = require('../package.json').version;
const DISPLAY_CONTRACT = 'dashboard-business-overview-insights-map/v1';

function businessOverviewCacheName(week) {
  const safeWeek = String(week || '').trim().replace(/[^0-9A-Za-z_-]/g, '_');
  return safeWeek ? `business-overview-insights-${safeWeek}.json` : 'business-overview-insights.json';
}

function publishAiwanInsightsFromValidate(record) {
  const cache = buildAiwanBusinessOverviewInsights(record);
  const name = businessOverviewCacheName(cache.week);
  store.writeJSON(name, cache);
  store.appendLog({
    action: 'aiwan-insights-bridge-published',
    run_id: record.run_id,
    week: cache.week,
    status: record.status,
    revision: record.revision,
    cache_name: name,
  });
  return { name, cache };
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
    generatedBy: 'aiwan-v1.6.2-loop',
    mode: 'aiwan_loop',
    inputHash: `aiwan:${record.run_id || ''}:${record.revision || 0}`,
    analysisStatus: {
      state: 'rolling',
      source: 'aiwan-v1.6.2-loop',
      run_id: record.run_id || null,
      status: record.status || null,
      revision: record.revision || null,
      written_at: record.written_at || null,
      generatedAt,
      generatedBy: 'aiwan-v1.6.2-loop',
      mode: 'aiwan_loop',
    },
  };
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
  publishAiwanInsightsFromValidate,
};

'use strict';

const path = require('node:path');
const store = require('./store');
const { DEFAULT_RULES } = require('./monitor');
const { composeDashboard: composeDashboardV2 } = require('./compose-dashboard');
const { getDashboard } = require('./dashboard');
const { publishAiwanInsightsFromValidate } = require('./aiwan-insights-bridge');

const STAGE_ORDER = ['read', 'process', 'analyze', 'validate'];
const STAGE_ALIASES = {
  fetch: 'read',
  data_read: 'read',
  data_process: 'process',
  analysis: 'analyze',
  validation: 'validate',
};
const VALID_STATUSES = new Set(['pending', 'running', 'success', 'warn', 'failed', 'skipped']);

function sanitizeId(value, field = 'id') {
  const s = String(value || '').trim();
  if (!s) throw new Error(`${field} is required`);
  if (!/^[0-9A-Za-z._:-]+$/.test(s)) {
    throw new Error(`${field} contains illegal characters; allowed: 0-9 A-Z a-z . _ : -`);
  }
  if (s.includes('..') || s.includes('/') || s.includes('\\')) throw new Error(`${field} must not contain path separators`);
  return s.slice(0, 120);
}

function normalizeStage(value) {
  const raw = String(value || '').trim();
  const stage = STAGE_ALIASES[raw] || raw;
  if (!STAGE_ORDER.includes(stage)) throw new Error(`stage must be one of ${STAGE_ORDER.join(', ')}`);
  return stage;
}

function runFile(runId, name) {
  return path.posix.join('aiwan-runs', sanitizeId(runId, 'run_id'), name);
}

function stageFile(runId, stage) {
  return runFile(runId, `${normalizeStage(stage)}.json`);
}

function readRun(runId) {
  return store.readJSON(runFile(runId, 'run.json'), null);
}

function readStage(runId, stage) {
  return store.readJSON(stageFile(runId, stage), null);
}

function safeReadStage(runId, stage) {
  try { return readStage(runId, stage); } catch { return null; }
}

function latestWeekFromCaches() {
  const categoryCache = store.readJSON('category-cache.json', null);
  const cache = store.readJSON('cache.json', null);
  const weeks = [];
  if (categoryCache) weeks.push(...weeksFromCache(categoryCache));
  if (cache) weeks.push(...weeksFromCache(cache));
  return [...new Set(weeks)].sort().pop() || '';
}

function weeksFromCache(cache) {
  if (!cache || typeof cache !== 'object') return [];
  if (Array.isArray(cache.weeks) && cache.weeks.length) return cache.weeks.filter(Boolean).map(String).sort();
  if (Array.isArray(cache.rows)) return [...new Set(cache.rows.map((r) => r.week).filter(Boolean).map(String))].sort();
  return [];
}

function defaultRunId(week) {
  const w = String(week || latestWeekFromCaches() || '').trim();
  if (!w) throw new Error('run_id or week is required because no latest week was found');
  return `${w}-weekly`;
}

function resolveRequestIds(body = {}) {
  const week = String(body.week || latestWeekFromCaches() || '').trim();
  const runId = sanitizeId(body.run_id || defaultRunId(week), 'run_id');
  const stage = normalizeStage(body.stage || 'read');
  return { runId, stage, week };
}

function buildDashboardSnapshot(week = '') {
  const categoryCache = store.readJSON('category-cache.json', null);
  const taxonomy = store.readJSON('category-taxonomy.json', null);
  const boardMetrics = store.readJSON('board-metrics.json', null);
  if (categoryCache && taxonomy && Array.isArray(categoryCache.rows) && categoryCache.rows.length) {
    const weeks = weeksFromCache(categoryCache);
    const targetWeek = String(week || weeks[weeks.length - 1] || '').trim();
    const prevWeek = weeks[weeks.indexOf(targetWeek) - 1] || null;
    if (targetWeek) {
      return composeDashboardV2({ categoryCache, taxonomy, boardMetrics, week: targetWeek, prevWeek });
    }
  }
  return getDashboard();
}

function buildCandidateAnomalies(dashboard) {
  const out = [];
  const categories = Array.isArray(dashboard && dashboard.categories) ? dashboard.categories : [];
  for (const c of categories) {
    const score = Number(c.anomalyScore || 0);
    const cur = c.cur || {};
    const delta = c.delta || {};
    if (score <= 0 && !(delta && (delta.gmv || delta.orderRate || delta.dealRate))) continue;
    out.push({
      level: 'category',
      entity_type: 'category',
      entity_name: c.category,
      category: c.category,
      tier: c.tier || null,
      board: c.board || c.secondaryCategory || null,
      anomaly_score: score,
      metric: pickPrimaryMetric(delta),
      direction: primaryDirection(delta),
      cur: compactMetrics(cur),
      delta: compactMetrics(delta),
    });
  }
  const topRows = Array.isArray(dashboard && dashboard.topRows) ? dashboard.topRows : [];
  for (const row of topRows.slice(0, 20)) {
    out.push({
      level: 'model',
      entity_type: 'model',
      entity_name: row.modelName,
      category: row.category,
      model_id: row.modelId || null,
      metric: 'orderRate',
      direction: row.deltaDir || null,
      cur: { orderRate: row.orderRate, gmv: row.gmv },
      delta: { orderRate: row.deltaRaw ?? null },
    });
  }
  return out.sort((a, b) => Math.abs(Number(b.cur && b.cur.gmv) || 0) - Math.abs(Number(a.cur && a.cur.gmv) || 0));
}

function pickPrimaryMetric(delta = {}) {
  if (delta.gmv != null) return 'gmv';
  if (delta.orderRate != null) return 'orderRate';
  if (delta.dealRate != null) return 'dealRate';
  return 'unknown';
}

function primaryDirection(delta = {}) {
  const metric = pickPrimaryMetric(delta);
  const v = Number(delta[metric]);
  if (!Number.isFinite(v)) return null;
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
}

function compactMetrics(obj = {}) {
  const keys = ['conditionUv', 'jkuv', 'evaUv', 'orderUv', 'shipCnt', 'dealCnt', 'gmv', 'evaRate', 'orderRate', 'shipRate', 'dealRate', 'returnRate'];
  const out = {};
  for (const k of keys) if (obj[k] != null) out[k] = obj[k];
  return out;
}

function buildHistory(week = '', limit = 10) {
  const cache = store.readJSON('cache.json', null);
  const categoryCache = store.readJSON('category-cache.json', null);
  const allWeeks = [...new Set([...weeksFromCache(cache), ...weeksFromCache(categoryCache)])].sort();
  const targetWeek = String(week || allWeeks[allWeeks.length - 1] || '').trim();
  const endIdx = targetWeek ? allWeeks.indexOf(targetWeek) : allWeeks.length - 1;
  const selectedWeeks = allWeeks.slice(Math.max(0, (endIdx >= 0 ? endIdx : allWeeks.length - 1) - limit + 1), (endIdx >= 0 ? endIdx : allWeeks.length - 1) + 1);
  return {
    weeks: selectedWeeks,
    requested_weeks: limit,
    model_cache: cache ? {
      syncedAt: cache.syncedAt || null,
      source: cache.source || null,
      row_count: Array.isArray(cache.rows) ? cache.rows.length : 0,
      categories: Array.isArray(cache.categories) ? cache.categories.length : [...new Set((cache.rows || []).map((r) => r.category).filter(Boolean))].length,
    } : null,
    category_cache: categoryCache ? {
      syncedAt: categoryCache.syncedAt || null,
      source: categoryCache.source || null,
      row_count: Array.isArray(categoryCache.rows) ? categoryCache.rows.length : 0,
      categories: Array.isArray(categoryCache.categories) ? categoryCache.categories.length : [...new Set((categoryCache.rows || []).map((r) => r.category).filter(Boolean))].length,
    } : null,
  };
}

function buildRules() {
  return {
    source: 'model-tag-monitor rules.json',
    rules: store.readJSON('rules.json', DEFAULT_RULES),
    fallback: DEFAULT_RULES,
  };
}

function buildRunMeta(runId, week, stage) {
  const run = readRun(runId);
  return run || {
    run_id: runId,
    week: week || latestWeekFromCaches() || null,
    status: 'pending',
    current_stage: stage,
    stages: {},
    stage_order: STAGE_ORDER,
  };
}

function previousStages(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  return idx <= 0 ? [] : STAGE_ORDER.slice(0, idx);
}

function collectStageOutputs(runId, stages) {
  const out = {};
  const missing = [];
  for (const s of stages) {
    const v = safeReadStage(runId, s);
    if (v) out[s] = v;
    else missing.push(s);
  }
  return { outputs: out, missing };
}

function buildReadResponse(body = {}) {
  const { runId, stage, week } = resolveRequestIds(body);
  const include = Array.isArray(body.include) && body.include.length
    ? body.include.map(String)
    : ['run_meta', 'history_10w', 'metric_snapshot', 'candidate_anomalies', 'rules', 'previous_stage_outputs'];
  const dashboard = include.some((x) => ['metric_snapshot', 'candidate_anomalies', 'context'].includes(x))
    ? buildDashboardSnapshot(week)
    : null;
  const response = {
    ok: true,
    run_id: runId,
    stage,
    week: week || (dashboard && dashboard.week) || latestWeekFromCaches() || null,
    context: {},
    previous_outputs: {},
    warnings: [],
  };
  if (include.includes('run_meta')) response.context.run_meta = buildRunMeta(runId, response.week, stage);
  if (include.includes('history_10w')) response.context.history_10w = buildHistory(response.week, Number(body.history_weeks || 10));
  if (include.includes('metric_snapshot')) response.context.metric_snapshot = dashboard ? slimDashboard(dashboard) : null;
  if (include.includes('candidate_anomalies')) response.context.candidate_anomalies = dashboard ? buildCandidateAnomalies(dashboard) : [];
  if (include.includes('rules')) response.context.rules = buildRules();
  if (include.includes('previous_stage_outputs')) {
    const { outputs, missing } = collectStageOutputs(runId, previousStages(stage));
    response.previous_outputs = outputs;
    if (missing.length) {
      response.ok = false;
      response.missing_previous_stages = missing;
      response.warnings.push(`missing previous stage outputs: ${missing.join(',')}`);
    }
  }
  if (stage === 'validate' || include.includes('current_stage_output') || include.includes('stage_output')) {
    const currentOutput = safeReadStage(runId, stage);
    if (currentOutput) response.current_output = currentOutput;
  }
  return response;
}

function slimDashboard(d) {
  if (!d) return null;
  return {
    version: d.version || null,
    week: d.week || (d.meta && d.meta.latestWeek) || null,
    prevWeek: d.prevWeek || null,
    weekRange: d.weekRange || null,
    syncedAt: d.syncedAt || (d.meta && d.meta.syncedAt) || null,
    analysisStatus: d.analysisStatus || null,
    board: d.board || null,
    penetration: d.penetration || null,
    kpiCards: d.kpiCards || null,
    tiers: d.tiers || [],
    categories: Array.isArray(d.categories) ? d.categories : [],
    insights: d.insights || null,
    topRows: Array.isArray(d.topRows) ? d.topRows : [],
  };
}

function buildWriteRecord(body = {}) {
  const { runId, stage, week } = resolveRequestIds(body);
  const status = String(body.status || 'success').trim();
  if (!VALID_STATUSES.has(status)) throw new Error(`status must be one of ${[...VALID_STATUSES].join(', ')}`);
  const existing = safeReadStage(runId, stage);
  const revision = Number(existing && existing.revision || 0) + 1;
  return {
    run_id: runId,
    week: week || latestWeekFromCaches() || null,
    stage,
    status,
    output_type: String(body.output_type || `${stage}_result`),
    revision,
    overwritten_previous_revision: revision > 1,
    payload: body.payload == null ? {} : body.payload,
    artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
    warnings: Array.isArray(body.warnings) ? body.warnings.map(String) : [],
    started_at: body.started_at || null,
    finished_at: body.finished_at || new Date().toISOString(),
    written_at: new Date().toISOString(),
    rerun: body.rerun === true,
    rerun_reason: body.rerun_reason || null,
  };
}

function writeStageResult(body = {}) {
  const record = buildWriteRecord(body);
  store.writeJSON(stageFile(record.run_id, record.stage), record);
  const run = updateRunFromStage(record);
  const bridge = tryPublishValidateInsights(record);
  store.appendLog({ action: 'aiwan-stage-write', run_id: record.run_id, stage: record.stage, status: record.status, revision: record.revision });
  return { ok: true, run_id: record.run_id, stage: record.stage, status: record.status, revision: record.revision, run, bridge, output: record };
}

function updateRunFromStage(record) {
  const current = readRun(record.run_id) || {
    run_id: record.run_id,
    week: record.week,
    status: 'running',
    stage_order: STAGE_ORDER,
    stages: {},
    created_at: new Date().toISOString(),
  };
  const stages = { ...(current.stages || {}) };
  stages[record.stage] = {
    status: record.status,
    revision: record.revision,
    output_type: record.output_type,
    written_at: record.written_at,
    warnings_count: record.warnings.length,
  };
  const validateFinal = isValidateFinalRecord(record);
  const failed = Object.values(stages).some((s) => s.status === 'failed');
  const allDone = STAGE_ORDER.every((s) => stages[s] && ['success', 'warn', 'skipped'].includes(stages[s].status));
  const status = failed
    ? 'failed'
    : validateFinal
      ? 'success'
      : allDone
        ? 'success'
        : 'running';
  const run = {
    ...current,
    week: record.week || current.week || null,
    status,
    overall_status: validateFinal ? record.status : (failed ? 'failed' : current.overall_status || null),
    current_stage: record.stage,
    stages,
    updated_at: new Date().toISOString(),
  };
  store.writeJSON(runFile(record.run_id, 'run.json'), run);
  return run;
}

function isValidateFinalRecord(record) {
  const payload = record && record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
    ? record.payload
    : {};
  const outputType = String(record && record.output_type || '');
  return record
    && record.stage === 'validate'
    && (outputType === 'validation_result' || outputType === 'validate_result')
    && ['success', 'warn', 'failed'].includes(record.status)
    && payload.processed_data
    && payload.analysis_result
    && payload.validation_result;
}

function tryPublishValidateInsights(record) {
  if (!isValidateFinalRecord(record) || !['success', 'warn'].includes(record.status)) return null;
  try {
    const result = publishAiwanInsightsFromValidate(record);
    return { ok: true, cache_name: result.name, mode: result.cache.mode, generatedBy: result.cache.generatedBy };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    store.appendLog({
      action: 'aiwan-insights-bridge-failed',
      run_id: record.run_id,
      week: record.week,
      status: record.status,
      revision: record.revision,
      error: message,
    });
    return { ok: false, error: message };
  }
}

module.exports = {
  STAGE_ORDER,
  buildReadResponse,
  writeStageResult,
  normalizeStage,
  sanitizeId,
  runFile,
  stageFile,
  isValidateFinalRecord,
};

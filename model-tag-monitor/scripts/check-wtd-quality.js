#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { dateToISOWeek, splitCsvLine } = require('./validate-daily-import-coverage');

const CATEGORY_OUTPUT = 'category_daily_avg';
const MODEL_OUTPUT = 'model_daily_avg';
const DEFAULT_WATCH_CATEGORIES = ['组装自行车'];
const METRIC_CANDIDATES = {
  gmv: ['成交gmv', '成交GMV', 'GMV', 'gmv', '成交金额'],
  dealCnt: ['成交量', '成交订单', '成交订单量', 'dealCnt'],
  orderCnt: ['下单量', '下单订单', 'orderCnt'],
  orderUv: ['下单UV', '下单uv', 'orderUv'],
  evaUv: ['估价UV', '估价uv', 'evaUv'],
  shipCnt: ['发货量', '发货数', 'shipCnt'],
};
const METRIC_LABELS = {
  gmv: '成交GMV',
  dealCnt: '成交量',
  orderCnt: '下单量',
  orderUv: '下单UV',
  evaUv: '估价UV',
  shipCnt: '发货数',
};

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

function lastTargetWeek(targetWeeks) {
  const weeks = String(targetWeeks || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  if (!weeks.length) throw new Error('target weeks are required');
  return weeks[weeks.length - 1];
}

function toNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || raw === '-' || raw === '/') return null;
  const n = Number(raw.replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeHeader(value) {
  return String(value || '').trim().replace(/^﻿/, '').toLowerCase();
}

function pickIndex(headers, names) {
  const normalized = headers.map(normalizeHeader);
  for (const name of names) {
    const idx = normalized.indexOf(normalizeHeader(name));
    if (idx >= 0) return idx;
  }
  return -1;
}

function isExplicitDailyAverageHeader(header) {
  return /日均|daily[_\s-]*avg|avg[_\s-]*daily/i.test(String(header || ''));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function outputPathFrom(importDir, key) {
  const activePath = path.join(importDir, 'active.json');
  if (!fs.existsSync(activePath)) return null;
  const active = readJson(activePath);
  const activeOutput = active && active.outputs && active.outputs[key];
  if (activeOutput) return path.resolve(activeOutput);
  if (active.manifest && fs.existsSync(active.manifest)) {
    const manifest = readJson(active.manifest);
    const manifestOutput = manifest && manifest.outputs && manifest.outputs[key] && manifest.outputs[key].path;
    if (manifestOutput) return path.resolve(manifestOutput);
  }
  return null;
}

function rowWeek(values, indices) {
  const explicit = indices.week >= 0 ? String(values[indices.week] || '').trim() : '';
  if (/^\d{4}-W\d{2}$/.test(explicit)) return explicit;
  const startDate = indices.weekStart >= 0 ? String(values[indices.weekStart] || '').trim() : '';
  return startDate ? dateToISOWeek(startDate) : explicit;
}

function loadCategoryRows(file, targetWeek) {
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  if (!raw.length) return { rows: [], headers: [], metricSources: {} };
  const headers = splitCsvLine(raw[0].replace(/^﻿/, '')).map((h) => h.trim());
  const indices = {
    week: pickIndex(headers, ['week', '统计周', '周次']),
    weekStart: pickIndex(headers, ['week_start_date', '周开始', '开始日期']),
    category: pickIndex(headers, ['品类名称', '品类', '三级品类', 'category']),
    dayCnt: pickIndex(headers, ['day_cnt', '已收到天数', 'daysReceived']),
  };
  const metricIndices = {};
  const metricSources = {};
  for (const [metric, names] of Object.entries(METRIC_CANDIDATES)) {
    const idx = pickIndex(headers, names.concat(names.map((name) => `${name}日均`)));
    if (idx >= 0) {
      metricIndices[metric] = idx;
      metricSources[metric] = headers[idx];
    }
  }
  const rows = [];
  for (const line of raw.slice(1)) {
    const values = splitCsvLine(line);
    if (rowWeek(values, indices) !== targetWeek) continue;
    const category = indices.category >= 0 ? String(values[indices.category] || '').trim() : '';
    if (!category) continue;
    const metrics = {};
    for (const [metric, idx] of Object.entries(metricIndices)) metrics[metric] = toNumber(values[idx]);
    rows.push({
      category,
      week: targetWeek,
      dayCnt: indices.dayCnt >= 0 ? toNumber(values[indices.dayCnt]) : null,
      metrics,
    });
  }
  return { rows, headers, metricSources };
}

function loadModelAggregates(file, targetWeek) {
  if (!file || !fs.existsSync(file)) return { rows: [], byCategory: new Map(), metricSources: {} };
  const { rows, metricSources } = loadCategoryRows(file, targetWeek);
  const byCategory = new Map();
  for (const row of rows) {
    if (!byCategory.has(row.category)) byCategory.set(row.category, { category: row.category, dayCnt: row.dayCnt, metrics: {} });
    const agg = byCategory.get(row.category);
    if (row.dayCnt != null) agg.dayCnt = row.dayCnt;
    for (const [metric, value] of Object.entries(row.metrics || {})) {
      if (value == null) continue;
      agg.metrics[metric] = (agg.metrics[metric] || 0) + value;
    }
  }
  return { rows, byCategory, metricSources };
}

function latestByCategory(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.category, row);
  return map;
}

function parseList(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function isEnabled(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function metricIsWtd(metricSources, metric) {
  const source = metricSources && metricSources[metric];
  if (!source) return false;
  return !isExplicitDailyAverageHeader(source);
}

function safeRatio(cur, prev) {
  if (cur == null || prev == null || prev <= 0) return null;
  return cur / prev;
}

function compareAgainstBaseline({ currentRows, baselineRows, currentMetricSources, baselineMetricSources, watchCategories, topN, blockRatio, warnRatio, broadDropShare, broadDropMinCategories }) {
  const current = latestByCategory(currentRows);
  const baseline = latestByCategory(baselineRows);
  const categoriesByBaselineGmv = [...baseline.values()]
    .slice()
    .sort((a, b) => ((b.metrics && b.metrics.gmv) || 0) - ((a.metrics && a.metrics.gmv) || 0))
    .slice(0, topN)
    .map((row) => row.category);
  const priorityCategories = new Set([...watchCategories, ...categoriesByBaselineGmv]);
  const comparisons = [];
  const errors = [];
  const warnings = [];
  let broadDropCount = 0;
  let comparedCategoryCount = 0;

  for (const [category, cur] of current.entries()) {
    const prev = baseline.get(category);
    if (!prev) continue;
    const dayCntIncreased = cur.dayCnt != null && prev.dayCnt != null && cur.dayCnt > prev.dayCnt;
    const dayCntSame = cur.dayCnt != null && prev.dayCnt != null && cur.dayCnt === prev.dayCnt;
    const categoryComparisons = [];
    let categoryHasBlockDrop = false;

    for (const metric of Object.keys(METRIC_CANDIDATES)) {
      if (!metricIsWtd(currentMetricSources, metric) || !metricIsWtd(baselineMetricSources, metric)) continue;
      const curValue = cur.metrics && cur.metrics[metric];
      const prevValue = prev.metrics && prev.metrics[metric];
      const ratio = safeRatio(curValue, prevValue);
      if (ratio == null) continue;
      const item = {
        metric,
        label: METRIC_LABELS[metric] || metric,
        current: curValue,
        baseline: prevValue,
        ratio,
      };
      categoryComparisons.push(item);
      if ((dayCntIncreased || dayCntSame) && ratio < blockRatio) {
        categoryHasBlockDrop = true;
        const message = `${category} ${item.label} 异常回退：current=${curValue}, baseline=${prevValue}, ratio=${ratio.toFixed(3)}, day_cnt ${prev.dayCnt}→${cur.dayCnt}`;
        if (priorityCategories.has(category)) errors.push(message);
        else warnings.push(message);
      } else if ((dayCntIncreased || dayCntSame) && ratio < warnRatio) {
        warnings.push(`${category} ${item.label} 明显回落：current=${curValue}, baseline=${prevValue}, ratio=${ratio.toFixed(3)}, day_cnt ${prev.dayCnt}→${cur.dayCnt}`);
      }
    }

    if (categoryComparisons.length) {
      comparedCategoryCount += 1;
      if (categoryHasBlockDrop) broadDropCount += 1;
      comparisons.push({
        category,
        priority: priorityCategories.has(category),
        currentDayCnt: cur.dayCnt,
        baselineDayCnt: prev.dayCnt,
        metrics: categoryComparisons,
      });
    }
  }

  if (comparedCategoryCount >= broadDropMinCategories && broadDropCount >= broadDropMinCategories && broadDropCount / comparedCategoryCount >= broadDropShare) {
    errors.push(`大面积 WTD 指标异常回退：${broadDropCount}/${comparedCategoryCount} 个可比品类低于 blockRatio=${blockRatio}`);
  }

  return { comparisons, errors, warnings };
}

function reconcileCategoryVsModel({ categoryRows, modelByCategory, metricSources, tolerance }) {
  const warnings = [];
  if (!modelByCategory || !modelByCategory.size) return warnings;
  for (const row of categoryRows) {
    const model = modelByCategory.get(row.category);
    if (!model) continue;
    for (const metric of ['gmv', 'dealCnt', 'orderCnt', 'orderUv', 'evaUv', 'shipCnt']) {
      if (!metricSources[metric]) continue;
      const categoryValue = row.metrics && row.metrics[metric];
      const modelValue = model.metrics && model.metrics[metric];
      if (categoryValue == null || modelValue == null || categoryValue === 0) continue;
      const diffRatio = Math.abs(categoryValue - modelValue) / Math.max(Math.abs(categoryValue), 1);
      if (diffRatio > tolerance) {
        warnings.push(`${row.category} ${METRIC_LABELS[metric] || metric} 品类汇总 vs 机型聚合差异 ${diffRatio.toFixed(3)}：category=${categoryValue}, model_sum=${modelValue}`);
      }
    }
  }
  return warnings;
}

async function checkWtdQuality(options) {
  const currentDir = path.resolve(options.currentDir || options['current-dir'] || process.env.STAGING_IMPORT_DIR || '');
  const baselineDir = path.resolve(options.baselineDir || options['baseline-dir'] || process.env.IMPORT_DIR || '');
  const targetWeek = options.targetWeek || options['target-week'] || lastTargetWeek(options.targetWeeks || options['target-weeks'] || process.env.TARGET_WEEKS || '');
  const blockRatio = Number(options.blockRatio || options['block-ratio'] || process.env.WTD_QUALITY_BLOCK_RATIO || '0.5');
  const warnRatio = Number(options.warnRatio || options['warn-ratio'] || process.env.WTD_QUALITY_WARN_RATIO || '0.8');
  const topN = Number(options.topN || options['top-n'] || process.env.WTD_QUALITY_TOP_N || '5');
  const broadDropShare = Number(options.broadDropShare || options['broad-drop-share'] || process.env.WTD_QUALITY_BROAD_DROP_SHARE || '0.3');
  const broadDropMinCategories = Number(options.broadDropMinCategories || options['broad-drop-min-categories'] || process.env.WTD_QUALITY_BROAD_DROP_MIN_CATEGORIES || '3');
  const reconciliationTolerance = Number(options.reconciliationTolerance || options['reconciliation-tolerance'] || process.env.WTD_QUALITY_RECONCILIATION_TOLERANCE || '0.25');
  const reconciliationEnabled = isEnabled(options.reconciliation || options['reconciliation'] || process.env.WTD_QUALITY_RECONCILE, false);
  const watchCategories = parseList(options.watchCategories || options['watch-categories'] || process.env.WTD_QUALITY_WATCH_CATEGORIES, DEFAULT_WATCH_CATEGORIES);

  const result = {
    ok: false,
    state: 'unknown',
    targetWeek,
    currentDir,
    baselineDir,
    thresholds: { blockRatio, warnRatio, topN, broadDropShare, broadDropMinCategories, reconciliationTolerance, reconciliationEnabled, watchCategories },
    comparisons: [],
    warnings: [],
    errors: [],
  };

  if (!currentDir || !fs.existsSync(currentDir)) {
    result.state = 'missing';
    result.errors.push(`current import dir not found: ${currentDir || '<missing>'}`);
    return result;
  }
  const currentCategoryFile = outputPathFrom(currentDir, CATEGORY_OUTPUT);
  if (!currentCategoryFile || !fs.existsSync(currentCategoryFile)) {
    result.state = 'missing';
    result.errors.push(`current ${CATEGORY_OUTPUT} not found under ${currentDir}`);
    return result;
  }
  const currentCategory = loadCategoryRows(currentCategoryFile, targetWeek);
  result.current = { categoryFile: currentCategoryFile, rows: currentCategory.rows.length, metricSources: currentCategory.metricSources };
  if (!currentCategory.rows.length) {
    result.state = 'missing';
    result.errors.push(`current ${CATEGORY_OUTPUT} has no rows for ${targetWeek}`);
    return result;
  }

  const currentModelFile = outputPathFrom(currentDir, MODEL_OUTPUT);
  const currentModel = loadModelAggregates(currentModelFile, targetWeek);
  result.reconciliation = { enabled: reconciliationEnabled, modelFile: currentModelFile || null };
  if (reconciliationEnabled) {
    result.warnings.push(...reconcileCategoryVsModel({
      categoryRows: currentCategory.rows,
      modelByCategory: currentModel.byCategory,
      metricSources: currentCategory.metricSources,
      tolerance: reconciliationTolerance,
    }));
  }

  if (!baselineDir || !fs.existsSync(baselineDir)) {
    result.state = 'no_baseline';
    result.ok = true;
    result.warnings.push(`baseline import dir not found; skipped baseline comparison: ${baselineDir || '<missing>'}`);
    return result;
  }
  const baselineCategoryFile = outputPathFrom(baselineDir, CATEGORY_OUTPUT);
  if (!baselineCategoryFile || !fs.existsSync(baselineCategoryFile)) {
    result.state = 'no_baseline';
    result.ok = true;
    result.warnings.push(`baseline ${CATEGORY_OUTPUT} not found; skipped baseline comparison under ${baselineDir}`);
    return result;
  }
  const baselineCategory = loadCategoryRows(baselineCategoryFile, targetWeek);
  result.baseline = { categoryFile: baselineCategoryFile, rows: baselineCategory.rows.length, metricSources: baselineCategory.metricSources };
  if (!baselineCategory.rows.length) {
    result.state = 'no_baseline';
    result.ok = true;
    result.warnings.push(`baseline ${CATEGORY_OUTPUT} has no rows for ${targetWeek}; skipped baseline comparison`);
    return result;
  }

  const compared = compareAgainstBaseline({
    currentRows: currentCategory.rows,
    baselineRows: baselineCategory.rows,
    currentMetricSources: currentCategory.metricSources,
    baselineMetricSources: baselineCategory.metricSources,
    watchCategories,
    topN,
    blockRatio,
    warnRatio,
    broadDropShare,
    broadDropMinCategories,
  });
  result.comparisons = compared.comparisons;
  result.warnings.push(...compared.warnings);
  result.errors.push(...compared.errors);

  if (!result.comparisons.length) {
    result.warnings.push(`no comparable baseline category rows for ${targetWeek}`);
  }

  result.ok = result.errors.length === 0;
  result.state = result.ok ? 'pass' : 'blocked';
  result.message = result.ok
    ? `${targetWeek} WTD quality gate passed with ${result.warnings.length} warning(s)`
    : result.errors.join('; ');
  return result;
}

async function main() {
  const args = parseArgs();
  if (!args['current-dir'] && !process.env.STAGING_IMPORT_DIR) {
    throw new Error('Usage: check-wtd-quality.js --current-dir <staging-import-dir> --baseline-dir <active-import-dir> --target-weeks <weeks> [--out <file>]');
  }
  const result = await checkWtdQuality(args);
  const text = JSON.stringify(result, null, 2);
  if (args.out) {
    fs.writeFileSync(args.out, `${text}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      state: result.state,
      targetWeek: result.targetWeek,
      currentDir: result.currentDir,
      baselineDir: result.baselineDir,
      out: args.out,
      comparisons: result.comparisons.length,
      errors: result.errors.length,
      warnings: result.warnings.length,
      message: result.message || null,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
  process.exit(result.ok ? 0 : 10);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_WATCH_CATEGORIES,
  METRIC_CANDIDATES,
  checkWtdQuality,
  compareAgainstBaseline,
  loadCategoryRows,
  reconcileCategoryVsModel,
};

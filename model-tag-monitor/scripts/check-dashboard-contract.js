#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { COUNT_KEYS } = require('../src/aggregate/funnel');
const APP_VERSION = require('../package.json').version;

const RATE_KEYS = ['evaRate', 'orderRate', 'shipRate', 'dealRate'];
const REQUIRED_TOP_LEVEL = ['version', 'week', 'weekRange', 'syncedAt', 'analysisStatus', 'board', 'kpiCards', 'penetration', 'tiers', 'categories', 'insights', 'reconciliation'];
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

function lastTargetWeek(targetWeeks) {
  const weeks = String(targetWeeks || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  return weeks.length ? weeks[weeks.length - 1] : '';
}

function isFiniteOrNull(value) {
  return value === null || Number.isFinite(Number(value));
}

function checkObjectFields(obj, fields, prefix, errors) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  for (const field of fields) {
    if (!(field in obj)) errors.push(`${prefix}.${field} missing`);
  }
}

function validateDashboardContract(dashboard, options = {}) {
  const errors = [];
  const warnings = [];
  const expectedVersion = options.expectedVersion || options['expected-version'] || '';
  const targetWeeks = options.targetWeeks || options['target-weeks'] || '';
  const expectedWeek = options.targetWeek || options['target-week'] || lastTargetWeek(targetWeeks);
  const expectedWeeks = String(targetWeeks || '').split(',').map((w) => w.trim()).filter(Boolean);

  if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) {
    return { ok: false, state: 'invalid', errors: ['dashboard payload must be an object'], warnings };
  }

  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in dashboard)) errors.push(`dashboard.${field} missing`);
  }
  const versionToCheck = expectedVersion || APP_VERSION;
  if (dashboard.version !== versionToCheck) errors.push(`dashboard.version mismatch: expected ${versionToCheck}, got ${dashboard.version || '<missing>'}`);
  if (expectedWeek && dashboard.week !== expectedWeek) errors.push(`dashboard.week mismatch: expected ${expectedWeek}, got ${dashboard.week || '<missing>'}`);
  const weeks = Array.isArray(dashboard.weeks) ? dashboard.weeks : dashboard.weekWindow;
  if (expectedWeeks.length && JSON.stringify(weeks || []) !== JSON.stringify(expectedWeeks)) {
    errors.push(`dashboard weeks mismatch: expected ${expectedWeeks.join(',')}, got ${Array.isArray(weeks) ? weeks.join(',') : '<missing>'}`);
  }

  checkObjectFields(dashboard.board, ['cur', 'delta'], 'dashboard.board', errors);
  if (dashboard.board && dashboard.board.cur) {
    for (const key of COUNT_KEYS.concat(RATE_KEYS)) {
      if (!(key in dashboard.board.cur)) errors.push(`dashboard.board.cur.${key} missing`);
      else if (!isFiniteOrNull(dashboard.board.cur[key])) errors.push(`dashboard.board.cur.${key} must be numeric or null`);
    }
  }
  if (dashboard.board && dashboard.board.delta) {
    for (const key of ['gmv', 'evaRate', 'orderRate', 'shipRate', 'dealRate']) {
      if (!(key in dashboard.board.delta)) errors.push(`dashboard.board.delta.${key} missing`);
      else if (!isFiniteOrNull(dashboard.board.delta[key])) errors.push(`dashboard.board.delta.${key} must be numeric or null`);
    }
  }

  if (!Array.isArray(dashboard.kpiCards) || !dashboard.kpiCards.length) {
    errors.push('dashboard.kpiCards must be a non-empty array');
  } else {
    const kpiKeys = dashboard.kpiCards.map((card) => card && card.key).filter(Boolean);
    for (const key of ['gmv', 'dealCnt', 'shipCnt', 'evaUv']) {
      if (!kpiKeys.includes(key)) errors.push(`dashboard.kpiCards missing ${key}`);
    }
    for (const forbidden of ['recycleDau', '回收DAU']) {
      if (kpiKeys.includes(forbidden)) errors.push(`dashboard.kpiCards contains forbidden supplement key ${forbidden}`);
    }
    const labels = dashboard.kpiCards.map((card) => String(card && card.label || '')).join('|');
    if (/回收DAU/.test(labels)) errors.push('dashboard.kpiCards contains forbidden label 回收DAU');
  }

  checkObjectFields(dashboard.penetration, ['appDau', 'recycleEntranceUv'], 'dashboard.penetration', errors);
  if (dashboard.penetration && Object.prototype.hasOwnProperty.call(dashboard.penetration, 'recycleDau')) {
    errors.push('dashboard.penetration.recycleDau is forbidden; use recycleEntranceUv only');
  }

  if (!dashboard.analysisStatus || typeof dashboard.analysisStatus !== 'object') {
    errors.push('dashboard.analysisStatus must be an object');
  } else {
    for (const key of ['state', 'label', 'cadence', 'isRolling', 'weekStart', 'weekEnd', 'timezone']) {
      if (!(key in dashboard.analysisStatus)) errors.push(`dashboard.analysisStatus.${key} missing`);
    }
    if (!['rolling', 'final', 'unknown'].includes(dashboard.analysisStatus.state)) {
      errors.push(`dashboard.analysisStatus.state invalid: ${dashboard.analysisStatus.state}`);
    }
    if (dashboard.analysisStatus.timezone !== 'Asia/Shanghai') warnings.push(`dashboard.analysisStatus.timezone is ${dashboard.analysisStatus.timezone || '<missing>'}`);
  }

  if (!Array.isArray(dashboard.tiers) || dashboard.tiers.length < REQUIRED_TIERS.length) {
    errors.push('dashboard.tiers must contain 发展/孵化/种子');
  } else {
    const tierNames = dashboard.tiers.map((t) => t && t.tier).filter(Boolean);
    for (const tier of REQUIRED_TIERS) if (!tierNames.includes(tier)) errors.push(`dashboard.tiers missing ${tier}`);
    for (const tier of dashboard.tiers) {
      if (!tier || typeof tier !== 'object') continue;
      checkObjectFields(tier, ['tier', 'cur', 'delta', 'trend'], `dashboard.tiers[${tier.tier || '?'}]`, errors);
      if (tier.cur) {
        for (const key of COUNT_KEYS.concat(RATE_KEYS, ['categoryCount'])) {
          if (!(key in tier.cur)) errors.push(`dashboard.tiers[${tier.tier}].cur.${key} missing`);
        }
      }
    }
  }

  if (!Array.isArray(dashboard.categories) || !dashboard.categories.length) {
    errors.push('dashboard.categories must be a non-empty array');
  } else {
    dashboard.categories.forEach((category, index) => {
      const prefix = `dashboard.categories[${index}]`;
      checkObjectFields(category, ['category', 'tier', 'board', 'secondaryCategory', 'status', 'cur', 'delta', 'trend', 'anomalyScore'], prefix, errors);
      if (category && category.cur) {
        for (const key of COUNT_KEYS.concat(RATE_KEYS)) {
          if (!(key in category.cur)) errors.push(`${prefix}.cur.${key} missing`);
        }
      }
    });
  }

  if (!dashboard.insights || typeof dashboard.insights !== 'object') {
    errors.push('dashboard.insights must be an object');
  } else {
    for (const key of ['board', 'tiers', 'secondaryCategories', 'categories', 'category', 'monitor']) {
      if (!(key in dashboard.insights)) errors.push(`dashboard.insights.${key} missing`);
    }
  }

  return {
    ok: errors.length === 0,
    state: errors.length === 0 ? 'pass' : 'invalid',
    targetWeek: expectedWeek || dashboard.week || null,
    expectedVersion: versionToCheck,
    errors,
    warnings,
    summary: {
      week: dashboard.week,
      version: dashboard.version,
      tiers: Array.isArray(dashboard.tiers) ? dashboard.tiers.length : 0,
      categories: Array.isArray(dashboard.categories) ? dashboard.categories.length : 0,
      kpiCards: Array.isArray(dashboard.kpiCards) ? dashboard.kpiCards.length : 0,
    },
  };
}

function main() {
  const args = parseArgs();
  if (!args['dashboard-file']) throw new Error('Usage: check-dashboard-contract.js --dashboard-file <dashboard.json> [--target-weeks <weeks>] [--expected-version <version>] [--out <file>]');
  const dashboard = JSON.parse(fs.readFileSync(args['dashboard-file'], 'utf8'));
  const result = validateDashboardContract(dashboard, args);
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
  REQUIRED_TOP_LEVEL,
  REQUIRED_TIERS,
  validateDashboardContract,
};

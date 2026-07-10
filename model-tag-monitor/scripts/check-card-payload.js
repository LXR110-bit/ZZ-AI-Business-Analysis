#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { collectStringFindings } = require('./quality-text');

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

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol);
  } catch (_) {
    return false;
  }
}

function validateCardPayload(payload, options = {}) {
  const errors = [];
  const warnings = [];
  const expectedWeek = options.week || '';

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, state: 'invalid', errors: ['card payload must be an object'], warnings };
  }
  for (const key of ['version', 'week', 'week_range', 'total', 'watch_count', 'report_url', 'dashboard_url', 'top_anomalies']) {
    if (!(key in payload)) errors.push(`payload.${key} missing`);
  }
  if (expectedWeek && payload.week !== expectedWeek) errors.push(`payload.week mismatch: expected ${expectedWeek}, got ${payload.week || '<missing>'}`);
  if (!isHttpUrl(payload.report_url)) errors.push(`payload.report_url must be http(s): ${payload.report_url || '<missing>'}`);
  if (!isHttpUrl(payload.dashboard_url)) errors.push(`payload.dashboard_url must be http(s): ${payload.dashboard_url || '<missing>'}`);
  if (!Number.isFinite(Number(payload.total)) || Number(payload.total) < 0) errors.push(`payload.total must be a non-negative number: ${payload.total}`);
  if (!Number.isFinite(Number(payload.watch_count)) || Number(payload.watch_count) < 0) errors.push(`payload.watch_count must be a non-negative number: ${payload.watch_count}`);

  if (!Array.isArray(payload.top_anomalies)) {
    errors.push('payload.top_anomalies must be an array');
  } else {
    if (payload.top_anomalies.length > 3) errors.push(`payload.top_anomalies must contain at most 3 items, got ${payload.top_anomalies.length}`);
    payload.top_anomalies.forEach((item, index) => {
      const prefix = `payload.top_anomalies[${index}]`;
      if (!item || typeof item !== 'object') {
        errors.push(`${prefix} must be an object`);
        return;
      }
      for (const key of ['rank', 'name', 'metric_current', 'metric_prev', 'delta_label', 'hypothesis']) {
        if (!(key in item)) errors.push(`${prefix}.${key} missing`);
      }
      if (Number(item.rank) !== index + 1) warnings.push(`${prefix}.rank expected ${index + 1}, got ${item.rank}`);
      if (!String(item.name || '').trim()) errors.push(`${prefix}.name must be non-empty`);
      if (!String(item.hypothesis || '').trim()) errors.push(`${prefix}.hypothesis must be non-empty`);
    });
  }

  const forbidden = collectStringFindings(payload, {
    rootPath: 'payload',
    ignorePath: (path) => /(^|\.)(report_url|dashboard_url)$/.test(path),
  });
  if (forbidden.length) {
    for (const item of forbidden) {
      errors.push(`forbidden technical token(s) ${item.tokens.join(',')} at ${item.path}: ${item.snippet}`);
    }
  }

  return {
    ok: errors.length === 0,
    state: errors.length === 0 ? 'pass' : 'invalid',
    week: payload.week || null,
    forbiddenFindings: forbidden,
    errors,
    warnings,
  };
}

function main() {
  const args = parseArgs();
  if (!args.payload) throw new Error('Usage: check-card-payload.js --payload <weekly-card-payload.json> [--week <week>] [--out <file>]');
  const payload = JSON.parse(fs.readFileSync(args.payload, 'utf8'));
  const result = validateCardPayload(payload, args);
  result.payloadFile = args.payload;
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
  validateCardPayload,
};

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { collectStringFindings } = require('./quality-text');

const REQUIRED_LAYERS = ['overall', 'category', 'model', 'fulfillment'];
const LEVEL_LABELS = new Set(['大盘', '品类', '机型', '履约']);
const STATUS_VALUES = new Set(['pass', 'warn', 'failed']);
const EXTRA_TECHNICAL_PATTERNS = [
  { token: 'evidence_id', pattern: /\bevidence_?ids?\b/ig },
  { token: 'model_trace', pattern: /\bmodel_trace\b/ig },
  { token: 'current_value', pattern: /\bcurrent_value\b/ig },
  { token: 'previous_value', pattern: /\bprevious_value\b/ig },
  { token: 'wow_pct', pattern: /\bwow_pct\b|\bWoW\b/ig },
  { token: 'week_start_date', pattern: /\bweek_start_date\b/ig },
  { token: 'raw artifact file', pattern: /\b(?:insights|summary|final_status|validation_report|manifest|evidence_pack)_[\w-]*\.(?:json|md|csv|xlsx)\b|\b(?:insights|summary|final_status|validation_report|manifest|evidence_pack)\.(?:json|md|csv|xlsx)\b/ig },
  { token: 'board_metrics_feishu', pattern: /\bboard_metrics_feishu(?:\.csv)?\b/ig },
  { token: 'SQL', pattern: /\bSQL\b/g },
  { token: 'LLM', pattern: /\bLLM\b/g },
];

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

function compact(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function findExtraTechnicalTokens(text) {
  const value = String(text || '');
  const hits = [];
  for (const { token, pattern } of EXTRA_TECHNICAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) hits.push(token);
  }
  return [...new Set(hits)];
}

function collectExtraFindings(value, options = {}) {
  const findings = [];
  const ignorePath = typeof options.ignorePath === 'function' ? options.ignorePath : () => false;
  const maxSnippet = options.maxSnippet || 120;
  function visit(node, path) {
    if (ignorePath(path, node)) return;
    if (typeof node === 'string') {
      const tokens = findExtraTechnicalTokens(node);
      if (tokens.length) {
        const snippet = compact(node);
        findings.push({ path, tokens, snippet: snippet.length > maxSnippet ? `${snippet.slice(0, maxSnippet - 1)}…` : snippet });
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => visit(child, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${path}.${key}`);
  }
  visit(value, options.rootPath || '$');
  return findings;
}

function validateAiBusinessCardPayload(payload, options = {}) {
  const errors = [];
  const warnings = [];
  const expectedRunDt = options['run-dt'] || options.runDt || '';

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, state: 'invalid', errors: ['ai business card payload must be an object'], warnings };
  }

  for (const key of ['schema_version', 'card_type', 'dry_run_only', 'version', 'run_dt', 'title', 'subtitle', 'status_label', 'report_url', 'dashboard_url', 'four_layer_summary', 'top_findings', 'known_gaps', 'validation']) {
    if (!(key in payload)) errors.push(`payload.${key} missing`);
  }
  if (payload.schema_version !== 'ai_business_summary.v1') errors.push(`payload.schema_version must be ai_business_summary.v1: ${payload.schema_version || '<missing>'}`);
  if (payload.card_type !== 'ai_business_summary') errors.push(`payload.card_type must be ai_business_summary: ${payload.card_type || '<missing>'}`);
  if (payload.dry_run_only !== true) errors.push('payload.dry_run_only must be true for v1.5.5');
  if (expectedRunDt && payload.run_dt !== expectedRunDt) errors.push(`payload.run_dt mismatch: expected ${expectedRunDt}, got ${payload.run_dt || '<missing>'}`);
  if (!compact(payload.title)) errors.push('payload.title must be non-empty');
  if (!compact(payload.subtitle).includes('dry-run') && !compact(payload.subtitle).includes('outbox')) {
    warnings.push('payload.subtitle should make dry-run/outbox status explicit');
  }

  for (const key of ['report_url', 'dashboard_url']) {
    if (!isHttpUrl(payload[key])) errors.push(`payload.${key} must be http(s): ${payload[key] || '<missing>'}`);
    else if (/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(String(payload[key]))) warnings.push(`payload.${key} points to local address: ${payload[key]}`);
  }
  if (payload.zloop_url && !isHttpUrl(payload.zloop_url)) errors.push(`payload.zloop_url must be http(s) when provided: ${payload.zloop_url}`);

  if (!payload.four_layer_summary || typeof payload.four_layer_summary !== 'object' || Array.isArray(payload.four_layer_summary)) {
    errors.push('payload.four_layer_summary must be an object');
  } else {
    for (const layer of REQUIRED_LAYERS) {
      const value = compact(payload.four_layer_summary[layer]);
      if (!value) errors.push(`payload.four_layer_summary.${layer} missing or empty`);
      if (value.length > 220) warnings.push(`payload.four_layer_summary.${layer} is long (${value.length} chars)`);
    }
  }

  if (!Array.isArray(payload.top_findings)) {
    errors.push('payload.top_findings must be an array');
  } else {
    if (payload.top_findings.length > 6) errors.push(`payload.top_findings must contain at most 6 items, got ${payload.top_findings.length}`);
    payload.top_findings.forEach((item, index) => {
      const prefix = `payload.top_findings[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      for (const key of ['rank', 'level_label', 'entity', 'metric_label', 'direction_label', 'severity_label', 'finding', 'evidence', 'action']) {
        if (!(key in item)) errors.push(`${prefix}.${key} missing`);
      }
      if (Number(item.rank) !== index + 1) warnings.push(`${prefix}.rank expected ${index + 1}, got ${item.rank}`);
      if (!LEVEL_LABELS.has(item.level_label)) errors.push(`${prefix}.level_label must be one of 大盘/品类/机型/履约`);
      for (const key of ['entity', 'metric_label', 'finding', 'evidence', 'action']) {
        if (!compact(item[key])) errors.push(`${prefix}.${key} must be non-empty`);
      }
    });
  }

  if (!Array.isArray(payload.action_items)) {
    warnings.push('payload.action_items missing or not an array');
  } else if (payload.action_items.length > 4) {
    errors.push(`payload.action_items must contain at most 4 items, got ${payload.action_items.length}`);
  }

  if (!Array.isArray(payload.known_gaps)) {
    errors.push('payload.known_gaps must be an array');
  } else {
    if (!payload.known_gaps.length) errors.push('payload.known_gaps must explicitly state known_gap status, even when none');
    payload.known_gaps.forEach((item, index) => {
      const text = typeof item === 'string' ? item : item && item.text;
      if (!compact(text)) errors.push(`payload.known_gaps[${index}].text must be non-empty`);
    });
  }

  if (!payload.validation || typeof payload.validation !== 'object' || Array.isArray(payload.validation)) {
    errors.push('payload.validation must be an object');
  } else {
    for (const key of ['overall_status', 'data_status', 'analysis_status']) {
      const value = compact(payload.validation[key]).toLowerCase();
      if (!STATUS_VALUES.has(value)) errors.push(`payload.validation.${key} must be pass|warn|failed: ${payload.validation[key] || '<missing>'}`);
    }
    if (payload.validation.push_allowed === true) errors.push('payload.validation.push_allowed must not be true for v1.5.5 dry-run');
    if (payload.validation.publish_allowed === true) errors.push('payload.validation.publish_allowed must not be true for v1.5.5 dry-run');
  }

  const ignorePath = (fieldPath) => /(^|\.)(report_url|dashboard_url|zloop_url)$/.test(fieldPath)
    || /^payload\.source_files/.test(fieldPath)
    || /^payload\.schema_version$/.test(fieldPath)
    || /^payload\.card_type$/.test(fieldPath)
    || /^payload\.generated_at$/.test(fieldPath);
  const forbidden = [
    ...collectStringFindings(payload, { rootPath: 'payload', ignorePath }),
    ...collectExtraFindings(payload, { rootPath: 'payload', ignorePath }),
  ];
  if (forbidden.length) {
    for (const item of forbidden) {
      errors.push(`forbidden technical token(s) ${item.tokens.join(',')} at ${item.path}: ${item.snippet}`);
    }
  }

  return {
    ok: errors.length === 0,
    state: errors.length === 0 ? 'pass' : 'invalid',
    run_dt: payload.run_dt || null,
    forbiddenFindings: forbidden,
    errors,
    warnings,
  };
}

function main() {
  const args = parseArgs();
  if (!args.payload) throw new Error('Usage: check-ai-business-card-payload.js --payload <ai-business-card-payload.json> [--run-dt YYYY-MM-DD] [--out <file>]');
  const payload = JSON.parse(fs.readFileSync(args.payload, 'utf8'));
  const result = validateAiBusinessCardPayload(payload, args);
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
  validateAiBusinessCardPayload,
  findExtraTechnicalTokens,
};

#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseCsvLine, normalizeWeek } = require('./sync-board-metrics-from-feishu');

const REQUIRED_COLUMNS = ['统计周', 'APP日均DAU', '回收入口UV'];
const OPTIONAL_COLUMNS = ['聚合回收渗透率', '聚合回收真实渗透率'];
const FORBIDDEN_COLUMNS = ['回收DAU', '回收日均DAU', 'recycleDau'];

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

function parseTargetWeeks(value) {
  return String(value || '').split(',').map((w) => w.trim()).filter(Boolean);
}

function lastTargetWeek(value) {
  const weeks = parseTargetWeeks(value);
  return weeks.length ? weeks[weeks.length - 1] : '';
}

function cleanNumber(value) {
  const raw = String(value || '').trim().replace(/,/g, '');
  if (!raw || raw === '-' || raw === '/') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function validateBoardMetricsCache(csvText, options = {}) {
  const errors = [];
  const warnings = [];
  const lines = String(csvText || '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { ok: false, state: 'missing', errors: ['board metrics CSV is empty'], warnings };

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  for (const col of REQUIRED_COLUMNS) if (!headers.includes(col)) errors.push(`required column missing: ${col}`);
  for (const col of FORBIDDEN_COLUMNS) if (headers.includes(col)) errors.push(`forbidden column present: ${col}`);
  const allowed = new Set(REQUIRED_COLUMNS.concat(OPTIONAL_COLUMNS));
  for (const col of headers) if (!allowed.has(col)) warnings.push(`unexpected column ignored by dashboard sync: ${col}`);

  const index = new Map(headers.map((h, i) => [h, i]));
  const rows = [];
  const requiredWeeks = options.requiredWeeks && options.requiredWeeks.length
    ? options.requiredWeeks
    : (options.targetWeek ? [options.targetWeek] : []);
  const requiredWeekSet = new Set(requiredWeeks);
  const shouldValidateAllRows = requiredWeekSet.size === 0;
  const skippedBlankWeeks = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const week = normalizeWeek(cells[index.get('统计周')]);
    if (!/^\d{4}-W\d{2}$/.test(week)) continue;
    const appDau = cleanNumber(cells[index.get('APP日均DAU')]);
    const recycleEntranceUv = cleanNumber(cells[index.get('回收入口UV')]);
    const shouldValidateRow = shouldValidateAllRows || requiredWeekSet.has(week);
    if (shouldValidateRow) {
      if (appDau == null || appDau <= 0) errors.push(`${week} APP日均DAU must be positive, got ${cells[index.get('APP日均DAU')] || '<empty>'}`);
      if (recycleEntranceUv == null || recycleEntranceUv <= 0) errors.push(`${week} 回收入口UV must be positive, got ${cells[index.get('回收入口UV')] || '<empty>'}`);
    } else if (appDau == null && recycleEntranceUv == null) {
      skippedBlankWeeks.push(week);
    }
    rows.push({ week, appDau, recycleEntranceUv });
  }
  if (!rows.length) errors.push('no valid week rows in board metrics CSV');

  const weekSet = new Set(rows.map((row) => row.week));
  for (const week of requiredWeeks) if (!weekSet.has(week)) errors.push(`required target week missing from board metrics CSV: ${week}`);
  if (skippedBlankWeeks.length) warnings.push(`skipped non-target blank week row(s): ${skippedBlankWeeks.join(',')}`);

  return {
    ok: errors.length === 0,
    state: errors.length === 0 ? 'pass' : 'invalid',
    headers,
    rows,
    errors,
    warnings,
  };
}

function main() {
  const args = parseArgs();
  const file = args.file || args.out || process.env.BOARD_METRICS_OUT;
  if (!file) throw new Error('Usage: check-board-metrics-cache.js --file <board_metrics_feishu.csv> [--target-weeks <weeks>] [--out <report.json>]');
  if (!fs.existsSync(file)) throw new Error(`board metrics CSV not found: ${file}`);
  const targetWeeks = parseTargetWeeks(args['target-weeks'] || process.env.TARGET_WEEKS || '');
  const targetWeek = args['target-week'] || (targetWeeks.length ? targetWeeks[targetWeeks.length - 1] : lastTargetWeek(''));
  const result = validateBoardMetricsCache(fs.readFileSync(file, 'utf8'), { targetWeek, requiredWeeks: targetWeeks });
  result.file = file;
  result.targetWeek = targetWeek || null;
  const text = JSON.stringify(result, null, 2);
  if (args.out && args.out !== file) fs.writeFileSync(args.out, `${text}\n`, 'utf8');
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
  FORBIDDEN_COLUMNS,
  REQUIRED_COLUMNS,
  validateBoardMetricsCache,
};

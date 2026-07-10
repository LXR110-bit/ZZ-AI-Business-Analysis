#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { isoWeekToRange } = require('../src/week-utils');

const REQUIRED_OUTPUTS = [
  'category_daily_avg',
  'category_fulfill_daily_avg',
  'category_fulfill_summary',
  'category_summary',
  'model_daily_avg',
  'model_summary',
];
const COVERAGE_OUTPUTS = ['category_daily_avg', 'model_daily_avg'];

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

function toShanghaiDateString(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function dateToUTC(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid yyyy-mm-dd date: ${dateStr}`);
  return d;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = dateToUTC(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
}

function compareDate(a, b) {
  return a.localeCompare(b);
}

function minDate(a, b) {
  return compareDate(a, b) <= 0 ? a : b;
}

function diffDays(start, end) {
  return Math.round((dateToUTC(end) - dateToUTC(start)) / 86400000);
}

function dateToISOWeek(dateStr) {
  const s = String(dateStr || '').trim();
  if (!s) return '';
  const d = dateToUTC(s);
  const dayOfWeek = d.getUTCDay() || 7;
  const weekThursday = new Date(d.getTime() + (4 - dayOfWeek) * 86400000);
  const year = weekThursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((weekThursday - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

function expectedCoverage(targetWeek, now) {
  const range = isoWeekToRange(targetWeek);
  const today = toShanghaiDateString(now);
  const yesterday = addDays(today, -1);
  const expectedDataEnd = minDate(yesterday, range.sunday);
  const expectedDays = compareDate(expectedDataEnd, range.monday) < 0
    ? 0
    : diffDays(range.monday, expectedDataEnd) + 1;
  return {
    targetWeek,
    weekStart: range.monday,
    weekEnd: range.sunday,
    today,
    expectedDataEnd,
    expectedDays,
  };
}

function lastTargetWeek(targetWeeks) {
  const weeks = String(targetWeeks || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean);
  if (!weeks.length) throw new Error('TARGET_WEEKS is empty');
  return weeks[weeks.length - 1];
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPathInside(parent, child) {
  const p = fs.realpathSync(parent);
  const c = fs.realpathSync(child);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function parseDateTime(value) {
  const d = new Date(String(value || ''));
  return Number.isNaN(d.getTime()) ? null : d;
}

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function pickIndex(headers, names) {
  for (const name of names) {
    const idx = headers.findIndex((h) => String(h).trim().toLowerCase() === name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

async function scanCoverageCsv(file, targetWeek, weekStart) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let headers = null;
  let startIdx = -1;
  let weekIdx = -1;
  let dayCntIdx = -1;
  let rowCount = 0;
  let invalidWeekStartRows = 0;
  const dayCounts = new Set();
  for await (const rawLine of rl) {
    let line = rawLine;
    if (!line.trim()) continue;
    if (!headers) {
      line = line.replace(/^﻿/, '');
      headers = splitCsvLine(line).map((h) => h.trim());
      startIdx = pickIndex(headers, ['week_start_date', '周开始', '开始日期']);
      weekIdx = pickIndex(headers, ['week', '统计周', '周次']);
      dayCntIdx = pickIndex(headers, ['day_cnt', '已收到天数']);
      continue;
    }
    const values = splitCsvLine(line);
    const startDate = startIdx >= 0 ? String(values[startIdx] || '').trim() : '';
    const week = weekIdx >= 0 ? String(values[weekIdx] || '').trim() : '';
    const inferredWeek = startDate ? dateToISOWeek(startDate) : '';
    if (week !== targetWeek && inferredWeek !== targetWeek) continue;
    rowCount += 1;
    if (startDate && startDate !== weekStart) invalidWeekStartRows += 1;
    const rawDayCnt = dayCntIdx >= 0 ? String(values[dayCntIdx] || '').trim() : '';
    const dayCnt = Number(rawDayCnt);
    if (Number.isFinite(dayCnt)) dayCounts.add(dayCnt);
    else dayCounts.add(NaN);
  }
  return {
    path: file,
    rowCount,
    dayCounts: [...dayCounts].map((n) => (Number.isNaN(n) ? null : n)).sort((a, b) => Number(a) - Number(b)),
    invalidWeekStartRows,
  };
}

function outputPathFrom(active, manifest, key) {
  const activePath = active && active.outputs && active.outputs[key];
  const manifestPath = manifest && manifest.outputs && manifest.outputs[key] && manifest.outputs[key].path;
  return activePath || manifestPath || null;
}

function buildBaseResult({ importDir, targetWeeks, runId, startedAt, now }) {
  const targetWeek = lastTargetWeek(targetWeeks);
  const coverage = expectedCoverage(targetWeek, now);
  return {
    ok: false,
    state: 'unknown',
    targetWeek,
    importDir,
    runId: runId || null,
    startedAt: startedAt || null,
    ...coverage,
    observed: {},
    errors: [],
    warnings: [],
  };
}

async function validateDailyImportCoverage(options) {
  const importDir = path.resolve(options.importDir || process.env.IMPORT_DIR || path.join(__dirname, '..', 'data', 'imports'));
  const targetWeeks = options.targetWeeks || process.env.TARGET_WEEKS || '';
  const result = buildBaseResult({ importDir, targetWeeks, runId: options.runId, startedAt: options.startedAt, now: options.now });

  if (result.expectedDays < 0 || result.expectedDays > 7) {
    result.state = 'invalid';
    result.errors.push(`expectedDays out of range: ${result.expectedDays}`);
    return result;
  }
  if (result.expectedDays === 0) {
    result.state = 'not_started';
    result.errors.push(`${result.targetWeek} has no expected T-1 data yet`);
    return result;
  }

  const activePath = path.join(importDir, 'active.json');
  if (!fs.existsSync(activePath)) {
    result.state = 'missing';
    result.errors.push(`active.json not found: ${activePath}`);
    return result;
  }
  result.activePath = activePath;
  const active = parseJsonFile(activePath);

  if (options.runId && active.run_id !== options.runId) {
    result.state = 'stale';
    result.errors.push(`active.json run_id mismatch: expected ${options.runId}, got ${active.run_id || '<missing>'}`);
  }
  if (options.startedAt) {
    const generatedAt = parseDateTime(active.generated_at);
    const started = parseDateTime(options.startedAt);
    if (!generatedAt || !started || generatedAt < started) {
      result.state = 'stale';
      result.errors.push(`active.json generated_at is stale: generated_at=${active.generated_at || '<missing>'}, started_at=${options.startedAt}`);
    }
  }

  const manifestPath = active.manifest ? path.resolve(active.manifest) : null;
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    result.state = result.state === 'unknown' ? 'missing' : result.state;
    result.errors.push(`manifest not found: ${active.manifest || '<missing>'}`);
    return result;
  }
  result.manifestPath = manifestPath;
  if (!isPathInside(importDir, manifestPath)) {
    result.state = 'invalid';
    result.errors.push(`manifest is outside IMPORT_DIR: ${manifestPath}`);
  }
  const manifest = parseJsonFile(manifestPath);
  if (options.runId && manifest.run_id !== options.runId) {
    result.state = result.state === 'unknown' ? 'stale' : result.state;
    result.errors.push(`manifest run_id mismatch: expected ${options.runId}, got ${manifest.run_id || '<missing>'}`);
  }

  for (const key of REQUIRED_OUTPUTS) {
    const outputPath = outputPathFrom(active, manifest, key);
    if (!outputPath) {
      result.state = result.state === 'unknown' ? 'missing' : result.state;
      result.errors.push(`required output missing in manifest/active: ${key}`);
      continue;
    }
    const resolved = path.resolve(outputPath);
    if (!fs.existsSync(resolved)) {
      result.state = result.state === 'unknown' ? 'missing' : result.state;
      result.errors.push(`required output file not found for ${key}: ${resolved}`);
      continue;
    }
    if (!isPathInside(importDir, resolved)) {
      result.state = 'invalid';
      result.errors.push(`required output file is outside IMPORT_DIR for ${key}: ${resolved}`);
    }
  }

  for (const key of COVERAGE_OUTPUTS) {
    const outputPath = outputPathFrom(active, manifest, key);
    if (!outputPath || !fs.existsSync(path.resolve(outputPath))) continue;
    const observed = await scanCoverageCsv(path.resolve(outputPath), result.targetWeek, result.weekStart);
    result.observed[key] = observed;
    if (observed.rowCount <= 0) {
      result.state = result.state === 'unknown' ? 'missing' : result.state;
      result.errors.push(`${key} has no rows for ${result.targetWeek}`);
      continue;
    }
    if (observed.invalidWeekStartRows > 0) {
      result.state = 'invalid';
      result.errors.push(`${key} has ${observed.invalidWeekStartRows} rows with week_start_date != ${result.weekStart}`);
    }
    if (observed.dayCounts.length !== 1 || observed.dayCounts[0] == null) {
      result.state = 'invalid';
      result.errors.push(`${key} day_cnt must be unique for ${result.targetWeek}; got ${JSON.stringify(observed.dayCounts)}`);
      continue;
    }
    const actualDays = Number(observed.dayCounts[0]);
    if (actualDays !== result.expectedDays) {
      result.state = actualDays < result.expectedDays ? 'incomplete' : 'invalid';
      result.errors.push(`${key} day_cnt mismatch for ${result.targetWeek}: expected ${result.expectedDays}, got ${actualDays}`);
    }
  }

  if (!result.errors.length) {
    result.ok = true;
    result.state = 'complete';
    result.message = `${result.targetWeek} imports cover ${result.expectedDays} day(s), through ${result.expectedDataEnd}`;
  } else {
    result.ok = false;
    if (result.state === 'unknown') result.state = 'invalid';
    result.message = result.errors.join('; ');
  }
  return result;
}

async function main() {
  const args = parseArgs();
  const result = await validateDailyImportCoverage({
    importDir: args['import-dir'],
    targetWeeks: args['target-weeks'],
    runId: args['run-id'],
    startedAt: args['started-at'],
    now: args.now,
  });
  const text = JSON.stringify(result, null, 2);
  if (args.out) fs.writeFileSync(args.out, `${text}\n`, 'utf8');
  process.stdout.write(`${text}\n`);
  process.exit(result.ok ? 0 : 10);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = {
  REQUIRED_OUTPUTS,
  COVERAGE_OUTPUTS,
  addDays,
  dateToISOWeek,
  expectedCoverage,
  scanCoverageCsv,
  splitCsvLine,
  validateDailyImportCoverage,
};

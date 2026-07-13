#!/usr/bin/env node
'use strict';

const { isoWeekToRange } = require('../src/week-utils');

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

function dateToISOWeek(dateStr) {
  const d = dateToUTC(dateStr);
  const dayOfWeek = d.getUTCDay() || 7;
  const weekThursday = new Date(d.getTime() + (4 - dayOfWeek) * 86400000);
  const year = weekThursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const weekNum = Math.ceil(((weekThursday - jan1) / 86400000 + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

function normalizeKeepWeeks(value) {
  const n = Number(value || 10);
  if (!Number.isInteger(n) || n < 1 || n > 53) throw new Error(`Invalid keepWeeks: ${value}`);
  return n;
}

function deriveTargetWeeks(options = {}) {
  const keepWeeks = normalizeKeepWeeks(options.keepWeeks || process.env.KEEP_WEEKS || 10);
  const today = toShanghaiDateString(options.now);
  // 06:50 cron runs before today's data exists. The target week must be the
  // ISO week that contains yesterday: Monday finalizes the previous week,
  // Tuesday-Sunday roll the current week forward day by day.
  const dataDate = addDays(today, -1);
  const targetWeek = dateToISOWeek(dataDate);
  const targetMonday = isoWeekToRange(targetWeek).monday;
  const weeks = [];
  for (let i = keepWeeks - 1; i >= 0; i -= 1) {
    weeks.push(dateToISOWeek(addDays(targetMonday, -7 * i)));
  }
  return weeks;
}

function main() {
  const args = parseArgs();
  const weeks = deriveTargetWeeks({
    keepWeeks: args['keep-weeks'] || process.env.KEEP_WEEKS,
    now: args.now || process.env.NOW,
  });
  process.stdout.write(`${weeks.join(',')}\n`);
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
  dateToISOWeek,
  deriveTargetWeeks,
};

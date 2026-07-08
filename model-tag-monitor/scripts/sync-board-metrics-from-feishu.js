#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_URL = 'https://zhuanspirit.feishu.cn/wiki/BVG1wCawniHIC5kn9eacgmP3nwX?from=from_copylink';
const DEFAULT_SHEET = '大盘数据（周日均）';
const DEFAULT_RANGE = 'A1:G80';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === ',' && !quoted) {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function normalizeWeek(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const full = s.match(/^(\d{4})[-_]?W(\d{1,2})$/i);
  if (full) return `${full[1]}-W${String(Number(full[2])).padStart(2, '0')}`;
  const short = s.match(/^(\d{2})[-_]?W(\d{1,2})$/i);
  if (short) return `20${short[1]}-W${String(Number(short[2])).padStart(2, '0')}`;
  return s;
}

function cleanNumber(value) {
  const s = String(value || '').trim().replace(/,/g, '');
  if (!s || s === '-' || s === '/') return '';
  return s;
}

function extractBoardRows(annotatedCsv) {
  const rawLines = String(annotatedCsv || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[row=\d+\]\s*/, ''))
    .filter((line) => line.trim());
  if (!rawLines.length) return [];
  const headers = parseCsvLine(rawLines[0]);
  const index = new Map(headers.map((h, i) => [String(h).trim(), i]));
  const col = (...names) => {
    for (const name of names) if (index.has(name)) return index.get(name);
    return -1;
  };
  const weekIdx = col('周次', '统计周', 'week');
  const appIdx = col('APP日均 DAU', 'APP日均DAU', 'APP DAU', 'appDau');
  const entranceIdx = col('回收入口 UV', '回收入口UV', 'recycleEntranceUv');
  const penetrationIdx = col('聚合回收渗透率', 'penetrationRate');
  const realPenetrationIdx = col('聚合回收真实渗透率', 'realPenetrationRate');
  if (weekIdx < 0 || appIdx < 0 || entranceIdx < 0) {
    throw new Error(`missing required columns: headers=${headers.join('|')}`);
  }

  const rows = [];
  for (const line of rawLines.slice(1)) {
    const cells = parseCsvLine(line);
    const week = normalizeWeek(cells[weekIdx]);
    if (!/^\d{4}-W\d{2}$/.test(week)) continue;
    rows.push({
      week,
      appDau: cleanNumber(cells[appIdx]),
      recycleEntranceUv: cleanNumber(cells[entranceIdx]),
      penetrationRate: penetrationIdx >= 0 ? String(cells[penetrationIdx] || '').trim() : '',
      realPenetrationRate: realPenetrationIdx >= 0 ? String(cells[realPenetrationIdx] || '').trim() : '',
    });
  }
  return rows;
}

function toCsv(rows) {
  const lines = ['统计周,APP日均DAU,回收入口UV,聚合回收渗透率,聚合回收真实渗透率'];
  for (const row of rows) {
    lines.push([row.week, row.appDau, row.recycleEntranceUv, row.penetrationRate, row.realPenetrationRate].join(','));
  }
  return `${lines.join('\n')}\n`;
}

function runLarkCsvGet({ url, sheetName, range, larkCli }) {
  const env = {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  };
  const args = ['sheets', '+csv-get', '--url', url, '--sheet-name', sheetName, '--range', range, '--max-chars', '200000', '--format', 'json'];
  const result = spawnSync(larkCli, args, { encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`lark-cli failed status=${result.status}: ${result.stderr || result.stdout}`);
  }
  const payload = JSON.parse(result.stdout);
  if (payload.ok === false) throw new Error(`lark-cli returned error: ${JSON.stringify(payload.error || payload)}`);
  return payload.data && payload.data.annotated_csv;
}

function main() {
  const args = parseArgs(process.argv);
  const url = args.url || process.env.BOARD_METRICS_FEISHU_URL || DEFAULT_URL;
  const sheetName = args.sheetName || process.env.BOARD_METRICS_FEISHU_SHEET || DEFAULT_SHEET;
  const range = args.range || process.env.BOARD_METRICS_FEISHU_RANGE || DEFAULT_RANGE;
  const out = args.out || process.env.BOARD_METRICS_OUT || path.join(process.env.IMPORT_DIR || path.join(__dirname, '..', 'data', 'imports'), 'board_metrics_feishu.csv');
  const larkCli = args.larkCli || process.env.LARK_CLI_BIN || 'lark-cli';

  const annotatedCsv = runLarkCsvGet({ url, sheetName, range, larkCli });
  const rows = extractBoardRows(annotatedCsv);
  if (!rows.length) throw new Error('no board metric rows extracted from Feishu sheet');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, toCsv(rows), 'utf8');
  process.stdout.write(JSON.stringify({ ok: true, out, rows: rows.length, weeks: rows.map((r) => r.week), url, sheetName }, null, 2));
  process.stdout.write('\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[sync-board-metrics-from-feishu] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseCsvLine, normalizeWeek, extractBoardRows, toCsv };

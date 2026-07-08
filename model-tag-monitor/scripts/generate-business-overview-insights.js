#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const store = require('../src/store');

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const apiBase = String(arg('api-base', process.env.API_BASE || 'http://127.0.0.1:8848')).replace(/\/+$/, '');
const dashboardFile = arg('dashboard-file', process.env.BUSINESS_OVERVIEW_DASHBOARD_FILE || '');
const outName = arg('out-name', process.env.BUSINESS_OVERVIEW_CACHE_NAME || 'business-overview-insights.json');
const strategyFile = arg('strategy-file', process.env.BUSINESS_OVERVIEW_STRATEGY_FILE || '');
const timeoutMs = Number(arg('timeout-ms', process.env.BUSINESS_OVERVIEW_AI_TIMEOUT_MS || '240000'));
const aiEnabled = process.env.BUSINESS_OVERVIEW_AI_ENABLED === '1';
const repoRoot = path.resolve(__dirname, '..', '..');
const schemaPath = path.join(__dirname, 'business-overview-insights.schema.json');
const STRATEGY_WARNING = '未配置上周策略/预判，暂无法检核兑现';
const DEFAULT_CODEX_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'CODEX_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

async function getJson(apiPath, timeout = 300000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(`${apiBase}${apiPath}`, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadDashboard() {
  if (!dashboardFile) return getJson('/api/dashboard', 300000);
  const payload = JSON.parse(fs.readFileSync(dashboardFile, 'utf8'));
  if (payload && payload.current && typeof payload.current === 'object') return payload.current;
  return payload;
}

function readStrategy() {
  if (strategyFile && fs.existsSync(strategyFile)) return fs.readFileSync(strategyFile, 'utf8').trim();
  return String(process.env.BUSINESS_OVERVIEW_LAST_WEEK_STRATEGIES || '').trim();
}

function hashInput(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function formatWan(v) {
  const n = Number(v) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(2)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

function summarizeDashboard(dashboard) {
  const categories = (dashboard.categories || [])
    .slice()
    .sort((a, b) => ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0))
    .slice(0, 20)
    .map((c) => ({
      category: c.category,
      tier: c.tier,
      board: c.board || c.secondaryCategory || '',
      status: c.status,
      cur: {
        conditionUv: c.cur && (c.cur.conditionUv ?? c.cur.jkuv),
        evaUv: c.cur && c.cur.evaUv,
        orderUv: c.cur && c.cur.orderUv,
        shipCnt: c.cur && c.cur.shipCnt,
        dealCnt: c.cur && c.cur.dealCnt,
        gmv: c.cur && c.cur.gmv,
        orderRate: c.cur && c.cur.orderRate,
        dealRate: c.cur && c.cur.dealRate,
      },
      delta: c.delta || null,
      anomalyScore: c.anomalyScore || 0,
    }));

  return {
    version: dashboard.version,
    week: dashboard.week,
    prevWeek: dashboard.prevWeek || '',
    weekRange: dashboard.weekRange || '',
    syncedAt: dashboard.syncedAt || '',
    board: dashboard.board || {},
    kpiCards: dashboard.kpiCards || [],
    tiers: dashboard.tiers || [],
    existingInsights: dashboard.insights || {},
    topCategories: categories,
  };
}

function fallbackInsights(dashboard, warnings, extraWarning) {
  const rawExisting = dashboard.insights && typeof dashboard.insights === 'object' ? dashboard.insights : {};
  // `/api/dashboard` may already contain a cached AI insight for the same week.
  // When AI is disabled or fails, do not re-label stale AI copy as deterministic.
  const existing = isGeneratedInsight(rawExisting) ? {} : rawExisting;
  const fallbackTiers = Object.fromEntries((dashboard.tiers || []).map((t) => {
    const cur = t.cur || {};
    return [t.tier, `${t.tier}层覆盖 ${cur.categoryCount || 0} 个在售品类，成交GMV ${formatWan(cur.gmv)}。`];
  }));
  const tiers = { ...fallbackTiers, ...((existing.tiers && typeof existing.tiers === 'object') ? existing.tiers : {}) };
  const topTier = (dashboard.tiers || []).slice().sort((a, b) => ((b.cur && b.cur.gmv) || 0) - ((a.cur && a.cur.gmv) || 0))[0];
  const board = dashboard.board && dashboard.board.cur ? dashboard.board.cur : {};
  return {
    version: '1.3.0',
    week: dashboard.week,
    prevWeek: dashboard.prevWeek || '',
    generatedAt: new Date().toISOString(),
    generatedBy: 'business_overview_deterministic',
    mode: 'deterministic',
    inputHash: hashInput(summarizeDashboard(dashboard)),
    insights: {
      board: existing.board || `${dashboard.week}：成交GMV ${formatWan(board.gmv)}，${topTier ? `${topTier.tier}层贡献最高` : '分层数据待补齐'}。`,
      tiers,
      category: existing.category || '按当前层识别品类异动原因、建议关注指标和需要复盘的核心/波动品类。',
      monitor: existing.monitor || '监测页可继续查看机型级异动明细。',
    },
    warnings: extraWarning ? warnings.concat(extraWarning) : warnings,
  };
}


function isReusableAiCache(cache) {
  return Boolean(
    cache
    && typeof cache === 'object'
    && cache.week
    && cache.mode === 'ai'
    && cache.generatedBy === 'codex-cli-read-only'
    && cache.insights
    && typeof cache.insights === 'object'
  );
}

function isGeneratedInsight(insights) {
  if (!insights || typeof insights !== 'object') return false;
  return Boolean(insights.generatedBy || insights.mode || insights.inputHash || insights.generatedAt);
}

function buildPrompt(summary, strategy, warnings) {
  return [
    '你是转转回收经营分析助手。请基于输入的 dashboard 周日均数据，输出给数据看板展示的经营分析洞察。',
    '要求：',
    '1. 只输出 JSON，必须符合 output schema。',
    '2. insights.board 是大盘一句话结论，覆盖风险等级、链路形态、量价判断。',
    '3. insights.tiers 必须至少包含 发展/孵化/种子 三个 key，每个 value 是对应层概览。',
    '4. insights.category 是品类简述概览，指出重点关注品类和原因。',
    '5. insights.monitor 是机型/监测页提示。',
    '6. 如果上周策略为空，warnings 必须包含“未配置上周策略/预判，暂无法检核兑现”。',
    '7. 不要编造未给出的策略、竞对或行情事实；不确定时标注待补充。',
    '',
    '<last_week_strategies>',
    strategy || '',
    '</last_week_strategies>',
    '<required_warnings>',
    JSON.stringify(warnings, null, 2),
    '</required_warnings>',
    '<dashboard_summary>',
    JSON.stringify(summary, null, 2),
    '</dashboard_summary>',
  ].join('\n');
}

function parseJsonText(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('empty Codex output');
  try { return JSON.parse(raw); } catch (_) { /* try fenced/body extraction */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return JSON.parse(fenced[1]);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('Codex output is not JSON');
}

function normalizeAiCache(aiResult, dashboard, summary, warnings) {
  if (!aiResult || typeof aiResult !== 'object' || !aiResult.insights) {
    throw new Error('AI result missing insights');
  }
  const insights = aiResult.insights;
  for (const key of ['board', 'category', 'monitor']) {
    if (typeof insights[key] !== 'string' || !insights[key].trim()) throw new Error(`AI insights.${key} missing`);
  }
  if (!insights.tiers || typeof insights.tiers !== 'object') throw new Error('AI insights.tiers missing');
  for (const tier of ['发展', '孵化', '种子']) {
    if (typeof insights.tiers[tier] !== 'string' || !insights.tiers[tier].trim()) {
      throw new Error(`AI insights.tiers.${tier} missing`);
    }
  }
  const aiWarnings = Array.isArray(aiResult.warnings) ? aiResult.warnings.filter(Boolean).map(String) : [];
  const mergedWarnings = [...new Set(warnings.concat(aiWarnings))];
  return {
    version: '1.3.0',
    week: dashboard.week,
    prevWeek: dashboard.prevWeek || '',
    generatedAt: new Date().toISOString(),
    generatedBy: 'codex-cli-read-only',
    mode: 'ai',
    inputHash: hashInput(summary),
    insights,
    warnings: mergedWarnings,
  };
}

function buildCodexEnv(source = process.env) {
  const allow = new Set(DEFAULT_CODEX_ENV_ALLOWLIST);
  String(source.BUSINESS_OVERVIEW_CODEX_ENV_ALLOW || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((key) => allow.add(key));

  const out = {};
  for (const key of allow) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}



function summarizeErrorMessage(error, maxLen = 240) {
  const raw = String((error && error.message) || error || '').replace(/\u001b\[[0-9;]*m/g, '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('user'))
    .filter((line) => !line.startsWith('<dashboard_summary>'))
    .filter((line) => !line.startsWith('{'))
    .filter((line) => !line.startsWith('"'));
  let msg = lines.find((line) => line.includes('invalid_json_schema'))
    || lines.find((line) => line.startsWith('ERROR:'))
    || lines.find((line) => line.includes('codex exec failed'))
    || lines[0]
    || raw;
  msg = msg.replace(/\s+/g, ' ').trim();
  if (msg.length > maxLen) msg = `${msg.slice(0, maxLen - 1)}…`;
  return msg || 'unknown error';
}

function runCodex(prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'business-overview-'));
  const lastMessage = path.join(dir, 'last-message.json');
  const args = [
    'exec',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--skip-git-repo-check',
    '--cd', repoRoot,
    '--output-schema', schemaPath,
    '--output-last-message', lastMessage,
    '-',
  ];
  const proc = spawnSync('codex', args, {
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: buildCodexEnv(process.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) throw new Error(`codex exec failed rc=${proc.status}: ${String(proc.stderr || proc.stdout).slice(0, 1000)}`);
  if (!fs.existsSync(lastMessage)) throw new Error('codex did not write --output-last-message');
  return parseJsonText(fs.readFileSync(lastMessage, 'utf8'));
}

async function main() {
  const dashboard = await loadDashboard();
  const strategy = readStrategy();
  const warnings = strategy ? [] : [STRATEGY_WARNING];
  const summary = summarizeDashboard(dashboard);

  let cache;
  if (!aiEnabled) {
    const existingCache = store.readJSON(outName, null);
    if (isReusableAiCache(existingCache)) {
      console.log(JSON.stringify({
        ok: true,
        mode: existingCache.mode,
        aiEnabled: false,
        preserved: true,
        out: store.filePath(outName),
        week: existingCache.week,
        dashboardWeek: dashboard.week,
        warnings: existingCache.warnings || [],
      }, null, 2));
      return;
    }
    cache = fallbackInsights(dashboard, warnings);
    store.writeJSON(outName, cache);
    console.log(JSON.stringify({ ok: true, mode: cache.mode, aiEnabled: false, preserved: false, out: store.filePath(outName), week: cache.week, warnings: cache.warnings }, null, 2));
    return;
  }

  try {
    const aiResult = runCodex(buildPrompt(summary, strategy, warnings));
    cache = normalizeAiCache(aiResult, dashboard, summary, warnings);
  } catch (e) {
    cache = fallbackInsights(dashboard, warnings, `AI生成失败，已降级为确定性洞察：${summarizeErrorMessage(e)}`);
  }
  store.writeJSON(outName, cache);
  console.log(JSON.stringify({ ok: true, mode: cache.mode, out: store.filePath(outName), week: cache.week, warnings: cache.warnings }, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[business-overview] failed:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = {
  buildCodexEnv,
  fallbackInsights,
  isGeneratedInsight,
  isReusableAiCache,
  summarizeDashboard,
  summarizeErrorMessage,
};

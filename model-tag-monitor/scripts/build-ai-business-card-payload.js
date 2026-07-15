#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const APP_VERSION = require('../package.json').version;

const LEVEL_LABELS = {
  overall: '大盘',
  category: '品类',
  model: '机型',
  fulfillment: '履约',
};

const SEVERITY_LABELS = {
  high: '高',
  medium: '中',
  low: '低',
  watch: '观察',
};

const DIRECTION_LABELS = {
  up: '上升',
  down: '下降',
  flat: '持平',
  mixed: '分化',
};

const METRIC_LABELS = {
  gmv: '成交金额',
  dealgmv: '成交金额',
  deal_gmv: '成交金额',
  amount: '成交金额',
  dealcnt: '成交量',
  deal_cnt: '成交量',
  ordercnt: '下单量',
  order_cnt: '下单量',
  shipcnt: '发货量',
  ship_cnt: '发货量',
  returnrate: '退回率',
  return_rate: '退回率',
  orderrate: '下单率',
  order_rate: '下单率',
  shiprate: '发货率',
  ship_rate: '发货率',
  dealrate: '成交率',
  deal_rate: '成交率',
  evarate: '估价完成率',
  eva_rate: '估价完成率',
  price: '均价',
  avgprice: '均价',
  avg_price: '均价',
  uv: '访问量',
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

function readJson(file, required = false) {
  if (!file) {
    if (required) throw new Error('missing required json file argument');
    return null;
  }
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`JSON parse failed for ${file}: ${err.message}`);
  }
}

function readText(file) {
  if (!file) return '';
  return fs.readFileSync(file, 'utf8');
}

function compactText(value, fallback = '') {
  return String(value == null ? fallback : value)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncate(value, max = 160) {
  const text = compactText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item != null);
  return [value];
}

function normalizeMetric(value) {
  const raw = compactText(value, '指标');
  const key = raw.replace(/[\s-]+/g, '_').toLowerCase();
  return METRIC_LABELS[key] || METRIC_LABELS[key.replace(/_/g, '')] || raw
    .replace(/\bgmv\b/ig, '成交金额')
    .replace(/\borderRate\b/g, '下单率')
    .replace(/\bdealRate\b/g, '成交率')
    .replace(/\bshipRate\b/g, '发货率')
    .replace(/\breturnRate\b/g, '退回率')
    .replace(/\bdealCnt\b/g, '成交量')
    .replace(/\bshipCnt\b/g, '发货量')
    .replace(/\borderCnt\b/g, '下单量');
}

function localizeGap(value) {
  let text = compactText(value);
  if (!text) return '';
  text = text
    .replace(/board_metrics_feishu\.csv/ig, '大盘流量指标')
    .replace(/board_metrics_feishu/ig, '大盘流量指标')
    .replace(/server_publish/ig, '服务器发布')
    .replace(/push_allowed/ig, '正式推送')
    .replace(/publish_allowed/ig, '正式发布')
    .replace(/out_of_scope/ig, '本阶段暂不启用')
    .replace(/pending/ig, '待接入')
    .replace(/\bgmv\b/ig, '成交金额')
    .replace(/\borderRate\b/g, '下单率')
    .replace(/\bdealCnt\b/g, '成交量')
    .replace(/\bshipCnt\b/g, '发货量')
    .replace(/\bshipRate\b/g, '发货率')
    .replace(/\bdealRate\b/g, '成交率')
    .replace(/\.json\b/ig, '')
    .replace(/\.csv\b/ig, '')
    .replace(/\.xlsx\b/ig, '')
    .replace(/\.md\b/ig, '');
  return truncate(text, 140);
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 10) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/\.00$/, '').replace(/0$/, '');
}

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const pct = Math.abs(n) <= 2 ? n * 100 : n;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function formatEvidence(insight) {
  const evidence = insight && typeof insight === 'object' ? insight.evidence || {} : {};
  const bits = [];
  if (evidence.current_value != null) bits.push(`当前 ${formatNumber(evidence.current_value)}`);
  if (evidence.previous_value != null) bits.push(`上期 ${formatNumber(evidence.previous_value)}`);
  if (evidence.wow_pct != null) bits.push(`环比 ${formatPercent(evidence.wow_pct)}`);
  if (!bits.length && evidence.delta != null) bits.push(`变化 ${formatNumber(evidence.delta)}`);
  return bits.length ? bits.join('，') : '证据已在上游产物中记录';
}

function severityRank(value) {
  return { high: 0, medium: 1, low: 2, watch: 3 }[value] ?? 4;
}

function allInsights(insights) {
  return [
    ...asArray(insights.key_findings).map((item) => ({ ...item, bucket: 'finding' })),
    ...asArray(insights.risks).map((item) => ({ ...item, bucket: 'risk' })),
    ...asArray(insights.opportunities).map((item) => ({ ...item, bucket: 'opportunity' })),
  ].filter((item) => item && typeof item === 'object');
}

function primaryAction(insight) {
  const direct = asArray(insight.recommended_actions).map(compactText).find(Boolean);
  if (direct) return direct;
  return '进入对应看板复盘证据，并补齐业务确认';
}

function primaryCause(insight) {
  const direct = asArray(insight.likely_causes).map(compactText).find(Boolean);
  if (direct) return direct;
  if (insight.rule_status === 'pending_business_confirmation') return '原因待业务确认';
  return '数据波动已触发关注';
}

function buildFinding(insight, index) {
  const level = LEVEL_LABELS[insight.level] ? insight.level : 'overall';
  const metric = normalizeMetric(insight.metric);
  const entity = compactText(insight.entity, LEVEL_LABELS[level]);
  const direction = DIRECTION_LABELS[insight.direction] || compactText(insight.direction, '波动');
  const severity = SEVERITY_LABELS[insight.severity] || compactText(insight.severity, '观察');
  const cause = primaryCause(insight);
  return {
    rank: index + 1,
    level,
    level_label: LEVEL_LABELS[level],
    entity: truncate(entity, 36),
    metric_label: truncate(metric, 24),
    direction_label: direction,
    severity_label: severity,
    finding: truncate(`${entity} ${metric}${direction}，${cause}`, 120),
    evidence: truncate(formatEvidence(insight), 90),
    action: truncate(primaryAction(insight), 100),
  };
}

function extractMarkdownLayerSummary(markdown, level) {
  if (!markdown) return '';
  const aliases = {
    overall: ['大盘', '整体', '总览'],
    category: ['品类'],
    model: ['机型'],
    fulfillment: ['履约', '发货', '回收履约'],
  }[level] || [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!/^#{1,4}\s+/.test(line)) continue;
    if (!aliases.some((alias) => line.includes(alias))) continue;
    const buf = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (/^#{1,4}\s+/.test(next)) break;
      if (next) buf.push(next.replace(/^[-*]\s*/, ''));
      if (buf.join('').length >= 80) break;
    }
    const text = compactText(buf.join(' '));
    if (text) return text;
  }
  return '';
}

function buildLayerSummary(level, insights, markdown) {
  const explicit = insights.four_layer_summary && insights.four_layer_summary[level]
    || insights.card_summary && insights.card_summary[level]
    || insights.layer_summary && insights.layer_summary[level];
  if (explicit) return truncate(explicit, 180);

  const md = extractMarkdownLayerSummary(markdown, level);
  if (md) return truncate(md, 180);

  if (level === 'overall' && insights.summary) return truncate(insights.summary, 180);

  const candidates = allInsights(insights)
    .filter((item) => item.level === level)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
  if (candidates.length) {
    const item = candidates[0];
    return truncate(`${compactText(item.entity, LEVEL_LABELS[level])} ${normalizeMetric(item.metric)}${DIRECTION_LABELS[item.direction] || '波动'}，${primaryAction(item)}`, 180);
  }
  return `本次未识别到明确${LEVEL_LABELS[level]}异常，保持日常观察。`;
}

function buildKnownGaps(insights, finalStatus, validationReport) {
  const raw = [
    ...asArray(insights.known_gaps),
    ...asArray(insights.data_quality_notes).filter((item) => /gap|缺口|待接入|pending|out_of_scope/i.test(String(item))),
    ...asArray(finalStatus && finalStatus.known_gaps),
    ...asArray(finalStatus && finalStatus.reasons).filter((item) => /gap|缺口|待接入|pending|out_of_scope|push|publish/i.test(String(item))),
    ...asArray(validationReport && validationReport.known_gaps),
  ];
  const seen = new Set();
  const gaps = [];
  for (const item of raw) {
    const text = localizeGap(typeof item === 'string' ? item : item && (item.text || item.reason || item.name || JSON.stringify(item)));
    if (!text || seen.has(text)) continue;
    seen.add(text);
    gaps.push({ rank: gaps.length + 1, text });
    if (gaps.length >= 4) break;
  }
  if (!gaps.length) gaps.push({ rank: 1, text: '暂无新增已知缺口；本版本仍仅 dry-run 落 outbox，不正式推送。' });
  return gaps;
}

function buildActions(insights) {
  const fromActions = asArray(insights.actions)
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      rank: index + 1,
      priority: compactText(item.priority, 'watch'),
      owner_hint: truncate(item.owner_hint || '业务负责人', 24),
      action: truncate(item.action || '复盘异常证据', 100),
      reason: truncate(item.reason || 'AI 摘要建议', 100),
    }));
  if (fromActions.length) return fromActions.slice(0, 4).map((item, index) => ({ ...item, rank: index + 1 }));

  return allInsights(insights)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, 3)
    .map((item, index) => ({
      rank: index + 1,
      priority: item.severity === 'high' ? 'P0' : item.severity === 'medium' ? 'P1' : 'watch',
      owner_hint: LEVEL_LABELS[item.level] || '业务负责人',
      action: truncate(primaryAction(item), 100),
      reason: truncate(`${compactText(item.entity, LEVEL_LABELS[item.level] || '对象')} ${normalizeMetric(item.metric)}${DIRECTION_LABELS[item.direction] || '波动'}`, 100),
    }));
}

function statusLabel(finalStatus) {
  const status = compactText(finalStatus && finalStatus.overall_status, 'warn').toLowerCase();
  if (status === 'pass') return '校验通过（仅 dry-run）';
  if (status === 'failed') return '校验失败（禁止推送）';
  return '校验告警（仅 dry-run）';
}

function statusColor(finalStatus) {
  const status = compactText(finalStatus && finalStatus.overall_status, 'warn').toLowerCase();
  if (status === 'pass') return 'green';
  if (status === 'failed') return 'red';
  return 'orange';
}

function buildAiBusinessCardPayload({ insights, summaryMarkdown = '', finalStatus = null, validationReport = null, options = {} }) {
  if (!insights || typeof insights !== 'object' || Array.isArray(insights)) {
    throw new Error('insights must be an object');
  }
  const runDt = options.runDt || insights.run_dt || (finalStatus && finalStatus.run_dt) || '';
  const runId = insights.run_id || (finalStatus && finalStatus.run_id) || '';
  const reportUrl = options.reportUrl || options.dashboardUrl || 'http://47.84.94.234:8848/?tab=dashboard';
  const dashboardUrl = options.dashboardUrl || reportUrl;
  const findings = allInsights(insights)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, Number(options.maxFindings || 6))
    .map(buildFinding);
  const actionItems = buildActions(insights);

  return {
    schema_version: 'ai_business_summary.v1',
    card_type: 'ai_business_summary',
    dry_run_only: true,
    version: options.version || APP_VERSION,
    run_id: runId,
    run_dt: runDt,
    generated_at: options.generatedAt || new Date().toISOString(),
    title: options.title || `AI 小万经营摘要 · ${runDt || '最新'}`,
    subtitle: 'v1.5.5 服务器读取 zloop 产物，当前仅 dry-run/outbox',
    status_label: statusLabel(finalStatus),
    status_color: statusColor(finalStatus),
    report_url: reportUrl,
    dashboard_url: dashboardUrl,
    zloop_url: options.zloopUrl || '',
    four_layer_summary: {
      overall: buildLayerSummary('overall', insights, summaryMarkdown),
      category: buildLayerSummary('category', insights, summaryMarkdown),
      model: buildLayerSummary('model', insights, summaryMarkdown),
      fulfillment: buildLayerSummary('fulfillment', insights, summaryMarkdown),
    },
    top_findings: findings,
    action_items: actionItems,
    known_gaps: buildKnownGaps(insights, finalStatus, validationReport),
    data_quality_notes: asArray(insights.data_quality_notes).map((item) => localizeGap(item)).filter(Boolean).slice(0, 4),
    validation: {
      overall_status: compactText(finalStatus && finalStatus.overall_status, 'warn'),
      data_status: compactText(finalStatus && finalStatus.data_status, 'warn'),
      analysis_status: compactText(finalStatus && finalStatus.analysis_status, 'warn'),
      publish_allowed: Boolean(finalStatus && finalStatus.publish_allowed),
      push_allowed: Boolean(finalStatus && finalStatus.push_allowed),
    },
    source_files: {
      insights: true,
      summary_md: Boolean(summaryMarkdown),
      final_status: Boolean(finalStatus),
      validation_report: Boolean(validationReport),
    },
  };
}

function main() {
  const args = parseArgs();
  if (!args.insights || !args.out) {
    throw new Error([
      'Usage: build-ai-business-card-payload.js --insights <insights.json> --out <payload.json>',
      '  [--summary <summary.md>] [--final-status <final_status.json>] [--validation-report <validation_report.json>]',
      '  [--report-url <url>] [--dashboard-url <url>] [--zloop-url <url>] [--run-dt YYYY-MM-DD]',
    ].join('\n'));
  }
  const payload = buildAiBusinessCardPayload({
    insights: readJson(args.insights, true),
    summaryMarkdown: readText(args.summary),
    finalStatus: readJson(args['final-status']),
    validationReport: readJson(args['validation-report']),
    options: {
      runDt: args['run-dt'],
      reportUrl: args['report-url'],
      dashboardUrl: args['dashboard-url'],
      zloopUrl: args['zloop-url'],
      title: args.title,
      generatedAt: args['generated-at'],
      maxFindings: args['max-findings'],
    },
  });
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, out: args.out, run_dt: payload.run_dt, findings: payload.top_findings.length, gaps: payload.known_gaps.length }, null, 2));
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
  buildAiBusinessCardPayload,
  normalizeMetric,
  localizeGap,
};

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildAiBusinessCardPayload } = require('../scripts/build-ai-business-card-payload');
const { validateAiBusinessCardPayload } = require('../scripts/check-ai-business-card-payload');

function fixtureInsights(override = {}) {
  return {
    run_id: 'run-20260715',
    run_dt: '2026-07-15',
    summary: '大盘成交金额小幅上升，但履约侧仍需观察。',
    key_findings: [
      {
        level: 'overall',
        entity: '聚合回收',
        metric: 'gmv',
        direction: 'up',
        severity: 'medium',
        evidence_ids: ['ev-overall-1'],
        evidence: { current_value: 1250000, previous_value: 1100000, wow_pct: 0.136, source: 'category_summary' },
        likely_causes: ['核心品类贡献提升'],
        recommended_actions: ['复盘核心品类贡献结构'],
        confidence: 'medium',
        rule_status: 'confirmed',
        model_trace: { mode: 'daily', primary: 'GLM-5.2', reviewer: 'DeepSeek V4 Pro' },
      },
      {
        level: 'category',
        entity: '手机',
        metric: 'dealCnt',
        direction: 'up',
        severity: 'high',
        evidence_ids: ['ev-category-1'],
        evidence: { current_value: 5600, previous_value: 5000, wow_pct: 0.12, source: 'category_daily_avg' },
        likely_causes: ['高价值品类拉动成交'],
        recommended_actions: ['检查手机品类活动和价格带变化'],
        confidence: 'high',
        rule_status: 'confirmed',
        model_trace: { mode: 'daily', primary: 'GLM-5.2', reviewer: 'DeepSeek V4 Pro' },
      },
      {
        level: 'model',
        entity: 'iPhone 15 Pro',
        metric: 'orderRate',
        direction: 'down',
        severity: 'medium',
        evidence_ids: ['ev-model-1'],
        evidence: { current_value: 0.102, previous_value: 0.121, wow_pct: -0.157, source: 'model_daily_avg' },
        likely_causes: ['部分机型下单承接转弱'],
        recommended_actions: ['复核机型页报价与转化链路'],
        confidence: 'medium',
        rule_status: 'pending_business_confirmation',
        model_trace: { mode: 'daily', primary: 'GLM-5.2', reviewer: 'DeepSeek V4 Pro' },
      },
      {
        level: 'fulfillment',
        entity: '邮寄履约',
        metric: 'shipRate',
        direction: 'mixed',
        severity: 'watch',
        evidence_ids: ['ev-fulfillment-1'],
        evidence: { current_value: 0.72, previous_value: 0.7, wow_pct: 0.028, source: 'category_fulfill_daily_avg' },
        likely_causes: ['不同履约方式表现分化'],
        recommended_actions: ['对比邮寄与到店履约断点'],
        confidence: 'medium',
        rule_status: 'confirmed',
        model_trace: { mode: 'daily', primary: 'GLM-5.2', reviewer: 'DeepSeek V4 Pro' },
      },
    ],
    risks: [],
    opportunities: [],
    actions: [{ owner_hint: '品类运营', action: '优先复盘手机品类成交结构', reason: '手机贡献了主要增量', priority: 'P1' }],
    data_quality_notes: ['board_metrics_feishu.csv pending'],
    known_gaps: ['board_metrics_feishu.csv pending', 'server_publish out_of_scope'],
    ...override,
  };
}

function finalStatus(override = {}) {
  return {
    run_dt: '2026-07-15',
    overall_status: 'warn',
    data_status: 'warn',
    analysis_status: 'pass',
    publish_allowed: false,
    push_allowed: false,
    reasons: ['server_publish out_of_scope'],
    known_gaps: ['board_metrics_feishu.csv pending'],
    ...override,
  };
}

test('buildAiBusinessCardPayload creates dry-run payload without raw technical leakage', () => {
  const payload = buildAiBusinessCardPayload({
    insights: fixtureInsights(),
    summaryMarkdown: '# 大盘\n大盘成交金额改善。\n# 品类\n手机品类贡献增量。\n# 机型\niPhone 机型下单率待复核。\n# 履约\n邮寄履约保持观察。',
    finalStatus: finalStatus(),
    validationReport: { known_gaps: ['board_metrics_feishu.csv pending'] },
    options: {
      reportUrl: 'https://example.com/report',
      dashboardUrl: 'https://example.com/dashboard',
      generatedAt: '2026-07-15T08:00:00.000Z',
    },
  });

  assert.equal(payload.dry_run_only, true);
  assert.equal(payload.four_layer_summary.overall, '大盘成交金额改善。');
  assert.match(payload.top_findings[0].metric_label, /成交量|成交金额|下单率|发货率/);
  assert.doesNotMatch(JSON.stringify(payload), /board_metrics_feishu\.csv|model_trace|evidence_ids|orderRate|dealCnt|shipRate|\bgmv\b/);

  const result = validateAiBusinessCardPayload(payload, { runDt: '2026-07-15' });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('validateAiBusinessCardPayload rejects missing layer, unsafe push flag and technical tokens', () => {
  const payload = buildAiBusinessCardPayload({
    insights: fixtureInsights(),
    finalStatus: finalStatus(),
    options: { reportUrl: 'https://example.com/report', dashboardUrl: 'https://example.com/dashboard' },
  });
  payload.validation.push_allowed = true;
  payload.four_layer_summary.model = '';
  payload.top_findings[0].finding = 'orderRate 下降 1pct，evidence_id=ev-1';

  const result = validateAiBusinessCardPayload(payload, { runDt: '2026-07-15' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /four_layer_summary\.model/);
  assert.match(result.errors.join('\n'), /push_allowed/);
  assert.match(result.errors.join('\n'), /orderRate|pct|evidence_id/);
});

test('builder and checker CLIs read local zloop artifacts and write payload/quality files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-business-card-'));
  const insightsFile = path.join(tmp, 'insights.json');
  const summaryFile = path.join(tmp, 'summary.md');
  const statusFile = path.join(tmp, 'final_status.json');
  const validationFile = path.join(tmp, 'validation_report.json');
  const payloadFile = path.join(tmp, 'payload.json');
  const qualityFile = path.join(tmp, 'quality.json');

  fs.writeFileSync(insightsFile, JSON.stringify(fixtureInsights(), null, 2), 'utf8');
  fs.writeFileSync(summaryFile, '# 大盘\n大盘成交金额改善。\n# 品类\n手机品类贡献增量。\n# 机型\niPhone 机型下单率待复核。\n# 履约\n邮寄履约保持观察。\n', 'utf8');
  fs.writeFileSync(statusFile, JSON.stringify(finalStatus(), null, 2), 'utf8');
  fs.writeFileSync(validationFile, JSON.stringify({ known_gaps: ['board_metrics_feishu.csv pending'] }, null, 2), 'utf8');

  const build = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/build-ai-business-card-payload.js'),
    '--insights', insightsFile,
    '--summary', summaryFile,
    '--final-status', statusFile,
    '--validation-report', validationFile,
    '--report-url', 'https://example.com/report',
    '--dashboard-url', 'https://example.com/dashboard',
    '--out', payloadFile,
    '--generated-at', '2026-07-15T08:00:00.000Z',
  ], { encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  assert.equal(fs.existsSync(payloadFile), true);

  const check = spawnSync(process.execPath, [
    path.join(__dirname, '../scripts/check-ai-business-card-payload.js'),
    '--payload', payloadFile,
    '--run-dt', '2026-07-15',
    '--out', qualityFile,
  ], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const quality = JSON.parse(fs.readFileSync(qualityFile, 'utf8'));
  assert.equal(quality.ok, true, quality.errors.join('\n'));
});

test('server dry-run sidecar copies zloop artifacts and renders ai_business_summary outbox only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-business-sidecar-'));
  const sourceDir = path.join(tmp, 'source');
  const workDir = path.join(tmp, 'work');
  const outboxDir = path.join(tmp, 'outbox');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'insights.json'), JSON.stringify(fixtureInsights(), null, 2), 'utf8');
  fs.writeFileSync(path.join(sourceDir, 'summary.md'), '# 大盘\n大盘成交金额改善。\n# 品类\n手机品类贡献增量。\n# 机型\niPhone 机型下单率待复核。\n# 履约\n邮寄履约保持观察。\n', 'utf8');
  fs.writeFileSync(path.join(sourceDir, 'final_status.json'), JSON.stringify(finalStatus(), null, 2), 'utf8');

  const script = path.join(__dirname, '../scripts/render-ai-business-summary-dry-run.sh');
  const result = spawnSync(script, [
    '--source-dir', sourceDir,
    '--run-dt', '2026-07-15',
    '--report-url', 'https://example.com/report',
    '--dashboard-url', 'https://example.com/dashboard',
    '--work-dir', workDir,
    '--outbox-dir', outboxDir,
  ], {
    encoding: 'utf8',
    env: { ...process.env, RUN_ID: 'test-run', FEISHU_REPO_DIR: path.join(__dirname, '../..') },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(workDir, 'artifacts', 'insights.json')), true);
  assert.equal(fs.existsSync(path.join(workDir, 'ai-business-card-payload-test-run.json')), true);
  assert.equal(fs.existsSync(path.join(workDir, 'ai-business-card-quality-test-run.json')), true);
  const outboxFiles = fs.readdirSync(outboxDir).filter((name) => name.endsWith('.json'));
  assert.equal(outboxFiles.length, 1);
  const outbox = JSON.parse(fs.readFileSync(path.join(outboxDir, outboxFiles[0]), 'utf8'));
  assert.equal(outbox.reason, 'dry_run');
  assert.equal(outbox.message.msg_type, 'interactive');
});

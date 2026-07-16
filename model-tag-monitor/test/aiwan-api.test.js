'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const PORT = 18851;

function httpJson(method, pathAndQuery, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload || {});
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathAndQuery,
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http json timeout')));
    req.end(body);
  });
}

function httpGet(pathAndQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathAndQuery, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http get timeout')));
  });
}

async function waitReady(child, maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (child.exitCode !== null) throw new Error(`server exited before ready: code=${child.exitCode} signal=${child.signalCode || ''}`);
    try {
      const r = await httpGet('/api/health');
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready within ' + maxMs + 'ms');
}

async function verifyAccess() {
  const r = await httpJson('POST', '/api/access/verify', { name: 'AI小万测试', code: 'TEST_ACCESS_CODE_20260715' });
  assert.equal(r.status, 200, r.body);
  return r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
}

function displayInsightsFixture() {
  return {
    board: 'AIWAN 大盘概览：机况UV增长但下单率下降0.80个百分点，优先下钻下单UV到发货数链路。',
    tiers: {
      发展: '发展层基于当前 dashboard 聚合指标判断，成交GMV承压但成交订单稳定，先看内存条下单率。',
      孵化: '孵化层当前样本较少，成交GMV波动需要结合二级类目继续观察。',
      种子: '种子层低基数品类较多，先按数据风险维持观察，不放大经营动作。',
    },
    secondaryCategories: {
      电脑办公: '电脑办公二级类目由内存条贡献主要成交GMV，需观察下单率和发货数承接。',
    },
    categories: {
      内存条: '内存条成交GMV下降，估价UV到下单UV转化偏弱，建议先查下单链路。',
    },
    category: 'AIWAN 全局品类概览：当前重点关注内存条，其他品类等待更多数据。',
    monitor: 'AIWAN 监测说明：validate 已完成，机型层本次没有独立输出，保留监测页结构化明细。',
    warnings: ['AIWAN display smoke warning'],
  };
}

function writeAiwanFixture(dir) {
  const weeks = ['2026-W27', '2026-W28'];
  const categoryRows = [
    { week: '2026-W27', category: '内存条', jkuv: 1000, conditionUv: 1000, evaUv: 600, evaCnt: 600, orderUv: 180, orderCnt: 180, shipCnt: 120, signCnt: 110, qcCnt: 100, dealCnt: 90, returnCnt: 5, gmv: 900000, daysReceived: 7 },
    { week: '2026-W28', category: '内存条', jkuv: 1000, conditionUv: 1000, evaUv: 560, evaCnt: 560, orderUv: 120, orderCnt: 120, shipCnt: 80, signCnt: 75, qcCnt: 70, dealCnt: 60, returnCnt: 4, gmv: 600000, daysReceived: 7 },
  ];
  fs.writeFileSync(path.join(dir, 'category-cache.json'), JSON.stringify({ syncedAt: '2026-07-15T00:00:00.000Z', weeks, categories: ['内存条'], rows: categoryRows }, null, 2));
  fs.writeFileSync(path.join(dir, 'category-taxonomy.json'), JSON.stringify({ syncedAt: '2026-07-15T00:00:00.000Z', rows: [{ category: '内存条', tier: '发展', board: '电脑办公', status: '在售', confidence: '高', lastWeekGmv: 900000 }] }, null, 2));
  fs.writeFileSync(path.join(dir, 'cache.json'), JSON.stringify({ syncedAt: '2026-07-15T00:00:00.000Z', categories: ['内存条'], weeks, rows: [] }, null, 2));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({ poolTopN: 20, waveThreshold: 0.1, trendWeeks: 3, minEvaUv: 15 }, null, 2));
}

test('/api/aiwan/read + /api/aiwan/write provide stage state bridge', async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwan-api-test-'));
  writeAiwanFixture(tmpDataDir);
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: tmpDataDir, ACCESS_CODE: 'TEST_ACCESS_CODE_20260715' };
  delete env.PROXY_UPSTREAM;
  const child = spawn(process.execPath, ['src/server.js'], { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  try {
    await waitReady(child);
    const headers = {};

    const missing = await httpJson('POST', '/api/aiwan/read', { run_id: '2026-W28-weekly', week: '2026-W28', stage: 'process', include: ['previous_stage_outputs'] }, headers);
    assert.equal(missing.status, 409, missing.body);
    assert.deepEqual(missing.json.missing_previous_stages, ['read']);

    const readWrite = await httpJson('POST', '/api/aiwan/write', { run_id: '2026-W28-weekly', week: '2026-W28', stage: 'read', status: 'success', output_type: 'read_context', payload: { history_weeks: ['2026-W27', '2026-W28'] } }, headers);
    assert.equal(readWrite.status, 200, readWrite.body);
    assert.equal(readWrite.json.revision, 1);

    const processRead = await httpJson('POST', '/api/aiwan/read', { run_id: '2026-W28-weekly', week: '2026-W28', stage: 'process', include: ['run_meta', 'metric_snapshot', 'candidate_anomalies', 'previous_stage_outputs'] }, headers);
    assert.equal(processRead.status, 200, processRead.body);
    assert.equal(processRead.json.previous_outputs.read.payload.history_weeks.length, 2);
    assert.equal(processRead.json.context.metric_snapshot.week, '2026-W28');
    assert.ok(Array.isArray(processRead.json.context.candidate_anomalies));

    const processWrite1 = await httpJson('POST', '/api/aiwan/write', { run_id: '2026-W28-weekly', week: '2026-W28', stage: 'process', status: 'success', payload: { candidate_count: 1 } }, headers);
    assert.equal(processWrite1.status, 200, processWrite1.body);
    const processWrite2 = await httpJson('POST', '/api/aiwan/write', { run_id: '2026-W28-weekly', week: '2026-W28', stage: 'process', status: 'success', payload: { candidate_count: 2 }, rerun: true, rerun_reason: 'manual test' }, headers);
    assert.equal(processWrite2.status, 200, processWrite2.body);
    assert.equal(processWrite2.json.revision, 2, '重复写同一阶段采用覆盖 + revision 递增策略');

    const stageFile = path.join(tmpDataDir, 'aiwan-runs', '2026-W28-weekly', 'process.json');
    const stagePayload = JSON.parse(fs.readFileSync(stageFile, 'utf8'));
    assert.equal(stagePayload.payload.candidate_count, 2);
    assert.equal(stagePayload.overwritten_previous_revision, true);

    await httpJson('POST', '/api/aiwan/write', { run_id: '2026-W28-weekly', week: '2026-W28', stage: 'analyze', status: 'success', output_type: 'analysis_result', payload: { findings_count: 1 } }, headers);
    const validateWrite = await httpJson('POST', '/api/aiwan/write', {
      run_id: '2026-W28-weekly',
      week: '2026-W28',
      stage: 'validate',
      status: 'warn',
      output_type: 'validation_result',
      payload: {
        processed_data: { status: 'success', week: '2026-W28' },
        analysis_result: {
          status: 'warn',
          week: '2026-W28',
          display_contract: 'dashboard-business-overview-insights-map/v1',
          display_insights: displayInsightsFixture(),
          findings: [],
        },
        validation_result: { overall_status: 'warn', checks: { smoke: true }, warnings: ['validate warning'], publish_allowed: true },
      },
      warnings: ['record warning'],
    }, headers);
    assert.equal(validateWrite.status, 200, validateWrite.body);
    assert.equal(validateWrite.json.run.status, 'success');
    assert.equal(validateWrite.json.run.overall_status, 'warn');
    assert.deepEqual(validateWrite.json.bridge, {
      ok: true,
      cache_name: 'business-overview-insights-2026-W28.json',
      mode: 'aiwan_loop',
      generatedBy: 'aiwan-v1.6.2-loop',
    });

    const aiwanCache = JSON.parse(fs.readFileSync(path.join(tmpDataDir, 'business-overview-insights-2026-W28.json'), 'utf8'));
    assert.equal(aiwanCache.mode, 'aiwan_loop');
    assert.equal(aiwanCache.generatedBy, 'aiwan-v1.6.2-loop');
    assert.equal(aiwanCache.insights.board, displayInsightsFixture().board);
    assert.equal(aiwanCache.insights.tiers.发展, displayInsightsFixture().tiers.发展);
    assert.equal(aiwanCache.insights.secondaryCategories.电脑办公, displayInsightsFixture().secondaryCategories.电脑办公);
    assert.equal(aiwanCache.insights.categories.内存条, displayInsightsFixture().categories.内存条);

    const validateRead = await httpJson('POST', '/api/aiwan/read', { run_id: '2026-W28-weekly', week: '2026-W28', stage: 'validate', include: ['run_meta', 'previous_stage_outputs'] }, headers);
    assert.equal(validateRead.status, 200, validateRead.body);
    assert.equal(validateRead.json.context.run_meta.stages.validate.output_type, 'validation_result');
    assert.equal(validateRead.json.context.run_meta.status, 'success');
    assert.equal(validateRead.json.context.run_meta.overall_status, 'warn');
    assert.equal(validateRead.json.current_output.output_type, 'validation_result');
    assert.equal(validateRead.json.current_output.payload.validation_result.publish_allowed, true);

    const dashboardWithoutCookie = await httpGet('/api/dashboard');
    assert.equal(dashboardWithoutCookie.status, 401, '页面业务 API 仍保留门禁，只有 aiwan API 放行');

    const cookie = await verifyAccess();
    const dashboard = await httpGet('/api/dashboard?week=2026-W28', { Cookie: cookie });
    assert.equal(dashboard.status, 200, dashboard.body);
    const dashboardJson = JSON.parse(dashboard.body);
    assert.equal(dashboardJson.insights.board, displayInsightsFixture().board);
    assert.equal(dashboardJson.insights.mode, 'aiwan_loop');
    assert.equal(dashboardJson.insights.generatedBy, 'aiwan-v1.6.2-loop');
    assert.equal(dashboardJson.insights.categories.内存条, displayInsightsFixture().categories.内存条);
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0) {
      console.error('[server stdout]', stdout);
      console.error('[server stderr]', stderr);
    }
  }
});

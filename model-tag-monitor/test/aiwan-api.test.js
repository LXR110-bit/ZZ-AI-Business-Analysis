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

    const publicRead = await httpJson('POST', '/api/aiwan/read', { run_id: 'public-aiwan-test', week: '2026-W28', stage: 'read', include: ['run_meta', 'rules'] });
    assert.equal(publicRead.status, 200, publicRead.body);
    assert.equal(publicRead.json.run_id, 'public-aiwan-test');

    const publicWrite = await httpJson('POST', '/api/aiwan/write', { run_id: 'public-aiwan-test', week: '2026-W28', stage: 'read', status: 'success', payload: { authenticated_via: 'public-aiwan-bridge' } });
    assert.equal(publicWrite.status, 200, publicWrite.body);
    assert.equal(publicWrite.json.output.payload.authenticated_via, 'public-aiwan-bridge');

    const publicDashboard = await httpGet('/api/dashboard');
    assert.equal(publicDashboard.status, 401, '页面业务 API 仍保留门禁，只有 aiwan API 放行');

    const cookie = await verifyAccess();
    const headers = { Cookie: cookie };

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

    const dashboard = await httpGet('/api/dashboard', headers);
    assert.equal(dashboard.status, 200, '旧 /api/dashboard 不受 aiwan API 影响');
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

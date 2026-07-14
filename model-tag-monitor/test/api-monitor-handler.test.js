/**
 * /api/monitor handler 集成测试（数据源模式）
 *
 * 主控铁律教训 7：本地绿 ≠ 生产绿，必须核对代码路径
 *
 * 覆盖：不带 PROXY_UPSTREAM 起 server（生产同款路径），验证：
 *   1) 响应头 Cache-Control 三连（no-store / no-cache / must-revalidate）
 *   2) 响应头 ETag / Last-Modified 已剥
 *   3) body 的每个 pool/watchList item.trend 归一化到位（5 项 rate、值合法）
 *
 * 为什么单开这个文件：既有 compose-dashboard.test.js 全是纯函数测试，
 * mock 数据源模式请求这一维只能靠 HTTP 层集成测试兜底。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const PORT = 18849; // 避开常用端口
const RATE_KEYS = ['dealRate', 'evaRate', 'orderRate', 'returnRate', 'shipRate'];

function httpGet(pathAndQuery, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathAndQuery, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http get timeout')));
  });
}


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

async function waitReady(child, maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before ready: code=${child.exitCode} signal=${child.signalCode || ''}`);
    }
    try {
      const r = await httpGet('/api/health');
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready within ' + maxMs + 'ms');
}

async function verifyAccess() {
  const r = await httpJson('POST', '/api/access/verify', { name: '测试用户', code: 'TEST_ACCESS_CODE_20260714' });
  assert.equal(r.status, 200, r.body);
  const setCookie = r.headers['set-cookie'];
  assert.ok(Array.isArray(setCookie) && setCookie.length, '门禁校验后必须设置 cookie');
  return setCookie.map((c) => c.split(';')[0]).join('; ');
}

function writeTinyMonitorFixture(dir) {
  const weeks = ['2026-W23', '2026-W24', '2026-W25', '2026-W26', '2026-W27'];
  const rows = weeks.map((week, i) => {
    const jkuv = 1000 + i * 20;
    const evaUv = 500 + i * 10;
    const orderUv = 100 + i * 5;
    const shipCnt = 80 + i * 4;
    const qcCnt = 70 + i * 3;
    const dealCnt = 60 + i * 2;
    const returnCnt = 3;
    const safeDiv = (a, b) => (b > 0 ? a / b : null);
    return {
      week, startDate: '2026-06-01', endDate: '2026-06-07', daysReceived: 7,
      category: '手机', modelId: 'M1', modelName: '测试机型',
      jkuv, evaUv, evaCnt: evaUv, orderUv, orderCnt: orderUv, shipCnt, signCnt: shipCnt, qcCnt, dealCnt, returnCnt, gmv: dealCnt * 1000,
      evaRate: safeDiv(evaUv, jkuv), orderRate: safeDiv(orderUv, evaUv), shipRate: safeDiv(shipCnt, evaUv), dealRate: safeDiv(dealCnt, evaUv), returnRate: safeDiv(returnCnt, qcCnt),
    };
  });
  fs.writeFileSync(path.join(dir, 'cache.json'), JSON.stringify({ syncedAt: new Date().toISOString(), categories: ['手机'], weeks, rows }, null, 2));
  fs.writeFileSync(path.join(dir, 'rules.json'), JSON.stringify({ poolTopN: 20, waveThreshold: 0.1, trendWeeks: 3, minEvaUv: 15 }, null, 2));
  fs.writeFileSync(path.join(dir, 'tags.json'), '{}');
}

test('/api/monitor handler: cache.json 存在时归一化 + Cache-Control 三连', async () => {
  // 使用隔离 DATA_DIR 小 fixture，避免本地真实 30 万行 cache 让 HTTP 集成测试超时。
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tag-monitor-test-'));
  writeTinyMonitorFixture(tmpDataDir);

  // 起 server.js 子进程（不带 PROXY_UPSTREAM → 走 handler 路径，跟生产一致）
  const env = { ...process.env, PORT: String(PORT), DATA_DIR: tmpDataDir, ACCESS_CODE: 'TEST_ACCESS_CODE_20260714' };
  delete env.PROXY_UPSTREAM; // 显式清空，防继承
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitReady(child);
    const cookie = await verifyAccess();
    const authHeaders = { Cookie: cookie, 'X-User': encodeURIComponent('测试用户') };

    const vocabPut = await httpJson('PUT', '/api/tag-vocab', {
      core: ['核心', '观察'],
      lifecycle: ['主流'],
      price: ['高价段'],
      custom: { 手机: [{ id: 'tier', name: '手机标签1', options: ['A层', 'B层'] }] },
    }, authHeaders);
    assert.equal(vocabPut.status, 200, 'tag-vocab PUT status 200');
    assert.equal(vocabPut.json.vocab.custom.手机[0].name, '手机标签1');

    const tagKey = encodeURIComponent('手机||测试机型');
    const tagPut = await httpJson('PUT', `/api/tags/${tagKey}`, {
      dimensions: { core: '核心', 'custom:手机:tier': 'A层' },
      note: 'api-test',
    }, authHeaders);
    assert.equal(tagPut.status, 200, 'tags PUT status 200');
    assert.deepEqual(tagPut.json.tags.dimensions, { core: '核心', 'custom:手机:tier': 'A层' });

    const tagsGet = await httpGet('/api/tags', authHeaders);
    assert.equal(tagsGet.status, 200, 'tags GET status 200');
    const tagsBody = JSON.parse(tagsGet.body);
    assert.equal(tagsBody['手机||测试机型'].dimensions.core, '核心');

    const logsGet = await httpGet('/api/logs?limit=20', authHeaders);
    assert.equal(logsGet.status, 200, 'logs GET status 200');
    const logs = JSON.parse(logsGet.body);
    assert.ok(logs.some((entry) => entry.user === '测试用户'), 'URI 编码的中文用户名必须解码后写入操作日志');

    const r = await httpGet('/api/monitor?category=%E6%89%8B%E6%9C%BA&tagDimension=custom%3A%E6%89%8B%E6%9C%BA%3Atier', authHeaders);
    assert.equal(r.status, 200, 'status 200');

    // 1) Cache-Control 三连
    const cc = r.headers['cache-control'];
    assert.ok(cc, 'Cache-Control header 必须存在');
    assert.match(cc, /no-store/, 'Cache-Control 必须含 no-store');
    assert.match(cc, /no-cache/, 'Cache-Control 必须含 no-cache');
    assert.match(cc, /must-revalidate/, 'Cache-Control 必须含 must-revalidate');

    // 2) ETag / Last-Modified 已剥
    assert.equal(r.headers['etag'], undefined, 'ETag 必须被剥掉');
    assert.equal(r.headers['last-modified'], undefined, 'Last-Modified 必须被剥掉');

    // 3) body 归一化
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.pool), 'pool 必须是数组');
    assert.ok(Array.isArray(body.tagDimensions), 'tagDimensions 必须是数组');
    assert.equal(body.tagSummary.dimension, 'custom:手机:tier', 'tagSummary 支持自定义标签维度');
    assert.equal(body.tagSummary.groups.find((g) => g.value === 'A层').modelCount, 1, '自定义标签聚合命中机型');
    assert.ok(body.tagSummary.groups.some((g) => g.value === '未打标'), '未打标必须作为正式分组');

    for (const item of body.pool) {
      assert.ok(item.trend && typeof item.trend === 'object', `pool item ${item.modelName} trend 必须是对象`);
      const keys = Object.keys(item.trend).sort();
      assert.deepEqual(keys, RATE_KEYS, `pool item ${item.modelName} trend 键必须齐全`);
      for (const k of RATE_KEYS) {
        const v = item.trend[k];
        assert.ok(v === null || v === 'up' || v === 'down', `pool item ${item.modelName} trend.${k} 值 ${JSON.stringify(v)} 必须 ∈ {null, up, down}`);
      }
    }

    if (Array.isArray(body.watchList)) {
      for (const item of body.watchList) {
        if (!item.trend) continue; // watchList item 可能没 trend（正常）
        const keys = Object.keys(item.trend).sort();
        assert.deepEqual(keys, RATE_KEYS, `watchList item ${item.modelName} trend 键必须齐全`);
      }
    }
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    if (child.exitCode && child.exitCode !== 0) {
      // 子进程提前退出时把日志带出来，避免测试静默卡死。
      console.error('[server stdout]', stdout);
      console.error('[server stderr]', stderr);
    }
  }
});

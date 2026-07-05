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
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const PORT = 18849; // 避开常用端口
const RATE_KEYS = ['dealRate', 'evaRate', 'orderRate', 'returnRate', 'shipRate'];

function httpGet(pathAndQuery) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathAndQuery }, (res) => {
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

async function waitReady(maxMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await httpGet('/api/meta');
      if (r.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server not ready within ' + maxMs + 'ms');
}

test('/api/monitor handler: cache.json 存在时归一化 + Cache-Control 三连', async (t) => {
  // 前置：确认本地有 data/cache.json（不然 handler 返 "尚未同步数据" 而不是走归一化路径）
  const cachePath = path.join(REPO_ROOT, 'data', 'cache.json');
  if (!fs.existsSync(cachePath)) {
    t.skip('data/cache.json 不存在（本地没同步过数据），跳过 handler 集成测试');
    return;
  }

  // 起 server.js 子进程（不带 PROXY_UPSTREAM → 走 handler 路径，跟生产一致）
  const env = { ...process.env, PORT: String(PORT) };
  delete env.PROXY_UPSTREAM; // 显式清空，防继承
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitReady();

    const r = await httpGet('/api/monitor');
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
    child.kill('SIGTERM');
    await new Promise((resolve) => child.on('exit', resolve));
  }
});

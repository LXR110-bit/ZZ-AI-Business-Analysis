#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const envKey = name.replace(/-/g, '_').toUpperCase();
  return process.env[envKey] || fallback;
}

const apiBase = String(arg('api-base', process.env.API_BASE || 'http://127.0.0.1:8848')).replace(/\/+$/, '');
const outDir = arg('out-dir', process.env.DASHBOARD_PUBLIC_DIR || path.join(__dirname, '..', 'data', 'public'));
const dashboardPath = arg('dashboard-path', '/api/dashboard');
const accessCode = process.env.ACCESS_CODE || '';
const accessName = process.env.ACCESS_NAME || 'dashboard-publisher';

function request(method, url, { body, headers = {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const setCookie = res.headers['set-cookie'] || [];
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`${method} ${url} failed: HTTP ${res.statusCode} ${text.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve({ text, headers: res.headers, setCookie });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${url} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function cookieHeader(setCookies) {
  return setCookies
    .map((item) => String(item).split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function main() {
  let cookie = process.env.API_COOKIE || '';
  if (!cookie && accessCode) {
    const body = JSON.stringify({ name: accessName, code: accessCode });
    const auth = await request('POST', `${apiBase}/api/access/verify`, {
      body,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeoutMs: 30000,
    });
    cookie = cookieHeader(auth.setCookie);
  }

  const dashboard = await request('GET', `${apiBase}${dashboardPath}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const parsed = JSON.parse(dashboard.text);
  if (!parsed || typeof parsed !== 'object') throw new Error('dashboard response is not an object');

  fs.mkdirSync(outDir, { recursive: true });
  const finalPath = path.join(outDir, 'dashboard.json');
  const tmpPath = path.join(outDir, `.dashboard.${process.pid}.${Date.now()}.tmp`);
  const payload = `${JSON.stringify(parsed, null, 2)}\n`;
  fs.writeFileSync(tmpPath, payload);
  fs.renameSync(tmpPath, finalPath);
  console.log(JSON.stringify({ ok: true, file: finalPath, bytes: Buffer.byteLength(payload), apiBase, dashboardPath }));
}

main().catch((err) => {
  console.error(`[publish-dashboard-json] ${err.stack || err.message}`);
  process.exit(1);
});

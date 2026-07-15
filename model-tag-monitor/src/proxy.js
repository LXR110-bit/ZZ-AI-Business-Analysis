// 透传代理：把 /api/* 全部转发到 PROXY_UPSTREAM
// 使用场景：本地跑新 UI，数据从线上现役服务（http://47.84.94.234:8848）读
// 排除路径：EXCLUDE_PATHS 里的（比如 /api/dashboard 在本地基于上游数据重新聚合）
//
// 简单实现：Node 18+ 原生 fetch。不依赖 http-proxy-middleware。

const EXCLUDE_PATHS = new Set(['/api/dashboard', '/api/aiwan/read', '/api/aiwan/write']);

// 逐 hop 头不要透传；这些由目标端 / 我方 fetch 自己维护
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'upgrade',
  'host',
  'content-length',
]);

function pickReqHeaders(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'accept-encoding') continue; // 让 fetch 自己 decode
    h[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return h;
}

function pickResHeaders(headers) {
  const out = {};
  headers.forEach((v, k) => {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) return;
    if (key === 'content-encoding') return; // fetch 已解压
    if (key === 'content-length') return; // express 自己算
    out[k] = v;
  });
  return out;
}

/**
 * 生成 Express 中间件；upstream 为空返回 null（调用方走本地路由）
 * @param {string} upstream e.g. "http://47.84.94.234:8848"
 * @param {Object} [opts]
 * @param {Object.<string, (obj:any)=>any>} [opts.responseRewrite]
 *        path → rewriter：JSON 响应到手后过一遍此函数再回给客户端。
 *        用途：兜底上游 buggy 字段（例如 /api/monitor 的 trend `{}` bug）。
 *        非 JSON 或 rewriter 抛错时原样透传。
 */
function createProxy(upstream, opts = {}) {
  if (!upstream) return null;
  const base = upstream.replace(/\/+$/, '');
  const responseRewrite = opts.responseRewrite || {};

  return async function proxyMiddleware(req, res, next) {
    // 只代理 /api/*，其他（静态、根路径）走本地
    if (!req.path.startsWith('/api/')) return next();
    if (EXCLUDE_PATHS.has(req.path)) return next();

    // originalUrl 在某些代理链下可能包含 scheme+host（HTTP 绝对 URL 请求）；
    // 保险起见只取 pathname + search
    const pathAndQuery = req.originalUrl.startsWith('http')
      ? new URL(req.originalUrl).pathname + (new URL(req.originalUrl).search || '')
      : req.originalUrl;
    const targetUrl = base + pathAndQuery;
    const method = req.method.toUpperCase();
    console.log(`[proxy] ${method} ${req.originalUrl} → ${targetUrl}`);

    try {
      const init = {
        method,
        headers: pickReqHeaders(req),
        redirect: 'manual',
      };
      if (method !== 'GET' && method !== 'HEAD') {
        // req.body 已经被 express.json() 解析；序列化回去
        if (req.body && Object.keys(req.body).length > 0) {
          init.body = JSON.stringify(req.body);
          init.headers['content-type'] = 'application/json';
        }
      }

      const upstreamRes = await fetch(targetUrl, init);
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      const outHeaders = pickResHeaders(upstreamRes.headers);
      res.status(upstreamRes.status);
      for (const [k, v] of Object.entries(outHeaders)) res.setHeader(k, v);

      // 响应改写：仅对已注册 path 的 JSON 200 应用
      const rewriter = responseRewrite[req.path];
      const ct = String(upstreamRes.headers.get('content-type') || '').toLowerCase();
      if (rewriter && upstreamRes.ok && ct.includes('application/json') && buf.length) {
        try {
          const obj = JSON.parse(buf.toString('utf8'));
          const rewritten = rewriter(obj);
          const outBuf = Buffer.from(JSON.stringify(rewritten), 'utf8');
          res.setHeader('content-type', 'application/json; charset=utf-8');
          // 归一化后的 body 与上游原文不同，禁止浏览器缓存旧 body
          // 与 server.js /api/monitor handler 保持一致：三连禁缓存
          res.removeHeader('etag');
          res.removeHeader('last-modified');
          res.setHeader('cache-control', 'no-store, no-cache, must-revalidate');
          res.send(outBuf);
          return;
        } catch (e) {
          console.warn(`[proxy] rewrite failed for ${req.path}: ${e.message}, fallthrough to raw`);
        }
      }
      res.send(buf);
    } catch (e) {
      console.error(`[proxy] ${method} ${targetUrl} failed:`, e.message);
      if (!res.headersSent) {
        res.status(502).json({ error: 'upstream unreachable', detail: e.message, target: targetUrl });
      }
    }
  };
}

module.exports = { createProxy, EXCLUDE_PATHS };

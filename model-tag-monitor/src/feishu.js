// 飞书 API 封装
// 复用 lark-channel-bridge 里存的 App Secret
const { spawn } = require('child_process');

const APP_ID = process.env.FEISHU_APP_ID || 'cli_aab4e49b7bb95bd3';
const BRIDGE_NODE = '/root/.nvm/versions/node/v20.20.2/bin/node';
const BRIDGE_CLI = '/root/.nvm/versions/node/v20.20.2/bin/lark-channel-bridge';
const SECRET_ID = `app-${APP_ID}`;

// 从 lark-channel-bridge 的加密 keystore 里取 App Secret
// 通过 stdin 传协议请求,读 stdout JSON
function getAppSecret() {
  const req = JSON.stringify({
    protocolVersion: 1,
    provider: 'bridge',
    ids: [SECRET_ID],
  });
  return new Promise((resolve, reject) => {
    const child = spawn(BRIDGE_NODE, [BRIDGE_CLI, 'secrets', 'get'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`spawn 失败: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`secrets get exit ${code}: ${err || out}`));
      try {
        const parsed = JSON.parse(out);
        const secret = parsed.values?.[SECRET_ID];
        if (!secret) return reject(new Error(`secret 未找到: ${SECRET_ID}, values keys: ${Object.keys(parsed.values || {}).join(',')}`));
        resolve(secret);
      } catch (e) {
        reject(new Error(`secrets get 返回非 JSON: ${out.slice(0, 200)}`));
      }
    });
    // 关键:写入请求后关闭 stdin,否则 bridge 一直等
    child.stdin.write(req);
    child.stdin.end();
    // 兜底超时
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        reject(new Error('secrets get 超时(10s)'));
      }
    }, 10000);
  });
}

// tenant_access_token 缓存,飞书 token 有效期 2 小时
let tokenCache = { token: null, expireAt: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expireAt) {
    return tokenCache.token;
  }
  const secret = await getAppSecret();
  const resp = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: secret }),
    }
  );
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`拿 token 失败: ${JSON.stringify(data)}`);
  tokenCache.token = data.tenant_access_token;
  // 提前 5 分钟过期
  tokenCache.expireAt = Date.now() + (data.expire - 300) * 1000;
  return tokenCache.token;
}

// Wiki node → obj_token
async function getWikiObjToken(nodeToken) {
  const token = await getToken();
  const resp = await fetch(
    `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${nodeToken}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`wiki get_node 失败: ${JSON.stringify(data)}`);
  return {
    objToken: data.data.node.obj_token,
    objType: data.data.node.obj_type,
    title: data.data.node.title,
  };
}

// 列出 sheets 里的所有 sheet 页
async function listSheets(spreadsheetToken) {
  const token = await getToken();
  const resp = await fetch(
    `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`sheets query 失败: ${JSON.stringify(data)}`);
  return data.data.sheets;
}

// 读单个 sheet 页的内容
// range 格式: sheetId!A1:Z1000
async function readSheetRange(spreadsheetToken, range) {
  const token = await getToken();
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}?valueRenderOption=ToString&dateTimeRenderOption=FormattedString`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`readSheetRange 失败: ${JSON.stringify(data)}`);
  return data.data.valueRange.values || [];
}

// 分页读全表内容
// sheetInfo: { sheet_id, title, row_count, ... }
async function readWholeSheet(spreadsheetToken, sheetInfo, columns = 'A:Z') {
  const sheetId = sheetInfo.sheet_id;
  const rowCount = sheetInfo.grid_properties?.row_count || sheetInfo.row_count || 1000;
  const PAGE = 5000;
  const all = [];
  for (let start = 1; start <= rowCount; start += PAGE) {
    const end = Math.min(start + PAGE - 1, rowCount);
    // range 里的列范围保留,行范围替换
    const [c1, c2] = columns.split(':');
    const range = `${sheetId}!${c1}${start}:${c2}${end}`;
    const rows = await readSheetRange(spreadsheetToken, range);
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < end - start + 1) break; // 提前结束
  }
  return all;
}

module.exports = {
  getAppSecret,
  getToken,
  getWikiObjToken,
  listSheets,
  readSheetRange,
  readWholeSheet,
};

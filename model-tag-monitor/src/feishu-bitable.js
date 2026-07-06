// 飞书多维表格(Bitable) API 封装 + 字段值归一化
// 复用 src/feishu.js 的 getToken()/getWikiObjToken()，不重复写认证逻辑
const feishu = require('./feishu');

const BITABLE_PAGE_SIZE = 500;

// 把 Bitable 字段值归一化成字符串
// 飞书文本字段有时返回纯字符串，有时返回富文本分段数组 [{ type: 'text', text: '内容' }, ...]
function bitableFieldToString(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) {
    return v
      .map((seg) => {
        if (seg && typeof seg === 'object' && typeof seg.text === 'string') return seg.text;
        if (typeof seg === 'string') return seg;
        return '';
      })
      .join('')
      .trim();
  }
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text.trim();
    return '';
  }
  return String(v).trim();
}

// 把 Bitable 字段值归一化成数字
// fallback: 值为 null/undefined/空字符串/非数字时的兜底值，默认 0（对齐 sync.js toNum 的约定）
function bitableFieldToNumber(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (Array.isArray(v)) {
    // 数字字段极少会是富文本数组，但防御式处理：取拼接后的文本再转数字
    return bitableFieldToNumber(bitableFieldToString(v), fallback);
  }
  const s = String(v).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

// 拉取一张 Bitable 表的全部 records
// wikiNodeToken: wiki node token（形如 https://.../wiki/{wikiNodeToken}?table=... 里的那段）
// tableId: Bitable table id（?table= 后面那段）
// 返回 { appToken, records }，records: [{ record_id, fields }]
async function listBitableRecords(wikiNodeToken, tableId) {
  const { objToken, objType, title } = await feishu.getWikiObjToken(wikiNodeToken);
  if (objType !== 'bitable') {
    throw new Error(`wiki node 不是 bitable 类型: ${objType} (node=${wikiNodeToken}, title=${title})`);
  }
  const appToken = objToken;
  const token = await feishu.getToken();

  const records = [];
  let pageToken = '';
  for (;;) {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`
    );
    url.searchParams.set('page_size', String(BITABLE_PAGE_SIZE));
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`bitable records 拉取失败: ${JSON.stringify(data)} (table=${tableId})`);
    }
    const items = data.data.items || [];
    for (const item of items) {
      records.push({ record_id: item.record_id, fields: item.fields || {} });
    }
    if (!data.data.has_more || !data.data.page_token) break;
    pageToken = data.data.page_token;
  }
  return { appToken, records };
}

module.exports = { listBitableRecords, bitableFieldToString, bitableFieldToNumber };

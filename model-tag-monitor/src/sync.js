// 从飞书 sheets 拉数据 → 归一化 → 落到 cache.json
const feishu = require('./feishu');
const store = require('./store');

// 飞书 wiki node:「机型维度周日均漏斗数据（6月）」
// 该 doc 内含 "日期机型维度周日均" sheet,字段名以 "XX日均" 结尾,值为周日均
const WIKI_NODE_TOKEN = 'UzEZwrOTVimV0RkjOaBcT4EWnGf';
const EXPECTED_DOC_TITLE = '机型维度周日均漏斗数据（6月）';

// 主 sheet 页名称候选(优先匹配"周日均"版本)
const MAIN_SHEET_KEYWORDS = ['日期机型维度周日均', '机型周日均', '日期机型'];

// 表头字段 → 内部字段名映射
// 官方口径已是"周日均":列名以 "XX日均" 结尾;老表用 "XX汇总" 是周累计,也做兼容(不推荐使用)
const HEADER_MAP = {
  // 时间维度
  统计周: 'week',
  周次: 'week',
  周开始: 'startDate',
  开始日期: 'startDate',
  周结束: 'endDate',
  结束日期: 'endDate',
  已收到天数: 'daysReceived',
  // 品类/机型
  品类名称: 'category',
  品类: 'category',
  一级品类: 'category',
  机型ID: 'modelId',
  型号ID: 'modelId',
  机型名称: 'modelName',
  型号: 'modelName',
  型号名称: 'modelName',
  // 漏斗指标(以"日均"为主口径,兼容旧"汇总"命名)
  机况UV日均: 'jkuv',
  机况UV汇总: 'jkuv',
  机况UV: 'jkuv',
  机况页UV: 'jkuv',
  估价UV日均: 'evaUv',
  估价UV汇总: 'evaUv',
  估价UV: 'evaUv',
  估价量日均: 'evaCnt',
  估价量: 'evaCnt',
  下单UV日均: 'orderUv',
  下单UV汇总: 'orderUv',
  下单UV: 'orderUv',
  下单量日均: 'orderCnt',
  下单量汇总: 'orderCnt',
  下单量: 'orderCnt',
  发货量日均: 'shipCnt',
  发货量汇总: 'shipCnt',
  发货量: 'shipCnt',
  签收量日均: 'signCnt',
  签收量汇总: 'signCnt',
  签收量: 'signCnt',
  质检量日均: 'qcCnt',
  质检量汇总: 'qcCnt',
  质检量: 'qcCnt',
  成交量日均: 'dealCnt',
  成交量汇总: 'dealCnt',
  成交量: 'dealCnt',
  退回量日均: 'returnCnt',
  退回量汇总: 'returnCnt',
  退回量: 'returnCnt',
  成交GMV日均: 'gmv',
  成交GMV汇总: 'gmv',
  成交GMV: 'gmv',
  GMV: 'gmv',
  客单价: 'avgPrice',
  成交客单价: 'avgPrice',
};

// 5 个核心转化率的计算口径
function computeRates(row) {
  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  return {
    evaRate: safeDiv(row.evaUv, row.jkuv), // 估价完成率 = 估价UV / 机况UV
    orderRate: safeDiv(row.orderUv, row.evaUv), // 估价下单率 = 下单UV / 估价UV
    shipRate: safeDiv(row.shipCnt, row.evaUv), // 估价发货率 = 发货量 / 估价UV
    dealRate: safeDiv(row.dealCnt, row.evaUv), // 估价成交率 = 成交量 / 估价UV
    returnRate: safeDiv(row.returnCnt, row.qcCnt), // 质检退回率 = 退回量 / 质检量
  };
}

// 数字转换,把飞书返回的字符串数字变成 number,处理空/非数字
function toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// 归一化一行:根据表头映射把值填入标准字段
function normalizeRow(headers, values) {
  const fields = {};
  headers.forEach((h, i) => {
    const key = HEADER_MAP[String(h || '').trim()];
    if (key) fields[key] = values[i];
  });
  // 数字字段
  ['jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv', 'avgPrice', 'daysReceived'].forEach(
    (k) => {
      if (fields[k] !== undefined) fields[k] = toNum(fields[k]);
      else fields[k] = 0;
    }
  );
  // 文本字段
  ['week', 'startDate', 'endDate', 'category', 'modelId', 'modelName'].forEach((k) => {
    if (fields[k] !== undefined) fields[k] = String(fields[k]).trim();
    else fields[k] = '';
  });
  // 转化率
  Object.assign(fields, computeRates(fields));
  return fields;
}

// 找主 sheet 页
function findMainSheet(sheets) {
  for (const kw of MAIN_SHEET_KEYWORDS) {
    const hit = sheets.find((s) => s.title && s.title.includes(kw));
    if (hit) return hit;
  }
  // 兜底:返回第一个
  return sheets[0];
}

async function sync() {
  console.log('[sync] 开始同步飞书数据...');
  const { objToken, objType, title } = await feishu.getWikiObjToken(WIKI_NODE_TOKEN);
  if (objType !== 'sheet') throw new Error(`wiki node 不是 sheet 类型: ${objType}`);
  console.log(`[sync] wiki -> sheet: ${title} (${objToken})`);
  if (title.trim() !== EXPECTED_DOC_TITLE) {
    console.warn(`[sync] 警告:doc 标题与预期不一致,预期="${EXPECTED_DOC_TITLE}",实际="${title.trim()}"。请确认 WIKI_NODE_TOKEN 未失效。`);
  }

  const sheets = await feishu.listSheets(objToken);
  console.log(`[sync] 找到 ${sheets.length} 个 sheet 页:`, sheets.map((s) => s.title));

  const main = findMainSheet(sheets);
  console.log(`[sync] 选中主 sheet: ${main.title}`);

  const rowCount = main.grid_properties?.row_count || 1000;
  const colCount = main.grid_properties?.column_count || 26;
  console.log(`[sync] sheet 尺寸: ${rowCount} 行 × ${colCount} 列`);

  // 先读表头(第 1 行)
  const colLetter = colToLetter(colCount);
  const headerRange = `${main.sheet_id}!A1:${colLetter}1`;
  const headerRows = await feishu.readSheetRange(objToken, headerRange);
  const headers = (headerRows[0] || []).map((h) => String(h || '').trim());
  console.log(`[sync] 表头:`, headers);

  // 检查关键字段是否都能映射到
  const mappedKeys = new Set(headers.map((h) => HEADER_MAP[h]).filter(Boolean));
  const requiredKeys = ['week', 'category', 'modelName', 'evaUv'];
  const missing = requiredKeys.filter((k) => !mappedKeys.has(k));
  if (missing.length) {
    console.warn(`[sync] 警告:缺少关键字段映射: ${missing.join(', ')}`);
  }

  // 分页读数据(跳过第 1 行表头)
  const PAGE = 5000;
  const rows = [];
  for (let start = 2; start <= rowCount; start += PAGE) {
    const end = Math.min(start + PAGE - 1, rowCount);
    const range = `${main.sheet_id}!A${start}:${colLetter}${end}`;
    console.log(`[sync] 读取 ${range}`);
    const chunk = await feishu.readSheetRange(objToken, range);
    if (!chunk.length) break;
    for (const values of chunk) {
      // 跳过完全空的行
      if (values.every((v) => v === null || v === undefined || v === '')) continue;
      const norm = normalizeRow(headers, values);
      // 只保留有 week+category+modelName 的行
      if (norm.week && norm.category && norm.modelName) rows.push(norm);
    }
  }
  console.log(`[sync] 归一化后有效行数: ${rows.length}`);

  // 统计品类
  const categories = [...new Set(rows.map((r) => r.category))].sort();
  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  console.log(`[sync] 品类: ${categories.length} 个, 周次: ${weeks.length} 个`);

  const cache = {
    syncedAt: new Date().toISOString(),
    source: {
      wikiNode: WIKI_NODE_TOKEN,
      objToken,
      title,
      sheetTitle: main.title,
    },
    headers,
    categories,
    weeks,
    rows,
  };
  store.writeJSON('cache.json', cache);
  store.appendLog({
    action: 'sync',
    rows: rows.length,
    categories: categories.length,
    weeks: weeks.length,
  });
  console.log('[sync] 完成');
  return { rows: rows.length, categories: categories.length, weeks: weeks.length };
}

// 列数 → Excel 字母,26 → Z, 27 → AA
function colToLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

module.exports = { sync, computeRates, HEADER_MAP };

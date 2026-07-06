// 品类分层映射表同步：飞书 Base(多维表格) → data/category-taxonomy.json
// 数据源：品类映射表.xlsx 用户维护后上传到飞书 Base
const store = require('./store');
const bitable = require('./feishu-bitable');

const WIKI_NODE_TOKEN = 'L7LowLNAbif0fgkzxIJcHCZynnb';
const TABLE_ID = 'tblXJ78kOrgKgZlc';

// 表头字段(中文列名) → 内部字段名
// !! 待接入时用 scripts/inspect-bitable-fields.js 核验真实字段名，见本计划 Task 8
const HEADER_MAP = {
  三级品类: 'category',
  阶段: 'tier',
  二级板块: 'board',
  业务状态: 'status',
  归类置信度: 'confidence',
  '最新周GMV(元)': 'lastWeekGmv',
};

const VALID_TIERS = ['发展', '孵化', '种子', '自营(非聚合)'];
const VALID_STATUSES = ['在售', '已下线'];

// 把一条 Bitable record.fields(中文 key) 归一化成内部字段名的行对象
function normalizeTaxonomyRecord(fields) {
  const row = {};
  for (const [cnKey, enKey] of Object.entries(HEADER_MAP)) {
    const raw = fields[cnKey];
    if (enKey === 'lastWeekGmv') {
      row[enKey] = bitable.bitableFieldToNumber(raw, 0);
    } else {
      row[enKey] = bitable.bitableFieldToString(raw);
    }
  }
  return row;
}

function isSelfOperated(row) {
  return row.tier === '自营(非聚合)';
}

function filterSelfOperated(rows) {
  return rows.filter((r) => !isSelfOperated(r));
}

// 拉取 + 归一化，但不做自营过滤(给 category-sync 复用做交叉过滤判断)
async function fetchRawRows() {
  const { records } = await bitable.listBitableRecords(WIKI_NODE_TOKEN, TABLE_ID);
  const rows = records.map((r) => normalizeTaxonomyRecord(r.fields));
  for (const row of rows) {
    if (row.tier && !VALID_TIERS.includes(row.tier)) {
      console.warn(`[taxonomy-sync] 警告: 未知 tier 值 "${row.tier}" (category=${row.category})`);
    }
    if (row.status && !VALID_STATUSES.includes(row.status)) {
      console.warn(`[taxonomy-sync] 警告: 未知 status 值 "${row.status}" (category=${row.category})`);
    }
  }
  return rows;
}

async function sync() {
  console.log('[taxonomy-sync] 开始同步品类分层映射...');
  const rawRows = await fetchRawRows();
  const rows = filterSelfOperated(rawRows);
  console.log(`[taxonomy-sync] 原始 ${rawRows.length} 行, 过滤自营(非聚合)后 ${rows.length} 行`);

  const cache = {
    syncedAt: new Date().toISOString(),
    rows,
  };
  store.writeJSON('category-taxonomy.json', cache);
  store.appendLog({ action: 'taxonomy-sync', rows: rows.length, filtered: rawRows.length - rows.length });
  console.log('[taxonomy-sync] 完成');
  return { rows: rows.length, filtered: rawRows.length - rows.length };
}

module.exports = {
  sync,
  fetchRawRows,
  normalizeTaxonomyRecord,
  isSelfOperated,
  filterSelfOperated,
  HEADER_MAP,
  VALID_TIERS,
  VALID_STATUSES,
  WIKI_NODE_TOKEN,
  TABLE_ID,
};

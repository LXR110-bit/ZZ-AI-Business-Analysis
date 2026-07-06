// 大盘维度漏斗数据同步：飞书 Bitable(月度分表) → data/board-cache.json
const store = require('./store');
const bitable = require('./feishu-bitable');

// 月份 → { wikiNode, tableId }，每月新增表只需要在这里加一行
const MONTH_TABLES = {
  '2026-05': { wikiNode: 'N8Ijw3rY7iIXhhkVRT6cZ9xTnPe', tableId: 'tblaByOmnpGBUVPo' },
  '2026-06': { wikiNode: 'N4bIw142pimzZDkCoPLc2Gt8nNc', tableId: 'tblM3nCspImZxNcP' },
  '2026-07': { wikiNode: 'OdhJwIkyvi55wVkPVxocZ7RFnIQ', tableId: 'tblj4hmOhxDt9bk4' },
};

// 表头字段(中文列名) → 内部字段名，口径与 src/sync.js HEADER_MAP 一致(周日均)
// !! 待接入时用 scripts/inspect-bitable-fields.js 核验真实字段名，见本计划 Task 8
const HEADER_MAP = {
  统计周: 'week',
  周次: 'week',
  机况UV日均: 'jkuv',
  估价UV日均: 'evaUv',
  估价量日均: 'evaCnt',
  下单UV日均: 'orderUv',
  下单量日均: 'orderCnt',
  发货量日均: 'shipCnt',
  签收量日均: 'signCnt',
  质检量日均: 'qcCnt',
  成交量日均: 'dealCnt',
  退回量日均: 'returnCnt',
  成交GMV日均: 'gmv',
};

const NUMBER_FIELDS = ['jkuv', 'evaUv', 'evaCnt', 'orderUv', 'orderCnt', 'shipCnt', 'signCnt', 'qcCnt', 'dealCnt', 'returnCnt', 'gmv'];

function normalizeBoardRecord(fields) {
  const row = {};
  for (const [cnKey, enKey] of Object.entries(HEADER_MAP)) {
    if (fields[cnKey] === undefined) continue;
    row[enKey] = fields[cnKey];
  }
  row.week = bitable.bitableFieldToString(row.week);
  for (const k of NUMBER_FIELDS) row[k] = bitable.bitableFieldToNumber(row[k], 0);
  return row;
}

// 4 个核心转化率，口径与 category-sync.js computeRates 一致
function computeRates(row) {
  const safeDiv = (a, b) => (b > 0 ? a / b : null);
  return {
    evaRate: safeDiv(row.evaUv, row.jkuv),
    orderRate: safeDiv(row.orderUv, row.evaUv),
    shipRate: safeDiv(row.shipCnt, row.evaUv),
    dealRate: safeDiv(row.dealCnt, row.evaUv),
  };
}

// 按 monthKey 升序合并，去重 key = week，后出现的月份覆盖前面
function mergeRows(monthlyRowsInOrder) {
  const map = new Map();
  for (const { rows } of monthlyRowsInOrder) {
    for (const row of rows) {
      if (!row.week) continue;
      map.set(row.week, row);
    }
  }
  return [...map.values()];
}

async function sync() {
  console.log('[board-sync] 开始同步大盘漏斗数据...');
  const monthKeys = Object.keys(MONTH_TABLES).sort();
  const monthlyRowsInOrder = [];
  for (const monthKey of monthKeys) {
    const { wikiNode, tableId } = MONTH_TABLES[monthKey];
    console.log(`[board-sync] 拉取 ${monthKey} (node=${wikiNode}, table=${tableId})`);
    const { records } = await bitable.listBitableRecords(wikiNode, tableId);
    const rows = records.map((r) => normalizeBoardRecord(r.fields)).filter((r) => r.week);
    console.log(`[board-sync] ${monthKey} 归一化后 ${rows.length} 行`);
    monthlyRowsInOrder.push({ monthKey, rows });
  }

  const merged = mergeRows(monthlyRowsInOrder);
  const rows = merged.map((row) => ({ ...row, ...computeRates(row) }));
  console.log(`[board-sync] 合并去重后 ${rows.length} 行`);

  const wikiNodesByMonth = {};
  for (const monthKey of monthKeys) wikiNodesByMonth[monthKey] = MONTH_TABLES[monthKey].wikiNode;

  const cache = {
    syncedAt: new Date().toISOString(),
    source: { wikiNodesByMonth },
    rows,
  };
  store.writeJSON('board-cache.json', cache);
  store.appendLog({ action: 'board-sync', rows: rows.length });
  console.log('[board-sync] 完成');
  return { rows: rows.length };
}

module.exports = { sync, normalizeBoardRecord, computeRates, mergeRows, HEADER_MAP, MONTH_TABLES };

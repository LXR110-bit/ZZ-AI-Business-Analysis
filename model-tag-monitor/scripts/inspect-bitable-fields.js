// 真实接入前的字段名核验脚本：连真实飞书 API，打印一条 record 的 fields keys
// 用法：node scripts/inspect-bitable-fields.js <wikiNodeToken> <tableId>
// 例：核验品类维度 7 月表 → node scripts/inspect-bitable-fields.js DAcFwVw8ViG3PHkqUOUcbmYGnDc tbl5EZ8oGsVE8joQ
const path = require('path');

function parseArgs(argv) {
  const [wikiNodeToken, tableId] = argv;
  if (!wikiNodeToken || !tableId) {
    throw new Error('用法: node scripts/inspect-bitable-fields.js <wikiNodeToken> <tableId>');
  }
  return { wikiNodeToken, tableId };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
    return;
  }
  const bitable = require(path.join(__dirname, '..', 'src', 'feishu-bitable'));
  const { records } = await bitable.listBitableRecords(args.wikiNodeToken, args.tableId);
  if (!records.length) {
    console.log('[inspect] 该表没有任何记录，无法核验字段名');
    return;
  }
  const sample = records[0];
  console.log('[inspect] record_id:', sample.record_id);
  console.log('[inspect] fields keys:', Object.keys(sample.fields));
  console.log('[inspect] fields 完整内容:', JSON.stringify(sample.fields, null, 2));
}

module.exports = { parseArgs };

if (require.main === module) {
  main().catch((e) => {
    console.error('[inspect] 失败:', e.message);
    process.exit(1);
  });
}

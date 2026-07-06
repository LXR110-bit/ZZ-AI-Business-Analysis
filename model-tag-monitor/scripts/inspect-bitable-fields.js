// 核验飞书 Bitable 真实字段名 vs HEADER_MAP 假设是否一致
// 三个同步任务(taxonomy-sync/category-sync/board-sync)的 HEADER_MAP 都是凭飞书表设计草稿盲猜的列名，
// 接入真实数据源前必须跑一遍这个脚本，核对真实列名，避免上线后静默漏字段(归一化时 undefined 被当 0/空串兜底，不报错但数据全错)。
//
// 用法：
//   node scripts/inspect-bitable-fields.js taxonomy
//   node scripts/inspect-bitable-fields.js category 2026-07
//   node scripts/inspect-bitable-fields.js board 2026-07
//   node scripts/inspect-bitable-fields.js --node=xxx --table=yyy   # 直接指定，不走已知同步任务配置
//
// 输出：该表第一条 record 的全部真实字段名 + 值类型 + 值预览；并与对应 HEADER_MAP 的中文列名做差集比对，
// 分别列出"表里有但 HEADER_MAP 没映射"和"HEADER_MAP 期望但表里找不到"的列名，两者都应为空才算核验通过。

const bitable = require('../src/feishu-bitable');
const taxonomySync = require('../src/taxonomy-sync');
const categorySync = require('../src/category-sync');
const boardSync = require('../src/board-sync');

function usage() {
  console.log(
    '用法: node scripts/inspect-bitable-fields.js <taxonomy|category|board> [monthKey]\n' +
      '  或: node scripts/inspect-bitable-fields.js --node=<wikiNodeToken> --table=<tableId>'
  );
}

// 解析 CLI 参数 → { wikiNode, tableId, expectedHeaderMap, label }
function resolveTarget(argv) {
  const nodeArg = argv.find((a) => a.startsWith('--node='));
  const tableArg = argv.find((a) => a.startsWith('--table='));
  if (nodeArg && tableArg) {
    return {
      wikiNode: nodeArg.slice('--node='.length),
      tableId: tableArg.slice('--table='.length),
      expectedHeaderMap: null,
      label: '(手动指定，跳过 HEADER_MAP 比对)',
    };
  }

  const [source, monthKey] = argv;
  if (source === 'taxonomy') {
    return {
      wikiNode: taxonomySync.WIKI_NODE_TOKEN,
      tableId: taxonomySync.TABLE_ID,
      expectedHeaderMap: taxonomySync.HEADER_MAP,
      label: 'taxonomy-sync (品类分层映射表)',
    };
  }
  if (source === 'category' || source === 'board') {
    const sync = source === 'category' ? categorySync : boardSync;
    const monthKeys = Object.keys(sync.MONTH_TABLES).sort();
    const key = monthKey || monthKeys[monthKeys.length - 1];
    const table = sync.MONTH_TABLES[key];
    if (!table) {
      throw new Error(`未知 monthKey "${key}"，可选: ${monthKeys.join(', ')}`);
    }
    return {
      wikiNode: table.wikiNode,
      tableId: table.tableId,
      expectedHeaderMap: sync.HEADER_MAP,
      label: `${source}-sync (${key})`,
    };
  }
  return null;
}

function describeValue(v) {
  if (Array.isArray(v)) return `array(len=${v.length}) ${JSON.stringify(v).slice(0, 80)}`;
  if (v && typeof v === 'object') return `object ${JSON.stringify(v).slice(0, 80)}`;
  return `${typeof v} ${JSON.stringify(v)}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const target = resolveTarget(argv);
  if (!target) {
    usage();
    process.exit(1);
  }

  const { wikiNode, tableId, expectedHeaderMap, label } = target;
  console.log(`[inspect] 目标: ${label}`);
  console.log(`[inspect] wikiNode=${wikiNode} tableId=${tableId}`);

  const { appToken, records } = await bitable.listBitableRecords(wikiNode, tableId);
  console.log(`[inspect] appToken=${appToken}`);
  console.log(`[inspect] 拉取到 ${records.length} 条 record`);

  if (records.length === 0) {
    console.log('[inspect] 表为空，无法核验字段名');
    return;
  }

  const sample = records[0].fields;
  const realKeys = Object.keys(sample);
  console.log(`\n[inspect] 第一条 record 真实字段(${realKeys.length}个):`);
  for (const k of realKeys) {
    console.log(`  "${k}" → ${describeValue(sample[k])}`);
  }

  if (!expectedHeaderMap) return;

  const expectedKeys = Object.keys(expectedHeaderMap);
  const realSet = new Set(realKeys);
  const expectedSet = new Set(expectedKeys);

  const unmapped = realKeys.filter((k) => !expectedSet.has(k));
  const missing = expectedKeys.filter((k) => !realSet.has(k));

  console.log(`\n[inspect] HEADER_MAP 核验结果:`);
  console.log(`  表里有但 HEADER_MAP 未映射的列(${unmapped.length}): ${unmapped.join(', ') || '无'}`);
  console.log(`  HEADER_MAP 期望但表里找不到的列(${missing.length}): ${missing.join(', ') || '无'}`);

  if (unmapped.length === 0 && missing.length === 0) {
    console.log('[inspect] ✓ 核验通过，HEADER_MAP 与真实字段名完全一致');
  } else {
    console.log('[inspect] ✗ 核验未通过，请更新对应 src/*.js 里的 HEADER_MAP');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[inspect] 失败:', e.message);
  process.exitCode = 1;
});

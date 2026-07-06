/**
 * composeDashboard 单测
 *
 * 覆盖：
 *  1) 契约对齐 — 用线上真实 /api/monitor + /api/meta fixture 跑一遍，锁 payload 结构/关键字段
 *  2) GMV 兜底 — 缓存缺失时从 pool.cur/prev.gmv 求和；缓存命中时直接取
 *  3) delta 排序 + 格式化 — |delta.orderRate| 降序，>=1× 用倍数、<1 用百分号
 *  4) 空 meta / 未同步保护
 *
 * 契约来源：docs/superpowers/handoffs/data_to_frontend_contract.md
 * 跑法：npm test （node --test）
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { composeDashboard, normalizeTrend, normalizeMonitor } = require('../src/dashboard');

const FIX_DIR = path.join(__dirname, 'fixtures');
const monitor = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'monitor.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(FIX_DIR, 'meta.json'), 'utf8'));

test('契约对齐：真实 fixture 跑通 & payload shape 稳定', () => {
  const p = composeDashboard({ meta, monitor });
  assert.ok(p, '应返回 payload');

  // meta
  assert.equal(typeof p.meta.syncedAt, 'string');
  assert.equal(p.meta.latestWeek, monitor.targetWeek);
  assert.equal(p.meta.totalWeeks, meta.weeks.length);
  assert.match(p.meta.weekRange, /^\d{2}-\d{2} ~ \d{2}-\d{2}$/);

  // kpi
  assert.equal(p.kpi.totalModels, monitor.pool.length);
  assert.equal(p.kpi.watchCount, monitor.watchList.length);
  assert.ok(p.kpi.totalCategories > 0);
  assert.ok(p.kpi.upCount >= 0 && p.kpi.upCount <= p.kpi.totalModels);
  assert.equal(typeof p.kpi.upDeltaLabel, 'string');

  // gmvTrend: 数组、长度 <= 5、每项 {week, gmv}
  assert.ok(Array.isArray(p.gmvTrend));
  assert.ok(p.gmvTrend.length > 0 && p.gmvTrend.length <= 5);
  for (const g of p.gmvTrend) {
    assert.equal(typeof g.week, 'string');
    assert.ok(g.gmv === null || typeof g.gmv === 'number');
  }

  // watchByCategory: <=6, count 降序
  assert.ok(p.watchByCategory.length <= 6);
  for (let i = 1; i < p.watchByCategory.length; i++) {
    assert.ok(p.watchByCategory[i - 1].count >= p.watchByCategory[i].count, '品类分布应按 count 降序');
  }

  // topRows: <=10, rank 1..N, |delta| 降序
  assert.ok(p.topRows.length <= 10);
  p.topRows.forEach((r, i) => {
    assert.equal(r.rank, i + 1);
    assert.ok(['up', 'down'].includes(r.deltaDir));
    assert.match(r.deltaLabel, /^[↑↓] [\d.]+(×|%)$/);
  });

  assert.equal(p._source, 'upstream');
});

test('GMV 兜底：无 cache 时 latest / prev 两周从 pool.cur / prev.gmv 求和', () => {
  const p = composeDashboard({ meta, monitor });
  const latest = p.meta.latestWeek;
  const trendLatest = p.gmvTrend.find((g) => g.week === latest);
  // 手工聚合一遍对比
  let expected = 0;
  for (const row of monitor.pool) {
    if (row.cur && row.cur.week === latest && typeof row.cur.gmv === 'number') expected += row.cur.gmv;
  }
  assert.equal(trendLatest.gmv, Math.round(expected), 'latestWeek GMV 应等于 pool.cur.gmv 之和 (四舍五入)');
});

test('GMV 缓存命中：cache.has(week) 直接返回 cache.get(week)，忽略 pool', () => {
  const cache = new Map([
    ['2026-W23', 1_000_000],
    ['2026-W27', 999_999], // 覆盖 latestWeek
  ]);
  const p = composeDashboard({ meta, monitor, gmvCache: cache });
  const w23 = p.gmvTrend.find((g) => g.week === '2026-W23');
  const w27 = p.gmvTrend.find((g) => g.week === '2026-W27');
  assert.equal(w23.gmv, 1_000_000, 'cache 命中应直接返回');
  assert.equal(w27.gmv, 999_999, 'cache 应覆盖 pool 兜底');
});

test('Top10 排序：按 |delta.orderRate| 降序，且 deltaLabel 格式随倍数切换', () => {
  const p = composeDashboard({ meta, monitor });
  if (p.topRows.length < 2) return; // 数据太少跳过
  // |delta| 非递增；deltaLabel 与 rank 1 的 delta 幅度一致
  // 由于 payload 不含原始 deltaRaw，反查 pool 拿真值
  const idx = new Map();
  for (const row of monitor.pool) {
    if (row.delta && typeof row.delta.orderRate === 'number' && row.cur) {
      idx.set(`${row.category}|${row.modelName}`, row.delta.orderRate);
    }
  }
  let prev = Infinity;
  for (const r of p.topRows) {
    const d = idx.get(`${r.category}|${r.modelName}`);
    assert.ok(typeof d === 'number', `找不到 topRow 反查 delta: ${r.modelName}`);
    assert.ok(Math.abs(d) <= prev, 'topRows 应按 |delta| 降序');
    prev = Math.abs(d);
    // 格式：|d| >= 1 → 倍数×；<1 → 百分号
    if (Math.abs(d) >= 1) assert.match(r.deltaLabel, /×$/);
    else assert.match(r.deltaLabel, /%$/);
    // 方向
    assert.equal(r.deltaDir, d >= 0 ? 'up' : 'down');
  }
});

test('未同步 / 空 meta 保护：composeDashboard 返回 null', () => {
  assert.equal(composeDashboard({ meta: null, monitor }), null);
  assert.equal(composeDashboard({ meta: { synced: false }, monitor }), null);
});

test('空 pool / watchList：KPI 全零、gmvTrend 全 null、Top10 为空', () => {
  const emptyMonitor = { targetWeek: '2026-W27', prevWeek: '2026-W26', weeks: meta.weeks, pool: [], watchList: [] };
  const p = composeDashboard({ meta, monitor: emptyMonitor });
  assert.equal(p.kpi.totalModels, 0);
  assert.equal(p.kpi.watchCount, 0);
  assert.equal(p.kpi.upCount, 0);
  assert.equal(p.topRows.length, 0);
  assert.equal(p.watchByCategory.length, 0);
  assert.ok(p.gmvTrend.every((g) => g.gmv === null));
});

// ---- case 7：trend 归一化兜底（zz-server wave.js calcTrend bug 兜底）----
// 参照：Python 版 wave.py 显式 out = {k: None for k in keys}，5 项 rate 全 null 兜底
// Node 版 wave.js 没这一步，出 `{}` / 部分字段泄漏，前端归一化层保护
test('normalizeTrend: {} → 5 项 rate 全 null', () => {
  const out = normalizeTrend({});
  assert.deepEqual(out, {
    evaRate: null, orderRate: null, shipRate: null, dealRate: null, returnRate: null,
  });
});

test('normalizeTrend: undefined / null → 5 项 rate 全 null', () => {
  assert.deepEqual(normalizeTrend(undefined), {
    evaRate: null, orderRate: null, shipRate: null, dealRate: null, returnRate: null,
  });
  assert.deepEqual(normalizeTrend(null), {
    evaRate: null, orderRate: null, shipRate: null, dealRate: null, returnRate: null,
  });
});

test('normalizeTrend: 部分字段泄漏 → 缺的补 null、合法值保留', () => {
  const out = normalizeTrend({ orderRate: 'up', shipRate: 'down' });
  assert.equal(out.orderRate, 'up');
  assert.equal(out.shipRate, 'down');
  assert.equal(out.evaRate, null);
  assert.equal(out.dealRate, null);
  assert.equal(out.returnRate, null);
});

test('normalizeTrend: 非法值（bool / number / 其他字符串）→ null', () => {
  const out = normalizeTrend({ evaRate: 'flat', orderRate: true, shipRate: 0, dealRate: 'UP' });
  assert.equal(out.evaRate, null, '"flat" 非契约值应归一 null');
  assert.equal(out.orderRate, null, 'true 应归一 null');
  assert.equal(out.shipRate, null, '0 应归一 null');
  assert.equal(out.dealRate, null, '"UP" 大小写不匹配契约');
  assert.equal(out.returnRate, null);
});

test('normalizeMonitor: pool / watchList 每 item 的 trend 都被归一化', () => {
  const buggy = {
    targetWeek: '2026-W27',
    prevWeek: '2026-W26',
    weeks: ['2026-W26', '2026-W27'],
    pool: [
      { category: 'A', modelName: 'M1', trend: {} },
      { category: 'A', modelName: 'M2', trend: { orderRate: 'up' } },
      { category: 'A', modelName: 'M3' /* trend 缺 */ },
    ],
    watchList: [
      { category: 'A', modelName: 'M1', trend: null },
    ],
  };
  const out = normalizeMonitor(buggy);
  for (const p of out.pool) {
    assert.deepEqual(Object.keys(p.trend).sort(), ['dealRate', 'evaRate', 'orderRate', 'returnRate', 'shipRate']);
  }
  assert.equal(out.pool[0].trend.orderRate, null, '{} → null');
  assert.equal(out.pool[1].trend.orderRate, 'up', '合法值保留');
  assert.equal(out.pool[1].trend.evaRate, null, '缺失字段补 null');
  assert.equal(out.pool[2].trend.orderRate, null, '整个 trend 缺 → 全 null');
  assert.equal(out.watchList[0].trend.orderRate, null, 'watchList 也归一');
  // 其他字段透传不改
  assert.equal(out.targetWeek, '2026-W27');
  assert.equal(out.pool[0].modelName, 'M1');
});

test('composeDashboard: 上游返回 trend={} 也不影响 KPI/topRows', () => {
  // 模拟上游 bug：把 fixture 里所有 trend 换成 {}
  const buggy = {
    ...monitor,
    pool: monitor.pool.map((p) => ({ ...p, trend: {} })),
    watchList: monitor.watchList.map((p) => ({ ...p, trend: {} })),
  };
  const p = composeDashboard({ meta, monitor: buggy });
  assert.ok(p, '归一化后应正常聚合');
  assert.equal(p.kpi.totalModels, monitor.pool.length);
  assert.equal(p.kpi.watchCount, monitor.watchList.length);
  // trend 不影响 topRows 排序（用 delta.orderRate）
  const clean = composeDashboard({ meta, monitor });
  assert.deepEqual(
    p.topRows.map((r) => r.modelName),
    clean.topRows.map((r) => r.modelName),
    'trend 全 {} 情况下 topRows 排序不受影响'
  );
});

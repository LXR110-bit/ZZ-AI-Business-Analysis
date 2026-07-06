// 监测逻辑
// 1. TOP N 入池(按估价 UV)
// 2. 5 个转化率周环比波动 > 阈值
// 3. 连续 N 周同向

const DEFAULT_RULES = {
  poolTopN: 20, // 每个品类取估价 UV TOP N
  poolMinWeek: null, // null = 用最新周
  waveThreshold: 0.1, // 周波动阈值 10%
  trendWeeks: 3, // 连续 N 周同向
  minEvaUv: 15, // 分母保护:日均估价 UV 太小的机型不参与波动/趋势判断
  rates: [
    { key: 'evaRate', name: '估价完成率' },
    { key: 'orderRate', name: '估价下单率' },
    { key: 'shipRate', name: '估价发货率' },
    { key: 'dealRate', name: '估价成交率' },
    { key: 'returnRate', name: '质检退回率' },
  ],
};

// 按 category+modelName 聚合成时间序列
function buildSeries(rows) {
  const map = new Map(); // key: cat||model, val: {category, modelName, weekly: Map<week, row>}
  for (const r of rows) {
    const key = `${r.category}||${r.modelName}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { category: r.category, modelName: r.modelName, weekly: new Map() };
      map.set(key, entry);
    }
    // 同一 category+model+week 如果多行,取最后一条
    entry.weekly.set(r.week, r);
  }
  return map;
}

// 计算某机型某周相比上一周的波动
function calcDelta(cur, prev) {
  if (!prev) return null;
  const out = {};
  for (const { key } of DEFAULT_RULES.rates) {
    const cv = cur[key];
    const pv = prev[key];
    if (cv === null || pv === null || pv === 0) {
      out[key] = null;
    } else {
      out[key] = (cv - pv) / pv;
    }
  }
  return out;
}

// 连续 N 周同向:返回 { key: 'up'|'down'|null }
function calcTrend(weeklyList, weeks, ratesKeys) {
  // weeklyList: 按 week 升序的行数组
  if (weeklyList.length < weeks) return {};
  const tail = weeklyList.slice(-weeks);
  const out = {};
  for (const k of ratesKeys) {
    let allUp = true;
    let allDown = true;
    for (let i = 1; i < tail.length; i++) {
      const cv = tail[i][k];
      const pv = tail[i - 1][k];
      if (cv === null || pv === null || pv === 0) {
        allUp = allDown = false;
        break;
      }
      if (cv <= pv) allUp = false;
      if (cv >= pv) allDown = false;
    }
    out[k] = allUp ? 'up' : allDown ? 'down' : null;
  }
  return out;
}

// 主监测函数
// cache: sync.js 生成的 cache.json
// rules: 用户配置
// tags: { 'category||modelName': [tag1, tag2] } (可选,用于附加显示)
function monitor(cache, rules = {}, tagsMap = {}, opts = {}) {
  const R = { ...DEFAULT_RULES, ...rules };
  const rows = cache.rows || [];
  const allWeeks = (cache.weeks || []).slice().sort();
  if (allWeeks.length === 0) return { pool: [], watchList: [], weeks: [] };

  // 目标周：优先取 opts.week（前端筛选），否则规则中的 poolMinWeek，最后回退到最新周
  const overrideWeek = opts.week && allWeeks.includes(opts.week) ? opts.week : null;
  const targetWeek = overrideWeek || R.poolMinWeek || allWeeks[allWeeks.length - 1];
  const prevWeek = allWeeks[allWeeks.indexOf(targetWeek) - 1];

  // 建立时序
  const series = buildSeries(rows);

  // 每个品类下按 targetWeek 的估价 UV 取 TOP N
  const catGroups = new Map(); // cat -> array of { model, thisWeekRow }
  for (const [, entry] of series) {
    const cur = entry.weekly.get(targetWeek);
    if (!cur) continue;
    let arr = catGroups.get(entry.category);
    if (!arr) {
      arr = [];
      catGroups.set(entry.category, arr);
    }
    arr.push({ entry, cur });
  }

  const pool = [];
  for (const [cat, list] of catGroups) {
    list.sort((a, b) => (b.cur.evaUv || 0) - (a.cur.evaUv || 0));
    const topN = list.slice(0, R.poolTopN);
    for (const item of topN) {
      const { entry, cur } = item;
      const prev = prevWeek ? entry.weekly.get(prevWeek) : null;
      const delta = calcDelta(cur, prev);

      // 排序 weekly 为按 week 升序,用于趋势判断
      const weeklyArr = [...entry.weekly.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([, v]) => v);
      // 只取 targetWeek 及之前的
      const idxT = weeklyArr.findIndex((r) => r.week === targetWeek);
      const tail = idxT >= 0 ? weeklyArr.slice(0, idxT + 1) : weeklyArr;
      const trend = calcTrend(tail, R.trendWeeks, R.rates.map((r) => r.key));

      const key = `${cat}||${entry.modelName}`;
      pool.push({
        category: cat,
        modelName: entry.modelName,
        tags: tagsMap[key] || [],
        cur,
        prev,
        delta,
        trend,
      });
    }
  }

  // 从 pool 里筛出需要 关注的
  const watchList = [];
  for (const p of pool) {
    const flags = [];
    if (p.cur.evaUv >= R.minEvaUv) {
      // 波动检测
      if (p.delta) {
        for (const { key, name } of R.rates) {
          const d = p.delta[key];
          if (d !== null && Math.abs(d) >= R.waveThreshold) {
            flags.push({ type: 'wave', metric: key, name, delta: d });
          }
        }
      }
      // 趋势检测
      for (const { key, name } of R.rates) {
        const t = p.trend[key];
        if (t) flags.push({ type: 'trend', metric: key, name, direction: t });
      }
    }
    if (flags.length) watchList.push({ ...p, flags });
  }

  return {
    targetWeek,
    prevWeek,
    weeks: allWeeks,
    pool,
    watchList,
    rules: R,
  };
}

module.exports = { monitor, DEFAULT_RULES };

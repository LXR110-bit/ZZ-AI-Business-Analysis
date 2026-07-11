// 监测逻辑
// 1. TOP N 入池(按估价 UV)
// 2. 5 个转化率周环比波动 > 阈值
// 3. 连续 N 周同向
// 4. v1.5: 基于全量机型输出标签维度聚合(不受 TOP N pool 限制)

const {
  DEFAULT_TAG_VOCAB,
  UNTAGGED_VALUE,
  buildDimensionDefinitions,
  findDimensionDefinition,
  normalizeTagRecord,
  normalizeTagVocab,
  tagValueFor,
} = require('./tagging');

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

const COUNT_KEYS = ['jkuv', 'evaUv', 'orderUv', 'shipCnt', 'qcCnt', 'dealCnt', 'gmv', 'returnCnt'];

function safeDiv(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return null;
  return x / y;
}

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

function flagsForItem(item, rules) {
  const flags = [];
  if (!item || !item.cur || item.cur.evaUv < rules.minEvaUv) return flags;
  if (item.delta) {
    for (const { key, name } of rules.rates) {
      const d = item.delta[key];
      if (d !== null && typeof d === 'number' && Math.abs(d) >= rules.waveThreshold) {
        flags.push({ type: 'wave', metric: key, name, delta: d });
      }
    }
  }
  for (const { key, name } of rules.rates) {
    const t = item.trend && item.trend[key];
    if (t) flags.push({ type: 'trend', metric: key, name, direction: t });
  }
  return flags;
}

function tagRecordFor(tagsInput, key, category) {
  const raw = tagsInput && tagsInput[key];
  return normalizeTagRecord(raw || {}, { category });
}

function buildModelItem(entry, cur, prevWeek, targetWeek, rules, tagsInput) {
  const prev = prevWeek ? entry.weekly.get(prevWeek) : null;
  const delta = calcDelta(cur, prev);
  const weeklyArr = [...entry.weekly.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, v]) => v);
  const idxT = weeklyArr.findIndex((r) => r.week === targetWeek);
  const tail = idxT >= 0 ? weeklyArr.slice(0, idxT + 1) : weeklyArr;
  const trend = calcTrend(tail, rules.trendWeeks, rules.rates.map((r) => r.key));
  const key = `${entry.category}||${entry.modelName}`;
  const tagRecord = tagRecordFor(tagsInput, key, entry.category);
  const item = {
    category: entry.category,
    modelName: entry.modelName,
    tags: tagRecord.tags || [],
    dimensions: tagRecord.dimensions || {},
    note: tagRecord.note || '',
    cur,
    prev,
    delta,
    trend,
  };
  const flags = flagsForItem(item, rules);
  return flags.length ? { ...item, flags } : item;
}

function buildFullModelItems(series, targetWeek, prevWeek, rules, tagsInput, categoryFilter = '') {
  const items = [];
  for (const [, entry] of series) {
    if (categoryFilter && entry.category !== categoryFilter) continue;
    const cur = entry.weekly.get(targetWeek);
    if (!cur) continue;
    items.push(buildModelItem(entry, cur, prevWeek, targetWeek, rules, tagsInput));
  }
  items.sort((a, b) => ((b.cur && b.cur.evaUv) || 0) - ((a.cur && a.cur.evaUv) || 0)
    || String(a.category).localeCompare(String(b.category), 'zh-CN')
    || String(a.modelName).localeCompare(String(b.modelName), 'zh-CN'));
  return items;
}

function sumCur(models) {
  const cur = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  for (const model of models) {
    const row = model.cur || {};
    for (const key of COUNT_KEYS) {
      const n = Number(row[key]);
      if (Number.isFinite(n)) cur[key] += n;
    }
  }
  cur.evaRate = safeDiv(cur.evaUv, cur.jkuv);
  cur.orderRate = safeDiv(cur.orderUv, cur.evaUv);
  cur.shipRate = safeDiv(cur.shipCnt, cur.evaUv);
  cur.dealRate = safeDiv(cur.dealCnt, cur.evaUv);
  cur.returnRate = safeDiv(cur.returnCnt, cur.qcCnt);
  return cur;
}

function summarizeTagGroup(value, models) {
  const categorySet = new Set(models.map((m) => m.category).filter(Boolean));
  const watchCount = models.filter((m) => (m.flags || []).length).length;
  const downTrendCount = models.filter((m) => (m.flags || []).some((f) => f.type === 'trend' && f.direction === 'down')).length;
  return {
    value,
    label: value,
    modelCount: models.length,
    categoryCount: categorySet.size,
    cur: sumCur(models),
    watchCount,
    downTrendCount,
    models,
  };
}

function buildTagSummary({ fullModels, tagDimension, tagVocab, category }) {
  const vocab = normalizeTagVocab(tagVocab || DEFAULT_TAG_VOCAB);
  const dimensions = buildDimensionDefinitions(vocab, category);
  const selectedDimension = findDimensionDefinition(vocab, tagDimension || 'core', category);
  const dimensionKey = selectedDimension ? selectedDimension.key : 'core';
  const dimension = selectedDimension || dimensions[0];
  const grouped = new Map();
  for (const model of fullModels) {
    const value = tagValueFor(model, dimensionKey);
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(model);
  }

  const orderedValues = [];
  for (const opt of dimension.options || []) {
    if (!orderedValues.includes(opt)) orderedValues.push(opt);
  }
  for (const value of grouped.keys()) {
    if (value !== UNTAGGED_VALUE && !orderedValues.includes(value)) orderedValues.push(value);
  }
  if (!orderedValues.includes(UNTAGGED_VALUE)) orderedValues.push(UNTAGGED_VALUE);

  const groups = orderedValues
    .map((value) => summarizeTagGroup(value, grouped.get(value) || []))
    // 保留未打标和字典枚举，即使当前为 0，便于前端作为选项展示。
    .filter((g) => g.modelCount > 0 || (dimension.options || []).includes(g.value) || g.value === UNTAGGED_VALUE);

  return {
    dimension: dimensionKey,
    label: dimension.label,
    category: dimension.category || category || null,
    groups,
  };
}

// 主监测函数
// cache: sync.js 生成的 cache.json
// rules: 用户配置
// tags: { 'category||modelName': { dimensions, tags, note } } 或旧 { 'category||modelName': [tag1, tag2] }
function monitor(cache, rules = {}, tagsMap = {}, opts = {}) {
  const R = { ...DEFAULT_RULES, ...rules };
  const rows = cache.rows || [];
  const allWeeks = (cache.weeks || []).slice().sort();
  if (allWeeks.length === 0) return { pool: [], watchList: [], weeks: [], tagDimensions: [], tagSummary: { dimension: 'core', groups: [] }, tagModels: [] };

  // 目标周：优先取 opts.week（前端筛选），否则规则中的 poolMinWeek，最后回退到最新周
  const overrideWeek = opts.week && allWeeks.includes(opts.week) ? opts.week : null;
  const targetWeek = overrideWeek || R.poolMinWeek || allWeeks[allWeeks.length - 1];
  const prevWeek = allWeeks[allWeeks.indexOf(targetWeek) - 1];
  const categoryFilter = String(opts.category || '').trim();
  const tagVocab = normalizeTagVocab(opts.tagVocab || DEFAULT_TAG_VOCAB);

  // 建立时序
  const series = buildSeries(rows);

  // v1.5 标签维度聚合必须基于全量机型，不受 TOP N pool 限制。
  const fullModels = buildFullModelItems(series, targetWeek, prevWeek, R, tagsMap, categoryFilter);
  const tagDimensions = buildDimensionDefinitions(tagVocab, categoryFilter);
  const tagSummary = buildTagSummary({
    fullModels,
    tagDimension: opts.tagDimension || 'core',
    tagVocab,
    category: categoryFilter,
  });
  const selectedTagValue = String(opts.tagValue || '').trim();
  const tagModels = selectedTagValue
    ? (tagSummary.groups.find((g) => g.value === selectedTagValue) || { models: [] }).models
    : fullModels;

  // 每个品类下按 targetWeek 的估价 UV 取 TOP N，保持原监测池契约。
  const catGroups = new Map(); // cat -> array of { model, thisWeekRow }
  for (const [, entry] of series) {
    if (categoryFilter && entry.category !== categoryFilter) continue;
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
  for (const [, list] of catGroups) {
    list.sort((a, b) => (b.cur.evaUv || 0) - (a.cur.evaUv || 0));
    const topN = list.slice(0, R.poolTopN);
    for (const item of topN) {
      pool.push(buildModelItem(item.entry, item.cur, prevWeek, targetWeek, R, tagsMap));
    }
  }

  const watchList = pool.filter((p) => (p.flags || []).length);

  return {
    targetWeek,
    prevWeek,
    weeks: allWeeks,
    pool,
    watchList,
    rules: R,
    tagDimensions,
    tagSummary,
    tagModels,
  };
}

module.exports = {
  monitor,
  DEFAULT_RULES,
  // Exported for focused v1.5 unit tests.
  buildFullModelItems,
  buildTagSummary,
  calcDelta,
  calcTrend,
};

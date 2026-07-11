'use strict';

const UNTAGGED_VALUE = '未打标';

const DEFAULT_TAG_VOCAB = {
  lifecycle: ['新品', '主流', '长尾', '淘汰'],
  price: ['高价段', '中价段', '低价段'],
  core: ['核心', '非核心', '观察'],
  custom: {},
};

const BASE_DIMENSIONS = [
  { key: 'core', label: '核心度', vocabKey: 'core' },
  { key: 'lifecycle', label: '生命周期', vocabKey: 'lifecycle' },
  { key: 'price', label: '价格段', vocabKey: 'price' },
];

function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const s = String(item == null ? '' : item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function sanitizeId(value, fallback, used) {
  let id = String(value || '').trim()
    .replace(/[^0-9A-Za-z_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!id) id = fallback;
  let candidate = id;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${id}_${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeCustomDimensions(custom) {
  const out = {};
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return out;
  for (const [categoryRaw, dimsRaw] of Object.entries(custom)) {
    const category = String(categoryRaw || '').trim();
    if (!category || !Array.isArray(dimsRaw)) continue;
    const dims = [];
    const used = new Set();
    let idx = 1;
    for (const raw of dimsRaw) {
      // v1.5 intentionally does not migrate old shape custom[category]=['标签A', ...].
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const name = String(raw.name || '').trim();
      const options = uniqStrings(raw.options);
      if (!name && !options.length) continue;
      const id = sanitizeId(raw.id, `custom_${idx}`, used);
      dims.push({ id, name: name || `自定义标签${idx}`, options });
      idx += 1;
    }
    if (dims.length) out[category] = dims;
  }
  return out;
}

function normalizeTagVocab(input = DEFAULT_TAG_VOCAB) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    lifecycle: Array.isArray(src.lifecycle) ? uniqStrings(src.lifecycle) : DEFAULT_TAG_VOCAB.lifecycle.slice(),
    price: Array.isArray(src.price) ? uniqStrings(src.price) : DEFAULT_TAG_VOCAB.price.slice(),
    core: Array.isArray(src.core) ? uniqStrings(src.core) : DEFAULT_TAG_VOCAB.core.slice(),
    custom: normalizeCustomDimensions(src.custom),
  };
}

function customDimensionKey(category, id) {
  return `custom:${category}:${id}`;
}

function parseModelKey(key) {
  const [category = '', ...rest] = String(key || '').split('||');
  return { category, modelName: rest.join('||') };
}

function buildDimensionDefinitions(vocabInput, category = '') {
  const vocab = normalizeTagVocab(vocabInput);
  const defs = BASE_DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    options: vocab[d.vocabKey] || [],
    categoryScoped: false,
  }));
  const cat = String(category || '').trim();
  if (cat && Array.isArray(vocab.custom[cat])) {
    for (const dim of vocab.custom[cat]) {
      defs.push({
        key: customDimensionKey(cat, dim.id),
        label: dim.name,
        options: dim.options || [],
        categoryScoped: true,
        category: cat,
        id: dim.id,
      });
    }
  }
  return defs;
}

function findDimensionDefinition(vocabInput, key, category = '') {
  const wanted = String(key || '').trim();
  const direct = buildDimensionDefinitions(vocabInput, category).find((d) => d.key === wanted);
  if (direct) return direct;
  const vocab = normalizeTagVocab(vocabInput);
  for (const cat of Object.keys(vocab.custom || {})) {
    const hit = buildDimensionDefinitions(vocab, cat).find((d) => d.key === wanted);
    if (hit) return hit;
  }
  return buildDimensionDefinitions(vocab, category)[0];
}

function flattenDimensionTags(dimensions) {
  return Object.values(dimensions || {}).map((v) => String(v || '').trim()).filter(Boolean);
}

function inferDimensionsFromTags(tags, vocabInput, category = '') {
  const vocab = normalizeTagVocab(vocabInput);
  const dimensions = {};
  const defs = buildDimensionDefinitions(vocab, category);
  for (const tag of uniqStrings(tags)) {
    for (const def of defs) {
      if (!dimensions[def.key] && (def.options || []).includes(tag)) {
        dimensions[def.key] = tag;
        break;
      }
    }
  }
  return dimensions;
}

function normalizeDimensions(rawDimensions) {
  const out = {};
  if (!rawDimensions || typeof rawDimensions !== 'object' || Array.isArray(rawDimensions)) return out;
  for (const [keyRaw, valueRaw] of Object.entries(rawDimensions)) {
    const key = String(keyRaw || '').trim();
    const value = String(valueRaw == null ? '' : valueRaw).trim();
    if (!key || !value || value === UNTAGGED_VALUE) continue;
    out[key] = value;
  }
  return out;
}

function normalizeTagRecord(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const note = String(src.note || '');
  let dimensions = normalizeDimensions(src.dimensions);
  if (!Object.keys(dimensions).length && Array.isArray(src.tags)) {
    dimensions = inferDimensionsFromTags(src.tags, opts.vocab || DEFAULT_TAG_VOCAB, opts.category || '');
  }
  return {
    dimensions,
    note,
    // Compatibility for existing monitor/table renderers until the v1.5 UI fully consumes dimensions.
    tags: Object.keys(dimensions).length ? flattenDimensionTags(dimensions) : uniqStrings(src.tags),
  };
}

function normalizeTagsStore(input = {}, opts = {}) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const [key, value] of Object.entries(src)) {
    if (!String(key).includes('||')) continue;
    const { category } = parseModelKey(key);
    out[key] = normalizeTagRecord(value, { ...opts, category });
  }
  return out;
}

function tagValueFor(record, dimensionKey) {
  const v = record && record.dimensions ? String(record.dimensions[dimensionKey] || '').trim() : '';
  return v || UNTAGGED_VALUE;
}

module.exports = {
  BASE_DIMENSIONS,
  DEFAULT_TAG_VOCAB,
  UNTAGGED_VALUE,
  buildDimensionDefinitions,
  customDimensionKey,
  findDimensionDefinition,
  flattenDimensionTags,
  normalizeTagRecord,
  normalizeTagsStore,
  normalizeTagVocab,
  parseModelKey,
  tagValueFor,
  uniqStrings,
};

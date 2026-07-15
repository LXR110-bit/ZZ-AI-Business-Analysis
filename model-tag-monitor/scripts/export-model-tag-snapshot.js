#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  BASE_DIMENSIONS,
  DEFAULT_TAG_VOCAB,
  buildDimensionDefinitions,
  findDimensionDefinition,
  normalizeTagsStore,
  normalizeTagVocab,
  parseModelKey,
  uniqStrings,
} = require('../src/tagging');
const { DEFAULT_RULES } = require('../src/monitor');
const PACKAGE_VERSION = require('../package.json').version;

const DEFAULT_API_BASE = 'http://127.0.0.1:8848';
const DEFAULT_RUN_ID_PREFIX = 'model_tag_sync';
const DEFAULT_EXAMPLE_LIMIT = 20;

function usage() {
  return `Usage: node scripts/export-model-tag-snapshot.js [options]\n\n` +
    `Exports model_tag_snapshot_<run_dt>.json and model_tag_knowledge_<run_dt>.json.\n\n` +
    `Options:\n` +
    `  --source api|file            Source mode. Default: api when --api-base is set, otherwise file.\n` +
    `  --api-base URL              model-tag-monitor server base. Default: ${DEFAULT_API_BASE} for source=api.\n` +
    `  --access-code CODE          Optional access code; script POSTs /api/access/verify and reuses cookie.\n` +
    `  --cookie COOKIE             Optional Cookie header for gated /api endpoints. Env: API_COOKIE.\n` +
    `  --data-dir DIR              File source directory. Default: model-tag-monitor/data.\n` +
    `  --out-dir DIR               Output directory. Default: data-dir.\n` +
    `  --run-dt YYYY-MM-DD         Business date. Default: today's local date.\n` +
    `  --run-id ID                 Run id. Default: model_tag_sync_<run_dt>.\n` +
    `  --generated-at ISO          Override generated_at for deterministic tests.\n` +
    `  --allow-file-fallback       If API source fails, fall back to file source and mark status=warn.\n` +
    `  --fallback-data-dir DIR      File fallback directory. Default: data-dir.\n` +
    `  --feishu-doc DOC_OR_URL      Optional Lark/Feishu Doc or Wiki doc URL/token to overwrite with summary.\n` +
    `  --feishu-as user|bot         Identity for lark-cli docs +update. Default: user. Env: FEISHU_SYNC_AS.\n` +
    `  --feishu-dry-run            Preview Feishu write through lark-cli --dry-run.\n` +
    `  --lark-cli-cmd CMD           lark-cli command. Default: lark-cli. Env: LARK_CLI_CMD.\n` +
    `  --no-feishu-md              Do not write model_tag_feishu_summary_<run_dt>.md.\n` +
    `  --no-manifest               Do not write model_tag_sync_manifest_<run_dt>.json.\n` +
    `  --quiet                     Print only the result JSON.\n`;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--quiet') args.quiet = true;
    else if (token === '--no-feishu-md') args.noFeishuMd = true;
    else if (token === '--no-manifest') args.noManifest = true;
    else if (token === '--allow-file-fallback') args.allowFileFallback = true;
    else if (token === '--feishu-dry-run') args.feishuDryRun = true;
    else if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`Missing value for ${token}`);
      args[key] = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function todayLocalDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function assertRunDt(runDt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(runDt || ''))) {
    throw new Error(`run_dt must be YYYY-MM-DD, got: ${runDt}`);
  }
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sortObject(value[key]);
  return out;
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(sortObject(value))).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJsonIfExists(file, fallback, warnings, label) {
  if (!fs.existsSync(file)) {
    if (warnings && label) warnings.push(`${label} missing; using default`);
    return fallback;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeRules(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    ...DEFAULT_RULES,
    ...src,
    rates: DEFAULT_RULES.rates,
  };
}

function pathForDisplay(p) {
  return path.resolve(p);
}

function truncateText(value, max = 1000) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function errorMessage(err) {
  return truncateText((err && (err.stack || err.message)) || err, 1200);
}

function splitCommand(command) {
  const text = String(command || '').trim();
  if (!text) return ['lark-cli'];
  // Good enough for env values such as "sudo -n lark-cli"; paths with spaces should use a wrapper script.
  return text.split(/\s+/).filter(Boolean);
}

async function getJson(apiBase, pathname, headers) {
  const res = await fetch(`${apiBase}${pathname}`, { headers: { Accept: 'application/json', ...headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${pathname} HTTP ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function appendSetCookie(existingCookie, setCookieHeader) {
  const pairs = [];
  if (existingCookie) pairs.push(existingCookie);
  const raw = typeof setCookieHeader === 'string' ? setCookieHeader : '';
  if (raw) {
    // Node fetch exposes a single comma-joined string; access cookie value has no comma.
    const first = raw.split(';')[0].trim();
    if (first) pairs.push(first);
  }
  return pairs.join('; ');
}

async function verifyAccess(apiBase, accessCode, cookie, user = 'zloop-process') {
  if (!accessCode) return cookie || '';
  const res = await fetch(`${apiBase}/api/access/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ name: user, code: accessCode }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/api/access/verify HTTP ${res.status}: ${text.slice(0, 500)}`);
  const setCookie = res.headers.get('set-cookie') || '';
  return appendSetCookie(cookie, setCookie);
}

async function loadBundleFromApi(options) {
  const apiBase = String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const cookie = await verifyAccess(apiBase, options.accessCode, options.cookie, options.user);
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (options.user) headers['X-User'] = encodeURIComponent(options.user);
  const [tags, vocab, rules] = await Promise.all([
    getJson(apiBase, '/api/tags', headers),
    getJson(apiBase, '/api/tag-vocab', headers),
    getJson(apiBase, '/api/rules', headers),
  ]);
  return {
    tags,
    vocab,
    rules,
    source: {
      mode: 'api',
      api_base: apiBase,
      endpoints: ['/api/tags', '/api/tag-vocab', '/api/rules'],
      authenticated: Boolean(cookie || options.accessCode),
    },
    warnings: [],
  };
}

function loadBundleFromFiles(options) {
  const dataDir = path.resolve(options.dataDir || path.join(__dirname, '..', 'data'));
  const warnings = [];
  const tags = readJsonIfExists(path.join(dataDir, 'tags.json'), {}, warnings, 'tags.json');
  const vocab = readJsonIfExists(path.join(dataDir, 'tag-vocab.json'), DEFAULT_TAG_VOCAB, warnings, 'tag-vocab.json');
  const rules = readJsonIfExists(path.join(dataDir, 'rules.json'), DEFAULT_RULES, warnings, 'rules.json');
  return {
    tags,
    vocab,
    rules,
    source: {
      mode: 'file',
      data_dir: pathForDisplay(dataDir),
      files: ['tags.json', 'tag-vocab.json', 'rules.json'],
    },
    warnings,
  };
}

function dimensionCatalog(vocab) {
  const custom = {};
  let customDimensionCount = 0;
  for (const category of Object.keys(vocab.custom || {}).sort()) {
    custom[category] = (vocab.custom[category] || []).map((dim) => {
      customDimensionCount += 1;
      return {
        key: `custom:${category}:${dim.id}`,
        id: dim.id,
        label: dim.name,
        options: dim.options || [],
        category_scoped: true,
      };
    });
  }
  return {
    base_dimensions: BASE_DIMENSIONS.map((dim) => ({
      key: dim.key,
      label: dim.label,
      options: vocab[dim.vocabKey] || [],
      category_scoped: false,
    })),
    custom_dimensions_by_category: custom,
    custom_dimension_count: customDimensionCount,
  };
}

function dimensionLabel(vocab, category, key) {
  const def = findDimensionDefinition(vocab, key, category);
  return def && def.key === key ? def.label : key;
}

function customDimensionMap(vocab, category, dimensions) {
  const out = {};
  for (const [key, value] of Object.entries(dimensions || {})) {
    if (!key.startsWith('custom:')) continue;
    out[dimensionLabel(vocab, category, key)] = value;
  }
  return out;
}

function addExample(list, entry, limit = DEFAULT_EXAMPLE_LIMIT) {
  if (list.length >= limit) return;
  const sample = { model_name: entry.model_name };
  if (entry.note) sample.note = entry.note;
  list.push(sample);
}

function buildSnapshot(rawBundle, options = {}) {
  const runDt = options.runDt || todayLocalDate();
  assertRunDt(runDt);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const runId = options.runId || `${DEFAULT_RUN_ID_PREFIX}_${runDt}`;
  const vocab = normalizeTagVocab(rawBundle.vocab || DEFAULT_TAG_VOCAB);
  const tags = normalizeTagsStore(rawBundle.tags || {}, { vocab });
  const rules = normalizeRules(rawBundle.rules || DEFAULT_RULES);
  const keys = Object.keys(tags).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const entries = [];
  const tagsByKey = {};
  let dimensionAssignmentCount = 0;
  let noteCount = 0;
  const categories = new Set();

  for (const key of keys) {
    const { category, modelName } = parseModelKey(key);
    categories.add(category);
    const rec = tags[key] || {};
    const dimensions = rec.dimensions || {};
    dimensionAssignmentCount += Object.keys(dimensions).length;
    if (String(rec.note || '').trim()) noteCount += 1;
    const entry = {
      key,
      category,
      model_name: modelName,
      dimensions,
      tags: rec.tags || [],
      note: String(rec.note || ''),
    };
    entries.push(entry);
    tagsByKey[key] = {
      dimensions,
      tags: rec.tags || [],
      note: String(rec.note || ''),
    };
  }

  const catalog = dimensionCatalog(vocab);
  const snapshotBase = {
    schema_version: 'model_tag_snapshot/v1',
    artifact_type: 'model_tag_snapshot',
    app: 'AI小万',
    app_version: PACKAGE_VERSION,
    run_id: runId,
    run_dt: runDt,
    generated_at: generatedAt,
    source_of_truth: 'model-tag-monitor-server-front-end-tags',
    source: rawBundle.source || {},
    warnings: rawBundle.warnings || [],
    stats: {
      tagged_model_count: entries.length,
      category_count: categories.size,
      categories: [...categories].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      dimension_assignment_count: dimensionAssignmentCount,
      note_count: noteCount,
      custom_dimension_count: catalog.custom_dimension_count,
    },
    vocab,
    dimension_catalog: catalog,
    rules,
    tags: tagsByKey,
    entries,
  };
  return { ...snapshotBase, sha256: sha256Json(snapshotBase) };
}

function summarizeDimension(bucket, entry, dimensionKey, value, label) {
  if (!bucket.dimensions[dimensionKey]) {
    bucket.dimensions[dimensionKey] = {
      key: dimensionKey,
      label,
      values: {},
    };
  }
  const dim = bucket.dimensions[dimensionKey];
  if (!dim.values[value]) dim.values[value] = { value, model_count: 0, examples: [] };
  dim.values[value].model_count += 1;
  addExample(dim.values[value].examples, entry);
}

function buildKnowledge(snapshot, options = {}) {
  const exampleLimit = Number(options.exampleLimit || DEFAULT_EXAMPLE_LIMIT);
  const byCategory = {};
  const modelEnrichment = {};

  for (const entry of snapshot.entries || []) {
    if (!byCategory[entry.category]) {
      byCategory[entry.category] = {
        category: entry.category,
        tagged_model_count: 0,
        note_count: 0,
        dimensions: {},
        examples: [],
      };
    }
    const bucket = byCategory[entry.category];
    bucket.tagged_model_count += 1;
    if (entry.note) bucket.note_count += 1;
    addExample(bucket.examples, entry, exampleLimit);

    const baseDimensions = {
      core: entry.dimensions.core || '',
      lifecycle: entry.dimensions.lifecycle || '',
      price: entry.dimensions.price || '',
    };
    modelEnrichment[entry.key] = {
      category: entry.category,
      model_name: entry.model_name,
      ...baseDimensions,
      custom_dimensions: customDimensionMap(snapshot.vocab, entry.category, entry.dimensions),
      all_dimensions: entry.dimensions,
      tags: entry.tags || [],
      note: entry.note || '',
    };

    for (const [dimensionKey, value] of Object.entries(entry.dimensions || {})) {
      const label = dimensionLabel(snapshot.vocab, entry.category, dimensionKey);
      summarizeDimension(bucket, entry, dimensionKey, value, label);
    }
  }

  const categorySummaries = Object.values(byCategory)
    .sort((a, b) => a.category.localeCompare(b.category, 'zh-Hans-CN'))
    .map((cat) => {
      const dimensions = Object.values(cat.dimensions)
        .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
        .map((dim) => ({
          ...dim,
          values: Object.values(dim.values)
            .sort((a, b) => b.model_count - a.model_count || a.value.localeCompare(b.value, 'zh-Hans-CN')),
        }));
      return { ...cat, dimensions };
    });

  const lines = [];
  lines.push(`# AI 小万机型标签分层摘要（${snapshot.run_dt}）`);
  lines.push('');
  lines.push(`- Source of truth：服务器前端打标结果（tags/tag-vocab/rules），飞书知识库仅接收摘要，不作为首版写入源。`);
  lines.push(`- Tagged models：${snapshot.stats.tagged_model_count}；Categories：${snapshot.stats.category_count}；Dimension assignments：${snapshot.stats.dimension_assignment_count}。`);
  if ((snapshot.warnings || []).length) lines.push(`- Warnings：${snapshot.warnings.join('；')}`);
  lines.push('');
  for (const cat of categorySummaries) {
    lines.push(`## ${cat.category}`);
    lines.push(`- 已打标机型：${cat.tagged_model_count}；带备注：${cat.note_count}`);
    for (const dim of cat.dimensions) {
      const topValues = dim.values.slice(0, 8).map((v) => `${v.value} ${v.model_count}`).join(' / ');
      lines.push(`- ${dim.label}：${topValues || '无'}`);
    }
    lines.push('');
  }

  const knowledgeBase = {
    schema_version: 'model_tag_knowledge/v1',
    artifact_type: 'model_tag_knowledge',
    app: snapshot.app,
    app_version: snapshot.app_version,
    run_id: snapshot.run_id,
    run_dt: snapshot.run_dt,
    generated_at: snapshot.generated_at,
    source_snapshot_sha256: snapshot.sha256,
    source_of_truth: snapshot.source_of_truth,
    rules_summary: {
      pool_top_n: snapshot.rules.poolTopN,
      wave_threshold: snapshot.rules.waveThreshold,
      trend_weeks: snapshot.rules.trendWeeks,
      min_eva_uv: snapshot.rules.minEvaUv,
      rates: snapshot.rules.rates,
    },
    dimension_catalog: snapshot.dimension_catalog,
    category_summaries: categorySummaries,
    model_enrichment: modelEnrichment,
    feishu_knowledge_summary: {
      title: `AI 小万机型标签分层摘要（${snapshot.run_dt}）`,
      target: '飞书知识库摘要页',
      write_mode: 'summary_only_not_source_of_truth',
      markdown: lines.join('\n'),
    },
    consumer_contract: {
      analyze_stage_required: true,
      join_key: 'category||model_name',
      missing_tag_policy: 'treat_as_未打标_and_do_not_infer_core/lifecycle/price',
      llm_usage: 'Analyze may quote category_summaries and model_enrichment; Process exporter itself does not call LLM.',
    },
  };
  return { ...knowledgeBase, sha256: sha256Json(knowledgeBase) };
}

async function loadRawBundle(options = {}) {
  const source = options.source || (options.apiBase ? 'api' : 'file');
  if (source === 'api') {
    try {
      return await loadBundleFromApi(options);
    } catch (err) {
      const canFallback = Boolean(options.allowFileFallback || options.fallbackDataDir);
      if (!canFallback) throw err;
      const fallback = loadBundleFromFiles({ ...options, dataDir: options.fallbackDataDir || options.dataDir });
      return {
        ...fallback,
        source: {
          mode: 'file_fallback',
          requested: {
            mode: 'api',
            api_base: String(options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
            endpoints: ['/api/tags', '/api/tag-vocab', '/api/rules'],
          },
          fallback: fallback.source,
          api_error: errorMessage(err),
        },
        warnings: [
          ...(fallback.warnings || []),
          `api source failed; used file fallback: ${errorMessage(err)}`,
        ],
        knownGaps: ['model_tag_api_unavailable_used_file_fallback'],
      };
    }
  }
  if (source === 'file') return loadBundleFromFiles(options);
  throw new Error(`Unknown source: ${source}`);
}

function runFeishuSummarySync(markdownFile, options = {}) {
  const target = String(options.feishuDoc || '').trim();
  const writeMode = 'summary_only_not_source_of_truth';
  if (!target) {
    return {
      status: 'not_configured',
      write_mode: writeMode,
      known_gap: 'feishu_knowledge_summary_sync_not_configured',
      message: 'Set FEISHU_KNOWLEDGE_DOC or --feishu-doc to sync the Markdown summary to Feishu Wiki/Doc.',
    };
  }
  if (!markdownFile) {
    return {
      status: 'failed',
      write_mode: writeMode,
      target,
      known_gap: 'feishu_knowledge_summary_sync_failed',
      error: 'No markdown summary file was written; remove --no-feishu-md before enabling Feishu sync.',
    };
  }

  const [cmd, ...prefixArgs] = splitCommand(options.larkCliCmd || 'lark-cli');
  const args = [
    ...prefixArgs,
    'docs',
    '+update',
    '--doc', target,
    '--command', 'overwrite',
    '--doc-format', 'markdown',
    '--content', `@${markdownFile}`,
    '--as', options.feishuAs || 'user',
    '--json',
  ];
  if (options.feishuDryRun) args.push('--dry-run');

  const proc = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const base = {
    write_mode: writeMode,
    target,
    command: 'lark-cli docs +update --command overwrite --doc-format markdown',
    dry_run: Boolean(options.feishuDryRun),
    stdout: truncateText(proc.stdout, 2000),
    stderr: truncateText(proc.stderr, 2000),
  };
  if (proc.error) {
    return {
      ...base,
      status: 'failed',
      known_gap: 'feishu_knowledge_summary_sync_failed',
      error: errorMessage(proc.error),
    };
  }
  if (proc.status !== 0) {
    return {
      ...base,
      status: 'failed',
      exit_code: proc.status,
      known_gap: 'feishu_knowledge_summary_sync_failed',
      error: truncateText(proc.stderr || proc.stdout, 2000),
    };
  }
  return { ...base, status: options.feishuDryRun ? 'dry_run' : 'success' };
}

function buildSyncManifest(snapshot, knowledge, files, feishuSync, knownGaps = []) {
  const gaps = [...new Set((knownGaps || []).filter(Boolean))];
  const warnings = [...new Set([...(snapshot.warnings || [])])];
  if (!Object.keys(knowledge.model_enrichment || {}).length) gaps.push('model_tag_knowledge_empty');
  const status = gaps.length || warnings.length ? 'warn' : 'success';
  const manifestBase = {
    schema_version: 'model_tag_sync_manifest/v1',
    artifact_type: 'model_tag_sync_manifest',
    stage: 'process',
    status,
    run_id: snapshot.run_id,
    run_dt: snapshot.run_dt,
    generated_at: snapshot.generated_at,
    model_tag_snapshot: path.basename(files.snapshot),
    model_tag_knowledge: path.basename(files.knowledge),
    model_tag_feishu_summary: files.feishu_markdown ? path.basename(files.feishu_markdown) : '',
    model_tag_snapshot_sha256: snapshot.sha256,
    model_tag_knowledge_sha256: knowledge.sha256,
    model_tag_source: snapshot.source_of_truth,
    model_tag_stats: {
      tagged_model_count: snapshot.stats.tagged_model_count,
      category_count: snapshot.stats.category_count,
      dimension_assignment_count: snapshot.stats.dimension_assignment_count,
      custom_dimension_count: snapshot.stats.custom_dimension_count,
    },
    source: snapshot.source,
    feishu_sync: feishuSync,
    warnings,
    known_gaps: gaps,
  };
  return { ...manifestBase, sha256: sha256Json(manifestBase) };
}

async function exportModelTagArtifacts(options = {}) {
  const rawBundle = await loadRawBundle(options);
  const runDt = options.runDt || todayLocalDate();
  assertRunDt(runDt);
  const snapshot = buildSnapshot(rawBundle, { ...options, runDt });
  const knowledge = buildKnowledge(snapshot, options);
  const outDir = path.resolve(options.outDir || options.dataDir || path.join(__dirname, '..', 'data'));
  const snapshotFile = path.join(outDir, `model_tag_snapshot_${runDt}.json`);
  const knowledgeFile = path.join(outDir, `model_tag_knowledge_${runDt}.json`);
  writeJson(snapshotFile, snapshot);
  writeJson(knowledgeFile, knowledge);
  let feishuMarkdownFile = '';
  if (!options.noFeishuMd) {
    feishuMarkdownFile = path.join(outDir, `model_tag_feishu_summary_${runDt}.md`);
    fs.mkdirSync(path.dirname(feishuMarkdownFile), { recursive: true });
    fs.writeFileSync(feishuMarkdownFile, `${knowledge.feishu_knowledge_summary.markdown}\n`, 'utf8');
  }

  const feishuSync = runFeishuSummarySync(feishuMarkdownFile, options);
  const knownGaps = [...(rawBundle.knownGaps || [])];
  if (feishuSync.known_gap) knownGaps.push(feishuSync.known_gap);
  const files = {
    snapshot: snapshotFile,
    knowledge: knowledgeFile,
    feishu_markdown: feishuMarkdownFile || undefined,
  };
  let manifest;
  if (!options.noManifest) {
    const manifestFile = path.join(outDir, `model_tag_sync_manifest_${runDt}.json`);
    manifest = buildSyncManifest(snapshot, knowledge, files, feishuSync, knownGaps);
    writeJson(manifestFile, manifest);
    files.manifest = manifestFile;
  }
  return {
    ok: true,
    status: manifest ? manifest.status : (knownGaps.length || snapshot.warnings.length ? 'warn' : 'success'),
    run_dt: runDt,
    run_id: snapshot.run_id,
    source: rawBundle.source,
    stats: snapshot.stats,
    files,
    sha256: {
      snapshot: snapshot.sha256,
      knowledge: knowledge.sha256,
      manifest: manifest && manifest.sha256,
    },
    feishu_sync: feishuSync,
    known_gaps: manifest ? manifest.known_gaps : knownGaps,
    warnings: snapshot.warnings,
  };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await exportModelTagArtifacts({
    source: args.source,
    apiBase: args.apiBase || process.env.MODEL_TAG_API_BASE || process.env.API_BASE,
    accessCode: args.accessCode || process.env.ACCESS_CODE || process.env.MODEL_TAG_ACCESS_CODE,
    cookie: args.cookie || process.env.API_COOKIE || process.env.MODEL_TAG_API_COOKIE,
    user: args.user || process.env.MODEL_TAG_SYNC_USER || 'zloop-process',
    dataDir: args.dataDir || process.env.DATA_DIR,
    fallbackDataDir: args.fallbackDataDir || process.env.FALLBACK_DATA_DIR || args.dataDir || process.env.DATA_DIR,
    allowFileFallback: Boolean(args.allowFileFallback || process.env.ALLOW_FILE_FALLBACK === '1' || process.env.MODEL_TAG_ALLOW_FILE_FALLBACK === '1'),
    outDir: args.outDir || process.env.OUT_DIR,
    runDt: args.runDt || process.env.RUN_DT,
    runId: args.runId || process.env.RUN_ID,
    generatedAt: args.generatedAt || process.env.GENERATED_AT,
    feishuDoc: args.feishuDoc || process.env.FEISHU_KNOWLEDGE_DOC || process.env.MODEL_TAG_FEISHU_DOC,
    feishuAs: args.feishuAs || process.env.FEISHU_SYNC_AS || 'user',
    feishuDryRun: Boolean(args.feishuDryRun || process.env.FEISHU_DRY_RUN === '1' || process.env.MODEL_TAG_FEISHU_DRY_RUN === '1'),
    larkCliCmd: args.larkCliCmd || process.env.LARK_CLI_CMD || 'lark-cli',
    noFeishuMd: args.noFeishuMd,
    noManifest: args.noManifest,
  });
  if (!args.quiet) {
    console.error(`[model-tag-sync] exported ${result.stats.tagged_model_count} tagged models for ${result.run_dt}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[model-tag-sync] ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildKnowledge,
  buildSnapshot,
  buildSyncManifest,
  exportModelTagArtifacts,
  loadBundleFromFiles,
  runFeishuSummarySync,
  normalizeRules,
  parseArgs,
  sha256Json,
};

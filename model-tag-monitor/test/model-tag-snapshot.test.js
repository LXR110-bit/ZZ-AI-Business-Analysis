const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildKnowledge,
  buildSnapshot,
  exportModelTagArtifacts,
  loadBundleFromFiles,
  runFeishuSummarySync,
} = require('../scripts/export-model-tag-snapshot');

function rawBundle() {
  return {
    source: { mode: 'unit' },
    warnings: [],
    vocab: {
      core: ['核心', '非核心', '观察'],
      lifecycle: ['新品', '主流'],
      price: ['高价段', '低价段'],
      custom: {
        组装机: [
          { id: 'tier', name: 'A/B层', options: ['A层', 'B层'] },
          { id: 'source', name: '货源层级', options: ['强货源', '弱货源'] },
        ],
      },
    },
    rules: { poolTopN: 30, waveThreshold: 0.2, trendWeeks: 4, minEvaUv: 25 },
    tags: {
      '组装机||机型A': {
        dimensions: {
          core: '核心',
          lifecycle: '主流',
          price: '高价段',
          'custom:组装机:tier': 'A层',
        },
        note: '重点看成交',
      },
      '组装机||机型B': {
        tags: ['观察', '低价段', 'B层'],
        note: '',
      },
      '手机||iPhone 16': {
        dimensions: { core: '核心', lifecycle: '新品' },
        note: '',
      },
    },
  };
}

test('buildSnapshot normalizes server tags into stable snapshot entries', () => {
  const snapshot = buildSnapshot(rawBundle(), {
    runDt: '2026-07-15',
    runId: 'unit-run',
    generatedAt: '2026-07-15T00:00:00.000Z',
  });

  assert.equal(snapshot.schema_version, 'model_tag_snapshot/v1');
  assert.equal(snapshot.source_of_truth, 'model-tag-monitor-server-front-end-tags');
  assert.equal(snapshot.stats.tagged_model_count, 3);
  assert.equal(snapshot.stats.category_count, 2);
  assert.equal(snapshot.stats.dimension_assignment_count, 9);
  assert.equal(snapshot.rules.poolTopN, 30);
  assert.equal(snapshot.rules.rates.length > 0, true, 'rules keeps fixed monitor rates');
  assert.deepEqual(snapshot.tags['组装机||机型B'].dimensions, {
    core: '观察',
    price: '低价段',
    'custom:组装机:tier': 'B层',
  });
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
});

test('buildKnowledge creates Analyze-friendly category summaries and model enrichment', () => {
  const snapshot = buildSnapshot(rawBundle(), {
    runDt: '2026-07-15',
    runId: 'unit-run',
    generatedAt: '2026-07-15T00:00:00.000Z',
  });
  const knowledge = buildKnowledge(snapshot);
  const category = knowledge.category_summaries.find((c) => c.category === '组装机');
  const tier = category.dimensions.find((d) => d.label === 'A/B层');

  assert.equal(knowledge.schema_version, 'model_tag_knowledge/v1');
  assert.equal(knowledge.source_snapshot_sha256, snapshot.sha256);
  assert.equal(category.tagged_model_count, 2);
  assert.deepEqual(tier.values.map((v) => [v.value, v.model_count]), [['A层', 1], ['B层', 1]]);
  assert.deepEqual(knowledge.model_enrichment['组装机||机型A'].custom_dimensions, { 'A/B层': 'A层' });
  assert.match(knowledge.feishu_knowledge_summary.markdown, /AI 小万机型标签分层摘要/);
  assert.match(knowledge.feishu_knowledge_summary.markdown, /Source of truth/);
});

test('exportModelTagArtifacts reads file source, falls back rules, and writes JSON/Markdown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tag-export-'));
  fs.writeFileSync(path.join(dir, 'tags.json'), JSON.stringify(rawBundle().tags), 'utf8');
  fs.writeFileSync(path.join(dir, 'tag-vocab.json'), JSON.stringify(rawBundle().vocab), 'utf8');

  const loaded = loadBundleFromFiles({ dataDir: dir });
  assert.deepEqual(loaded.warnings, ['rules.json missing; using default']);

  const outDir = path.join(dir, 'out');
  const result = await exportModelTagArtifacts({
    source: 'file',
    dataDir: dir,
    outDir,
    runDt: '2026-07-15',
    runId: 'unit-run',
    generatedAt: '2026-07-15T00:00:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(result.stats.tagged_model_count, 3);
  assert.equal(fs.existsSync(path.join(outDir, 'model_tag_snapshot_2026-07-15.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'model_tag_knowledge_2026-07-15.json')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'model_tag_feishu_summary_2026-07-15.md')), true);
  assert.equal(fs.existsSync(path.join(outDir, 'model_tag_sync_manifest_2026-07-15.json')), true);
  assert.equal(result.status, 'warn');
  assert.equal(result.feishu_sync.status, 'not_configured');
  assert.equal(result.known_gaps.includes('feishu_knowledge_summary_sync_not_configured'), true);
  const written = JSON.parse(fs.readFileSync(result.files.knowledge, 'utf8'));
  assert.equal(written.consumer_contract.join_key, 'category||model_name');
  const manifest = JSON.parse(fs.readFileSync(result.files.manifest, 'utf8'));
  assert.equal(manifest.model_tag_snapshot, 'model_tag_snapshot_2026-07-15.json');
  assert.equal(manifest.model_tag_knowledge_sha256, result.sha256.knowledge);
});

test('exportModelTagArtifacts falls back to file source when API is unavailable and fallback is enabled', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tag-fallback-'));
  fs.writeFileSync(path.join(dir, 'tags.json'), JSON.stringify(rawBundle().tags), 'utf8');
  fs.writeFileSync(path.join(dir, 'tag-vocab.json'), JSON.stringify(rawBundle().vocab), 'utf8');

  const result = await exportModelTagArtifacts({
    source: 'api',
    apiBase: 'http://127.0.0.1:1',
    allowFileFallback: true,
    dataDir: dir,
    outDir: path.join(dir, 'out'),
    runDt: '2026-07-15',
    runId: 'unit-run',
    generatedAt: '2026-07-15T00:00:00.000Z',
  });

  assert.equal(result.source.mode, 'file_fallback');
  assert.equal(result.known_gaps.includes('model_tag_api_unavailable_used_file_fallback'), true);
  assert.equal(result.stats.tagged_model_count, 3);
});

test('runFeishuSummarySync overwrites a configured Feishu doc through lark-cli docs update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-tag-feishu-'));
  const markdown = path.join(dir, 'summary.md');
  const log = path.join(dir, 'args.json');
  const fakeCli = path.join(dir, 'fake-lark-cli.js');
  fs.writeFileSync(markdown, '# summary\n', 'utf8');
  fs.writeFileSync(fakeCli, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ ok: true }));
`, { mode: 0o755 });

  const result = runFeishuSummarySync(markdown, {
    feishuDoc: 'doc-token',
    feishuDryRun: true,
    larkCliCmd: fakeCli,
    feishuAs: 'bot',
  });

  assert.equal(result.status, 'dry_run');
  const args = JSON.parse(fs.readFileSync(log, 'utf8'));
  assert.deepEqual(args.slice(0, 4), ['docs', '+update', '--doc', 'doc-token']);
  assert.equal(args.includes('--dry-run'), true);
  assert.equal(args.includes('--doc-format'), true);
  assert.equal(args.includes('markdown'), true);
});

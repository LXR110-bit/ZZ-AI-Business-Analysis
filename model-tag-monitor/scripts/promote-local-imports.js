#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function atomicWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function copyFileAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.tmp`);
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

function firstCsvField(line) {
  const text = String(line || '');
  if (!text.startsWith('"')) {
    const comma = text.indexOf(',');
    return (comma < 0 ? text : text.slice(0, comma)).trim().replace(/^\uFEFF/, '');
  }
  let value = '';
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] !== '"') {
      value += text[i];
      continue;
    }
    if (text[i + 1] === '"') {
      value += '"';
      i += 1;
      continue;
    }
    break;
  }
  return value.trim().replace(/^\uFEFF/, '');
}

function normalizeCsvHeader(line) {
  return String(line || '').replace(/^\uFEFF/, '').trim();
}

async function readCsvHeader(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line;
  } finally {
    lines.close();
    input.destroy();
  }
  throw new Error(`CSV has no header: ${file}`);
}

async function readSourcePartitions(file) {
  const partitions = new Set();
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let header = null;
  for await (const line of lines) {
    if (header === null) {
      header = line;
      continue;
    }
    if (!line.trim()) continue;
    const partition = firstCsvField(line);
    if (partition) partitions.add(partition);
  }
  if (header === null) throw new Error(`CSV has no header: ${file}`);
  if (firstCsvField(header) !== 'week_start_date') {
    throw new Error(`CSV first column must be week_start_date: ${file}`);
  }
  if (!partitions.size) throw new Error(`CSV has no week_start_date partitions: ${file}`);
  return { header, partitions };
}

async function* dataLines(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let first = true;
  for await (const line of lines) {
    if (first) {
      first = false;
      continue;
    }
    if (line.trim()) yield line;
  }
}

async function mergeCsvPartitionsAtomic(src, dest) {
  if (!fs.existsSync(dest)) {
    copyFileAtomic(src, dest);
    return null;
  }

  const { header: sourceHeader, partitions } = await readSourcePartitions(src);
  const destHeader = await readCsvHeader(dest);
  if (normalizeCsvHeader(destHeader) !== normalizeCsvHeader(sourceHeader)) {
    throw new Error(`CSV header mismatch while promoting ${path.basename(src)}`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.tmp`);
  let rowCount = 0;
  async function* mergedLines() {
    yield `${sourceHeader}\n`;
    for await (const line of dataLines(dest)) {
      if (partitions.has(firstCsvField(line))) continue;
      rowCount += 1;
      yield `${line}\n`;
    }
    for await (const line of dataLines(src)) {
      rowCount += 1;
      yield `${line}\n`;
    }
  }

  try {
    await pipeline(Readable.from(mergedLines()), fs.createWriteStream(tmp, { encoding: 'utf8' }));
    fs.renameSync(tmp, dest);
  } finally {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
  return rowCount;
}

function isPathInside(parent, child) {
  const p = fs.realpathSync(parent);
  const c = fs.realpathSync(child);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

async function promoteLocalImports({ sourceDir, destDir, runId }) {
  const sourceRoot = path.resolve(sourceDir);
  const destRoot = path.resolve(destDir);
  const sourceActivePath = path.join(sourceRoot, 'active.json');
  if (!fs.existsSync(sourceActivePath)) throw new Error(`source active.json not found: ${sourceActivePath}`);
  const sourceActive = readJson(sourceActivePath);
  if (runId && sourceActive.run_id !== runId) {
    throw new Error(`source active run_id mismatch: expected ${runId}, got ${sourceActive.run_id || '<missing>'}`);
  }
  const sourceManifestPath = path.resolve(sourceActive.manifest || '');
  if (!sourceManifestPath || !fs.existsSync(sourceManifestPath)) {
    throw new Error(`source manifest not found: ${sourceActive.manifest || '<missing>'}`);
  }
  if (!isPathInside(sourceRoot, sourceManifestPath)) {
    throw new Error(`source manifest is outside source dir: ${sourceManifestPath}`);
  }
  const manifest = readJson(sourceManifestPath);
  if (runId && manifest.run_id !== runId) {
    throw new Error(`source manifest run_id mismatch: expected ${runId}, got ${manifest.run_id || '<missing>'}`);
  }

  const promotedOutputs = {};
  for (const [key, rawSourcePath] of Object.entries(sourceActive.outputs || {})) {
    const src = path.resolve(rawSourcePath);
    if (!fs.existsSync(src)) throw new Error(`source output missing for ${key}: ${src}`);
    if (!isPathInside(sourceRoot, src)) throw new Error(`source output outside source dir for ${key}: ${src}`);
    const dest = path.join(destRoot, path.basename(src));
    const mergedRowCount = path.extname(src).toLowerCase() === '.csv'
      ? await mergeCsvPartitionsAtomic(src, dest)
      : (copyFileAtomic(src, dest), null);
    promotedOutputs[key] = dest;
    if (manifest.outputs && manifest.outputs[key]) {
      const stat = fs.statSync(dest);
      manifest.outputs[key].path = dest;
      manifest.outputs[key].filename = path.basename(dest);
      manifest.outputs[key].bytes = stat.size;
      manifest.outputs[key].sha256 = sha256(dest);
      if (mergedRowCount !== null) manifest.outputs[key].row_count = mergedRowCount;
    }
  }

  const manifestDestPath = path.join(destRoot, 'manifests', path.basename(sourceManifestPath));
  manifest.manifest_path = manifestDestPath;
  atomicWriteJson(manifestDestPath, manifest);

  const active = {
    schema_version: sourceActive.schema_version || 1,
    run_id: sourceActive.run_id,
    generated_at: sourceActive.generated_at,
    outputs: promotedOutputs,
    manifest: manifestDestPath,
  };
  atomicWriteJson(path.join(destRoot, 'active.json'), active);

  return {
    ok: true,
    run_id: active.run_id,
    source_dir: sourceRoot,
    dest_dir: destRoot,
    manifest: manifestDestPath,
    outputs: promotedOutputs,
  };
}

async function main() {
  const args = parseArgs();
  if (!args['source-dir'] || !args['dest-dir']) {
    throw new Error('Usage: promote-local-imports.js --source-dir <staging> --dest-dir <IMPORT_DIR> [--run-id <id>]');
  }
  const result = await promoteLocalImports({ sourceDir: args['source-dir'], destDir: args['dest-dir'], runId: args['run-id'] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { firstCsvField, mergeCsvPartitionsAtomic, promoteLocalImports };

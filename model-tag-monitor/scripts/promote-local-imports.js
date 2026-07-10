#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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

function isPathInside(parent, child) {
  const p = fs.realpathSync(parent);
  const c = fs.realpathSync(child);
  return c === p || c.startsWith(`${p}${path.sep}`);
}

function promoteLocalImports({ sourceDir, destDir, runId }) {
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
    copyFileAtomic(src, dest);
    promotedOutputs[key] = dest;
    if (manifest.outputs && manifest.outputs[key]) {
      const stat = fs.statSync(dest);
      manifest.outputs[key].path = dest;
      manifest.outputs[key].filename = path.basename(dest);
      manifest.outputs[key].bytes = stat.size;
      manifest.outputs[key].sha256 = sha256(dest);
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

function main() {
  const args = parseArgs();
  if (!args['source-dir'] || !args['dest-dir']) {
    throw new Error('Usage: promote-local-imports.js --source-dir <staging> --dest-dir <IMPORT_DIR> [--run-id <id>]');
  }
  const result = promoteLocalImports({ sourceDir: args['source-dir'], destDir: args['dest-dir'], runId: args['run-id'] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.stack || e.message);
    process.exit(1);
  }
}

module.exports = { promoteLocalImports };

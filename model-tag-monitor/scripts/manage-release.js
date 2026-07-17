#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  initManifest,
  parseArgs,
  updateManifest,
  writeStatus,
} = require('./release-utils');

function parsePatch(value) {
  if (!value) return {};
  return JSON.parse(value);
}

function main() {
  const [command] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(3));
  const releaseDir = path.resolve(args['release-dir'] || '');
  if (!releaseDir || releaseDir === path.resolve('.')) throw new Error('manage-release requires --release-dir');

  if (command === 'init') {
    const manifest = initManifest({
      releaseDir,
      runId: args['run-id'],
      targetWeek: args['target-week'],
      targetWeeks: args['target-weeks'],
      startedAt: args['started-at'],
      version: args.version,
      sourceType: args['source-type'] || 'csv_imports',
      builder: args.builder || 'legacy-offline-build',
    });
    console.log(JSON.stringify({ ok: true, manifest }, null, 2));
    return;
  }

  if (command === 'status') {
    const status = writeStatus(releaseDir, {
      stage: args.stage,
      status: args.status,
      message: args.message || '',
      detailFile: args['detail-file'] || '',
      retryable: args.retryable !== '0' && args.retryable !== 'false',
      code: Number(args.code || 0),
    });
    console.log(JSON.stringify({ ok: true, status }, null, 2));
    return;
  }

  if (command === 'manifest') {
    const patch = parsePatch(args.patch || '{}');
    if (args.status) patch.status = args.status;
    if (args['coverage-file']) patch.coverageFile = args['coverage-file'];
    const manifest = updateManifest(releaseDir, patch);
    console.log(JSON.stringify({ ok: true, manifest }, null, 2));
    return;
  }

  throw new Error('Usage: manage-release.js <init|status|manifest> --release-dir DIR ...');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[manage-release] ${err.stack || err.message}`);
    process.exit(1);
  }
}

#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
  cleanupReleases,
  parseArgs,
  publishRelease,
  updateManifest,
  writeStatus,
} = require('./release-utils');

function usage() {
  return [
    'Usage: publish-release.js --release-dir DIR --current-path DIR',
    'Optional: --compatibility-path DIR --retention-days 30 --keep-success 8 --dry-run-cleanup',
  ].join('\n');
}

function main() {
  const args = parseArgs();
  const releaseDir = path.resolve(args['release-dir'] || '');
  const currentPath = path.resolve(args['current-path'] || '');
  if (!releaseDir || releaseDir === path.resolve('.')) throw new Error(usage());
  if (!currentPath || currentPath === path.resolve('.')) throw new Error(usage());
  writeStatus(releaseDir, { stage: 'publish', status: 'running', message: `publishing to ${currentPath}` });
  const result = publishRelease({
    releaseDir,
    currentPath,
    compatibilityPath: args['compatibility-path'] ? path.resolve(args['compatibility-path']) : '',
  });
  updateManifest(releaseDir, { status: 'published' });

  const releasesDir = args['releases-dir']
    ? path.resolve(args['releases-dir'])
    : path.dirname(releaseDir);
  const cleanup = cleanupReleases({
    releasesDir,
    retentionDays: Number(args['retention-days'] || process.env.RELEASE_RETENTION_DAYS || 30),
    keepSuccess: Number(args['keep-success'] || process.env.RELEASE_KEEP_SUCCESS || 8),
    dryRun: Boolean(args['dry-run-cleanup']),
  });

  console.log(JSON.stringify({
    ok: true,
    releaseDir,
    currentPath,
    previousTarget: result.previousTarget,
    removed: cleanup.removed,
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[publish-release] ${err.stack || err.message}`);
    process.exit(1);
  }
}

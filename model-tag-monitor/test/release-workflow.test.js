'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  initManifest,
  publishRelease,
  readJSON,
  updateManifest,
  writeJSONAtomic,
  writeStatus,
} = require('../scripts/release-utils');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function minimalDashboard() {
  return {
    version: '1.6.0',
    week: '2026-W29',
    prevWeek: '2026-W28',
    weekRange: '07-13 ~ 07-19',
    kpiCards: [{ key: 'gmv', deltaPct: 0.12 }],
    categories: [
      {
        category: '手机',
        board: '数码',
        secondaryCategory: '数码',
        anomalyScore: 2,
        cur: { gmv: 120000, orderRate: 0.1 },
        delta: { orderRate: -0.01 },
        trend: { gmv: { prev: 100000, deltaPct: 0.2 } },
      },
    ],
  };
}

test('release manifest records artifacts and status', () => {
  const releaseDir = tmpDir('release-manifest-');
  fs.mkdirSync(path.join(releaseDir, 'data'), { recursive: true });
  writeJSONAtomic(path.join(releaseDir, 'data', 'dashboard.json'), minimalDashboard());
  initManifest({
    releaseDir,
    runId: '20260717T065001+0800',
    targetWeek: '2026-W29',
    targetWeeks: '2026-W20,2026-W29',
    startedAt: '2026-07-17T06:50:01+08:00',
    version: '1.6.0',
  });
  updateManifest(releaseDir, { status: 'validated' });
  writeStatus(releaseDir, { stage: 'validate', status: 'success', message: 'ok' });

  const manifest = readJSON(path.join(releaseDir, 'manifest.json'));
  assert.equal(manifest.status, 'validated');
  assert.equal(manifest.artifacts.data['dashboard.json'].row_count, 1);
  assert.match(manifest.artifacts.data['dashboard.json'].sha256, /^[a-f0-9]{64}$/);
  const status = readJSON(path.join(releaseDir, 'status.json'));
  assert.equal(status.stages.validate.status, 'success');
});

test('publishRelease switches current to release data and preserves existing directory', () => {
  const root = tmpDir('release-publish-');
  const releaseDir = path.join(root, 'releases', 'run1');
  const currentPath = path.join(root, 'data', 'current');
  fs.mkdirSync(path.join(releaseDir, 'data'), { recursive: true });
  fs.mkdirSync(currentPath, { recursive: true });
  writeJSONAtomic(path.join(currentPath, 'dashboard.json'), { old: true });
  writeJSONAtomic(path.join(releaseDir, 'data', 'dashboard.json'), minimalDashboard());
  initManifest({ releaseDir, runId: 'run1', targetWeek: '2026-W29', targetWeeks: '2026-W29' });

  const result = publishRelease({ releaseDir, currentPath });
  assert.equal(result.ok, true);
  assert.equal(fs.lstatSync(currentPath).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(currentPath), fs.realpathSync(path.join(releaseDir, 'data')));
  const previous = fs.readdirSync(path.dirname(currentPath)).filter((name) => name.startsWith('current.previous-'));
  assert.equal(previous.length, 1);
});

test('build-weekly-card-payload can build from dashboard file without API', () => {
  const dir = tmpDir('card-dashboard-file-');
  const dashboardFile = path.join(dir, 'dashboard.json');
  const out = path.join(dir, 'payload.json');
  writeJSONAtomic(dashboardFile, minimalDashboard());

  const result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'build-weekly-card-payload.js'),
    '--dashboard-file', dashboardFile,
    '--dashboard-url', 'http://example.test/dashboard',
    '--report-url', 'http://example.test/report',
    '--out', out,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = readJSON(out);
  assert.equal(payload.week, '2026-W29');
  assert.equal(payload.top_anomalies[0].name, '手机');
});

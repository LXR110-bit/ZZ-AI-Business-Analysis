'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RELEASE_STATUS = new Set(['building', 'failed', 'validated', 'ai_ready', 'published', 'published_notify_failed']);
const STAGE_ORDER = ['import', 'build', 'validate', 'ai', 'publish', 'notify'];

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

function writeJSONAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJSON(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function ensureReleaseLayout(releaseDir) {
  for (const name of ['imports', 'data', 'checks', 'logs']) {
    fs.mkdirSync(path.join(releaseDir, name), { recursive: true });
  }
}

function relativeToRelease(releaseDir, file) {
  return path.relative(releaseDir, file).replace(/\\/g, '/');
}

function countRowsInJson(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.rows)) return value.rows.length;
  if (Array.isArray(value.categories)) return value.categories.length;
  if (Array.isArray(value.kpiCards)) return value.kpiCards.length;
  return null;
}

function weeksInJson(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value.weeks)) return value.weeks;
  if (Array.isArray(value.weekWindow)) return value.weekWindow;
  if (value.week) return [value.week];
  return null;
}

function artifactForFile(releaseDir, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const ext = path.extname(file).toLowerCase();
  const item = {
    path: relativeToRelease(releaseDir, file),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  };
  if (ext === '.json') {
    try {
      const json = readJSON(file, null);
      const rows = countRowsInJson(json);
      const weeks = weeksInJson(json);
      if (rows != null) item.row_count = rows;
      if (weeks) item.weeks = weeks;
    } catch (_) {
      // Keep the hash even if a diagnostic JSON is malformed.
    }
  } else if (ext === '.csv') {
    const text = fs.readFileSync(file, 'utf8').trim();
    item.row_count = text ? Math.max(0, text.split(/\r?\n/).length - 1) : 0;
  }
  return item;
}

function collectArtifacts(releaseDir) {
  const artifacts = {};
  const groups = [
    ['data', path.join(releaseDir, 'data')],
    ['checks', path.join(releaseDir, 'checks')],
    ['imports', path.join(releaseDir, 'imports')],
  ];
  for (const [group, dir] of groups) {
    artifacts[group] = {};
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) continue;
      artifacts[group][file] = artifactForFile(releaseDir, full);
    }
  }
  return artifacts;
}

function initManifest({ releaseDir, runId, targetWeek, targetWeeks, startedAt, version, sourceType = 'csv_imports', builder = 'legacy-offline-build' }) {
  ensureReleaseLayout(releaseDir);
  const manifest = {
    schema_version: 1,
    run_id: runId,
    target_week: targetWeek,
    target_weeks: String(targetWeeks || '').split(',').map((w) => w.trim()).filter(Boolean),
    expected_data_end: null,
    expected_days: null,
    source_type: sourceType,
    builder,
    version: version || null,
    status: 'building',
    started_at: startedAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    artifacts: collectArtifacts(releaseDir),
    publish: {
      published_at: null,
      current_target: null,
      previous_success_release_id: null,
    },
  };
  writeJSONAtomic(path.join(releaseDir, 'manifest.json'), manifest);
  writeStatus(releaseDir, { stage: 'import', status: 'running', message: 'release initialized' });
  return manifest;
}

function updateManifest(releaseDir, patch = {}) {
  const file = path.join(releaseDir, 'manifest.json');
  const current = readJSON(file, {});
  const coverage = patch.coverageFile ? readJSON(patch.coverageFile, null) : null;
  const next = {
    ...current,
    ...patch,
    expected_data_end: patch.expected_data_end ?? (coverage && coverage.expectedDataEnd) ?? current.expected_data_end ?? null,
    expected_days: patch.expected_days ?? (coverage && coverage.expectedDays) ?? current.expected_days ?? null,
    artifacts: collectArtifacts(releaseDir),
    updated_at: new Date().toISOString(),
  };
  delete next.coverageFile;
  if (next.status && !RELEASE_STATUS.has(next.status)) {
    throw new Error(`invalid release status: ${next.status}`);
  }
  writeJSONAtomic(file, next);
  return next;
}

function writeStatus(releaseDir, { stage, status, message = '', detailFile = '', retryable = true, code = 0 } = {}) {
  if (stage && !STAGE_ORDER.includes(stage)) throw new Error(`invalid stage: ${stage}`);
  const file = path.join(releaseDir, 'status.json');
  const current = readJSON(file, { schema_version: 1, stages: {} });
  const now = new Date().toISOString();
  const prev = stage ? current.stages[stage] || {} : {};
  const next = {
    ...current,
    current_stage: stage || current.current_stage || null,
    status: status || current.status || 'unknown',
    updated_at: now,
    stages: {
      ...(current.stages || {}),
      ...(stage ? {
        [stage]: {
          ...prev,
          stage,
          status,
          message,
          detail_file: detailFile || '',
          retryable,
          code,
          started_at: prev.started_at || now,
          ended_at: ['success', 'failed', 'skipped'].includes(status) ? now : prev.ended_at || null,
        },
      } : {}),
    },
  };
  writeJSONAtomic(file, next);
  return next;
}

function copyFileAtomic(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(src)) return;
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    const stat = fs.statSync(s);
    if (stat.isDirectory()) copyTree(s, d);
    else if (stat.isFile()) copyFileAtomic(s, d);
  }
}

function resolveCurrentTarget(currentPath) {
  if (!fs.existsSync(currentPath)) return null;
  try {
    const real = fs.realpathSync(currentPath);
    return real;
  } catch (_) {
    return currentPath;
  }
}

function releaseIdFromDataPath(dataPath) {
  if (!dataPath) return null;
  const parent = path.basename(path.dirname(dataPath));
  return parent || null;
}

function switchSymlink(target, linkPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  const tmp = `${linkPath}.next-${process.pid}-${Date.now()}`;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  fs.symlinkSync(target, tmp, 'dir');
  if (fs.existsSync(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      fs.renameSync(linkPath, `${linkPath}.previous-${Date.now()}`);
    }
  }
  fs.renameSync(tmp, linkPath);
}

function publishRelease({ releaseDir, currentPath, compatibilityPath = '' }) {
  const dataDir = path.join(releaseDir, 'data');
  if (!fs.existsSync(path.join(dataDir, 'dashboard.json'))) {
    throw new Error(`release data is not publishable; missing ${path.join(dataDir, 'dashboard.json')}`);
  }
  const previousTarget = resolveCurrentTarget(currentPath);
  switchSymlink(dataDir, currentPath);
  if (compatibilityPath && path.resolve(compatibilityPath) !== path.resolve(currentPath)) {
    copyTree(dataDir, compatibilityPath);
  }
  const manifest = updateManifest(releaseDir, {
    status: 'published',
    publish: {
      published_at: new Date().toISOString(),
      current_target: currentPath,
      previous_success_release_id: releaseIdFromDataPath(previousTarget),
    },
  });
  writeStatus(releaseDir, { stage: 'publish', status: 'success', message: `published to ${currentPath}` });
  return { ok: true, currentPath, previousTarget, manifest };
}

function cleanupReleases({ releasesDir, retentionDays = 30, keepSuccess = 8, dryRun = false } = {}) {
  if (!fs.existsSync(releasesDir)) return { removed: [] };
  const now = Date.now();
  const dayMs = 86400000;
  const releases = fs.readdirSync(releasesDir)
    .map((name) => {
      const dir = path.join(releasesDir, name);
      if (!fs.statSync(dir).isDirectory()) return null;
      const manifest = readJSON(path.join(dir, 'manifest.json'), {});
      const stat = fs.statSync(dir);
      return { name, dir, manifest, mtimeMs: stat.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const successKeep = new Set(releases.filter((r) => r.manifest.status === 'published').slice(0, keepSuccess).map((r) => r.name));
  const removed = [];
  for (const item of releases) {
    if (successKeep.has(item.name)) continue;
    if ((now - item.mtimeMs) <= retentionDays * dayMs) continue;
    removed.push(item.dir);
    if (!dryRun) fs.rmSync(item.dir, { recursive: true, force: true });
  }
  return { removed };
}

module.exports = {
  STAGE_ORDER,
  artifactForFile,
  cleanupReleases,
  collectArtifacts,
  copyFileAtomic,
  ensureReleaseLayout,
  initManifest,
  parseArgs,
  publishRelease,
  readJSON,
  sha256File,
  updateManifest,
  writeJSONAtomic,
  writeStatus,
};

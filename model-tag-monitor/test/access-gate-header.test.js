'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const REFRESH_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'refresh-dashboard-daily.sh'), 'utf8');
const INSIGHTS_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'generate-business-overview-insights.js'), 'utf8');
const CARD_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-weekly-card-payload.js'), 'utf8');
const ECOSYSTEM_CONFIG = fs.readFileSync(path.join(__dirname, '..', 'ecosystem.config.js'), 'utf8');

test('X-User request header URI-encodes Unicode gate names', () => {
  assert.match(
    APP_JS,
    /'X-User': encodeURIComponent\(getUserName\(\) \|\| 'anonymous'\)/,
    'API requests must not place a raw Unicode display name in a fetch header'
  );
});

test('daily refresh authenticates once and forwards the access cookie to every API client', () => {
  assert.match(REFRESH_SCRIPT, /authenticate_api/);
  assert.match(REFRESH_SCRIPT, /export API_COOKIE/);
  assert.match(REFRESH_SCRIPT, /curl -fsS --max-time 900 -b "\$API_COOKIE_JAR"/);
  assert.match(REFRESH_SCRIPT, /curl -fsS --max-time 300 -b "\$API_COOKIE_JAR"/);
  assert.match(INSIGHTS_SCRIPT, /\{ Cookie: apiCookie \}/);
  assert.match(CARD_SCRIPT, /headers\.Cookie = apiCookie/);
});

test('PM2 sync window rolls with imported data instead of pinning calendar weeks', () => {
  assert.match(ECOSYSTEM_CONFIG, /KEEP_WEEKS:\s*'10'/);
  assert.match(ECOSYSTEM_CONFIG, /TARGET_WEEKS:\s*''/);
  assert.doesNotMatch(ECOSYSTEM_CONFIG, /TARGET_WEEKS:\s*'\d{4}-W\d{2}/);
});


test('production access gate has no hard-coded access code fallback', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /const ACCESS_CODE = process\.env\.ACCESS_CODE \|\| ''/);
  assert.doesNotMatch(server, /WXFX2026/);
  assert.doesNotMatch(REFRESH_SCRIPT, /WXFX2026/);
  assert.match(REFRESH_SCRIPT, /ACCESS_CODE is required/);
});

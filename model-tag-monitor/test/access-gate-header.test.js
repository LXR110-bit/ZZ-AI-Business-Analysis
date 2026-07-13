'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('X-User request header URI-encodes Unicode gate names', () => {
  assert.match(
    APP_JS,
    /'X-User': encodeURIComponent\(getUserName\(\) \|\| 'anonymous'\)/,
    'API requests must not place a raw Unicode display name in a fetch header'
  );
});

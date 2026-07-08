'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('monitor table shows 机况UV/日 before 估价UV/日 in both header and row cells', () => {
  const headerJkuv = APP_JS.indexOf("monitorSortableTh('jkuv', '机况UV<sub");
  const headerEvaUv = APP_JS.indexOf("monitorSortableTh('evaUv', '估价UV<sub");
  assert.notEqual(headerJkuv, -1, 'monitor header must include 机况UV/日');
  assert.notEqual(headerEvaUv, -1, 'monitor header must include 估价UV/日');
  assert.ok(headerJkuv < headerEvaUv, '监测表表头必须先展示机况UV/日，再展示估价UV/日');

  const rowJkuv = APP_JS.indexOf('${fmtInt(cur.jkuv)}');
  const rowEvaUv = APP_JS.indexOf('${fmtInt(cur.evaUv)}');
  assert.notEqual(rowJkuv, -1, 'monitor row must render jkuv cell');
  assert.notEqual(rowEvaUv, -1, 'monitor row must render evaUv cell');
  assert.ok(rowJkuv < rowEvaUv, '监测表行数据必须与表头一致：机况UV/日 在 估价UV/日 前');
});

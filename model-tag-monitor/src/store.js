// JSON 文件存储层
// 简单的读写 + 原子写(先写 .tmp 再 rename)
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name) {
  return path.join(DATA_DIR, name);
}

function readJSON(name, fallback) {
  ensureDir();
  const p = filePath(name);
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`readJSON ${name} 失败:`, e.message);
    return fallback;
  }
}

function writeJSON(name, data) {
  ensureDir();
  const p = filePath(name);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// 追加一行到操作日志
function appendLog(entry) {
  ensureDir();
  const p = filePath('operations.log');
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(p, line, 'utf8');
}

function readLogs(limit = 200) {
  ensureDir();
  const p = filePath('operations.log');
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  return lines
    .slice(-limit)
    .reverse()
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { ts: '', raw: l };
      }
    });
}

module.exports = { readJSON, writeJSON, appendLog, readLogs, filePath };

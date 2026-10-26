'use strict';
// Filesystem helpers and a tiny JSON document store with atomic writes.
const fs = require('fs');
const path = require('path');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, data) {
  mkdirp(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.data = readJsonFile(file, undefined);
    if (this.data === undefined) {
      this.data = typeof defaults === 'function' ? defaults() : defaults;
      this.save();
    }
  }
  get() {
    return this.data;
  }
  set(data) {
    this.data = data;
    this.save();
    return data;
  }
  update(fn) {
    const r = fn(this.data);
    if (r !== undefined) this.data = r;
    this.save();
    return this.data;
  }
  save() {
    writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }
}

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
function safeJoin(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, clean);
  const r = path.resolve(root);
  if (full !== r && !full.startsWith(r + path.sep)) {
    const err = new Error('path escapes repository root');
    err.status = 400;
    throw err;
  }
  return full;
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { total += fs.statSync(p).size; files++; }
    }
  };
  walk(dir);
  return { bytes: total, files };
}

module.exports = { mkdirp, writeAtomic, readJsonFile, JsonStore, safeJoin, rmrf, dirSize };

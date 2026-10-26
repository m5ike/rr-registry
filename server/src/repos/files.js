'use strict';
// Direct filesystem access to a repository directory (tree / stat / read / write / delete).
const fs = require('fs');
const path = require('path');
const { HttpError } = require('../util/http');
const { safeJoin, mkdirp, writeAtomic, rmrf } = require('../util/store');

function info(root, full) {
  const st = fs.statSync(full);
  const rel = path.relative(root, full).split(path.sep).join('/');
  return {
    name: path.basename(full) || '/',
    path: `/${rel}`.replace(/\/$/, '') || '/',
    type: st.isDirectory() ? 'dir' : 'file',
    size: st.isDirectory() ? 0 : st.size,
    modified: st.mtime.toISOString(),
  };
}

function resolve(root, rel) {
  return safeJoin(root, rel);
}

function stat(root, rel) {
  const full = resolve(root, rel);
  if (!fs.existsSync(full)) throw new HttpError(404, `path ${rel || '/'} not found`);
  const i = info(root, full);
  if (i.type === 'dir') i.children = fs.readdirSync(full).length;
  return i;
}

function tree(root, rel = '/', depth = 1) {
  mkdirp(root);
  const full = resolve(root, rel);
  if (!fs.existsSync(full)) throw new HttpError(404, `path ${rel} not found`);
  const walk = (p, d) => {
    const node = info(root, p);
    if (node.type === 'dir' && d > 0) {
      node.children = fs.readdirSync(p)
        .filter((n) => !n.endsWith('.tmp'))
        .sort()
        .map((n) => walk(path.join(p, n), d - 1))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    }
    return node;
  };
  return walk(full, Math.max(0, Math.min(Number(depth) || 1, 20)));
}

function read(root, rel) {
  const full = resolve(root, rel);
  let st;
  try { st = fs.statSync(full); } catch { throw new HttpError(404, `file ${rel} not found`); }
  if (st.isDirectory()) throw new HttpError(400, `${rel} is a directory`);
  return { full, data: fs.readFileSync(full), stat: st };
}

function write(root, rel, data) {
  if (!rel || rel === '/' ) throw new HttpError(400, 'path is required');
  const full = resolve(root, rel);
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) throw new HttpError(400, `${rel} is a directory`);
  writeAtomic(full, data);
  return info(root, full);
}

function mkdir(root, rel) {
  const full = resolve(root, rel);
  mkdirp(full);
  return info(root, full);
}

function remove(root, rel) {
  if (!rel || rel === '/') throw new HttpError(400, 'refusing to delete repository root');
  const full = resolve(root, rel);
  if (!fs.existsSync(full)) throw new HttpError(404, `path ${rel} not found`);
  rmrf(full);
  // clean empty parents up to the root
  let d = path.dirname(full);
  while (d.startsWith(root) && d !== path.resolve(root)) {
    try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
    d = path.dirname(d);
  }
}

module.exports = { tree, stat, read, write, mkdir, remove };

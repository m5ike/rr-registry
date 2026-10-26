'use strict';
// Minimal ustar reader/writer (enough for npm package tarballs).
const zlib = require('zlib');

function octal(buf, off, len) {
  const s = buf.toString('ascii', off, off + len).replace(/\0.*$/, '').trim();
  return s ? parseInt(s, 8) : 0;
}

function str(buf, off, len) {
  return buf.toString('utf8', off, off + len).replace(/\0.*$/s, '');
}

function parsePax(data) {
  const out = {};
  let s = data.toString('utf8');
  while (s.length) {
    const sp = s.indexOf(' ');
    const len = parseInt(s.slice(0, sp), 10);
    if (!len) break;
    const rec = s.slice(sp + 1, len - 1);
    const eq = rec.indexOf('=');
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    s = s.slice(len);
  }
  return out;
}

/** Extract entries from a (gzipped) tar buffer. */
function extract(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const entries = [];
  let off = 0;
  let longName = null;
  let pax = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(h, 345, 155);
    let name = str(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(data, 0, data.length); continue; }
    if (type === 'x') { pax = parsePax(data); continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (pax && pax.path) name = pax.path;
    pax = null;
    entries.push({ name, type: type === '5' ? 'dir' : type === '0' || type === '\0' ? 'file' : type, mode: octal(h, 100, 8), size, data: Buffer.from(data) });
  }
  return entries;
}

function header(name, size, mode, type, mtime) {
  const h = Buffer.alloc(512, 0);
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const idx = name.lastIndexOf('/', name.length - 1);
    prefix = name.slice(0, idx);
    name = name.slice(idx + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long: ${prefix}/${name}`);
  }
  h.write(name, 0, 100, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/**
 * Create a gzipped tarball.
 * @param {{name:string,data:Buffer|string,mode?:number}[]} files
 */
function create(files, { mtime = Date.UTC(1985, 9, 26, 8, 15) } = {}) {
  const parts = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    parts.push(header(f.name, data.length, f.mode || 0o644, '0', mtime));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

/** Read package.json from an npm tarball (first package/package.json entry). */
function readPackageJson(tgz) {
  const entry = extract(tgz).find((e) => e.type === 'file' && /^[^/]+\/package\.json$/.test(e.name));
  if (!entry) throw new Error('package.json not found in tarball');
  return JSON.parse(entry.data.toString('utf8'));
}

function readReadme(tgz) {
  const entry = extract(tgz).find((e) => e.type === 'file' && /^[^/]+\/readme(\.md|\.markdown|\.txt)?$/i.test(e.name));
  return entry ? entry.data.toString('utf8') : '';
}

module.exports = { extract, create, readPackageJson, readReadme };

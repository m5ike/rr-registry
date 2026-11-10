'use strict';
// Encrypted, streamed archives for export / import.
//
// File layout (.rrx):  "RRX1" | uint32 BE header length | header JSON | ciphertext | 16 B GCM tag
//   header: { format, v, created, appVersion, kdf: { alg: 'scrypt', N, r, p, salt }, cipher: 'aes-256-gcm', iv }
//   plaintext = gzip(tar)  - tar entries are written as a stream (no size limit in memory),
//   the header is authenticated as AAD, so it cannot be altered either.
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('RRX1');
const KDF = { alg: 'scrypt', N: 32768, r: 8, p: 1 };

function deriveKey(passphrase, kdf) {
  return crypto.scryptSync(String(passphrase), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

// ---------------------------------------------------------------- tar (stream writer)
function octal(n, len) {
  return `${n.toString(8).padStart(len - 1, '0')}\0`;
}

function rawHeader(name, size, mode, type, mtime) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);

/** Header block(s) for an entry; long names use a GNU "L" record. */
function headerFor(name, size, mode, mtime) {
  const nb = Buffer.from(name, 'utf8');
  if (nb.length <= 100) return [rawHeader(name, size, mode, '0', mtime)];
  const long = Buffer.concat([nb, Buffer.from([0])]);
  return [rawHeader('././@LongLink', long.length, 0o644, 'L', mtime), long, pad(long.length), rawHeader(name.slice(0, 99), size, mode, '0', mtime)];
}

/**
 * Tar stream from an async iterable of entries:
 *   { name, data: Buffer|string } or { name, file: absolutePath } (+ optional mode, mtime)
 */
async function* tarStream(entries) {
  for await (const e of entries) {
    if (e.data !== undefined) {
      const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
      yield* headerFor(e.name, data.length, e.mode || 0o644, e.mtime || Date.now());
      yield data;
      yield pad(data.length);
    } else {
      let st;
      try { st = fs.statSync(e.file); } catch { continue; } // vanished meanwhile
      if (!st.isFile()) continue;
      yield* headerFor(e.name, st.size, e.mode || st.mode, st.mtimeMs);
      let written = 0;
      for await (const chunk of fs.createReadStream(e.file, { start: 0, end: Math.max(0, st.size - 1) })) {
        if (!st.size) break;
        written += chunk.length;
        yield chunk;
      }
      if (written < st.size) yield Buffer.alloc(st.size - written); // truncated meanwhile - keep the archive valid
      yield pad(st.size);
    }
  }
  yield Buffer.alloc(1024);
}

// ---------------------------------------------------------------- encrypt / decrypt
/** Write an encrypted archive of `entries` to `file`. Resolves { size, sha256, header }. */
async function writeEncrypted(file, entries, passphrase, meta = {}) {
  const header = {
    format: 'rr-export', v: 1, created: new Date().toISOString(), ...meta,
    kdf: { ...KDF, salt: crypto.randomBytes(16).toString('base64') }, cipher: 'aes-256-gcm', iv: crypto.randomBytes(12).toString('base64'),
  };
  const hb = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(hb.length);
  const key = deriveKey(passphrase, header.kdf);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  cipher.setAAD(hb);
  fs.writeFileSync(file, Buffer.concat([MAGIC, len, hb]), { mode: 0o600 });
  await pipeline(Readable.from(tarStream(entries)), zlib.createGzip({ level: 6 }), cipher, fs.createWriteStream(file, { flags: 'a' }));
  fs.appendFileSync(file, cipher.getAuthTag());
  const hash = crypto.createHash('sha256');
  for await (const c of fs.createReadStream(file)) hash.update(c);
  return { size: fs.statSync(file).size, sha256: hash.digest('hex'), header };
}

/** Read the (public, unencrypted) header of an archive. */
function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const pre = Buffer.alloc(8);
    if (fs.readSync(fd, pre, 0, 8, 0) < 8 || !pre.subarray(0, 4).equals(MAGIC)) throw new Error('not an RR Registry export file');
    const n = pre.readUInt32BE(4);
    if (n > 64 * 1024) throw new Error('invalid export header');
    const hb = Buffer.alloc(n);
    fs.readSync(fd, hb, 0, n, 8);
    const header = JSON.parse(hb.toString('utf8'));
    if (header.format !== 'rr-export') throw new Error('unknown export format');
    return { header, headerBytes: hb, dataStart: 8 + n };
  } finally {
    fs.closeSync(fd);
  }
}

/** Decrypt an archive into a plain tar file. Throws on a wrong passphrase or a damaged file. */
async function decryptToTar(file, passphrase, tarFile) {
  const { header, headerBytes, dataStart } = readHeader(file);
  const size = fs.statSync(file).size;
  if (size < dataStart + 16) throw new Error('export file is truncated');
  const tag = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  const key = deriveKey(passphrase, header.kdf);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(file, { start: dataStart, end: size - 17 }), decipher, zlib.createGunzip(), fs.createWriteStream(tarFile, { mode: 0o600 }));
  } catch (e) {
    fs.rmSync(tarFile, { force: true });
    const err = new Error('wrong passphrase or damaged export file');
    err.status = 400;
    throw err;
  }
  return header;
}

// ---------------------------------------------------------------- tar (indexed reader)
function str(buf, off, len) {
  return buf.toString('utf8', off, off + len).replace(/\0.*$/s, '');
}

/** Index a tar file: [{ name, offset, size, mode }] (data offsets, no data loaded). */
function indexTar(tarFile) {
  const fd = fs.openSync(tarFile, 'r');
  const out = [];
  try {
    const total = fs.fstatSync(fd).size;
    const h = Buffer.alloc(512);
    let off = 0;
    let longName = null;
    while (off + 512 <= total) {
      fs.readSync(fd, h, 0, 512, off);
      if (h.every((b) => b === 0)) break;
      const size = parseInt(str(h, 124, 12).trim() || '0', 8);
      const type = String.fromCharCode(h[156] || 48);
      const mode = parseInt(str(h, 100, 8).trim() || '644', 8);
      let name = str(h, 0, 100);
      const prefix = str(h, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
      const dataOff = off + 512;
      off = dataOff + Math.ceil(size / 512) * 512;
      if (type === 'L') {
        const b = Buffer.alloc(size);
        fs.readSync(fd, b, 0, size, dataOff);
        longName = b.toString('utf8').replace(/\0.*$/s, '');
        continue;
      }
      if (type !== '0' && type !== '\0') continue;
      if (longName) { name = longName; longName = null; }
      out.push({ name, offset: dataOff, size, mode });
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function readEntry(tarFile, e) {
  const fd = fs.openSync(tarFile, 'r');
  try {
    const b = Buffer.alloc(e.size);
    if (e.size) fs.readSync(fd, b, 0, e.size, e.offset);
    return b;
  } finally {
    fs.closeSync(fd);
  }
}

/** Copy an entry's data to a file (streamed). */
async function extractEntry(tarFile, e, dest) {
  if (!e.size) { fs.writeFileSync(dest, Buffer.alloc(0), { mode: e.mode & 0o777 || 0o644 }); return; }
  await pipeline(fs.createReadStream(tarFile, { start: e.offset, end: e.offset + e.size - 1 }), fs.createWriteStream(dest, { mode: e.mode & 0o777 || 0o644 }));
  try { fs.chmodSync(dest, e.mode & 0o777 || 0o644); } catch { /* best effort */ }
}

module.exports = { writeEncrypted, readHeader, decryptToTar, indexTar, readEntry, extractEntry, tarStream };

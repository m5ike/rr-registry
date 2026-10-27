'use strict';
// Repository policies shared by all repository types: storage quota and immutability.
const { HttpError } = require('./util/http');
const { dirSize } = require('./util/store');

const sizes = new Map();

/** Current size of a repository in bytes (cached for 30 s - walking a big repo is expensive). */
function repoBytes(handler, fresh = false) {
  const c = sizes.get(handler.dir);
  if (!fresh && c && Date.now() - c.at < 30000) return c.bytes;
  const bytes = dirSize(handler.dir).bytes;
  sizes.set(handler.dir, { bytes, at: Date.now() });
  return bytes;
}

function invalidate(handler) {
  sizes.delete(handler.dir);
}

/** Throw 507 when writing `incoming` more bytes would exceed the repository quota (quotaMb). */
function checkQuota(handler, incoming = 0) {
  const q = Number(handler.conf.quotaMb) || 0;
  if (!q) return;
  const limit = q * 1024 * 1024;
  const used = repoBytes(handler);
  if (used + incoming > limit) {
    throw new HttpError(507, `quota exceeded for repository ${handler.conf.name}: ${(used / 1048576).toFixed(1)} MB used of ${q} MB`, { quotaMb: q, usedBytes: used });
  }
}

/** Throw 403 for destructive changes in immutable repositories (published content never changes). */
function assertMutable(conf, what) {
  if (conf.immutable) throw new HttpError(403, `repository ${conf.name} is immutable: ${what} is not allowed`);
}

module.exports = { checkQuota, assertMutable, repoBytes, invalidate };

'use strict';
// Filesystem cache for remote (proxied) content: <dir>/<ab>/<sha256>.json (meta) + .bin (body).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { mkdirp, writeAtomic, rmrf } = require('./util/store');

class Cache {
  constructor(dir) {
    this.dir = dir;
    this.inflight = new Map();
    this.counters = { hits: 0, misses: 0, stale: 0, errors: 0 };
    mkdirp(dir);
  }

  key(id) {
    return crypto.createHash('sha256').update(id).digest('hex');
  }

  files(key) {
    const d = path.join(this.dir, key.slice(0, 2));
    return { meta: path.join(d, `${key}.json`), body: path.join(d, `${key}.bin`) };
  }

  get(id) {
    const key = this.key(id);
    const f = this.files(key);
    try {
      const meta = JSON.parse(fs.readFileSync(f.meta, 'utf8'));
      const body = fs.readFileSync(f.body);
      return { meta, body, fresh: Date.parse(meta.expires) > Date.now() };
    } catch {
      return null;
    }
  }

  put(id, meta, body) {
    const key = this.key(id);
    const f = this.files(key);
    const m = { key, id, size: body.length, created: new Date().toISOString(), ...meta };
    writeAtomic(f.body, body);
    writeAtomic(f.meta, JSON.stringify(m, null, 2));
    return m;
  }

  delete(key) {
    if (!/^[0-9a-f]{64}$/.test(key)) return false;
    const f = this.files(key);
    const existed = fs.existsSync(f.meta);
    fs.rmSync(f.meta, { force: true });
    fs.rmSync(f.body, { force: true });
    return existed;
  }

  *entries() {
    let dirs;
    try { dirs = fs.readdirSync(this.dir); } catch { return; }
    for (const d of dirs) {
      let files;
      try { files = fs.readdirSync(path.join(this.dir, d)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          yield JSON.parse(fs.readFileSync(path.join(this.dir, d, f), 'utf8'));
        } catch { /* skip broken entry */ }
      }
    }
  }

  list({ q = '', limit = 200 } = {}) {
    const out = [];
    const now = Date.now();
    for (const m of this.entries()) {
      if (q && !m.id.includes(q)) continue;
      out.push({ ...m, expired: Date.parse(m.expires) <= now });
    }
    out.sort((a, b) => b.created.localeCompare(a.created));
    return { total: out.length, entries: out.slice(0, limit) };
  }

  stats() {
    let entries = 0;
    let bytes = 0;
    let expired = 0;
    const now = Date.now();
    for (const m of this.entries()) {
      entries++;
      bytes += m.size || 0;
      if (Date.parse(m.expires) <= now) expired++;
    }
    return { dir: this.dir, entries, expired, bytes, ...this.counters };
  }

  purge({ expired = false, q = '' } = {}) {
    if (!expired && !q) {
      const n = this.stats().entries;
      rmrf(this.dir);
      mkdirp(this.dir);
      return n;
    }
    let n = 0;
    const now = Date.now();
    for (const m of [...this.entries()]) {
      if (expired && Date.parse(m.expires) > now) continue;
      if (q && !m.id.includes(q)) continue;
      if (this.delete(m.key)) n++;
    }
    return n;
  }

  /**
   * Fetch a remote URL through the cache.
   * @returns {Promise<{status:number, headers:object, body:Buffer, cache:string}>}
   */
  async fetch(url, { ttl = 300, headers = {}, method = 'GET', body, id, ruleId, timeoutMs = 30000 } = {}) {
    const cacheable = method === 'GET' && ttl > 0;
    const cid = id || `${method} ${url}`;
    let entry = null;
    if (cacheable) {
      entry = this.get(cid);
      if (entry && entry.fresh) {
        this.counters.hits++;
        return { status: entry.meta.status, headers: entry.meta.headers, body: entry.body, cache: 'HIT' };
      }
    }
    if (cacheable && this.inflight.has(cid)) return this.inflight.get(cid);
    const p = (async () => {
      try {
        const r = await fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
        const buf = Buffer.from(await r.arrayBuffer());
        const h = {};
        for (const k of ['content-type', 'etag', 'last-modified']) if (r.headers.get(k)) h[k] = r.headers.get(k);
        if (r.ok && cacheable) {
          this.counters.misses++;
          this.put(cid, { url, status: r.status, headers: h, ruleId, expires: new Date(Date.now() + ttl * 1000).toISOString() }, buf);
          return { status: r.status, headers: h, body: buf, cache: 'MISS' };
        }
        if (!r.ok && r.status >= 500 && entry) {
          this.counters.stale++;
          return { status: entry.meta.status, headers: entry.meta.headers, body: entry.body, cache: 'STALE' };
        }
        return { status: r.status, headers: h, body: buf, cache: 'BYPASS' };
      } catch (e) {
        this.counters.errors++;
        if (entry) {
          this.counters.stale++;
          return { status: entry.meta.status, headers: entry.meta.headers, body: entry.body, cache: 'STALE' };
        }
        return { status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: `upstream error: ${e.message}`, url })), cache: 'ERROR' };
      } finally {
        this.inflight.delete(cid);
      }
    })();
    if (cacheable) this.inflight.set(cid, p);
    return p;
  }
}

module.exports = { Cache };

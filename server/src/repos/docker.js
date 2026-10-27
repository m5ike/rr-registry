'use strict';
// Docker / OCI image repository - Docker Registry HTTP API v2 (OCI distribution spec).
//
//   GET    /v2/                                    API version check (docker login)
//   HEAD   /v2/<name>/blobs/<digest>               blob exists?            GET downloads it
//   POST   /v2/<name>/blobs/uploads/               start an upload (?digest= monolithic, ?mount=&from= cross mount)
//   PATCH  /v2/<name>/blobs/uploads/<uuid>         append a chunk          GET = upload status
//   PUT    /v2/<name>/blobs/uploads/<uuid>?digest= finish (verifies sha256) DELETE = cancel
//   PUT    /v2/<name>/manifests/<tag|digest>       push a manifest / image index (referenced blobs must exist)
//   GET    /v2/<name>/manifests/<tag|digest>       pull it                 DELETE removes it
//   GET    /v2/<name>/tags/list                    tags (?n=&last= pagination)
//   GET    /v2/_catalog                            image names
//
// Storage (data/repos/<repo>/):  blobs/sha256/<hex>   content addressed (layers, configs and manifests)
//                                images/<name>/tags/<tag>                 -> digest
//                                images/<name>/manifests/<hex>.json       -> { mediaType, size, created }
//                                _uploads/<uuid>  (+ .json)               uploads in progress
// Blobs are shared between images; `gc()` removes what no manifest references.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { HttpError, NotFoundLocal, send, sendJson } = require('../util/http');
const { mkdirp, writeAtomic, readJsonFile, rmrf } = require('../util/store');
const { checkQuota, assertMutable, invalidate } = require('../policies');

const NAME_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_RE = /^sha256:([a-f0-9]{64})$/;
const MANIFEST_TYPES = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
];

/** Registry API error in the OCI format: { errors: [{ code, message, detail }] }. */
class RegistryError extends HttpError {
  constructor(status, code, message, detail) {
    super(status, message);
    this.code = code;
    this.detail = detail;
  }
}

function sendRegistryError(res, e) {
  const status = e.status || 500;
  const code = e.code || (status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'DENIED' : status === 404 ? 'NAME_UNKNOWN' : status === 405 ? 'UNSUPPORTED' : 'UNKNOWN');
  if (status === 401) res.setHeader('www-authenticate', 'Basic realm="rr-registry"');
  sendJson(res, status, { errors: [{ code, message: e.message || 'error', detail: e.detail || null }] });
}

const sha256File = (file) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(`sha256:${h.digest('hex')}`)).on('error', reject);
  });

class DockerRepo {
  constructor(app, conf) {
    this.app = app;
    this.conf = conf;
    this.dir = path.join(app.config.dataDir, 'repos', conf.name);
    mkdirp(path.join(this.dir, 'blobs', 'sha256'));
    mkdirp(path.join(this.dir, 'images'));
    mkdirp(path.join(this.dir, '_uploads'));
  }

  packagePath() {
    return null;
  }

  // ---------- storage ----------
  blobFile(digest) {
    const m = DIGEST_RE.exec(digest);
    if (!m) throw new RegistryError(400, 'DIGEST_INVALID', `invalid digest ${digest}`);
    return path.join(this.dir, 'blobs', 'sha256', m[1]);
  }
  hasBlob(digest) {
    try {
      return fs.statSync(this.blobFile(digest)).isFile();
    } catch {
      return false;
    }
  }
  imageDir(name) {
    if (!NAME_RE.test(name) || name.length > 255) throw new RegistryError(400, 'NAME_INVALID', `invalid image name ${name}`);
    return path.join(this.dir, 'images', ...name.split('/'));
  }
  manifestMeta(name, digest) {
    return readJsonFile(path.join(this.imageDir(name), 'manifests', `${digest.slice(7)}.json`), null);
  }
  /** tag or digest → { digest, meta } (null when unknown in this image). */
  resolve(name, ref) {
    let digest = ref;
    if (!DIGEST_RE.test(ref)) {
      if (!TAG_RE.test(ref)) throw new RegistryError(400, 'TAG_INVALID', `invalid tag ${ref}`);
      try {
        digest = fs.readFileSync(path.join(this.imageDir(name), 'tags', ref), 'utf8').trim();
      } catch {
        return null;
      }
    }
    const meta = this.manifestMeta(name, digest);
    return meta && this.hasBlob(digest) ? { digest, meta } : null;
  }

  /** All image names (directories that hold manifests). */
  names() {
    const root = path.join(this.dir, 'images');
    const out = [];
    const walk = (dir, prefix) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      if (entries.some((e) => e.isDirectory() && e.name === 'manifests')) out.push(prefix);
      for (const e of entries) if (e.isDirectory() && e.name !== 'manifests' && e.name !== 'tags') walk(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
    };
    walk(root, '');
    return out.filter(Boolean).sort();
  }
  tags(name) {
    try {
      return fs.readdirSync(path.join(this.imageDir(name), 'tags')).filter((t) => !t.endsWith('.tmp')).sort();
    } catch {
      return [];
    }
  }
  manifestBody(digest) {
    return fs.readFileSync(this.blobFile(digest));
  }
  /** Total size of an image (config + layers; for an index the sum of its manifests). */
  imageSize(digest, seen = new Set()) {
    if (seen.has(digest) || !this.hasBlob(digest)) return 0;
    seen.add(digest);
    let m;
    try {
      m = JSON.parse(this.manifestBody(digest).toString('utf8'));
    } catch {
      return 0;
    }
    if (Array.isArray(m.manifests)) return m.manifests.reduce((n, x) => n + this.imageSize(x.digest, seen), 0);
    return (m.config ? m.config.size || 0 : 0) + (m.layers || []).reduce((n, l) => n + (l.size || 0), 0);
  }

  listPackages(q = '') {
    return this.names()
      .filter((n) => !q || n.includes(q))
      .map((n) => ({ name: n, version: this.tags(n).slice(-1)[0] || '', description: `${this.tags(n).length} tag(s)` }));
  }

  /** Image overview for the management API. */
  images() {
    return this.names().map((name) => {
      const tags = this.tags(name);
      let updated = null;
      for (const t of tags) {
        try {
          const st = fs.statSync(path.join(this.imageDir(name), 'tags', t));
          if (!updated || st.mtime > updated) updated = st.mtime;
        } catch { /* ignore */ }
      }
      const latest = tags.includes('latest') ? this.resolve(name, 'latest') : tags.length ? this.resolve(name, tags[tags.length - 1]) : null;
      return { name, tags: tags.length, size: latest ? this.imageSize(latest.digest) : 0, updated: updated ? updated.toISOString() : null };
    });
  }
  tagDetails(name) {
    if (!this.names().includes(name)) throw new HttpError(404, `image ${name} not found`);
    return this.tags(name).map((tag) => {
      const r = this.resolve(name, tag);
      let created = null;
      try {
        created = fs.statSync(path.join(this.imageDir(name), 'tags', tag)).mtime.toISOString();
      } catch { /* ignore */ }
      return { tag, digest: r ? r.digest : null, mediaType: r ? r.meta.mediaType : null, size: r ? this.imageSize(r.digest) : 0, created };
    });
  }
  deleteTag(name, tag) {
    const f = path.join(this.imageDir(name), 'tags', tag);
    if (!fs.existsSync(f)) throw new HttpError(404, `tag ${name}:${tag} not found`);
    fs.unlinkSync(f);
  }
  deleteManifest(name, digest) {
    const dir = this.imageDir(name);
    const meta = path.join(dir, 'manifests', `${digest.slice(7)}.json`);
    if (!fs.existsSync(meta)) throw new RegistryError(404, 'MANIFEST_UNKNOWN', `manifest ${digest} not found`);
    fs.unlinkSync(meta);
    for (const t of this.tags(name)) {
      const f = path.join(dir, 'tags', t);
      if (fs.readFileSync(f, 'utf8').trim() === digest) fs.unlinkSync(f);
    }
  }

  /**
   * Retention policy (repo.cleanup): per image keep the newest `maxVersions` tags and drop tags older
   * than `maxAgeDays` ("latest" is always kept), then garbage-collect unreferenced data.
   */
  cleanup(policy = {}, { dryRun = false } = {}) {
    const actions = [];
    const max = Number(policy.maxVersions) || 0;
    const age = Number(policy.maxAgeDays) || 0;
    for (const name of this.names()) {
      const tags = this.tagDetails(name).filter((t) => t.tag !== 'latest').sort((a, b) => String(b.created).localeCompare(String(a.created)));
      tags.forEach((t, i) => {
        const old = age && t.created && Date.now() - Date.parse(t.created) > age * 86400000;
        if ((max && i >= max) || old) actions.push({ action: 'delete-tag', target: `${name}:${t.tag}`, reason: old ? `older than ${age} days` : `more than ${max} tags` });
      });
    }
    let freedBytes = 0;
    if (!dryRun) {
      for (const a of actions) {
        const [name, tag] = a.target.split(':');
        try { this.deleteTag(name, tag); } catch { /* already gone */ }
      }
      freedBytes = this.gc({ untagged: true }).bytes;
      invalidate(this);
    }
    return { actions, freedBytes };
  }

  /**
   * Garbage collection: optionally drop untagged manifests, then every blob that no manifest
   * references, and uploads older than a day. Returns what was removed.
   */
  gc({ untagged = false } = {}) {
    const removed = { manifests: 0, blobs: 0, bytes: 0, uploads: 0 };
    const keep = new Set();
    const mark = (digest) => {
      if (keep.has(digest) || !this.hasBlob(digest)) return;
      keep.add(digest);
      try {
        const m = JSON.parse(this.manifestBody(digest).toString('utf8'));
        if (m.config && m.config.digest) keep.add(m.config.digest);
        for (const l of m.layers || []) keep.add(l.digest);
        for (const x of m.manifests || []) mark(x.digest);
      } catch { /* not JSON */ }
    };
    for (const name of this.names()) {
      const dir = path.join(this.imageDir(name), 'manifests');
      const tagged = new Set(this.tags(name).map((t) => fs.readFileSync(path.join(this.imageDir(name), 'tags', t), 'utf8').trim()));
      // children of a tagged index stay
      for (const d of tagged) mark(d);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const digest = `sha256:${f.slice(0, -5)}`;
        if (untagged && !tagged.has(digest) && !keep.has(digest)) {
          fs.unlinkSync(path.join(dir, f));
          removed.manifests++;
        } else mark(digest);
      }
    }
    const bdir = path.join(this.dir, 'blobs', 'sha256');
    for (const f of fs.readdirSync(bdir)) {
      if (keep.has(`sha256:${f}`) || f.endsWith('.tmp')) continue;
      const full = path.join(bdir, f);
      removed.bytes += fs.statSync(full).size;
      fs.unlinkSync(full);
      removed.blobs++;
    }
    const udir = path.join(this.dir, '_uploads');
    for (const f of fs.readdirSync(udir)) {
      const full = path.join(udir, f);
      if (Date.now() - fs.statSync(full).mtimeMs > 24 * 3600 * 1000) {
        rmrf(full);
        if (!f.endsWith('.json')) removed.uploads++;
      }
    }
    return removed;
  }

  // ---------- HTTP (/v2/...) ----------
  uploadFile(uuid) {
    if (!/^[a-f0-9-]{36}$/.test(uuid)) throw new RegistryError(404, 'BLOB_UPLOAD_UNKNOWN', 'unknown upload');
    return path.join(this.dir, '_uploads', uuid);
  }
  uploadSize(file) {
    try {
      return fs.statSync(file).size;
    } catch {
      throw new RegistryError(404, 'BLOB_UPLOAD_UNKNOWN', 'unknown upload');
    }
  }
  async appendBody(req, file) {
    await pipeline(req, fs.createWriteStream(file, { flags: 'a' }));
  }
  async commitUpload(file, digest) {
    const actual = await sha256File(file);
    if (actual !== digest) {
      fs.rmSync(file, { force: true });
      throw new RegistryError(400, 'DIGEST_INVALID', `digest mismatch: got ${actual}`);
    }
    const dest = this.blobFile(digest);
    if (fs.existsSync(dest)) fs.rmSync(file, { force: true });
    else fs.renameSync(file, dest);
    fs.rmSync(`${file}.json`, { force: true });
  }

  /** Handle /v2/... (path without the "/v2" prefix). */
  async handleV2(req, res, p, search) {
    res.setHeader('docker-distribution-api-version', 'registry/2.0');
    const method = req.method;
    const read = () => this.app.auth.require(req, 'read', this.conf);
    const push = () => {
      const id = this.app.auth.require(req, 'publish', this.conf);
      if (this.conf.allowPublish === false) throw new RegistryError(403, 'DENIED', 'pushing to this repository is disabled');
      if (method !== 'DELETE') {
        try { checkQuota(this, Number(req.headers['content-length']) || 0); } catch (e) { throw new RegistryError(e.status, 'DENIED', e.message); }
      }
      return id;
    };
    if (p === '/' || p === '') {
      // docker login probes this with credentials; anonymous pulls are allowed when the repo is public
      const id = this.app.auth.authenticate(req);
      if (!id && !this.app.auth.can(null, 'read', this.conf)) throw new RegistryError(401, 'UNAUTHORIZED', 'authentication required');
      return sendJson(res, 200, {});
    }
    if (p === '/_catalog') {
      read();
      const all = this.names();
      const n = Number(search.get('n')) || all.length;
      const last = search.get('last');
      const start = last ? all.findIndex((x) => x > last) : 0;
      const page = start < 0 ? [] : all.slice(start, start + n);
      if (start >= 0 && start + n < all.length) res.setHeader('link', `</v2/_catalog?n=${n}&last=${encodeURIComponent(page[page.length - 1])}>; rel="next"`);
      return sendJson(res, 200, { repositories: page });
    }
    const m = /^\/(.+?)\/(blobs\/uploads\/?([^/]*)|blobs\/([^/]+)|manifests\/([^/]+)|tags\/list)$/.exec(p);
    if (!m) throw new RegistryError(404, 'NAME_UNKNOWN', 'unknown endpoint');
    const name = m[1];
    this.imageDir(name); // validates the name
    const loc = (sub) => `/v2/${name}/${sub}`;

    // ----- uploads -----
    if (m[2].startsWith('blobs/uploads')) {
      const uuid = m[3];
      if (!uuid) {
        if (method !== 'POST') throw new RegistryError(405, 'UNSUPPORTED', 'method not allowed');
        const id = push();
        const mount = search.get('mount');
        if (mount && this.hasBlob(mount)) {
          res.setHeader('location', loc(`blobs/${mount}`));
          res.setHeader('docker-content-digest', mount);
          return send(res, 201, null);
        }
        const newId = crypto.randomUUID();
        const file = this.uploadFile(newId);
        fs.writeFileSync(file, Buffer.alloc(0));
        fs.writeFileSync(`${file}.json`, JSON.stringify({ name, user: id ? id.name : null, started: new Date().toISOString() }));
        const digest = search.get('digest');
        if (digest) {
          await this.appendBody(req, file);
          await this.commitUpload(file, digest);
          this.app.audit(id, 'docker-blob', `${this.conf.name}/${name}@${digest}`);
          res.setHeader('location', loc(`blobs/${digest}`));
          res.setHeader('docker-content-digest', digest);
          return send(res, 201, null);
        }
        res.setHeader('location', loc(`blobs/uploads/${newId}`));
        res.setHeader('docker-upload-uuid', newId);
        res.setHeader('range', '0-0');
        return send(res, 202, null);
      }
      const file = this.uploadFile(uuid);
      if (method === 'GET') {
        read();
        const size = this.uploadSize(file);
        res.setHeader('location', loc(`blobs/uploads/${uuid}`));
        res.setHeader('docker-upload-uuid', uuid);
        res.setHeader('range', `0-${Math.max(0, size - 1)}`);
        return send(res, 204, null);
      }
      if (method === 'PATCH') {
        push();
        this.uploadSize(file);
        await this.appendBody(req, file);
        const size = this.uploadSize(file);
        res.setHeader('location', loc(`blobs/uploads/${uuid}`));
        res.setHeader('docker-upload-uuid', uuid);
        res.setHeader('range', `0-${Math.max(0, size - 1)}`);
        return send(res, 202, null);
      }
      if (method === 'PUT') {
        const id = push();
        this.uploadSize(file);
        const digest = search.get('digest');
        if (!digest) throw new RegistryError(400, 'DIGEST_INVALID', 'digest query parameter required');
        await this.appendBody(req, file);
        await this.commitUpload(file, digest);
        this.app.audit(id, 'docker-blob', `${this.conf.name}/${name}@${digest}`);
        res.setHeader('location', loc(`blobs/${digest}`));
        res.setHeader('docker-content-digest', digest);
        return send(res, 201, null);
      }
      if (method === 'DELETE') {
        push();
        this.uploadSize(file);
        fs.rmSync(file, { force: true });
        fs.rmSync(`${file}.json`, { force: true });
        return send(res, 204, null);
      }
      throw new RegistryError(405, 'UNSUPPORTED', 'method not allowed');
    }

    // ----- blobs -----
    if (m[4]) {
      const digest = m[4];
      if (method === 'GET' || method === 'HEAD') {
        read();
        if (!this.hasBlob(digest)) throw new RegistryError(404, 'BLOB_UNKNOWN', `blob ${digest} not found`);
        const file = this.blobFile(digest);
        const size = fs.statSync(file).size;
        const headers = { 'content-type': 'application/octet-stream', 'docker-content-digest': digest, etag: `"${digest}"`, 'accept-ranges': 'bytes' };
        if (method === 'HEAD') return send(res, 200, null, { ...headers, 'content-length': size });
        this.app.stats.downloads++;
        const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range || ''));
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end) throw new RegistryError(416, 'BLOB_UNKNOWN', 'range not satisfiable');
          res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
          return pipeline(fs.createReadStream(file, { start, end }), res);
        }
        res.writeHead(200, { ...headers, 'content-length': size });
        return pipeline(fs.createReadStream(file), res);
      }
      if (method === 'DELETE') {
        // blobs are shared between images - garbage collection removes unreferenced ones
        push();
        throw new RegistryError(405, 'UNSUPPORTED', 'delete manifests and run garbage collection instead');
      }
      throw new RegistryError(405, 'UNSUPPORTED', 'method not allowed');
    }

    // ----- manifests -----
    if (m[5]) {
      const ref = decodeURIComponent(m[5]);
      if (method === 'GET' || method === 'HEAD') {
        read();
        const r = this.resolve(name, ref);
        if (!r) throw new RegistryError(404, 'MANIFEST_UNKNOWN', `manifest ${name}:${ref} not found`);
        const body = this.manifestBody(r.digest);
        const headers = { 'content-type': r.meta.mediaType, 'docker-content-digest': r.digest, etag: `"${r.digest}"` };
        if (method === 'HEAD') return send(res, 200, null, { ...headers, 'content-length': body.length });
        this.app.stats.downloads++;
        this.app.statsStore.hit(this.conf.name, `${name}:${ref}`);
        return send(res, 200, body, headers);
      }
      if (method === 'PUT') {
        const id = push();
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 4 * 1024 * 1024) throw new RegistryError(413, 'MANIFEST_INVALID', 'manifest too large');
          chunks.push(c);
        }
        const body = Buffer.concat(chunks);
        let doc;
        try {
          doc = JSON.parse(body.toString('utf8'));
        } catch {
          throw new RegistryError(400, 'MANIFEST_INVALID', 'manifest is not JSON');
        }
        const mediaType = String(req.headers['content-type'] || doc.mediaType || '').split(';')[0].trim() || 'application/vnd.oci.image.manifest.v1+json';
        if (!MANIFEST_TYPES.includes(mediaType)) throw new RegistryError(400, 'MANIFEST_INVALID', `unsupported manifest type ${mediaType}`);
        // everything the manifest points to must be here already
        const missing = [];
        if (Array.isArray(doc.manifests)) {
          for (const x of doc.manifests) if (!this.hasBlob(x.digest)) missing.push(x.digest);
        } else {
          if (!doc.config || !doc.config.digest) throw new RegistryError(400, 'MANIFEST_INVALID', 'manifest has no config');
          for (const d of [doc.config.digest, ...(doc.layers || []).filter((l) => !l.urls).map((l) => l.digest)]) if (!this.hasBlob(d)) missing.push(d);
        }
        if (missing.length) throw new RegistryError(400, 'MANIFEST_BLOB_UNKNOWN', `unknown blob(s) ${missing.join(', ')}`, { missing });
        const digest = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
        if (DIGEST_RE.test(ref) && ref !== digest) throw new RegistryError(400, 'DIGEST_INVALID', `manifest digest is ${digest}`);
        if (this.conf.immutable && !DIGEST_RE.test(ref)) {
          const cur = this.resolve(name, ref);
          if (cur && cur.digest !== digest) throw new RegistryError(403, 'DENIED', `repository ${this.conf.name} is immutable: tag ${name}:${ref} cannot be overwritten`);
        }
        const bfile = this.blobFile(digest);
        if (!fs.existsSync(bfile)) writeAtomic(bfile, body);
        const dir = this.imageDir(name);
        writeAtomic(path.join(dir, 'manifests', `${digest.slice(7)}.json`), JSON.stringify({ mediaType, size: body.length, created: new Date().toISOString() }));
        if (!DIGEST_RE.test(ref)) writeAtomic(path.join(dir, 'tags', ref), digest);
        this.app.audit(id, 'docker-push', `${this.conf.name}/${name}:${ref}`);
        invalidate(this);
        this.app.events.emit('docker.push', { repo: this.conf.name, name, ref, digest, mediaType }, id);
        res.setHeader('location', loc(`manifests/${digest}`));
        res.setHeader('docker-content-digest', digest);
        return send(res, 201, null);
      }
      if (method === 'DELETE') {
        const id = push();
        try { assertMutable(this.conf, 'deleting images'); } catch (e) { throw new RegistryError(403, 'DENIED', e.message); }
        if (DIGEST_RE.test(ref)) this.deleteManifest(name, ref);
        else {
          try {
            this.deleteTag(name, ref);
          } catch {
            throw new RegistryError(404, 'MANIFEST_UNKNOWN', `tag ${ref} not found`);
          }
        }
        this.app.audit(id, 'docker-delete', `${this.conf.name}/${name}:${ref}`);
        this.app.events.emit('docker.delete', { repo: this.conf.name, name, ref }, id);
        return send(res, 202, null);
      }
      throw new RegistryError(405, 'UNSUPPORTED', 'method not allowed');
    }

    // ----- tags -----
    if (method !== 'GET') throw new RegistryError(405, 'UNSUPPORTED', 'method not allowed');
    read();
    if (!this.names().includes(name)) throw new RegistryError(404, 'NAME_UNKNOWN', `image ${name} not found`);
    const all = this.tags(name);
    const n = Number(search.get('n')) || all.length;
    const last = search.get('last');
    const start = last ? all.findIndex((t) => t > last) : 0;
    const page = start < 0 ? [] : all.slice(start, start + n);
    if (start >= 0 && start + n < all.length) res.setHeader('link', `</v2/${name}/tags/list?n=${n}&last=${encodeURIComponent(page[page.length - 1])}>; rel="next"`);
    return sendJson(res, 200, { name, tags: page });
  }

  /** /r/<repo>/... is not used by docker clients - point to /v2/. */
  async handle(ctx) {
    throw new NotFoundLocal(`docker repository ${this.conf.name}: use the Docker Registry API at /v2/`);
  }
}

module.exports = { DockerRepo, RegistryError, sendRegistryError, NAME_RE };

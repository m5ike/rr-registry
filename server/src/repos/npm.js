'use strict';
// npm compatible repository (works with npm, yarn, pnpm, bun and deno npm: specifiers).
//
// Storage layout:  <data>/repos/<repo>/<name>/packument.json
//                  <data>/repos/<repo>/<name>/<basename>-<version>.tgz
// (scoped packages live in <repo>/@scope/<name>/)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, NotFoundLocal, send, sendJson, readJson } = require('../util/http');
const { mkdirp, writeAtomic, readJsonFile, rmrf } = require('../util/store');
const semver = require('../util/semver');
const tar = require('../util/tar');
const { checkQuota, assertMutable, invalidate } = require('../policies');

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9._~-][a-z0-9._~-]*$/i;

function validName(name) {
  return typeof name === 'string' && name.length <= 214 && NAME_RE.test(name) && !name.split('/').some((s) => s === '.' || s === '..' || s.startsWith('.'));
}

function baseName(name) {
  return name.includes('/') ? name.split('/')[1] : name;
}

class NpmRepo {
  constructor(app, conf) {
    this.app = app;
    this.conf = conf;
    this.dir = path.join(app.config.dataDir, 'repos', conf.name);
    mkdirp(this.dir);
  }

  // ---------- storage ----------
  pkgDir(name) {
    if (!validName(name)) throw new HttpError(400, `invalid package name: ${name}`);
    return path.join(this.dir, ...name.split('/'));
  }

  read(name) {
    if (!validName(name)) return null;
    return readJsonFile(path.join(this.pkgDir(name), 'packument.json'), null);
  }

  write(name, doc) {
    const rev = parseInt(String(doc._rev || '0').split('-')[0], 10) || 0;
    doc._rev = `${rev + 1}-${crypto.randomBytes(8).toString('hex')}`;
    doc.time = doc.time || {};
    doc.time.modified = new Date().toISOString();
    writeAtomic(path.join(this.pkgDir(name), 'packument.json'), JSON.stringify(doc, null, 2));
  }

  newDoc(name) {
    const now = new Date().toISOString();
    return { _id: name, name, description: '', 'dist-tags': {}, versions: {}, time: { created: now, modified: now }, maintainers: [], readme: '' };
  }

  names() {
    const out = [];
    let top;
    try { top = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return out; }
    for (const e of top) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('@')) {
        for (const s of fs.readdirSync(path.join(this.dir, e.name), { withFileTypes: true })) {
          if (s.isDirectory() && fs.existsSync(path.join(this.dir, e.name, s.name, 'packument.json'))) out.push(`${e.name}/${s.name}`);
        }
      } else if (fs.existsSync(path.join(this.dir, e.name, 'packument.json'))) out.push(e.name);
    }
    return out.sort();
  }

  summary(doc) {
    const latest = doc['dist-tags'].latest;
    const m = doc.versions[latest] || {};
    return {
      name: doc.name,
      version: latest,
      description: doc.description || m.description || '',
      keywords: m.keywords || [],
      versions: Object.keys(doc.versions).length,
      distTags: doc['dist-tags'],
      maintainers: doc.maintainers || [],
      author: m.author || null,
      license: m.license || '',
      modified: doc.time.modified,
      created: doc.time.created,
    };
  }

  listPackages(q = '') {
    const ql = String(q).toLowerCase();
    return this.names()
      .map((n) => this.read(n))
      .filter(Boolean)
      .filter((d) => !ql || d.name.toLowerCase().includes(ql) || String(d.description || '').toLowerCase().includes(ql))
      .map((d) => this.summary(d));
  }

  getPackage(name) {
    const doc = this.read(name);
    if (!doc) throw new HttpError(404, `package ${name} not found in ${this.conf.name}`);
    return doc;
  }

  storeVersion(doc, manifest, tgz, identity) {
    const name = doc.name;
    const version = manifest.version;
    if (!semver.valid(version)) throw new HttpError(400, `invalid version: ${version}`);
    if (doc.versions[version]) throw new HttpError(403, `cannot publish over the previously published version ${name}@${version}`);
    checkQuota(this, tgz.length);
    const file = `${baseName(name)}-${version}.tgz`;
    const shasum = crypto.createHash('sha1').update(tgz).digest('hex');
    const integrity = `sha512-${crypto.createHash('sha512').update(tgz).digest('base64')}`;
    const m = { ...manifest };
    delete m.readme;
    delete m._attachments;
    m.name = name;
    m._id = `${name}@${version}`;
    m.dist = { ...(m.dist || {}), shasum, integrity, tarball: `/${name}/-/${file}`, size: tgz.length };
    if (identity) m._npmUser = { name: identity.name };
    mkdirp(this.pkgDir(name));
    writeAtomic(path.join(this.pkgDir(name), file), tgz);
    doc.versions[version] = m;
    doc.time[version] = new Date().toISOString();
    if (m.description) doc.description = m.description;
    return m;
  }

  finalize(doc, identity, maintainers) {
    if (maintainers && maintainers.length) doc.maintainers = maintainers;
    else if (identity && !doc.maintainers.some((x) => x.name === identity.name)) doc.maintainers.push({ name: identity.name, email: identity.email || '' });
    const versions = Object.keys(doc.versions);
    if (!doc['dist-tags'].latest || !doc.versions[doc['dist-tags'].latest]) doc['dist-tags'].latest = semver.maxStable(versions);
    for (const [t, v] of Object.entries(doc['dist-tags'])) if (!doc.versions[v]) delete doc['dist-tags'][t];
  }

  /** Publish request as sent by `npm publish` (PUT /<name> with _attachments). */
  publishNpm(body, identity) {
    const name = body.name || body._id;
    if (!validName(name)) throw new HttpError(400, `invalid package name: ${name}`);
    const atts = body._attachments || {};
    if (!Object.keys(atts).length) return this.updateMetadata(name, body, identity);
    const doc = this.read(name) || this.newDoc(name);
    const versions = Object.keys(body.versions || {});
    if (!versions.length) throw new HttpError(400, 'no versions in publish request');
    let lastTgz = null;
    for (const v of versions) {
      const file = `${baseName(name)}-${v}.tgz`;
      const key = Object.keys(atts).find((k) => k.endsWith(file)) || Object.keys(atts)[0];
      const att = atts[key];
      const tgz = Buffer.from(att.data, 'base64');
      if (att.length && Number(att.length) !== tgz.length) throw new HttpError(400, 'attachment length mismatch');
      this.storeVersion(doc, body.versions[v], tgz, identity);
      lastTgz = tgz;
    }
    for (const [t, v] of Object.entries(body['dist-tags'] || {})) doc['dist-tags'][t] = v;
    if (body.readme) doc.readme = body.readme;
    else if (body.versions[versions[0]].readme) doc.readme = body.versions[versions[0]].readme;
    else {
      try { doc.readme = tar.readReadme(lastTgz) || doc.readme; } catch { /* keep previous readme */ }
    }
    this.finalize(doc, identity);
    this.write(name, doc);
    this.app.audit(identity, 'publish', `${this.conf.name}/${name}@${versions.join(',')}`);
    invalidate(this);
    this.app.events.emit('npm.publish', { repo: this.conf.name, name, versions, distTags: doc['dist-tags'] }, identity);
    return { ok: true, id: name, rev: doc._rev };
  }

  /** Publish a raw .tgz (admin API / CLI / seeding). */
  publishTarball(tgz, identity, { tag = 'latest', maintainers } = {}) {
    let pj;
    try { pj = tar.readPackageJson(tgz); } catch (e) { throw new HttpError(400, `invalid package tarball: ${e.message}`); }
    if (!validName(pj.name)) throw new HttpError(400, `invalid package name: ${pj.name}`);
    const doc = this.read(pj.name) || this.newDoc(pj.name);
    const m = this.storeVersion(doc, pj, tgz, identity);
    doc['dist-tags'][tag] = pj.version;
    const readme = tar.readReadme(tgz);
    if (readme) doc.readme = readme;
    this.finalize(doc, identity, maintainers);
    this.write(pj.name, doc);
    this.app.audit(identity, 'publish', `${this.conf.name}/${pj.name}@${pj.version}`);
    invalidate(this);
    this.app.events.emit('npm.publish', { repo: this.conf.name, name: pj.name, versions: [pj.version], distTags: doc['dist-tags'] }, identity);
    return { ok: true, name: pj.name, version: pj.version, dist: m.dist };
  }

  /** Metadata update (npm deprecate / npm unpublish <pkg>@<ver> / dist-tag changes). */
  updateMetadata(name, body, identity) {
    const doc = this.getPackage(name);
    const removed = body.versions ? Object.keys(doc.versions).filter((v) => !body.versions[v]) : [];
    if (removed.length) assertMutable(this.conf, 'unpublishing versions');
    if (body.versions) {
      for (const v of Object.keys(doc.versions)) {
        if (!body.versions[v]) this.removeVersionFiles(doc, v);
        else if (body.versions[v].deprecated) doc.versions[v].deprecated = body.versions[v].deprecated;
        else delete doc.versions[v].deprecated;
      }
    }
    if (body['dist-tags']) doc['dist-tags'] = { ...body['dist-tags'] };
    if (!Object.keys(doc.versions).length) {
      this.unpublish(name, identity);
      return { ok: true, id: name };
    }
    this.finalize(doc);
    this.write(name, doc);
    if (removed.length) this.app.events.emit('npm.unpublish', { repo: this.conf.name, name, versions: removed }, identity);
    else this.app.events.emit('npm.deprecate', { repo: this.conf.name, name }, identity);
    return { ok: true, id: name, rev: doc._rev };
  }

  removeVersionFiles(doc, v) {
    const m = doc.versions[v];
    if (!m) return;
    const file = path.basename(m.dist.tarball);
    fs.rmSync(path.join(this.pkgDir(doc.name), file), { force: true });
    delete doc.versions[v];
    delete doc.time[v];
  }

  deleteVersion(name, version, identity) {
    const doc = this.getPackage(name);
    if (!doc.versions[version]) throw new HttpError(404, `version ${version} not found`);
    assertMutable(this.conf, 'deleting versions');
    this.removeVersionFiles(doc, version);
    this.app.audit(identity, 'unpublish', `${this.conf.name}/${name}@${version}`);
    if (!Object.keys(doc.versions).length) return this.unpublish(name, identity);
    this.finalize(doc);
    this.write(name, doc);
    invalidate(this);
    this.app.events.emit('npm.unpublish', { repo: this.conf.name, name, versions: [version] }, identity);
    return { ok: true };
  }

  unpublish(name, identity) {
    const dir = this.pkgDir(name);
    if (!fs.existsSync(dir)) throw new HttpError(404, `package ${name} not found`);
    assertMutable(this.conf, 'unpublishing packages');
    rmrf(dir);
    const parent = path.dirname(dir);
    if (parent !== this.dir && fs.existsSync(parent) && !fs.readdirSync(parent).length) fs.rmdirSync(parent);
    this.app.audit(identity, 'unpublish', `${this.conf.name}/${name}`);
    invalidate(this);
    this.app.events.emit('npm.unpublish', { repo: this.conf.name, name, versions: null }, identity);
    return { ok: true };
  }

  setTag(name, tag, version) {
    const doc = this.getPackage(name);
    if (!doc.versions[version]) throw new HttpError(404, `version ${version} not found`);
    if (!tag || semver.valid(tag)) throw new HttpError(400, 'invalid tag');
    doc['dist-tags'][tag] = version;
    this.write(name, doc);
    this.app.events.emit('npm.tag', { repo: this.conf.name, name, tag, version }, null);
    return doc['dist-tags'];
  }

  deleteTag(name, tag) {
    const doc = this.getPackage(name);
    if (tag === 'latest') throw new HttpError(400, 'cannot delete the latest tag');
    delete doc['dist-tags'][tag];
    this.write(name, doc);
    this.app.events.emit('npm.tag', { repo: this.conf.name, name, tag, version: null }, null);
    return doc['dist-tags'];
  }

  deprecate(name, version, message) {
    const doc = this.getPackage(name);
    const list = version === '*' ? Object.keys(doc.versions) : [version];
    for (const v of list) {
      if (!doc.versions[v]) throw new HttpError(404, `version ${v} not found`);
      if (message) doc.versions[v].deprecated = message;
      else delete doc.versions[v].deprecated;
    }
    this.write(name, doc);
    this.app.events.emit('npm.deprecate', { repo: this.conf.name, name, versions: list, message }, null);
    return { ok: true };
  }

  /**
   * Retention policy (repo.cleanup): keep the newest `maxVersions` versions of every package and/or drop
   * versions older than `maxAgeDays`. Versions referenced by a dist-tag are kept; `prereleaseOnly`
   * limits the cleanup to pre-releases (1.0.0-beta.1).
   */
  cleanup(policy = {}, { dryRun = false } = {}) {
    const actions = [];
    const max = Number(policy.maxVersions) || 0;
    const age = Number(policy.maxAgeDays) || 0;
    for (const n of this.names()) {
      const doc = this.read(n);
      if (!doc) continue;
      const tagged = new Set(Object.values(doc['dist-tags']));
      let candidates = semver.sort(Object.keys(doc.versions)).reverse();
      if (policy.prereleaseOnly) candidates = candidates.filter((v) => (semver.parse(v) || { pre: [] }).pre.length);
      candidates.forEach((v, i) => {
        if (tagged.has(v)) return;
        const old = age && doc.time[v] && Date.now() - Date.parse(doc.time[v]) > age * 86400000;
        if ((max && i >= max) || old) actions.push({ action: 'delete-version', target: `${n}@${v}`, size: doc.versions[v].dist.size || 0, reason: old ? `older than ${age} days` : `more than ${max} versions` });
      });
    }
    let freedBytes = 0;
    if (!dryRun) {
      for (const a of actions) {
        const i = a.target.lastIndexOf('@');
        const name = a.target.slice(0, i);
        const doc = this.read(name);
        if (!doc) continue;
        this.removeVersionFiles(doc, a.target.slice(i + 1));
        freedBytes += a.size;
        if (!Object.keys(doc.versions).length) rmrf(this.pkgDir(name));
        else { this.finalize(doc); this.write(name, doc); }
      }
      invalidate(this);
    }
    return { actions, freedBytes };
  }

  tarball(name, file) {
    if (!/^[^/\\]+\.tgz$/.test(file)) throw new NotFoundLocal('invalid tarball name');
    const p = path.join(this.pkgDir(name), file);
    try { return fs.readFileSync(p); } catch { return null; }
  }

  search(text = '', size = 20, from = 0) {
    const terms = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const n of this.names()) {
      const d = this.read(n);
      if (!d) continue;
      const s = this.summary(d);
      let score = 0;
      let ok = true;
      for (const t of terms) {
        const [q, val] = t.includes(':') ? t.split(/:(.*)/) : [null, t];
        if (q === 'keywords') ok = ok && s.keywords.some((k) => String(k).toLowerCase() === val);
        else if (q === 'scope') ok = ok && s.name.startsWith(`@${val.replace(/^@/, '')}/`);
        else if (q === 'maintainer' || q === 'author') ok = ok && s.maintainers.some((m) => String(m.name).toLowerCase() === val);
        else if (s.name.toLowerCase() === val) score += 10;
        else if (s.name.toLowerCase().includes(val)) score += 5;
        else if (s.description.toLowerCase().includes(val) || s.keywords.some((k) => String(k).toLowerCase().includes(val))) score += 1;
        else ok = false;
      }
      if (ok) results.push({ s, score });
    }
    results.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
    const page = results.slice(Number(from) || 0, (Number(from) || 0) + Math.min(Number(size) || 20, 250));
    return {
      objects: page.map(({ s, score }) => ({
        package: {
          name: s.name, scope: s.name.startsWith('@') ? s.name.slice(1).split('/')[0] : 'unscoped', version: s.version, description: s.description,
          keywords: s.keywords, date: s.modified, links: {}, license: s.license, author: s.author || undefined,
          publisher: { username: (s.maintainers[0] || {}).name || '', email: (s.maintainers[0] || {}).email || '' },
          maintainers: s.maintainers.map((m) => ({ username: m.name, email: m.email || '' })),
        },
        score: { final: Math.min(1, score / 10 + 0.1), detail: { quality: 1, popularity: 1, maintenance: 1 } },
        searchScore: score,
        repository: this.conf.name,
      })),
      total: results.length,
      time: new Date().toUTCString(),
    };
  }

  /** Client facing packument: absolute tarball URLs. */
  serialize(doc, base) {
    const out = JSON.parse(JSON.stringify(doc));
    for (const v of Object.values(out.versions)) {
      if (v.dist && v.dist.tarball && v.dist.tarball.startsWith('/')) v.dist.tarball = base + v.dist.tarball;
    }
    return out;
  }

  // ---------- request handling ----------
  packagePath(decodedPath) {
    const segs = decodedPath.split('/').filter(Boolean);
    if (!segs.length || segs[0] === '-') return null;
    const name = segs[0].startsWith('@') && !segs[0].includes('/') ? `${segs[0]}/${segs[1] || ''}` : segs[0];
    return `/${name}`;
  }

  split(rawPath) {
    const segs = rawPath.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    let name;
    let rest;
    if (segs[0].startsWith('@') && !segs[0].includes('/')) {
      name = `${segs[0]}/${segs[1] || ''}`;
      rest = segs.slice(2);
    } else {
      name = segs[0];
      rest = segs.slice(1);
    }
    return { name, rest };
  }

  async handle(ctx) {
    const { req, res, method } = ctx;
    const auth = this.app.auth;
    if (ctx.path === '/' || ctx.path === '') {
      auth.require(req, 'read', this.conf);
      return sendJson(res, 200, { db_name: this.conf.name, type: 'npm', doc_count: this.names().length });
    }
    if (ctx.path.startsWith('/-/')) return this.handleSpecial(ctx);

    const { name, rest } = this.split(ctx.rawPath);
    if (!validName(name)) throw new HttpError(400, `invalid package name: ${name}`);

    // /<name>
    if (rest.length === 0) {
      if (method === 'GET' || method === 'HEAD') {
        auth.require(req, 'read', this.conf);
        const doc = this.read(name);
        if (!doc) throw new NotFoundLocal(`package ${name} not found`);
        return sendJson(res, 200, this.serialize(doc, ctx.base), { etag: `"${doc._rev}"` });
      }
      if (method === 'PUT') {
        const id = this.requirePublish(req);
        const body = await readJson(req, this.app.config.maxBody);
        return sendJson(res, 201, this.publishNpm(body, id));
      }
      throw new HttpError(405, 'method not allowed');
    }
    // /<name>/-rev/<rev>
    if (rest[0] === '-rev') {
      const id = this.requirePublish(req);
      if (method === 'PUT') return sendJson(res, 201, this.updateMetadata(name, await readJson(req, this.app.config.maxBody), id));
      if (method === 'DELETE') return sendJson(res, 200, this.unpublish(name, id));
      throw new HttpError(405, 'method not allowed');
    }
    // /<name>/-/<file>[/-rev/<rev>]
    if (rest[0] === '-') {
      const file = rest[1];
      if (rest[2] === '-rev' && method === 'DELETE') {
        this.requirePublish(req);
        fs.rmSync(path.join(this.pkgDir(name), path.basename(file)), { force: true });
        return sendJson(res, 200, { ok: true });
      }
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      auth.require(req, 'read', this.conf);
      const data = this.tarball(name, file);
      if (!data) throw new NotFoundLocal(`tarball ${file} not found`);
      this.app.stats.downloads++;
      if (method === 'GET') this.app.statsStore.hit(this.conf.name, name);
      return send(res, 200, data, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
    }
    // /<name>/<version|tag>
    if (rest.length === 1 && (method === 'GET' || method === 'HEAD')) {
      auth.require(req, 'read', this.conf);
      const doc = this.read(name);
      if (!doc) throw new NotFoundLocal(`package ${name} not found`);
      const v = doc['dist-tags'][rest[0]] || rest[0];
      if (!doc.versions[v]) throw new NotFoundLocal(`version ${rest[0]} not found`);
      const m = this.serialize({ versions: { [v]: doc.versions[v] } }, ctx.base).versions[v];
      return sendJson(res, 200, m);
    }
    throw new NotFoundLocal('not found');
  }

  requirePublish(req) {
    const id = this.app.auth.require(req, 'publish', this.conf);
    if (this.conf.allowPublish === false) throw new HttpError(403, `publishing to repository ${this.conf.name} is disabled`);
    return id;
  }

  async handleSpecial(ctx) {
    const { req, res, method } = ctx;
    const auth = this.app.auth;
    const p = ctx.path;
    if (p === '/-/ping') return sendJson(res, 200, {});
    if (p === '/-/whoami') {
      const id = auth.require(req, 'user');
      return sendJson(res, 200, { username: id.name });
    }
    if (p === '/-/v1/login') throw new HttpError(404, 'web login not supported, use legacy login');
    let m = /^\/-\/user\/org\.couchdb\.user:(.+)$/.exec(p);
    if (m) {
      const name = m[1];
      if (method === 'GET') {
        auth.require(req, 'user');
        return sendJson(res, 200, { name });
      }
      if (method !== 'PUT') throw new HttpError(405, 'method not allowed');
      const body = await readJson(req);
      let id = auth.checkCredentials(name, body.password || '');
      if (!id) {
        const settings = this.app.stores.settings.get();
        const exists = name === this.app.config.adminUser || this.app.stores.users.get()[name];
        if (exists || !settings.allowRegistration) throw new HttpError(401, 'invalid credentials');
        auth.createUser({ name, password: body.password, email: body.email, role: 'publisher' });
        id = { name, role: 'publisher' };
      }
      const t = auth.issueToken({ user: id.name, role: id.role, name: 'npm login', kind: 'npm' });
      this.app.audit(id, 'login', 'npm');
      return sendJson(res, 201, { ok: true, id: `org.couchdb.user:${name}`, token: t.token });
    }
    m = /^\/-\/user\/token\/(.+)$/.exec(p);
    if (m && method === 'DELETE') {
      auth.revokeToken(decodeURIComponent(m[1]));
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/-/v1/search') {
      auth.require(req, 'read', this.conf);
      const q = new URLSearchParams(ctx.search);
      return sendJson(res, 200, this.search(q.get('text') || '', q.get('size') || 20, q.get('from') || 0));
    }
    if (p.startsWith('/-/package/')) {
      const segs = ctx.rawPath.split('/').filter(Boolean).slice(2).map((s) => decodeURIComponent(s));
      const i = segs.indexOf('dist-tags');
      if (i < 1) throw new HttpError(404, 'not found');
      const name = segs.slice(0, i).join('/');
      const tag = segs[i + 1];
      if (method === 'GET') {
        auth.require(req, 'read', this.conf);
        const doc = this.read(name);
        if (!doc) throw new NotFoundLocal(`package ${name} not found`);
        return sendJson(res, 200, tag ? { [tag]: doc['dist-tags'][tag] } : doc['dist-tags']);
      }
      this.requirePublish(req);
      if (method === 'PUT' || method === 'POST') {
        const body = await readJson(req);
        const version = typeof body === 'string' ? body : body.version;
        return sendJson(res, 201, { ok: true, 'dist-tags': this.setTag(name, tag, version) });
      }
      if (method === 'DELETE') return sendJson(res, 200, { ok: true, 'dist-tags': this.deleteTag(name, tag) });
      throw new HttpError(405, 'method not allowed');
    }
    if (p.startsWith('/-/npm/v1/security/')) {
      // `npm audit`: forwarded by a routing rule when one matches, otherwise report nothing.
      ctx.fallback = () => sendJson(res, 200, {});
      throw new NotFoundLocal('audit not available locally');
    }
    throw new NotFoundLocal('not found');
  }
}

module.exports = { NpmRepo, validName };

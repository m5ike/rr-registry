'use strict';
// Export / import of the whole registry (Settings -> Export / Import).
//
// An export is an encrypted archive (util/archive.js) holding the selected sections in a fixed,
// dependency-safe order. An import goes through stages:
//   upload / remote download -> unlock (passphrase) -> plan -> select + approve -> run
// The plan lists one operation per item (user, repository, repository content, route, ...) with its
// action (create / overwrite / merge / skip / extract), target path, size, dependencies and status.
// Operations of a remote import (URL) start unapproved - every one must be approved before it runs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { HttpError } = require('./util/http');
const { mkdirp, writeAtomic, readJsonFile, rmrf, safeJoin, dirSize } = require('./util/store');
const archive = require('./util/archive');
const { SERVER_KEYS } = require('./config');

/** Sections in export AND import order - every section only depends on earlier ones. */
const SECTIONS = [
  { id: 'server', title: 'Přihlašovací údaje serveru', description: 'administrátor, heslo, API token, veřejná URL', secret: true },
  { id: 'secret', title: 'Podpisový klíč', description: 'HMAC klíč pro podepsané URL tarballů', secret: true },
  { id: 'plugins', title: 'Vlastní pluginy', description: 'soubory data/plugins/*.js' },
  { id: 'users', title: 'Uživatelé', description: 'účty, role, hesla (hash)', secret: true },
  { id: 'tokens', title: 'Tokeny', description: 'API a npm tokeny (hash)', secret: true },
  { id: 'repos', title: 'Repozitáře – konfigurace', description: 'typy, ACL, kvóty, retence, skupiny' },
  { id: 'content', title: 'Repozitáře – obsah', description: 'balíčky, image, git repozitáře, soubory' },
  { id: 'routes', title: 'Směrovací pravidla', description: 'pravidla routingu vč. tokenů pro cíle', secret: true },
  { id: 'webhooks', title: 'Webhooky', description: 'webhooky vč. tajných klíčů', secret: true },
  { id: 'settings', title: 'Nastavení serveru', description: 'výchozí repozitáře, TTL, CORS, pluginy…' },
  { id: 'stats', title: 'Statistiky stahování', description: 'data/stats.json' },
  { id: 'audit', title: 'Audit log', description: 'data/audit.log' },
  { id: 'cache', title: 'Cache', description: 'stažený obsah vzdálených registrů (lze obnovit)', optional: true },
];
const ORDER = SECTIONS.map((s) => s.id);
const ID_RE = /^[a-z0-9]{8,32}$/;
const KEEP_MS = 24 * 3600 * 1000;

function walk(dir, base = dir, out = []) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile() && !e.name.endsWith('.tmp')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const json = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);

class Transfer {
  constructor(app) {
    this.app = app;
    this.exportsDir = path.join(app.config.dataDir, 'exports');
    this.importsDir = path.join(app.config.dataDir, 'imports');
    this.workspacesDir = path.join(app.config.dataDir, 'workspaces');
  }

  get stores() { return this.app.stores; }

  // ================================================================ export
  /** What can be exported, with item lists and sizes (for the export dialog). */
  describe() {
    const c = this.app.config;
    const s = this.stores;
    const plugins = this.pluginFiles();
    return {
      sections: SECTIONS.map((sec) => {
        let items = [];
        if (sec.id === 'server') items = [{ id: 'server', title: `${c.adminUser} · API token ${c.apiToken ? 'nastaven' : 'nenastaven'}` }];
        if (sec.id === 'secret') items = [{ id: 'secret', title: 'podpisový klíč' }];
        if (sec.id === 'plugins') items = plugins.map((f) => ({ id: f, title: f }));
        if (sec.id === 'users') items = Object.values(s.users.get()).map((u) => ({ id: u.name, title: `${u.name} (${u.role})` }));
        if (sec.id === 'tokens') items = s.tokens.get().map((t) => ({ id: t.id, title: `${t.name} · ${t.user}` }));
        if (sec.id === 'repos') items = s.repos.get().map((r) => ({ id: r.name, title: `${r.name} (${r.type})` }));
        if (sec.id === 'content') items = s.repos.get().map((r) => ({ id: r.name, title: r.name, ...dirSize(path.join(c.dataDir, 'repos', r.name)) }));
        if (sec.id === 'routes') items = s.routes.get().map((r) => ({ id: r.id, title: r.name }));
        if (sec.id === 'webhooks') items = s.webhooks.get().map((h) => ({ id: h.id, title: h.name }));
        if (sec.id === 'settings') items = [{ id: 'settings', title: s.settings.get().title }];
        if (sec.id === 'stats') items = [{ id: 'stats', title: 'stats.json' }];
        if (sec.id === 'audit') items = [{ id: 'audit', title: 'audit.log' }];
        if (sec.id === 'cache') items = [{ id: 'cache', title: 'cache', ...dirSize(path.join(c.dataDir, 'cache')) }];
        return { ...sec, items, bytes: items.reduce((n, i) => n + (i.bytes || 0), 0) };
      }),
    };
  }

  pluginFiles() {
    try { return fs.readdirSync(path.join(this.app.config.dataDir, 'plugins')).filter((f) => f.endsWith('.js')).sort(); } catch { return []; }
  }

  /** Entries for the archive, in section order. `sel` = { section: true | [ids] } */
  async* entries(sel, manifest) {
    const c = this.app.config;
    const s = this.stores;
    const pick = (sec, list, key) => (sel[sec] === true ? list : list.filter((x) => (sel[sec] || []).includes(key(x))));
    const items = {};
    for (const id of ORDER) items[id] = [];
    const files = [];
    if (sel.server) {
      const v = Object.fromEntries(SERVER_KEYS.map((k) => [k, c[k] || '']));
      files.push({ name: 'server/server.json', data: json(v), mode: 0o600 });
      items.server.push({ id: 'server', title: `administrátor ${v.adminUser}`, meta: { adminUser: v.adminUser, apiToken: !!v.apiToken, publicUrl: v.publicUrl } });
    }
    if (sel.secret) {
      files.push({ name: 'secret/secret', data: this.app.secret, mode: 0o600 });
      items.secret.push({ id: 'secret', title: 'podpisový klíč' });
    }
    for (const f of pick('plugins', this.pluginFiles(), (x) => x)) {
      files.push({ name: `plugins/${f}`, file: path.join(c.dataDir, 'plugins', f) });
      items.plugins.push({ id: f, title: f });
    }
    const users = pick('users', Object.values(s.users.get()), (u) => u.name);
    if (users.length) files.push({ name: 'users/users.json', data: json(Object.fromEntries(users.map((u) => [u.name, u]))), mode: 0o600 });
    users.forEach((u) => items.users.push({ id: u.name, title: `${u.name} (${u.role})`, meta: { role: u.role } }));
    const tokens = pick('tokens', s.tokens.get(), (t) => t.id);
    if (tokens.length) files.push({ name: 'tokens/tokens.json', data: json(tokens), mode: 0o600 });
    tokens.forEach((t) => items.tokens.push({ id: t.id, title: `${t.name} · ${t.user}`, meta: { user: t.user } }));
    const repos = pick('repos', s.repos.get(), (r) => r.name);
    if (repos.length) files.push({ name: 'repos/repos.json', data: json(repos) });
    repos.forEach((r) => items.repos.push({ id: r.name, title: `${r.name} (${r.type})`, meta: { type: r.type, members: r.members || null } }));
    const content = pick('content', s.repos.get(), (r) => r.name);
    const contentFiles = [];
    for (const r of content) {
      const dir = path.join(c.dataDir, 'repos', r.name);
      const list = walk(dir);
      let bytes = 0;
      for (const rel of list) {
        try { bytes += fs.statSync(path.join(dir, rel)).size; } catch { /* ignore */ }
        contentFiles.push({ name: `content/${r.name}/${rel}`, file: path.join(dir, rel) });
      }
      items.content.push({ id: r.name, title: r.name, meta: { type: r.type, files: list.length, bytes } });
    }
    const routes = pick('routes', s.routes.get(), (r) => r.id);
    if (routes.length) files.push({ name: 'routes/routes.json', data: json(routes), mode: 0o600 });
    routes.forEach((r) => items.routes.push({ id: r.id, title: r.name, meta: { repo: r.repo, when: r.when } }));
    const hooks = pick('webhooks', s.webhooks.get(), (h) => h.id);
    if (hooks.length) files.push({ name: 'webhooks/webhooks.json', data: json(hooks), mode: 0o600 });
    hooks.forEach((h) => items.webhooks.push({ id: h.id, title: h.name, meta: { repos: h.repos } }));
    if (sel.settings) {
      files.push({ name: 'settings/settings.json', data: json(s.settings.get()) });
      items.settings.push({ id: 'settings', title: s.settings.get().title });
    }
    if (sel.stats) {
      this.app.statsStore.flush();
      const f = path.join(c.dataDir, 'stats.json');
      files.push(fs.existsSync(f) ? { name: 'stats/stats.json', file: f } : { name: 'stats/stats.json', data: json({ repos: {} }) });
      items.stats.push({ id: 'stats', title: 'statistiky stahování' });
    }
    if (sel.audit) {
      const f = path.join(c.dataDir, 'audit.log');
      files.push(fs.existsSync(f) ? { name: 'audit/audit.log', file: f } : { name: 'audit/audit.log', data: '' });
      items.audit.push({ id: 'audit', title: 'audit log' });
    }
    const cacheFiles = [];
    if (sel.cache) {
      const dir = path.join(c.dataDir, 'cache');
      const list = walk(dir);
      list.forEach((rel) => cacheFiles.push({ name: `cache/${rel}`, file: path.join(dir, rel) }));
      items.cache.push({ id: 'cache', title: 'cache', meta: { files: list.length, ...dirSize(dir) } });
    }
    manifest.sections = SECTIONS.filter((sec) => items[sec.id].length).map((sec) => ({ id: sec.id, title: sec.title, secret: !!sec.secret, items: items[sec.id] }));
    yield { name: 'manifest.json', data: json(manifest) };
    // fixed order: config first, repository content, then the rest
    const byPrefix = (p) => files.filter((f) => f.name.startsWith(p));
    for (const p of ['server/', 'secret/', 'plugins/', 'users/', 'tokens/', 'repos/']) yield* byPrefix(p);
    yield* contentFiles;
    for (const p of ['routes/', 'webhooks/', 'settings/', 'stats/', 'audit/']) yield* byPrefix(p);
    yield* cacheFiles;
  }

  normalizeSelection(body) {
    const sel = {};
    const sections = Array.isArray(body.sections) ? body.sections : body.sections ? String(body.sections).split(',') : ORDER.filter((x) => x !== 'cache');
    for (const s of sections.map((x) => String(x).trim()).filter(Boolean)) {
      if (!ORDER.includes(s)) throw new HttpError(400, `unknown section ${s} (${ORDER.join(', ')})`);
      sel[s] = true;
    }
    for (const [k, v] of Object.entries(body.items || {})) {
      if (!ORDER.includes(k)) throw new HttpError(400, `unknown section ${k}`);
      sel[k] = v === true || v === '*' ? true : Array.isArray(v) ? v.map(String) : String(v).split(',').filter(Boolean);
    }
    if (!Object.keys(sel).length) throw new HttpError(400, 'nothing selected for export');
    return sel;
  }

  checkPassphrase(p) {
    if (!p || String(p).length < 8) throw new HttpError(400, 'passphrase must have at least 8 characters');
  }

  async createExport(body, identity, base) {
    this.checkPassphrase(body.passphrase);
    const sel = this.normalizeSelection(body);
    mkdirp(this.exportsDir);
    const id = crypto.randomBytes(8).toString('hex');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(this.exportsDir, `${id}.rrx`);
    const manifest = {
      format: 'rr-export', version: 1, id, created: new Date().toISOString(), appVersion: this.app.config.version,
      source: { title: this.stores.settings.get().title, url: base || '' }, note: String(body.note || ''), createdBy: identity ? identity.name : 'system',
    };
    const t0 = Date.now();
    const r = await archive.writeEncrypted(file, this.entries(sel, manifest), body.passphrase, { appVersion: this.app.config.version, source: manifest.source.title, note: manifest.note });
    const meta = {
      id, file: `rr-export-${stamp}.rrx`, size: r.size, sha256: r.sha256, created: manifest.created, createdBy: manifest.createdBy, note: manifest.note,
      ms: Date.now() - t0, sections: manifest.sections.map((s) => ({ id: s.id, title: s.title, items: s.items.length })),
    };
    writeAtomic(path.join(this.exportsDir, `${id}.json`), JSON.stringify(meta, null, 2));
    this.app.audit(identity, 'export', `${meta.sections.map((s) => `${s.id}(${s.items})`).join(' ')} · ${meta.size} B`);
    return meta;
  }

  listExports() {
    let list = [];
    try { list = fs.readdirSync(this.exportsDir).filter((f) => f.endsWith('.json')); } catch { return []; }
    return list.map((f) => readJsonFile(path.join(this.exportsDir, f), null)).filter(Boolean).sort((a, b) => b.created.localeCompare(a.created));
  }

  exportMeta(id) {
    if (!ID_RE.test(String(id))) throw new HttpError(400, 'invalid export id');
    const meta = readJsonFile(path.join(this.exportsDir, `${id}.json`), null);
    if (!meta || !fs.existsSync(path.join(this.exportsDir, `${id}.rrx`))) throw new HttpError(404, `export ${id} not found`);
    return { ...meta, path: path.join(this.exportsDir, `${id}.rrx`) };
  }

  deleteExport(id) {
    const m = this.exportMeta(id);
    fs.rmSync(m.path, { force: true });
    fs.rmSync(path.join(this.exportsDir, `${id}.json`), { force: true });
  }

  // ================================================================ import: receive
  importDir(id) {
    if (!ID_RE.test(String(id))) throw new HttpError(400, 'invalid import id');
    return path.join(this.importsDir, id);
  }

  loadState(id) {
    const st = readJsonFile(path.join(this.importDir(id), 'state.json'), null);
    if (!st) throw new HttpError(404, `import ${id} not found`);
    return st;
  }

  saveState(st) {
    writeAtomic(path.join(this.importDir(st.id), 'state.json'), JSON.stringify(st, null, 2));
    fs.chmodSync(path.join(this.importDir(st.id), 'state.json'), 0o600);
  }

  /** Remove import staging directories older than a day (they may hold decrypted secrets). */
  sweep() {
    let list = [];
    try { list = fs.readdirSync(this.importsDir); } catch { return 0; }
    let n = 0;
    for (const id of list) {
      const st = readJsonFile(path.join(this.importsDir, id, 'state.json'), null);
      const t = st ? Date.parse(st.updated || st.created) : 0;
      if (!st || Date.now() - t > KEEP_MS) { rmrf(path.join(this.importsDir, id)); n++; }
    }
    return n;
  }

  newImport(source, identity) {
    this.sweep();
    const id = crypto.randomBytes(8).toString('hex');
    mkdirp(this.importDir(id));
    fs.chmodSync(this.importDir(id), 0o700);
    const st = { id, status: 'received', created: new Date().toISOString(), updated: new Date().toISOString(), createdBy: identity ? identity.name : 'system', source };
    return st;
  }

  /** Store an uploaded archive (request body streamed to disk). */
  async receiveUpload(req, identity, limit) {
    const st = this.newImport({ kind: 'upload', name: String(req.headers['x-file-name'] || 'upload.rrx').slice(0, 200) }, identity);
    const file = path.join(this.importDir(st.id), 'bundle.rrx');
    let size = 0;
    const counter = new (require('stream').Transform)({
      transform(chunk, enc, cb) {
        size += chunk.length;
        if (size > limit) return cb(new HttpError(413, 'export file too large'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, counter, fs.createWriteStream(file, { mode: 0o600 }));
      return this.received(st, file, size);
    } catch (e) {
      rmrf(this.importDir(st.id));
      throw e.status ? e : new HttpError(400, e.message);
    }
  }

  received(st, file, size) {
    let header;
    try { header = archive.readHeader(file).header; } catch (e) {
      rmrf(this.importDir(st.id));
      throw new HttpError(400, e.message);
    }
    st.size = size;
    st.header = { created: header.created, appVersion: header.appVersion, source: header.source, note: header.note };
    st.status = 'locked';
    this.saveState(st);
    return this.publicState(st);
  }

  /**
   * Remote import: download an export file from a URL, or ask another RR Registry
   * (mode "server": URL of the server + its admin token) to create a fresh export first.
   */
  async receiveRemote(body, identity, limit) {
    const url = String(body.url || '').trim();
    if (!/^https?:\/\/[^/]+/.test(url)) throw new HttpError(400, 'url must be an http(s) URL');
    const mode = body.mode === 'server' ? 'server' : 'file';
    if (body.passphrase) this.checkPassphrase(body.passphrase);
    const headers = { 'user-agent': `rr-registry/${this.app.config.version}` };
    if (body.token) headers.authorization = `Bearer ${body.token}`;
    let fileUrl = url;
    let remoteId = null;
    const base = url.replace(/\/+$/, '');
    if (mode === 'server') {
      if (!body.passphrase) throw new HttpError(400, 'passphrase is required to request an export from a remote server');
      const sections = body.sections || ORDER.filter((x) => x !== 'cache');
      const r = await fetch(`${base}/api/v1/exports`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ sections, passphrase: body.passphrase, note: `remote import → ${this.stores.settings.get().title}` }), signal: AbortSignal.timeout(60 * 60 * 1000) });
      const t = await r.text();
      if (!r.ok) throw new HttpError(502, `remote export failed: HTTP ${r.status} ${t.slice(0, 200)}`);
      remoteId = JSON.parse(t).id;
      fileUrl = `${base}/api/v1/exports/${remoteId}/download`;
    }
    const st = this.newImport({ kind: 'remote', mode, url: base, remoteId }, identity);
    const file = path.join(this.importDir(st.id), 'bundle.rrx');
    try {
      const r = await fetch(fileUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(60 * 60 * 1000) });
      if (!r.ok) throw new HttpError(502, `download failed: HTTP ${r.status}`);
      let size = 0;
      const src = Readable.fromWeb(r.body);
      const counter = new (require('stream').Transform)({
        transform(chunk, enc, cb) {
          size += chunk.length;
          if (size > limit) return cb(new HttpError(413, 'export file too large'));
          cb(null, chunk);
        },
      });
      await pipeline(src, counter, fs.createWriteStream(file, { mode: 0o600 }));
      if (remoteId) fetch(`${base}/api/v1/exports/${remoteId}`, { method: 'DELETE', headers }).catch(() => {});
      this.received(st, file, size);
    } catch (e) {
      rmrf(this.importDir(st.id));
      throw e.status ? e : new HttpError(502, `remote import failed: ${e.message}`);
    }
    this.app.audit(identity, 'import-remote', `${base} (${mode})`);
    if (body.passphrase) return this.unlock(st.id, body.passphrase, identity);
    return this.publicState(this.loadState(st.id));
  }

  // ================================================================ import: unlock + plan
  async unlock(id, passphrase, identity) {
    const st = this.loadState(id);
    if (st.status !== 'locked') return this.publicState(st);
    const dir = this.importDir(id);
    const tarFile = path.join(dir, 'payload.tar');
    await archive.decryptToTar(path.join(dir, 'bundle.rrx'), passphrase, tarFile);
    const index = archive.indexTar(tarFile);
    const me = index.find((e) => e.name === 'manifest.json');
    if (!me) throw new HttpError(400, 'export has no manifest');
    const manifest = JSON.parse(archive.readEntry(tarFile, me).toString('utf8'));
    writeAtomic(path.join(dir, 'index.json'), JSON.stringify(index));
    st.manifest = { created: manifest.created, appVersion: manifest.appVersion, source: manifest.source, note: manifest.note, createdBy: manifest.createdBy, sections: manifest.sections.map((s) => ({ id: s.id, title: s.title, items: s.items.length })) };
    st.items = manifest.sections;
    st.status = 'ready';
    st.options = { conflict: 'skip', target: { mode: 'live', path: '' } };
    st.remote = st.source.kind === 'remote';
    st.ops = this.initialOps(st);
    st.updated = new Date().toISOString();
    this.saveState(st);
    this.app.audit(identity, 'import-unlock', `${id} (${st.ops.length} operací)`);
    return this.publicState(st);
  }

  initialOps(st) {
    const ops = [];
    for (const sec of st.items) {
      const list = sec.id === 'repos'
        ? [...sec.items.filter((i) => i.meta.type !== 'group'), ...sec.items.filter((i) => i.meta.type === 'group')]
        : sec.items;
      for (const it of list) {
        ops.push({
          id: `${sec.id}:${it.id}`, section: sec.id, key: it.id, title: it.title, meta: it.meta || {},
          selected: sec.id !== 'cache', approved: st.source.kind !== 'remote', override: null, rename: null,
        });
      }
    }
    return ops;
  }

  /** Bundle data needed to plan / apply, read lazily from the decrypted tar. */
  bundle(st) {
    const dir = this.importDir(st.id);
    const tarFile = path.join(dir, 'payload.tar');
    const index = readJsonFile(path.join(dir, 'index.json'), []);
    const get = (name) => {
      const e = index.find((x) => x.name === name);
      return e ? JSON.parse(archive.readEntry(tarFile, e).toString('utf8')) : null;
    };
    return { tarFile, index, get };
  }

  /** Compute actions, targets, dependencies and blockers for the current selection. */
  plan(st) {
    const c = this.app.config;
    const s = this.stores;
    const b = this.bundle(st);
    const repos = b.get('repos/repos.json') || [];
    const tokens = b.get('tokens/tokens.json') || [];
    const routes = b.get('routes/routes.json') || [];
    const hooks = b.get('webhooks/webhooks.json') || [];
    const settings = b.get('settings/settings.json');
    const byId = new Map(st.ops.map((o) => [o.id, o]));
    const sel = (id) => byId.has(id) && byId.get(id).selected;
    const workspace = st.options.target.mode === 'workspace';
    const localRepo = (name) => s.repos.get().find((r) => r.name === name);
    const repoTarget = (name) => { const o = byId.get(`repos:${name}`); return (o && o.rename) || name; };
    const localPlugins = new Set(this.pluginFiles());
    const builtinPlugins = new Set(Object.keys(this.app.plugins.available));
    const wsBase = workspace ? safeJoin(this.workspacesDir, st.options.target.path || st.id) : null;

    for (const o of st.ops) {
      o.deps = [];
      o.warnings = [];
      const need = (depId, title, localOk) => {
        if (localOk) return;
        o.deps.push({ id: depId, title, inBundle: byId.has(depId), selected: sel(depId) });
      };
      let exists = false;
      let target = '';
      switch (o.section) {
        case 'server': exists = true; target = path.join(c.dataDir, 'config', 'server.json'); o.warnings.push('změní heslo administrátora a API token – platí ihned, přihlášení tokenem RR_API_TOKEN skončí'); break;
        case 'secret': exists = true; target = path.join(c.dataDir, 'config', 'secret'); break;
        case 'plugins': exists = localPlugins.has(o.key); target = path.join(c.dataDir, 'plugins', o.key); break;
        case 'users': exists = !!s.users.get()[o.key] || o.key === c.adminUser; target = path.join(c.dataDir, 'config', 'users.json'); if (o.key === c.adminUser) o.warnings.push('jméno koliduje s vestavěným administrátorem'); break;
        case 'tokens': {
          exists = s.tokens.get().some((t) => t.id === o.key);
          target = path.join(c.dataDir, 'config', 'tokens.json');
          const t = tokens.find((x) => x.id === o.key);
          if (t) need(`users:${t.user}`, `uživatel ${t.user}`, !!s.users.get()[t.user] || t.user === c.adminUser || (sel('server:server') && t.user === (b.get('server/server.json') || {}).adminUser));
          break;
        }
        case 'repos': {
          const r = repos.find((x) => x.name === o.key);
          const name = repoTarget(o.key);
          exists = !!localRepo(name);
          target = path.join(c.dataDir, 'config', 'repos.json');
          if (o.rename && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(o.rename)) o.warnings.push('neplatný nový název');
          if (exists && r && localRepo(name).type !== r.type) o.warnings.push(`místní repozitář ${name} je typu ${localRepo(name).type}`);
          if (r && r.type === 'group') for (const m of r.members || []) need(`repos:${m}`, `člen skupiny ${m}`, !!localRepo(m));
          break;
        }
        case 'content': {
          const name = repoTarget(o.key);
          const local = localRepo(name);
          exists = !!local && walk(path.join(c.dataDir, 'repos', name)).length > 0;
          target = workspace ? path.join(wsBase, 'content', o.key) : path.join(c.dataDir, 'repos', name);
          need(`repos:${o.key}`, `konfigurace repozitáře ${o.key}`, !!local || workspace);
          if (local && o.meta.type && local.type !== o.meta.type) o.warnings.push(`místní repozitář je typu ${local.type}, obsah je typu ${o.meta.type}`);
          break;
        }
        case 'routes': {
          const r = routes.find((x) => x.id === o.key);
          exists = s.routes.get().some((x) => x.id === o.key || (r && x.name === r.name));
          target = path.join(c.dataDir, 'config', 'routes.json');
          if (r && r.repo && r.repo !== '*') need(`repos:${r.repo}`, `repozitář ${r.repo}`, !!localRepo(r.repo));
          break;
        }
        case 'webhooks': {
          const h = hooks.find((x) => x.id === o.key);
          exists = s.webhooks.get().some((x) => x.id === o.key || (h && x.name === h.name));
          target = path.join(c.dataDir, 'config', 'webhooks.json');
          for (const r of (h && h.repos) || []) if (r !== '*' && !localRepo(r) && !sel(`repos:${r}`)) o.warnings.push(`filtr na repozitář ${r}, který nebude existovat`);
          break;
        }
        case 'settings':
          exists = true;
          target = path.join(c.dataDir, 'config', 'settings.json');
          if (settings) {
            for (const k of ['defaultRepo', 'dockerRepo', 'gitRepo', 'clientsRepo']) if (settings[k]) need(`repos:${settings[k]}`, `repozitář ${settings[k]} (${k})`, !!localRepo(settings[k]));
            for (const p of settings.plugins || []) if (!builtinPlugins.has(p)) need(`plugins:${p}.js`, `plugin ${p}`, false);
          }
          break;
        case 'stats': exists = fs.existsSync(path.join(c.dataDir, 'stats.json')); target = path.join(c.dataDir, 'stats.json'); break;
        case 'audit': exists = fs.existsSync(path.join(c.dataDir, 'audit.log')); target = path.join(c.dataDir, 'audit.log'); break;
        case 'cache': exists = true; target = path.join(c.dataDir, 'cache'); break;
        default: break;
      }
      if (workspace && o.section !== 'content') target = path.join(wsBase, o.section);
      o.exists = exists;
      o.target = target;
      const conflict = o.override || st.options.conflict;
      if (workspace) o.action = 'extract';
      else if (o.section === 'content') o.action = exists ? (conflict === 'overwrite' ? 'merge' : 'skip') : 'create';
      else if (['stats', 'audit', 'cache'].includes(o.section)) o.action = exists && conflict !== 'overwrite' ? 'skip' : exists ? 'overwrite' : 'create';
      else o.action = exists ? (conflict === 'overwrite' ? 'overwrite' : 'skip') : 'create';
      if (workspace) o.deps = [];
      o.missing = o.deps.filter((d) => !d.selected);
      o.blocked = o.selected && o.action !== 'skip' && o.missing.length > 0;
      o.size = o.meta.bytes || 0;
    }
    const chosen = st.ops.filter((o) => o.selected && o.action !== 'skip');
    return {
      order: ORDER,
      selected: chosen.length,
      bytes: chosen.reduce((n, o) => n + o.size, 0),
      blocked: chosen.filter((o) => o.blocked).map((o) => o.id),
      unapproved: chosen.filter((o) => !o.approved).map((o) => o.id),
      missingInBundle: [...new Set(chosen.flatMap((o) => o.missing.filter((d) => !d.inBundle).map((d) => d.title)))],
      targets: [...new Set(chosen.map((o) => (o.section === 'content' || o.section === 'plugins' || o.section === 'cache' || st.options.target.mode === 'workspace' ? o.target : path.join(c.dataDir, 'config'))))],
      workspace: wsBase,
    };
  }

  publicState(st) {
    const out = { ...st };
    delete out.items;
    if (st.status === 'ready' || st.status === 'done' || st.status === 'failed') {
      out.plan = this.plan(st);
      out.sections = SECTIONS.map(({ id, title, description, secret }) => ({ id, title, description, secret: !!secret }));
    }
    out.dataDir = this.app.config.dataDir;
    return out;
  }

  getImport(id) {
    return this.publicState(this.loadState(id));
  }

  listImports() {
    this.sweep();
    let list = [];
    try { list = fs.readdirSync(this.importsDir); } catch { return []; }
    return list.map((id) => readJsonFile(path.join(this.importsDir, id, 'state.json'), null)).filter(Boolean)
      .map((st) => ({ id: st.id, status: st.status, created: st.created, source: st.source, size: st.size, header: st.header, ops: (st.ops || []).length }))
      .sort((a, b) => b.created.localeCompare(a.created));
  }

  /**
   * Change selection / approval / options:
   *   { select: { opId|section: bool }, approve: [opId] | 'selected', revoke: [opId], includeDependencies: true,
   *     conflict: 'skip'|'overwrite', overrides: { opId: 'skip'|'overwrite'|null }, renames: { repo: newName },
   *     target: { mode: 'live'|'workspace', path } }
   */
  updateImport(id, body, identity) {
    const st = this.loadState(id);
    if (st.status !== 'ready') throw new HttpError(409, `import is ${st.status}`);
    const byId = new Map(st.ops.map((o) => [o.id, o]));
    for (const [k, v] of Object.entries(body.select || {})) {
      const on = v === true || v === 'true';
      if (byId.has(k)) byId.get(k).selected = on;
      else if (ORDER.includes(k)) st.ops.filter((o) => o.section === k).forEach((o) => { o.selected = on; });
      else throw new HttpError(400, `unknown operation ${k}`);
    }
    if (body.conflict) {
      if (!['skip', 'overwrite'].includes(body.conflict)) throw new HttpError(400, 'conflict must be skip or overwrite');
      st.options.conflict = body.conflict;
    }
    for (const [k, v] of Object.entries(body.overrides || {})) {
      if (!byId.has(k)) throw new HttpError(400, `unknown operation ${k}`);
      if (v && !['skip', 'overwrite'].includes(v)) throw new HttpError(400, 'override must be skip, overwrite or null');
      byId.get(k).override = v || null;
    }
    for (const [k, v] of Object.entries(body.renames || {})) {
      const o = byId.get(`repos:${k}`);
      if (!o) throw new HttpError(400, `repository ${k} is not in the export`);
      if (v && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v)) throw new HttpError(400, `invalid repository name ${v}`);
      o.rename = v && v !== k ? v : null;
    }
    if (body.target) {
      const mode = body.target.mode === 'workspace' ? 'workspace' : 'live';
      const p = String(body.target.path || '').replace(/^\/+/, '');
      if (mode === 'workspace') {
        if (!/^[A-Za-z0-9._/-]{0,200}$/.test(p) || p.split('/').includes('..')) throw new HttpError(400, 'invalid workspace path');
        safeJoin(this.workspacesDir, p || st.id);
      }
      st.options.target = { mode, path: p };
    }
    if (body.includeDependencies) {
      // select missing dependencies that the export contains, repeatedly (dependencies of dependencies)
      for (let i = 0; i < 5; i++) {
        this.plan(st);
        let changed = false;
        for (const o of st.ops) {
          if (!o.selected) continue;
          for (const d of o.missing || []) if (d.inBundle && !byId.get(d.id).selected) { byId.get(d.id).selected = true; changed = true; }
        }
        if (!changed) break;
      }
    }
    const approve = body.approve === 'selected' ? st.ops.filter((o) => o.selected).map((o) => o.id) : body.approve || [];
    for (const k of approve) {
      if (!byId.has(k)) throw new HttpError(400, `unknown operation ${k}`);
      byId.get(k).approved = true;
    }
    for (const k of body.revoke || []) if (byId.has(k)) byId.get(k).approved = false;
    if (approve.length) this.app.audit(identity, 'import-approve', `${id}: ${approve.length} operací`);
    st.updated = new Date().toISOString();
    this.saveState(st);
    return this.publicState(st);
  }

  deleteImport(id) {
    this.loadState(id);
    rmrf(this.importDir(id));
  }

  // ================================================================ import: run
  async runImport(id, body, identity) {
    const st = this.loadState(id);
    if (st.status !== 'ready') throw new HttpError(409, `import is ${st.status}`);
    const plan = this.plan(st);
    if (!body.confirmPaths) throw new HttpError(400, 'confirm the target paths first (confirmPaths: true)', { targets: plan.targets });
    if (plan.blocked.length) throw new HttpError(409, `missing dependencies for: ${plan.blocked.join(', ')}`, { blocked: plan.blocked });
    if (plan.unapproved.length) throw new HttpError(409, `operations not approved: ${plan.unapproved.join(', ')}`, { unapproved: plan.unapproved });
    const b = this.bundle(st);
    const c = this.app.config;
    const s = this.stores;
    const workspace = st.options.target.mode === 'workspace';
    const results = [];
    const failed = new Set();
    const extracted = new Set();
    st.status = 'running';
    this.saveState(st);
    const entriesWith = (prefix) => b.index.filter((e) => e.name.startsWith(prefix));
    const extract = async (prefix, destDir) => {
      let n = 0;
      for (const e of entriesWith(prefix)) {
        const rel = e.name.slice(prefix.length);
        if (!rel) continue;
        const dest = safeJoin(destDir, rel);
        mkdirp(path.dirname(dest));
        await archive.extractEntry(b.tarFile, e, dest);
        n++;
      }
      return n;
    };
    const ordered = st.ops.slice().sort((x, y) => ORDER.indexOf(x.section) - ORDER.indexOf(y.section));
    for (const o of ordered) {
      if (!o.selected) continue;
      if (o.action === 'skip') { o.status = 'skipped'; results.push({ id: o.id, status: 'skipped', message: 'existuje – přeskočeno' }); continue; }
      const failedDep = (o.deps || []).find((d) => failed.has(d.id));
      if (failedDep) { o.status = 'failed'; failed.add(o.id); results.push({ id: o.id, status: 'failed', message: `závislost ${failedDep.title} selhala` }); continue; }
      try {
        let message = '';
        if (workspace) {
          // section files hold all items of a section - extract them once
          const prefix = o.section === 'content' ? `content/${o.key}/` : `${o.section}/`;
          if (extracted.has(prefix)) message = `součást ${o.target}`;
          else {
            extracted.add(prefix);
            message = `${await extract(prefix, o.target)} souborů → ${o.target}`;
          }
        } else {
          // repository content follows a rename of its repository configuration
          if (o.section === 'content') o.repoTarget = byKey(st, o.key).rename || o.key;
          message = await this.apply(o, b, { c, s });
        }
        o.status = 'done';
        results.push({ id: o.id, status: 'done', message });
      } catch (e) {
        o.status = 'failed';
        failed.add(o.id);
        results.push({ id: o.id, status: 'failed', message: e.message });
      }
    }
    if (!workspace) {
      // pick up the new configuration everywhere
      this.app.handlers.clear();
      const { PluginManager } = require('./plugins');
      this.app.plugins = new PluginManager(this.app);
      this.app.plugins.load();
      for (const r of s.repos.get().filter((x) => x.type === 'git')) {
        if (st.ops.some((o) => o.section === 'content' && o.status === 'done' && ((byKey(st, o.key).rename || o.key) === r.name))) {
          await this.app.repoHandler(r.name).reconfigureAll().catch(() => {});
        }
      }
    }
    st.status = results.some((r) => r.status === 'failed') ? 'failed' : 'done';
    st.results = results;
    st.finished = new Date().toISOString();
    st.updated = st.finished;
    this.saveState(st);
    // the decrypted payload is not needed any more
    fs.rmSync(path.join(this.importDir(id), 'payload.tar'), { force: true });
    const done = results.filter((r) => r.status === 'done').length;
    this.app.audit(identity, 'import', `${id}: ${done} hotovo, ${results.filter((r) => r.status === 'failed').length} chyb, ${results.filter((r) => r.status === 'skipped').length} přeskočeno${workspace ? ` → ${st.options.target.path || id}` : ''}`);
    this.app.events.emit('transfer.import', { id, done, failed: results.filter((r) => r.status === 'failed').length, workspace }, identity);
    return { id, status: st.status, results };
  }

  /** Apply one operation to the live registry. Returns a short message. */
  async apply(o, b, { c, s }) {
    const over = o.action === 'overwrite' || o.action === 'merge';
    const need = (name) => {
      const e = b.index.find((x) => x.name === name);
      if (!e) throw new Error(`${name} chybí v exportu`);
      return e;
    };
    switch (o.section) {
      case 'server': {
        const v = b.get('server/server.json');
        writeAtomic(path.join(c.dataDir, 'config', 'server.json'), JSON.stringify(v, null, 2));
        fs.chmodSync(path.join(c.dataDir, 'config', 'server.json'), 0o600);
        for (const k of SERVER_KEYS) if (v[k]) c[k] = v[k];
        return `administrátor ${v.adminUser}${v.apiToken ? ', API token' : ''} – platí ihned`;
      }
      case 'secret': {
        const e = need('secret/secret');
        const v = archive.readEntry(b.tarFile, e).toString('utf8').trim();
        writeAtomic(path.join(c.dataDir, 'config', 'secret'), v);
        this.app.secret = v;
        return 'podpisový klíč nahrazen';
      }
      case 'plugins': {
        const e = need(`plugins/${o.key}`);
        const dest = safeJoin(path.join(c.dataDir, 'plugins'), o.key);
        mkdirp(path.dirname(dest));
        await archive.extractEntry(b.tarFile, e, dest);
        try { delete require.cache[require.resolve(dest)]; } catch { /* not loaded */ }
        return dest;
      }
      case 'users': {
        const u = (b.get('users/users.json') || {})[o.key];
        s.users.update((d) => { d[o.key] = u; });
        return `${over ? 'přepsán' : 'vytvořen'} (${u.role})`;
      }
      case 'tokens': {
        const t = (b.get('tokens/tokens.json') || []).find((x) => x.id === o.key);
        s.tokens.update((l) => [...l.filter((x) => x.id !== t.id), t]);
        return `${t.name} · ${t.user}`;
      }
      case 'repos': {
        const r = { ...(b.get('repos/repos.json') || []).find((x) => x.name === o.key) };
        if (o.rename) r.name = o.rename;
        if (r.type === 'group' && r.deployTo && o.rename) { /* members keep their names */ }
        s.repos.update((l) => {
          const i = l.findIndex((x) => x.name === r.name);
          if (i >= 0) l[i] = r; else l.push(r);
        });
        mkdirp(path.join(c.dataDir, 'repos', r.name));
        return `${r.name} (${r.type})${o.rename ? ` ← ${o.key}` : ''}`;
      }
      case 'content': {
        const name = o.repoTarget || o.key;
        const dest = path.join(c.dataDir, 'repos', name);
        mkdirp(dest);
        let n = 0;
        for (const e of b.index.filter((x) => x.name.startsWith(`content/${o.key}/`))) {
          const target = safeJoin(dest, e.name.slice(`content/${o.key}/`.length));
          mkdirp(path.dirname(target));
          await archive.extractEntry(b.tarFile, e, target);
          n++;
        }
        return `${n} souborů → ${dest}`;
      }
      case 'routes': {
        const r = (b.get('routes/routes.json') || []).find((x) => x.id === o.key);
        s.routes.update((l) => [...l.filter((x) => x.id !== r.id && x.name !== r.name), r]);
        return r.name;
      }
      case 'webhooks': {
        const h = (b.get('webhooks/webhooks.json') || []).find((x) => x.id === o.key);
        s.webhooks.update((l) => [...l.filter((x) => x.id !== h.id && x.name !== h.name), h]);
        return h.name;
      }
      case 'settings': {
        const v = b.get('settings/settings.json');
        const cur = s.settings.get();
        const next = { ...cur, ...v };
        const warn = [];
        for (const k of ['defaultRepo', 'dockerRepo', 'gitRepo', 'clientsRepo']) {
          if (next[k] && !this.app.repoConfig(next[k])) { warn.push(k); next[k] = cur[k]; }
        }
        s.settings.set(next);
        return warn.length ? `uloženo, ponecháno původní: ${warn.join(', ')}` : 'uloženo';
      }
      case 'stats': {
        const e = need('stats/stats.json');
        await archive.extractEntry(b.tarFile, e, path.join(c.dataDir, 'stats.json'));
        this.app.statsStore.data = readJsonFile(path.join(c.dataDir, 'stats.json'), { repos: {} });
        return 'statistiky nahrazeny';
      }
      case 'audit': {
        const e = need('audit/audit.log');
        await archive.extractEntry(b.tarFile, e, path.join(c.dataDir, 'audit.log'));
        return 'audit log nahrazen';
      }
      case 'cache': {
        const dest = path.join(c.dataDir, 'cache');
        let n = 0;
        for (const e of b.index.filter((x) => x.name.startsWith('cache/'))) {
          const target = safeJoin(dest, e.name.slice('cache/'.length));
          mkdirp(path.dirname(target));
          await archive.extractEntry(b.tarFile, e, target);
          n++;
        }
        return `${n} souborů`;
      }
      default:
        throw new Error(`unknown section ${o.section}`);
    }
  }
}

function byKey(st, key) {
  return st.ops.find((o) => o.id === `repos:${key}`) || {};
}

module.exports = { Transfer, SECTIONS, ORDER };

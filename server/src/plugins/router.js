'use strict';
// URL routing plugin: forwards requests to other registries according to rules.
//
// Rule fields:
//   id, name, enabled, priority (lower first)
//   when:      "always"   - forward before looking into the local repository
//              "notfound" - forward only if the local repository has no such item
//              "push"     - replicate writes to the target after they succeed locally
//                           (npm publish, generic upload/delete, git push -> automatic push to a remote)
//   For git repositories "always"/"notfound" create a local pull-through mirror (clone from the target)
//   that is refreshed after cacheTtl; "push" pushes the repository to <target>/<name>.git.
//   matchOn:   "package" (package path like /@scope/name, default) | "path" (path inside repo) | "url" (full URL incl. query)
//   matchType: "prefix" | "glob" | "regex" | "contains" | "exact"
//   pattern:   pattern for matchType (empty = everything)
//   repo:      repository name or "*"; repoType: "npm" | "generic" | "*"
//   key:       routing key - matches /~<key>/..., header X-RR-Key or ?rr_key=<key>
//   header:    { name, pattern } - optional header condition (regex)
//   methods:   ["GET","HEAD"] by default
//   target:    upstream base URL, e.g. https://registry.npmjs.org
//   stripPrefix / addPrefix: path rewriting before forwarding
//   headers:   extra headers sent upstream (e.g. Authorization)
//   cacheTtl:  seconds the response stays in cache (0 = no cache)
//   token / username: credentials for the remote (git: Basic x-access-token:<token>, npm/generic: Bearer)
//   push rules: replicateDeletes (generic), gitMode "mirror" | "branches", createMissing + private (GitHub)
const crypto = require('crypto');
const { HttpError, send } = require('../util/http');
const files = require('../repos/files');

const MATCH_TYPES = ['prefix', 'glob', 'regex', 'contains', 'exact'];
const MATCH_ON = ['package', 'path', 'url'];
const WHEN = ['always', 'notfound', 'push'];
const REPLICABLE = ['npm.publish', 'file.upload', 'file.delete', 'git.push'];

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function testPattern(type, pattern, value) {
  if (!pattern) return true;
  switch (type) {
    case 'exact': return value === pattern;
    case 'contains': return value.includes(pattern);
    case 'glob': return globToRegex(pattern).test(value);
    case 'regex': return new RegExp(pattern).test(value);
    case 'prefix':
    default: return value.startsWith(pattern);
  }
}

function normalizeRule(input, existing = {}) {
  const r = { ...existing, ...input };
  r.id = existing.id || input.id || crypto.randomBytes(4).toString('hex');
  r.name = String(r.name || '').trim();
  if (!r.name) throw new HttpError(400, 'rule name is required');
  r.enabled = r.enabled !== false && r.enabled !== 'false';
  r.priority = Number(r.priority ?? 100);
  r.when = r.when || 'notfound';
  if (!WHEN.includes(r.when)) throw new HttpError(400, `when must be one of ${WHEN.join(', ')}`);
  r.matchOn = r.matchOn || 'package';
  if (!MATCH_ON.includes(r.matchOn)) throw new HttpError(400, `matchOn must be one of ${MATCH_ON.join(', ')}`);
  r.matchType = r.matchType || 'prefix';
  if (!MATCH_TYPES.includes(r.matchType)) throw new HttpError(400, `matchType must be one of ${MATCH_TYPES.join(', ')}`);
  r.pattern = String(r.pattern || '');
  if (r.matchType === 'regex') {
    try { new RegExp(r.pattern); } catch (e) { throw new HttpError(400, `invalid regex: ${e.message}`); }
  }
  r.repo = r.repo || '*';
  r.repoType = r.repoType || '*';
  r.key = r.key || '';
  if (r.header && (!r.header.name)) r.header = null;
  r.methods = (Array.isArray(r.methods) ? r.methods : String(r.methods || 'GET,HEAD').split(',')).map((m) => m.trim().toUpperCase()).filter(Boolean);
  r.target = String(r.target || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/.test(r.target)) throw new HttpError(400, 'target must be an http(s) URL');
  r.stripPrefix = r.stripPrefix || '';
  r.addPrefix = r.addPrefix || '';
  r.headers = r.headers && typeof r.headers === 'object' ? r.headers : {};
  r.cacheTtl = r.cacheTtl === undefined || r.cacheTtl === '' ? null : Number(r.cacheTtl);
  r.description = r.description || '';
  if (input.token === '***') r.token = existing.token;
  r.token = r.token || '';
  r.username = r.username || '';
  r.replicateDeletes = r.replicateDeletes === true || r.replicateDeletes === 'true';
  r.createMissing = r.createMissing === true || r.createMissing === 'true';
  r.private = r.private !== false && r.private !== 'false';
  r.gitMode = r.gitMode === 'branches' ? 'branches' : 'mirror';
  return r;
}

/** Rule as returned by the API - secrets masked. */
function publicRule(r) {
  return { ...r, token: r.token ? '***' : '' };
}

class RouterPlugin {
  constructor(app) {
    this.app = app;
    this.jobs = [];
    this.queue = [];
    this.active = 0;
  }

  get store() { return this.app.stores.routes; }

  rules() {
    return [...this.store.get()].sort((a, b) => a.priority - b.priority);
  }

  // ---- CRUD (used by the admin API) ----
  get(id) {
    const r = this.store.get().find((x) => x.id === id || x.name === id);
    if (!r) throw new HttpError(404, `route ${id} not found`);
    return r;
  }
  create(input) {
    const r = normalizeRule(input);
    if (this.store.get().some((x) => x.name === r.name)) throw new HttpError(409, `route ${r.name} already exists`);
    this.store.update((list) => { list.push(r); });
    return r;
  }
  update(id, input) {
    const cur = this.get(id);
    const r = normalizeRule({ ...input, id: cur.id }, cur);
    this.store.update((list) => list.map((x) => (x.id === cur.id ? r : x)));
    return r;
  }
  remove(id) {
    const cur = this.get(id);
    this.store.update((list) => list.filter((x) => x.id !== cur.id));
  }

  // ---- matching ----
  subject(rule, ctx) {
    if (rule.matchOn === 'url') return ctx.url;
    if (rule.matchOn === 'path') return ctx.path;
    return ctx.pkgPath || ctx.path;
  }

  matches(rule, ctx) {
    if (!rule.enabled) return false;
    if (rule.when !== 'push' && !rule.methods.includes(ctx.method)) return false;
    if (rule.repo !== '*' && rule.repo !== ctx.repo.name) return false;
    if (rule.repoType !== '*' && rule.repoType !== ctx.repo.type) return false;
    if (rule.key && rule.key !== ctx.key) return false;
    if (rule.header && rule.header.name) {
      const v = ctx.headers[String(rule.header.name).toLowerCase()];
      if (v === undefined) return false;
      if (rule.header.pattern && !new RegExp(rule.header.pattern).test(String(v))) return false;
    }
    return testPattern(rule.matchType, rule.pattern, this.subject(rule, ctx));
  }

  targetUrl(rule, ctx) {
    let sub = ctx.rawPath || '/';
    if (rule.stripPrefix && sub.startsWith(rule.stripPrefix)) sub = sub.slice(rule.stripPrefix.length);
    if (!sub.startsWith('/')) sub = `/${sub}`;
    return `${rule.target}${rule.addPrefix}${sub}${ctx.search || ''}`;
  }

  /** Explain which rules match a synthetic request - used by the admin "test route" endpoint. */
  explain({ repo, path = '/', key = '', method = 'GET', headers = {} }) {
    const repoConf = this.app.repoConfig(repo || this.app.defaultRepoName());
    if (!repoConf) throw new HttpError(404, `repository ${repo} not found`);
    const handler = this.app.repoHandler(repoConf.name);
    const [p, search = ''] = String(path).split('?');
    const decoded = decodeURIComponent(p);
    const ctx = {
      repo: repoConf, method: method.toUpperCase(), key, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      rawPath: p, path: decoded, search: search ? `?${search}` : '', url: path,
      pkgPath: handler.packagePath ? handler.packagePath(decoded) : null,
    };
    const results = this.rules().map((r) => ({ id: r.id, name: r.name, when: r.when, priority: r.priority, matched: this.matches(r, ctx), target: this.targetUrl(r, ctx) }));
    const first = (phase) => results.find((x) => x.matched && x.when === phase) || null;
    return { request: { repo: repoConf.name, path: ctx.path, packagePath: ctx.pkgPath, key, method: ctx.method }, always: first('always'), notfound: first('notfound'), rules: results };
  }

  // ---- hooks ----
  async beforeLocal(ctx) {
    return this.forwardMatching(ctx, 'always', true);
  }

  async onNotFound(ctx) {
    return this.forwardMatching(ctx, 'notfound', false);
  }

  async forwardMatching(ctx, phase, fallthroughOn404) {
    const rules = this.rules().filter((r) => r.when === phase && this.matches(r, ctx));
    if (rules.length) this.app.auth.require(ctx.req, 'read', ctx.repo);
    if (ctx.repo.type === 'git') return this.gitPullThrough(rules, ctx);
    for (let i = 0; i < rules.length; i++) {
      const r = await this.forward(rules[i], ctx);
      const last = i === rules.length - 1;
      if (r.status === 404 && (!last || fallthroughOn404)) continue;
      this.respond(ctx, rules[i], r);
      return true;
    }
    return false;
  }

  async forward(rule, ctx) {
    const settings = this.app.stores.settings.get();
    const url = this.targetUrl(rule, ctx);
    const isTarball = /\/-\/[^/]+\.(tgz|tar\.gz)$/.test(ctx.path);
    const ttl = isTarball ? Number(settings.tarballTtl ?? 2592000) : rule.cacheTtl ?? Number(settings.cacheTtl ?? 300);
    const accept = ctx.headers.accept || '*/*';
    const headers = { 'user-agent': `rr-registry/${this.app.config.version}`, accept, ...rule.headers };
    let body;
    if (!['GET', 'HEAD'].includes(ctx.method)) {
      body = await ctx.body();
      if (ctx.headers['content-type']) headers['content-type'] = ctx.headers['content-type'];
    }
    const kind = /vnd\.npm\.install-v1/.test(accept) ? 'corgi' : 'full';
    const r = await this.app.cache.fetch(url, {
      ttl, headers, method: ctx.method === 'HEAD' ? 'GET' : ctx.method, body, ruleId: rule.id, id: `${ctx.method === 'HEAD' ? 'GET' : ctx.method} ${url} ${kind}`,
    });
    return { ...r, url };
  }

  respond(ctx, rule, r) {
    let body = r.body;
    const headers = { 'content-type': r.headers['content-type'] || 'application/octet-stream', 'x-rr-cache': r.cache, 'x-rr-route': rule.name };
    if (r.status === 200 && ctx.repo.type === 'npm' && /json/.test(headers['content-type']) && !ctx.path.includes('/-/') && ctx.pkgPath) {
      try {
        const doc = JSON.parse(body.toString('utf8'));
        this.rewriteTarballs(doc, rule, ctx);
        body = Buffer.from(JSON.stringify(doc));
      } catch { /* not a packument - pass through */ }
    }
    this.app.stats.proxied++;
    send(ctx.res, r.status, body, headers);
  }

  rewriteTarballs(doc, rule, ctx) {
    const versions = doc.versions || {};
    const list = doc.dist ? [doc] : Object.values(versions);
    const base = `${rule.target}${rule.addPrefix}`;
    for (const v of list) {
      const t = v && v.dist && v.dist.tarball;
      if (!t) continue;
      if (t.startsWith(`${base}/`)) {
        v.dist.tarball = `${ctx.base}${rule.stripPrefix || ''}${t.slice(base.length)}`;
      } else {
        v.dist.tarball = `${ctx.rootBase}/-/rr/t/${rule.id}/${this.sign(rule.id, t)}/${Buffer.from(t).toString('base64url')}`;
      }
    }
  }

  sign(ruleId, url) {
    return crypto.createHmac('sha256', this.app.secret).update(`${ruleId}\n${url}`).digest('base64url').slice(0, 22);
  }

  /** GET /-/rr/t/<ruleId>/<sig>/<b64url> - signed passthrough for tarballs hosted elsewhere. */
  async serveSigned(req, res, ruleId, sig, b64) {
    const url = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = this.sign(ruleId, url);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new HttpError(403, 'invalid signature');
    const rule = this.get(ruleId);
    const settings = this.app.stores.settings.get();
    const r = await this.app.cache.fetch(url, { ttl: Number(settings.tarballTtl ?? 2592000), headers: { 'user-agent': `rr-registry/${this.app.config.version}`, ...rule.headers }, ruleId: rule.id });
    send(res, r.status, r.body, { 'content-type': r.headers['content-type'] || 'application/octet-stream', 'x-rr-cache': r.cache, 'x-rr-route': rule.name });
  }

  // ---- git: pull-through mirrors ----
  gitRemoteUrl(rule, name) {
    let p = `/${name}`;
    if (rule.stripPrefix && p.startsWith(rule.stripPrefix)) p = p.slice(rule.stripPrefix.length);
    if (!p.startsWith('/')) p = `/${p}`;
    return `${rule.target}${rule.addPrefix}${p}.git`;
  }

  remoteAuth(rule) {
    if (rule.token) return { username: rule.username || 'x-access-token', token: rule.token };
    const h = rule.headers && (rule.headers.Authorization || rule.headers.authorization);
    return h ? { header: h } : null;
  }

  /** Clone a missing git repository from the first matching rule's target, then serve it locally. */
  async gitPullThrough(rules, ctx) {
    const h = ctx.handler;
    const p = h.parse(ctx.path);
    if (!rules.length || !p || !p.sub || /git-receive-pack/.test(`${ctx.path}${ctx.search}`)) return false;
    if (h.exists(p.name)) return false;
    this.cloning = this.cloning || new Map();
    const key = `${ctx.repo.name}/${p.name}`;
    if (!this.cloning.has(key)) {
      const settings = this.app.stores.settings.get();
      const job = (async () => {
        for (const rule of rules) {
          const url = this.gitRemoteUrl(rule, p.name);
          try {
            await h.create(p.name, {
              importUrl: url, mirror: true, interval: 0, ttl: rule.cacheTtl ?? Number(settings.cacheTtl ?? 300),
              auth: this.remoteAuth(rule), ruleId: rule.id, description: `zrcadlo ${url}`,
            }, { name: `route:${rule.name}`, role: 'admin' });
            return rule;
          } catch (e) {
            this.app.log.warn(`git pull-through ${key} via ${rule.name}: ${e.message}`);
          }
        }
        return null;
      })().finally(() => this.cloning.delete(key));
      this.cloning.set(key, job);
    }
    const rule = await this.cloning.get(key);
    if (!h.exists(p.name)) return false;
    this.app.stats.proxied++;
    if (rule) ctx.res.setHeader('x-rr-route', rule.name);
    await h.handle(ctx);
    return true;
  }

  // ---- "push" rules: replication of local writes to remote servers ----
  async onEvent(ev) {
    if (!REPLICABLE.includes(ev.type)) return;
    const conf = this.app.repoConfig(ev.repo);
    if (!conf) return;
    const d = ev.data || {};
    const subject = ev.type.startsWith('file.') ? d.path : `/${d.name}`;
    const ctx = { repo: conf, method: 'PUT', key: '', headers: {}, path: subject, rawPath: subject, pkgPath: subject, url: subject };
    for (const rule of this.rules().filter((r) => r.when === 'push' && this.matches(r, ctx))) {
      if (ev.type === 'file.delete' && !rule.replicateDeletes) continue;
      this.enqueue(rule, ev);
    }
  }

  enqueue(rule, ev) {
    const d = ev.data || {};
    const job = {
      id: crypto.randomBytes(5).toString('hex'), rule: rule.id, ruleName: rule.name, event: ev.type, repo: ev.repo,
      item: d.name ? `${d.name}${d.versions ? `@${d.versions.join(',')}` : ''}` : d.path, target: rule.target,
      status: 'queued', attempts: 0, error: null, result: null, created: new Date().toISOString(), user: ev.user, ev,
    };
    this.jobs.push(job);
    if (this.jobs.length > 300) this.jobs.shift();
    this.queue.push(job);
    this.pump();
    return job;
  }

  pump() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.runJob(job).finally(() => { this.active--; this.pump(); });
    }
  }

  async runJob(job) {
    let rule;
    try { rule = this.get(job.rule); } catch { job.status = 'error'; job.error = 'rule was deleted'; return; }
    job.status = 'running';
    job.attempts++;
    job.started = new Date().toISOString();
    try {
      job.result = await this.replicate(rule, job.ev);
      job.status = job.result && job.result.skipped ? 'skipped' : 'ok';
      job.error = null;
    } catch (e) {
      job.error = e.message;
      if (job.attempts < 3) {
        job.status = 'retry';
        setTimeout(() => { this.queue.push(job); this.pump(); }, job.attempts * 10000 * (this.app.config.retryScale ?? 1)).unref();
      } else {
        job.status = 'error';
        this.app.events.emit('replication.failed', { repo: job.repo, rule: rule.name, item: job.item, target: rule.target, error: e.message });
      }
    }
    job.finished = new Date().toISOString();
  }

  remotePath(rule, p) {
    if (rule.stripPrefix && p.startsWith(rule.stripPrefix)) p = p.slice(rule.stripPrefix.length);
    if (!p.startsWith('/')) p = `/${p}`;
    return `${rule.target}${rule.addPrefix}${p}`;
  }

  async replicate(rule, ev) {
    const d = ev.data;
    const h = this.app.repoHandler(ev.repo);
    const headers = { 'user-agent': `rr-registry/${this.app.config.version}`, ...rule.headers };
    if (rule.token && !headers.authorization && !headers.Authorization) headers.authorization = `Bearer ${rule.token}`;
    const call = async (method, url, body, extra = {}) => {
      const r = await fetch(url, { method, headers: { ...headers, ...extra }, body, signal: AbortSignal.timeout(10 * 60 * 1000) });
      return { status: r.status, ok: r.ok, text: (await r.text()).slice(0, 500) };
    };
    switch (ev.type) {
      case 'git.push':
        return h.pushTo(d.name, { url: this.gitRemoteUrl(rule, d.name), auth: this.remoteAuth(rule), mode: rule.gitMode, createMissing: rule.createMissing, private: rule.private });
      case 'file.upload': {
        const url = this.remotePath(rule, d.path);
        const r = await call('PUT', url, files.read(h.dir, d.path).data, { 'content-type': 'application/octet-stream' });
        if (!r.ok) throw new Error(`PUT ${url}: HTTP ${r.status} ${r.text}`);
        return { url, status: r.status };
      }
      case 'file.delete': {
        const url = this.remotePath(rule, d.path);
        const r = await call('DELETE', url);
        if (!r.ok && r.status !== 404) throw new Error(`DELETE ${url}: HTTP ${r.status} ${r.text}`);
        return { url, status: r.status };
      }
      case 'npm.publish': {
        const doc = h.read(d.name);
        if (!doc) return { skipped: true, reason: 'package no longer exists' };
        const out = [];
        for (const v of d.versions || []) {
          const m = doc.versions[v];
          if (!m) continue;
          const file = m.dist.tarball.split('/').pop();
          const tgz = h.tarball(d.name, file);
          const tag = (Object.entries(doc['dist-tags']).find(([, x]) => x === v) || ['replicated'])[0];
          const url = `${rule.target}${rule.addPrefix}/${d.name.replace('/', '%2f')}`;
          const body = {
            _id: d.name, name: d.name, description: doc.description || '', readme: doc.readme || '', 'dist-tags': { [tag]: v },
            versions: { [v]: { ...m, dist: { ...m.dist, tarball: `${rule.target}/${d.name}/-/${file}` } } },
            _attachments: { [file]: { content_type: 'application/octet-stream', data: tgz.toString('base64'), length: tgz.length } },
          };
          const r = await call('PUT', url, JSON.stringify(body), { 'content-type': 'application/json' });
          if (!r.ok && !(r.status === 403 || r.status === 409)) throw new Error(`publish ${d.name}@${v} to ${url}: HTTP ${r.status} ${r.text}`);
          out.push({ version: v, status: r.status, existed: !r.ok });
        }
        return { versions: out, skipped: out.length > 0 && out.every((x) => x.existed) };
      }
      default:
        return { skipped: true, reason: `${ev.type} is not replicated` };
    }
  }

  listJobs({ limit = 100, status } = {}) {
    return this.jobs.filter((j) => !status || j.status === status).slice(-limit).reverse().map(({ ev, ...j }) => j);
  }

  retryJob(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) throw new HttpError(404, `replication job ${id} not found`);
    if (job.status === 'running' || job.status === 'queued') return { ...job, ev: undefined };
    job.attempts = 0;
    job.status = 'queued';
    this.queue.push(job);
    this.pump();
    return { ...job, ev: undefined };
  }
}

module.exports = {
  name: 'router',
  description: 'Směrování požadavků na vzdálené registry dle pravidel (maska URL, část URL, klíč, hlavička, nenalezeno lokálně) s cache, git pull-through zrcadla a replikace zápisů (push) na vzdálené servery.',
  create: (app) => new RouterPlugin(app),
  normalizeRule,
  globToRegex,
  testPattern,
  publicRule,
};

'use strict';
// RR Registry - application core and HTTP dispatcher.
//
// URL layout
//   /                         homepage (HTML)            /admin/      web administration
//   /api/v1/...               management API             /downloads/  client packages (.tgz)
//   /install.sh               client installer           /static/     assets + rr-client.js
//   /<npm path>               default repository (npm protocol), e.g. /lodash, /-/v1/search
//   /r/<repo>/<path>          a specific repository
//   /v2/...                   Docker Registry HTTP API v2 (the docker repository from settings.dockerRepo)
//   /git/<name>.git/...       git smart HTTP (the git repository from settings.gitRepo; others at /r/<repo>/<name>.git)
//   /-/rr/hooks/git/<repo>/<name>   incoming webhook (GitHub/GitLab) -> refresh a git pull mirror
//   /~<key>/...               routing key prefix (combinable with /r/<repo>/)
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { HttpError, NotFoundLocal, sendError, sendJson, readBody, baseUrl } = require('./util/http');
const { gitAvailable } = require('./util/git');
const { JsonStore, mkdirp, readJsonFile, rmrf, dirSize } = require('./util/store');
const { Auth } = require('./auth');
const { Portal } = require('./portal');
const { TypeHosts } = require('./typehosts');
const { Transfer } = require('./transfer');
const { Cache } = require('./cache');
const { PluginManager } = require('./plugins');
const { NpmRepo } = require('./repos/npm');
const { GenericRepo } = require('./repos/generic');
const { DockerRepo, sendRegistryError } = require('./repos/docker');
const { GitRepo } = require('./repos/git');
const { GroupRepo } = require('./repos/group');
const { Events } = require('./events');
const { Stats } = require('./stats');
const { Scheduler } = require('./scheduler');
const { repoBytes } = require('./policies');
const { createAdminApi } = require('./api/admin');
const { createWeb } = require('./web');

const REPO_TYPES = { npm: NpmRepo, generic: GenericRepo, docker: DockerRepo, git: GitRepo, group: GroupRepo };
const ACL_LEVELS = ['none', 'read', 'publish'];
const GIT_PATH_RE = /^\/git\/(?!-\/)(?:.+\.git(?:\/.*)?|.+\/(?:info\/refs|git-upload-pack|git-receive-pack))$/;
const SETTINGS_KEYS = ['title', 'defaultRepo', 'dockerRepo', 'gitRepo', 'anonymousRead', 'allowRegistration', 'cacheTtl', 'tarballTtl', 'plugins', 'clientsRepo', 'cors', 'motd'];

function makeLogger(quiet) {
  const ts = () => new Date().toISOString();
  return {
    info: (...a) => { if (!quiet) console.log(ts(), '[info]', ...a); },
    warn: (...a) => { if (!quiet) console.warn(ts(), '[warn]', ...a); },
    error: (...a) => console.error(ts(), '[error]', ...a),
  };
}

class App {
  constructor(overrides = {}) {
    this.config = loadConfig(overrides);
    const c = this.config;
    this.log = makeLogger(c.quiet);
    this.started = Date.now();
    this.stats = { requests: 0, downloads: 0, proxied: 0, errors: 0 };
    this.logs = { requests: [], audit: [] };
    mkdirp(c.dataDir);
    const cfg = (f) => path.join(c.dataDir, 'config', f);
    this.stores = {
      settings: new JsonStore(cfg('settings.json'), () => ({
        title: 'RR Registry',
        defaultRepo: c.defaultRepo,
        anonymousRead: true,
        allowRegistration: false,
        cacheTtl: c.cacheTtl,
        tarballTtl: 30 * 24 * 3600,
        plugins: ['router'],
        clientsRepo: c.defaultRepo,
        dockerRepo: 'docker',
        gitRepo: 'git',
        cors: '*',
        motd: '',
      })),
      repos: new JsonStore(cfg('repos.json'), () => [
        { name: c.defaultRepo, type: 'npm', description: 'Výchozí npm repozitář', public: true, allowPublish: true, created: new Date().toISOString() },
        { name: 'files', type: 'generic', description: 'Obecné soubory / artefakty', public: true, allowPublish: true, created: new Date().toISOString() },
        { name: 'docker', type: 'docker', description: 'Docker / OCI image (Docker Registry API v2 na /v2/)', public: true, allowPublish: true, created: new Date().toISOString() },
        { name: 'git', type: 'git', description: 'Git repozitáře (git clone/push přes HTTP na /git/)', public: true, allowPublish: true, autoCreate: true, created: new Date().toISOString() },
      ]),
      routes: new JsonStore(cfg('routes.json'), () => (c.upstream ? [{
        id: 'npmjs', name: 'npmjs-fallback', enabled: true, priority: 1000, when: 'notfound', matchOn: 'package', matchType: 'prefix', pattern: '',
        repo: '*', repoType: 'npm', key: '', header: null, methods: ['GET', 'HEAD', 'POST'], target: c.upstream, stripPrefix: '', addPrefix: '', headers: {},
        cacheTtl: null, description: 'Balíčky, které nejsou v lokálním registru, se stáhnou z npmjs.org a uloží do cache.',
      }] : [])),
      users: new JsonStore(cfg('users.json'), {}),
      tokens: new JsonStore(cfg('tokens.json'), []),
      webhooks: new JsonStore(cfg('webhooks.json'), []),
    };
    this.ensureDockerRepo();
    this.ensureGitRepo();
    const secretFile = cfg('secret');
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    this.secret = fs.readFileSync(secretFile, 'utf8').trim();
    this.spec = JSON.parse(fs.readFileSync(c.specFile, 'utf8'));
    this.cache = new Cache(path.join(c.dataDir, 'cache'));
    this.auth = new Auth(this);
    this.portal = new Portal(process.env, this.log);
    this.typeHosts = new TypeHosts(this);
    this.transfer = new Transfer(this);
    this.handlers = new Map();
    this.events = new Events(this);
    this.statsStore = new Stats(this);
    this.scheduler = new Scheduler(this);
    this.plugins = new PluginManager(this);
    this.plugins.load();
    this.api = createAdminApi(this);
    this.web = createWeb(this);
  }

  // ---------- repositories ----------
  /** Installations from before 1.1 get the docker repository on first start. */
  ensureDockerRepo() {
    const s = this.stores.settings.get();
    const repos = this.stores.repos.get();
    if (!s.dockerRepo && !repos.some((r) => r.type === 'docker')) {
      if (!repos.some((r) => r.name === 'docker'))
        this.stores.repos.update((l) => { l.push({ name: 'docker', type: 'docker', description: 'Docker / OCI image (Docker Registry API v2 na /v2/)', public: true, allowPublish: true, created: new Date().toISOString() }); });
      this.stores.settings.set({ ...s, dockerRepo: 'docker' });
    } else if (!s.dockerRepo) this.stores.settings.set({ ...s, dockerRepo: repos.find((r) => r.type === 'docker').name });
  }
  /** Installations from before 1.2 get the git repository on first start. */
  ensureGitRepo() {
    const s = this.stores.settings.get();
    if (s.gitRepo) return;
    const repos = this.stores.repos.get();
    const existing = repos.find((r) => r.type === 'git');
    if (!existing && !repos.some((r) => r.name === 'git')) {
      this.stores.repos.update((l) => { l.push({ name: 'git', type: 'git', description: 'Git repozitáře (git clone/push přes HTTP na /git/)', public: true, allowPublish: true, autoCreate: true, created: new Date().toISOString() }); });
    }
    this.stores.settings.set({ ...s, gitRepo: existing ? existing.name : 'git' });
  }
  dockerRepo() {
    const name = this.stores.settings.get().dockerRepo;
    const conf = name && this.repoConfig(name);
    if (!conf || conf.type !== 'docker') throw new HttpError(404, 'no docker repository configured (settings.dockerRepo)');
    return this.repoHandler(name);
  }
  listRepos() {
    return this.stores.repos.get();
  }
  repoConfig(name) {
    return this.listRepos().find((r) => r.name === name) || null;
  }
  defaultRepoName() {
    return this.stores.settings.get().defaultRepo;
  }
  repoPrefix(name) {
    return name === this.defaultRepoName() ? '' : `/r/${name}`;
  }
  repoHandler(name) {
    const conf = this.repoConfig(name);
    if (!conf) throw new HttpError(404, `repository ${name} not found`);
    let h = this.handlers.get(name);
    if (!h || h.conf !== conf) {
      h = new REPO_TYPES[conf.type](this, conf);
      this.handlers.set(name, h);
    }
    return h;
  }
  repoInfo(name, detailed = false) {
    const conf = this.repoConfig(name);
    if (!conf) throw new HttpError(404, `repository ${name} not found`);
    const h = this.repoHandler(name);
    const docker = conf.type === 'docker';
    const s = this.stores.settings.get();
    const info = {
      ...conf,
      default: name === this.defaultRepoName(),
      path: docker ? '/v2/' : conf.type === 'git' && name === s.gitRepo ? '/git/' : `/r/${name}/`,
      packages: conf.type === 'npm' || conf.type === 'group' ? h.names().length : undefined,
      images: docker ? h.names().length : undefined,
      gitRepos: conf.type === 'git' ? h.names().length : undefined,
      dockerDefault: docker ? name === s.dockerRepo : undefined,
      gitDefault: conf.type === 'git' ? name === s.gitRepo : undefined,
    };
    if (conf.quotaMb) info.quota = { limitBytes: conf.quotaMb * 1048576, usedBytes: repoBytes(h) };
    if (detailed) info.storage = { dir: h.dir, ...dirSize(h.dir) };
    return info;
  }
  createRepo(body) {
    const name = String(body.name || '');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new HttpError(400, 'invalid repository name (a-z, 0-9, ._-)');
    if (['r', 'api', 'admin', 'static', 'downloads', 'v2', 'docs', '-'].includes(name)) throw new HttpError(400, 'reserved repository name');
    const type = body.type || 'npm';
    if (!REPO_TYPES[type]) throw new HttpError(400, `type must be one of ${Object.keys(REPO_TYPES).join(', ')}`);
    if (this.repoConfig(name)) throw new HttpError(409, `repository ${name} already exists`);
    const conf = { name, type, description: body.description || '', public: body.public !== false && body.public !== 'false', allowPublish: body.allowPublish !== false && body.allowPublish !== 'false', created: new Date().toISOString() };
    if (type === 'git') conf.autoCreate = true;
    this.applyRepoOptions(conf, body);
    this.stores.repos.update((l) => { l.push(conf); });
    this.repoHandler(name);
    this.events.emit('repo.create', { repo: name, type });
    return this.repoInfo(name);
  }

  /** Advanced repository options: quota, immutability, access list, cleanup policy, group members. */
  applyRepoOptions(conf, body) {
    const bool = (v) => v === true || v === 'true' || v === 1 || v === '1';
    if (body.quotaMb !== undefined) {
      const q = Number(body.quotaMb);
      if (!(q >= 0)) throw new HttpError(400, 'quotaMb must be a number >= 0');
      conf.quotaMb = q || 0;
    }
    if (body.immutable !== undefined) conf.immutable = bool(body.immutable);
    if (body.autoCreate !== undefined) conf.autoCreate = bool(body.autoCreate);
    if (body.acl !== undefined) {
      const acl = typeof body.acl === 'string' ? Object.fromEntries(body.acl.split(',').filter(Boolean).map((x) => x.split(':').map((y) => y.trim()))) : body.acl || {};
      for (const [u, l] of Object.entries(acl)) if (!ACL_LEVELS.includes(l)) throw new HttpError(400, `acl level for ${u} must be one of ${ACL_LEVELS.join(', ')}`);
      conf.acl = acl;
    }
    if (body.cleanup !== undefined) {
      if (body.cleanup === null || body.cleanup === false) delete conf.cleanup;
      else {
        const c = { ...(conf.cleanup || {}), ...body.cleanup };
        conf.cleanup = {
          enabled: bool(c.enabled),
          maxVersions: Number(c.maxVersions) || 0,
          maxAgeDays: Number(c.maxAgeDays) || 0,
          prereleaseOnly: bool(c.prereleaseOnly),
          pattern: String(c.pattern || ''),
          intervalHours: Number(c.intervalHours) || 24,
        };
      }
    }
    if (conf.type === 'group') {
      if (body.members !== undefined) {
        const members = (Array.isArray(body.members) ? body.members : String(body.members).split(',')).map((m) => String(m).trim()).filter(Boolean);
        const types = new Set();
        for (const m of members) {
          const mc = this.repoConfig(m);
          if (!mc || m === conf.name) throw new HttpError(400, `group member ${m} does not exist`);
          if (!['npm', 'generic'].includes(mc.type)) throw new HttpError(400, `group member ${m} must be an npm or generic repository`);
          types.add(mc.type);
        }
        if (types.size > 1) throw new HttpError(400, 'all group members must have the same type');
        conf.members = members;
      }
      if (body.deployTo !== undefined) conf.deployTo = body.deployTo || '';
      if (!conf.members || !conf.members.length) throw new HttpError(400, 'a group needs at least one member');
      if (conf.deployTo && !conf.members.includes(conf.deployTo)) throw new HttpError(400, 'deployTo must be one of the members');
    }
    return conf;
  }
  updateRepo(name, body) {
    const conf = this.repoConfig(name);
    if (!conf) throw new HttpError(404, `repository ${name} not found`);
    const wasImmutable = !!conf.immutable;
    const next = { ...conf };
    for (const k of ['description', 'public', 'allowPublish']) if (body[k] !== undefined) next[k] = k === 'description' ? String(body[k]) : body[k] !== false && body[k] !== 'false';
    this.applyRepoOptions(next, body);
    Object.assign(conf, next);
    this.stores.repos.save();
    this.handlers.delete(name);
    if (conf.type === 'git' && wasImmutable !== !!conf.immutable) {
      this.repoHandler(name).reconfigureAll().catch((e) => this.log.warn(`reconfigure ${name}: ${e.message}`));
    }
    this.events.emit('repo.update', { repo: name, changes: Object.keys(body) });
    return this.repoInfo(name);
  }
  deleteRepo(name, purge) {
    if (!this.repoConfig(name)) throw new HttpError(404, `repository ${name} not found`);
    if (name === this.defaultRepoName()) throw new HttpError(400, 'cannot delete the default repository');
    this.stores.repos.update((l) => l.filter((r) => r.name !== name));
    this.handlers.delete(name);
    if (purge) {
      rmrf(path.join(this.config.dataDir, 'repos', name));
      this.statsStore.remove(name);
    }
    this.events.emit('repo.delete', { repo: name, purge: !!purge });
  }

  /** Run the cleanup (retention) policy of a repository; dryRun only reports what would be removed. */
  async runCleanup(name, { dryRun = false, policy } = {}, identity = null) {
    const conf = this.repoConfig(name);
    if (!conf) throw new HttpError(404, `repository ${name} not found`);
    const h = this.repoHandler(name);
    if (typeof h.cleanup !== 'function') throw new HttpError(400, `${conf.type} repositories have no cleanup`);
    if (!dryRun && conf.immutable) throw new HttpError(403, `repository ${name} is immutable`);
    const pol = policy && Object.keys(policy).length ? policy : conf.cleanup || {};
    if (conf.type !== 'git' && !pol.maxVersions && !pol.maxAgeDays) throw new HttpError(400, 'cleanup policy has no rule (set maxVersions and/or maxAgeDays)');
    const r = await h.cleanup(pol, { dryRun });
    if (!dryRun) {
      conf.cleanupLastRun = new Date().toISOString();
      this.stores.repos.save();
      this.audit(identity, 'cleanup', `${name}: ${r.actions.length} actions, ${r.freedBytes} B`);
      this.events.emit('repo.cleanup', { repo: name, actions: r.actions.length, freedBytes: r.freedBytes }, identity);
    }
    return { repo: name, dryRun, policy: pol, ...r };
  }

  updateSettings(body) {
    const s = { ...this.stores.settings.get() };
    for (const k of Object.keys(body)) {
      if (!SETTINGS_KEYS.includes(k)) throw new HttpError(400, `unknown setting ${k}`);
      s[k] = body[k];
    }
    if (!this.repoConfig(s.defaultRepo)) throw new HttpError(400, `repository ${s.defaultRepo} does not exist`);
    if (s.defaultRepo && this.repoConfig(s.defaultRepo).type === 'docker') throw new HttpError(400, 'the default repository cannot be a docker repository');
    if (s.dockerRepo && (!this.repoConfig(s.dockerRepo) || this.repoConfig(s.dockerRepo).type !== 'docker')) throw new HttpError(400, `${s.dockerRepo} is not a docker repository`);
    if (s.gitRepo && (!this.repoConfig(s.gitRepo) || this.repoConfig(s.gitRepo).type !== 'git')) throw new HttpError(400, `${s.gitRepo} is not a git repository`);
    if (['git', 'docker'].includes(this.repoConfig(s.defaultRepo).type)) throw new HttpError(400, 'the default repository must be an npm, generic or group repository');
    for (const k of ['anonymousRead', 'allowRegistration']) s[k] = s[k] === true || s[k] === 'true';
    for (const k of ['cacheTtl', 'tarballTtl']) s[k] = Number(s[k]) || 0;
    if (typeof s.plugins === 'string') s.plugins = s.plugins.split(',').map((x) => x.trim()).filter(Boolean);
    this.stores.settings.set(s);
    this.plugins.load();
    return s;
  }

  router() {
    const r = this.plugins.get('router');
    if (!r) throw new HttpError(400, 'router plugin is disabled');
    return r;
  }

  // ---------- logging ----------
  audit(identity, action, target) {
    const e = { time: new Date().toISOString(), user: identity ? identity.name : 'anonymous', action, target };
    this.logs.audit.push(e);
    if (this.logs.audit.length > 1000) this.logs.audit.shift();
    try { fs.appendFileSync(path.join(this.config.dataDir, 'audit.log'), JSON.stringify(e) + '\n'); } catch { /* ignore */ }
  }

  // ---------- clients ----------
  clientIndex() {
    return readJsonFile(path.join(this.config.distDir, 'packages', 'index.json'), []);
  }
  clientList(base) {
    const repo = this.stores.settings.get().clientsRepo || this.defaultRepoName();
    const reg = `${base}${this.repoPrefix(repo)}/`;
    return this.clientIndex().map((p) => ({
      ...p,
      download: `${base}/downloads/${p.file}`,
      npmInstall: `npm install -g ${p.name} --registry ${reg}`,
    }));
  }
  ensureClients() {
    if (!fs.existsSync(path.join(this.config.distDir, 'packages', 'index.json'))) {
      this.log.info('client packages not built yet - building');
      require(path.join(this.config.root, 'tools', 'build.js')).build({ quiet: true });
    }
  }
  seedClients() {
    const s = this.stores.settings.get();
    const repoName = s.clientsRepo || this.defaultRepoName();
    if (!this.repoConfig(repoName) || this.repoConfig(repoName).type !== 'npm') return [];
    const repo = this.repoHandler(repoName);
    const published = [];
    for (const p of this.clientIndex()) {
      const doc = repo.read(p.name);
      if (doc && doc.versions[p.version]) continue;
      const tgz = fs.readFileSync(path.join(this.config.distDir, 'packages', p.file));
      repo.publishTarball(tgz, { name: 'm5ike', role: 'admin' }, { maintainers: [{ name: 'm5ike', email: 'm5ike@users.noreply.github.com' }] });
      published.push(`${p.name}@${p.version}`);
    }
    if (published.length) this.log.info(`published client packages: ${published.join(', ')}`);
    return published;
  }
  async rebuildClients() {
    const build = require(path.join(this.config.root, 'tools', 'build.js'));
    delete require.cache[require.resolve(path.join(this.config.root, 'tools', 'build.js'))];
    const r = build.build({ quiet: true });
    const published = this.seedClients();
    return { packages: r.packages, published };
  }

  status(base) {
    const npmRepos = this.listRepos().filter((r) => r.type === 'npm');
    const c = this.cache.stats();
    return {
      name: 'rr-registry',
      title: this.stores.settings.get().title,
      version: this.config.version,
      maintainer: 'm5ike',
      node: process.version,
      uptime: Math.round((Date.now() - this.started) / 1000),
      time: new Date().toISOString(),
      registry: `${base}/`,
      defaultRepo: this.defaultRepoName(),
      repos: this.listRepos().length,
      packages: npmRepos.reduce((n, r) => n + this.repoHandler(r.name).names().length, 0),
      routes: this.stores.routes.get().length,
      typeHosts: this.typeHosts.list(base),
      gitRepos: this.listRepos().filter((r) => r.type === 'git').reduce((n, r) => n + this.repoHandler(r.name).names().length, 0),
      webhooks: this.stores.webhooks.get().length,
      git: gitAvailable() || null,
      cache: { entries: c.entries, bytes: c.bytes, hits: c.hits, misses: c.misses },
      stats: this.stats,
    };
  }

  portalManifest(res) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(this.config.root, 'portal.app.json'), 'utf8'));
    } catch {
      return sendJson(res, 404, { error: 'portal manifest not shipped with this build' });
    }
    manifest.version = this.config.version;
    return sendJson(res, 200, manifest);
  }

  // ---------- HTTP ----------
  async handle(req, res) {
    const t0 = Date.now();
    this.stats.requests++;
    const url = new URL(req.url, 'http://localhost');
    const settings = this.stores.settings.get();
    if (settings.cors) {
      res.setHeader('access-control-allow-origin', settings.cors);
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-rr-key, npm-command, accept');
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
      res.setHeader('access-control-expose-headers', 'x-rr-cache, x-rr-route, content-disposition');
    }
    res.setHeader('x-powered-by', `rr-registry/${this.config.version}`);
    res.on('finish', () => {
      let user = 'anonymous';
      if (req._identity) user = req._identity.name;
      const e = { time: new Date(t0).toISOString(), method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - t0, user, ip: req.socket.remoteAddress, cache: res.getHeader('x-rr-cache') || '' };
      if (res.statusCode >= 500) this.stats.errors++;
      this.logs.requests.push(e);
      if (this.logs.requests.length > 1000) this.logs.requests.shift();
      if (this.config.logRequests && !this.config.quiet) this.log.info(`${e.method} ${e.url} ${e.status} ${e.ms}ms ${e.user}${e.cache ? ` cache=${e.cache}` : ''}`);
    });
    try {
      let p = url.pathname;
      await this.auth.portalPreauth(req);
      // AI Tools Portal discovery (contract 1): the manifest of this app, optional for standalone use.
      if (p === '/.well-known/portal-app.json' && (req.method === 'GET' || req.method === 'HEAD')) return this.portalManifest(res);
      // {type}-{app}.<domain>: one repository type at the host root (see typehosts.js)
      const th = this.typeHosts.match(req);
      if (th) {
        const np = this.typeHosts.rewrite(th.type, p);
        if (np === null) throw new HttpError(404, `no ${th.type} repository on this registry`);
        req._typeHost = th.host;
        res.setHeader('x-rr-type-host', th.type);
        if (np !== p) { p = np; url.pathname = np; }
      }
      if (p === '/api/v1' || p.startsWith('/api/v1/')) return await this.api(req, res, url);
      if (p === '/v2' || p.startsWith('/v2/')) {
        try {
          return await this.dockerRepo().handleV2(req, res, p.slice(3) || '/', url.searchParams);
        } catch (e) {
          if (!e.status || e.status >= 500) this.log.error(req.method, req.url, e.stack || e.message);
          return sendRegistryError(res, e);
        }
      }
      const hook = /^\/-\/rr\/hooks\/git\/([^/]+)\/(.+)$/.exec(p);
      if (hook && req.method === 'POST') {
        const h = this.repoHandler(decodeURIComponent(hook[1]));
        if (h.conf.type !== 'git') throw new HttpError(400, 'not a git repository');
        return sendJson(res, 200, await h.webhook(decodeURIComponent(hook[2]).replace(/\.git$/, ''), req, await readBody(req, 5 * 1024 * 1024)));
      }
      if (await this.web.serve(req, res, url)) return;

      const signed = /\/-\/rr\/t\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(p);
      if (signed) {
        this.auth.require(req, 'read', this.repoConfig(this.defaultRepoName()));
        return await this.router().serveSigned(req, res, signed[1], signed[2], signed[3]);
      }

      let key = String(req.headers['x-rr-key'] || url.searchParams.get('rr_key') || '');
      let prefix = '';
      const km = /^\/~([^/]+)(\/.*)?$/.exec(p);
      if (km) {
        key = decodeURIComponent(km[1]);
        prefix = `/~${km[1]}`;
        p = km[2] || '/';
      }
      let repoName = this.defaultRepoName();
      const rm = /^\/r\/([^/]+)(\/.*)?$/.exec(p);
      if (!rm && GIT_PATH_RE.test(p) && this.repoConfig(settings.gitRepo)) {
        repoName = settings.gitRepo;
        prefix += '/git';
        p = p.slice(4);
      } else if (rm) {
        repoName = decodeURIComponent(rm[1]);
        prefix += `/r/${rm[1]}`;
        p = rm[2] || '/';
      }
      const conf = this.repoConfig(repoName);
      if (!conf) throw new HttpError(404, `repository ${repoName} not found`);
      const handler = this.repoHandler(repoName);
      const sp = new URLSearchParams(url.search);
      sp.delete('rr_key');
      const search = sp.toString() ? `?${sp}` : '';
      let decoded;
      try { decoded = decodeURIComponent(p); } catch { throw new HttpError(400, 'bad URL encoding'); }
      const root = baseUrl(req, this.config);
      let bodyPromise = null;
      const ctx = {
        req, res, app: this, repo: conf, handler, method: req.method, key, headers: req.headers,
        rawPath: p, path: decoded, search, url: req.url,
        base: `${root}${prefix}`, rootBase: root,
        pkgPath: handler.packagePath(decoded),
        body: () => (bodyPromise = bodyPromise || readBody(req, this.config.maxBody)),
      };
      if (await this.plugins.run('beforeLocal', ctx)) return;
      try {
        await handler.handle(ctx);
      } catch (e) {
        if (!(e instanceof NotFoundLocal)) throw e;
        if (await this.plugins.run('onNotFound', ctx)) return;
        if (ctx.fallback) return ctx.fallback();
        throw e;
      }
    } catch (e) {
      if (!e.status || (e.status >= 500 && e.status !== 507)) this.log.error(req.method, req.url, e.stack || e.message);
      if (e.status === 401 && !res.getHeader('www-authenticate')) res.setHeader('www-authenticate', 'Bearer realm="rr-registry"');
      sendError(res, e);
    }
  }

  listen(port = this.config.port, host = this.config.host) {
    this.ensureClients();
    this.seedClients();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.keepAliveTimeout = 65000;
    // image layers can be large - no overall request deadline (headers still time out)
    this.server.requestTimeout = 0;
    if (this.config.scheduler !== false) this.scheduler.start();
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        this.typeHosts.schedule(500);
        this.log.info(`RR Registry ${this.config.version} listening on http://${host}:${this.port} (data: ${this.config.dataDir})`);
        resolve(this);
      });
    });
  }

  close() {
    this.scheduler.stop();
    this.typeHosts.stop();
    try { this.statsStore.flush(); } catch { /* ignore */ }
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections && this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

module.exports = { App };

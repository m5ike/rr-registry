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
//   /~<key>/...               routing key prefix (combinable with /r/<repo>/)
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { loadConfig } = require('./config');
const { HttpError, NotFoundLocal, sendError, readBody, baseUrl } = require('./util/http');
const { JsonStore, mkdirp, readJsonFile, rmrf, dirSize } = require('./util/store');
const { Auth } = require('./auth');
const { Cache } = require('./cache');
const { PluginManager } = require('./plugins');
const { NpmRepo } = require('./repos/npm');
const { GenericRepo } = require('./repos/generic');
const { DockerRepo, sendRegistryError } = require('./repos/docker');
const { createAdminApi } = require('./api/admin');
const { createWeb } = require('./web');

const REPO_TYPES = { npm: NpmRepo, generic: GenericRepo, docker: DockerRepo };
const SETTINGS_KEYS = ['title', 'defaultRepo', 'dockerRepo', 'anonymousRead', 'allowRegistration', 'cacheTtl', 'tarballTtl', 'plugins', 'clientsRepo', 'cors', 'motd'];

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
        cors: '*',
        motd: '',
      })),
      repos: new JsonStore(cfg('repos.json'), () => [
        { name: c.defaultRepo, type: 'npm', description: 'Výchozí npm repozitář', public: true, allowPublish: true, created: new Date().toISOString() },
        { name: 'files', type: 'generic', description: 'Obecné soubory / artefakty', public: true, allowPublish: true, created: new Date().toISOString() },
        { name: 'docker', type: 'docker', description: 'Docker / OCI image (Docker Registry API v2 na /v2/)', public: true, allowPublish: true, created: new Date().toISOString() },
      ]),
      routes: new JsonStore(cfg('routes.json'), () => (c.upstream ? [{
        id: 'npmjs', name: 'npmjs-fallback', enabled: true, priority: 1000, when: 'notfound', matchOn: 'package', matchType: 'prefix', pattern: '',
        repo: '*', repoType: 'npm', key: '', header: null, methods: ['GET', 'HEAD', 'POST'], target: c.upstream, stripPrefix: '', addPrefix: '', headers: {},
        cacheTtl: null, description: 'Balíčky, které nejsou v lokálním registru, se stáhnou z npmjs.org a uloží do cache.',
      }] : [])),
      users: new JsonStore(cfg('users.json'), {}),
      tokens: new JsonStore(cfg('tokens.json'), []),
    };
    this.ensureDockerRepo();
    const secretFile = cfg('secret');
    if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    this.secret = fs.readFileSync(secretFile, 'utf8').trim();
    this.spec = JSON.parse(fs.readFileSync(c.specFile, 'utf8'));
    this.cache = new Cache(path.join(c.dataDir, 'cache'));
    this.auth = new Auth(this);
    this.handlers = new Map();
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
    const info = {
      ...conf,
      default: name === this.defaultRepoName(),
      path: docker ? '/v2/' : `/r/${name}/`,
      packages: conf.type === 'npm' ? h.names().length : undefined,
      images: docker ? h.names().length : undefined,
      dockerDefault: docker ? name === this.stores.settings.get().dockerRepo : undefined,
    };
    if (detailed) info.storage = { dir: h.dir, ...dirSize(h.dir) };
    return info;
  }
  createRepo(body) {
    const name = String(body.name || '');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) throw new HttpError(400, 'invalid repository name (a-z, 0-9, ._-)');
    if (['r', 'api', 'admin', 'static', 'downloads', 'v2'].includes(name)) throw new HttpError(400, 'reserved repository name');
    const type = body.type || 'npm';
    if (!REPO_TYPES[type]) throw new HttpError(400, `type must be one of ${Object.keys(REPO_TYPES).join(', ')}`);
    if (this.repoConfig(name)) throw new HttpError(409, `repository ${name} already exists`);
    const conf = { name, type, description: body.description || '', public: body.public !== false, allowPublish: body.allowPublish !== false, created: new Date().toISOString() };
    this.stores.repos.update((l) => { l.push(conf); });
    this.repoHandler(name);
    return this.repoInfo(name);
  }
  updateRepo(name, body) {
    const conf = this.repoConfig(name);
    if (!conf) throw new HttpError(404, `repository ${name} not found`);
    for (const k of ['description', 'public', 'allowPublish']) if (body[k] !== undefined) conf[k] = k === 'description' ? String(body[k]) : body[k] !== false && body[k] !== 'false';
    this.stores.repos.save();
    this.handlers.delete(name);
    return this.repoInfo(name);
  }
  deleteRepo(name, purge) {
    if (!this.repoConfig(name)) throw new HttpError(404, `repository ${name} not found`);
    if (name === this.defaultRepoName()) throw new HttpError(400, 'cannot delete the default repository');
    this.stores.repos.update((l) => l.filter((r) => r.name !== name));
    this.handlers.delete(name);
    if (purge) rmrf(path.join(this.config.dataDir, 'repos', name));
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
      cache: { entries: c.entries, bytes: c.bytes, hits: c.hits, misses: c.misses },
      stats: this.stats,
    };
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
      if (p === '/api/v1' || p.startsWith('/api/v1/')) return await this.api(req, res, url);
      if (p === '/v2' || p.startsWith('/v2/')) {
        try {
          return await this.dockerRepo().handleV2(req, res, p.slice(3) || '/', url.searchParams);
        } catch (e) {
          if (!e.status || e.status >= 500) this.log.error(req.method, req.url, e.stack || e.message);
          return sendRegistryError(res, e);
        }
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
      if (rm) {
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
      if (!e.status || e.status >= 500) this.log.error(req.method, req.url, e.stack || e.message);
      if (e.status === 401) res.setHeader('www-authenticate', 'Bearer realm="rr-registry"');
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
    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        this.port = this.server.address().port;
        this.log.info(`RR Registry ${this.config.version} listening on http://${host}:${this.port} (data: ${this.config.dataDir})`);
        resolve(this);
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections && this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

module.exports = { App };

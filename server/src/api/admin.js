'use strict';
// Management REST API (/api/v1). Routes are built from api/spec.json - every operation in the
// spec must have a handler here, so the generated client libraries always match the server.
const { HttpError, send, sendJson, readBody, readJson, baseUrl, mimeType } = require('../util/http');
const files = require('../repos/files');

function compile(spec) {
  return spec.operations
    .map((op) => {
      const keys = [];
      const re = op.path.split('/').map((seg) => {
        if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('/');
      return { op, keys, re: new RegExp(`^${spec.basePath}${re}/?$`) };
    })
    .sort((a, b) => a.keys.length - b.keys.length);
}

function bool(v) {
  return v === true || v === 'true' || v === '1' || v === 1 || v === 'yes';
}

function createHandlers(app) {
  const npmRepo = (name) => {
    const h = app.repoHandler(name);
    if (h.conf.type !== 'npm') throw new HttpError(400, `repository ${name} is not an npm repository`);
    return h;
  };

  return {
    // ---- system ----
    status: ({ req }) => app.status(baseUrl(req, app.config)),
    getSpec: () => app.spec,
    listClients: ({ req }) => app.clientList(baseUrl(req, app.config)),
    rebuildClients: async ({ identity }) => {
      const r = await app.rebuildClients();
      app.audit(identity, 'rebuild-clients', r.packages.map((p) => `${p.name}@${p.version}`).join(', '));
      return r;
    },
    getLogs: ({ query }) => {
      const limit = Math.min(Number(query.limit) || 100, 1000);
      const type = query.type || 'all';
      return {
        requests: type === 'audit' ? [] : app.logs.requests.slice(-limit).reverse(),
        audit: type === 'requests' ? [] : app.logs.audit.slice(-limit).reverse(),
      };
    },
    listPlugins: () => app.plugins.info(),

    // ---- auth ----
    login: ({ body }) => {
      const id = app.auth.checkCredentials(body.username, body.password);
      if (!id) throw new HttpError(401, 'invalid username or password');
      const t = app.auth.issueToken({ user: id.name, role: id.role, name: body.tokenName || 'login session', kind: 'session', ttlSeconds: Number(body.ttl) || 12 * 3600 });
      app.audit(id, 'login', 'api');
      return { token: t.token, user: { name: id.name, role: id.role }, expires: t.expires };
    },
    logout: ({ identity }) => {
      if (identity.tokenId) app.auth.revokeToken(identity.tokenId);
      return { ok: true };
    },
    whoami: ({ identity }) => ({ name: identity.name, role: identity.role, readonly: !!identity.readonly, via: identity.via }),

    // ---- repositories ----
    listRepos: ({ identity }) => app.listRepos().filter((r) => app.auth.can(identity, 'read', r)).map((r) => app.repoInfo(r.name)),
    createRepo: ({ body, identity }) => {
      const r = app.createRepo(body);
      app.audit(identity, 'create-repo', r.name);
      return r;
    },
    getRepo: ({ params }) => app.repoInfo(params.repo, true),
    updateRepo: ({ params, body, identity }) => {
      const r = app.updateRepo(params.repo, body);
      app.audit(identity, 'update-repo', r.name);
      return r;
    },
    deleteRepo: ({ params, query, identity }) => {
      app.deleteRepo(params.repo, bool(query.purge));
      app.audit(identity, 'delete-repo', params.repo);
      return { ok: true };
    },

    // ---- packages ----
    listPackages: ({ params, query }) => app.repoHandler(params.repo).listPackages(query.q || ''),
    uploadPackage: async ({ req, params, query, identity }) => {
      const repo = npmRepo(params.repo);
      const tgz = await readBody(req, app.config.maxBody);
      if (!tgz.length) throw new HttpError(400, 'empty body, send the .tgz file');
      return repo.publishTarball(tgz, identity, { tag: query.tag || 'latest' });
    },
    getPackage: ({ req, params }) => {
      const repo = npmRepo(params.repo);
      return repo.serialize(repo.getPackage(params.pkg), `${baseUrl(req, app.config)}${app.repoPrefix(params.repo)}`);
    },
    deletePackage: ({ params, identity }) => npmRepo(params.repo).unpublish(params.pkg, identity),
    deleteVersion: ({ params, identity }) => npmRepo(params.repo).deleteVersion(params.pkg, params.version, identity),
    downloadTarball: ({ res, params }) => {
      const repo = npmRepo(params.repo);
      const doc = repo.getPackage(params.pkg);
      const v = doc['dist-tags'][params.version] || params.version;
      const m = doc.versions[v];
      if (!m) throw new HttpError(404, `version ${params.version} not found`);
      const file = m.dist.tarball.split('/').pop();
      const data = repo.tarball(params.pkg, file);
      if (!data) throw new HttpError(404, 'tarball missing');
      send(res, 200, data, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${file}"` });
    },
    deprecateVersion: ({ params, body }) => npmRepo(params.repo).deprecate(params.pkg, params.version, body.message || ''),
    setDistTag: ({ params, body }) => npmRepo(params.repo).setTag(params.pkg, params.tag, typeof body === 'string' ? body : body.version),
    deleteDistTag: ({ params }) => npmRepo(params.repo).deleteTag(params.pkg, params.tag),
    search: ({ query, identity }) => {
      const repos = app.listRepos().filter((r) => r.type === 'npm' && (!query.repo || r.name === query.repo) && app.auth.can(identity, 'read', r));
      const objects = [];
      for (const r of repos) objects.push(...app.repoHandler(r.name).search(query.q || '', 250, 0).objects);
      objects.sort((a, b) => b.searchScore - a.searchScore);
      return { total: objects.length, objects: objects.slice(0, Number(query.size) || 50) };
    },

    // ---- files ----
    tree: ({ params, query }) => files.tree(app.repoHandler(params.repo).dir, query.path || '/', query.depth || 1),
    stat: ({ params, query }) => files.stat(app.repoHandler(params.repo).dir, query.path || '/'),
    readFile: ({ res, params, query }) => {
      const f = files.read(app.repoHandler(params.repo).dir, query.path);
      send(res, 200, f.data, { 'content-type': mimeType(query.path), 'content-disposition': `inline; filename="${String(query.path).split('/').pop()}"` });
    },
    writeFile: async ({ req, params, query, identity }) => {
      const data = await readBody(req, app.config.maxBody);
      const r = files.write(app.repoHandler(params.repo).dir, query.path, data);
      app.audit(identity, 'write-file', `${params.repo}${r.path}`);
      return r;
    },
    deleteFile: ({ params, query, identity }) => {
      files.remove(app.repoHandler(params.repo).dir, query.path);
      app.audit(identity, 'delete-file', `${params.repo}${query.path}`);
      return { ok: true };
    },
    mkdir: ({ params, query }) => files.mkdir(app.repoHandler(params.repo).dir, query.path),

    // ---- routes ----
    listRoutes: () => app.router().rules(),
    createRoute: ({ body, identity }) => {
      const r = app.router().create(body);
      app.audit(identity, 'create-route', r.name);
      return r;
    },
    getRoute: ({ params }) => app.router().get(params.id),
    updateRoute: ({ params, body, identity }) => {
      const r = app.router().update(params.id, body);
      app.audit(identity, 'update-route', r.name);
      return r;
    },
    deleteRoute: ({ params, identity }) => {
      app.router().remove(params.id);
      app.audit(identity, 'delete-route', params.id);
      return { ok: true };
    },
    testRoute: ({ body }) => app.router().explain(body),

    // ---- cache ----
    cacheStats: () => app.cache.stats(),
    listCache: ({ query }) => app.cache.list({ q: query.q || '', limit: Number(query.limit) || 200 }),
    purgeCache: ({ query, identity }) => {
      const removed = app.cache.purge({ expired: bool(query.expired), q: query.q || '' });
      app.audit(identity, 'purge-cache', `${removed} entries`);
      return { ok: true, removed };
    },
    deleteCacheEntry: ({ params }) => {
      if (!app.cache.delete(params.key)) throw new HttpError(404, 'cache entry not found');
      return { ok: true };
    },

    // ---- users ----
    listUsers: () => app.auth.listUsers(),
    createUser: ({ body, identity }) => {
      const u = app.auth.createUser(body);
      app.audit(identity, 'create-user', u.name);
      return u;
    },
    updateUser: ({ params, body, identity }) => {
      const u = app.auth.updateUser(params.name, body);
      app.audit(identity, 'update-user', u.name);
      return u;
    },
    deleteUser: ({ params, identity }) => {
      app.auth.deleteUser(params.name);
      app.audit(identity, 'delete-user', params.name);
      return { ok: true };
    },

    // ---- tokens ----
    listTokens: ({ identity }) => app.auth.listTokens(identity.role === 'admin' ? null : identity.name),
    createToken: ({ body, identity }) => {
      let user = identity.name;
      let role = identity.role;
      if (body.user && body.user !== identity.name) {
        if (identity.role !== 'admin') throw new HttpError(403, 'only admin can create tokens for other users');
        const u = app.stores.users.get()[body.user];
        if (!u && body.user !== app.config.adminUser) throw new HttpError(404, `user ${body.user} not found`);
        user = body.user;
        role = u ? u.role : 'admin';
      }
      if (identity.readonly) throw new HttpError(403, 'read-only token cannot create tokens');
      const t = app.auth.issueToken({ user, role, name: body.name || 'api', readonly: bool(body.readonly), ttlSeconds: Number(body.ttl) || 0 });
      app.audit(identity, 'create-token', `${t.name} for ${user}`);
      return t;
    },
    revokeToken: ({ params, identity }) => {
      const t = app.stores.tokens.get().find((x) => x.id === params.id);
      if (!t) throw new HttpError(404, 'token not found');
      if (identity.role !== 'admin' && t.user !== identity.name) throw new HttpError(403, 'forbidden');
      app.auth.revokeToken(params.id);
      return { ok: true };
    },

    // ---- settings ----
    getSettings: () => app.stores.settings.get(),
    updateSettings: ({ body, identity }) => {
      const s = app.updateSettings(body);
      app.audit(identity, 'update-settings', Object.keys(body).join(', '));
      return s;
    },
  };
}

function createAdminApi(app) {
  const routes = compile(app.spec);
  const handlers = createHandlers(app);
  const missing = app.spec.operations.filter((o) => !handlers[o.id]).map((o) => o.id);
  if (missing.length) throw new Error(`API handlers missing for: ${missing.join(', ')}`);

  return async function handleApi(req, res, url) {
    if (req.method === 'OPTIONS') return send(res, 204, null);
    const p = url.pathname;
    let route = null;
    let m = null;
    let pathMatched = false;
    for (const r of routes) {
      const mm = r.re.exec(p);
      if (!mm) continue;
      pathMatched = true;
      if (r.op.method === req.method || (req.method === 'HEAD' && r.op.method === 'GET')) { route = r; m = mm; break; }
    }
    if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method not allowed' : `unknown API endpoint ${p}`);
    const params = {};
    route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const query = Object.fromEntries(url.searchParams);
    let repo = null;
    if (params.repo) {
      repo = app.repoConfig(params.repo);
      if (!repo) throw new HttpError(404, `repository ${params.repo} not found`);
    }
    const identity = app.auth.require(req, route.op.auth, repo);
    let body;
    if (route.op.body === 'json') body = await readJson(req, app.config.maxBody);
    const out = await handlers[route.op.id]({ req, res, params, query, body, identity, repo, op: route.op });
    if (!res.headersSent) sendJson(res, route.op.method === 'POST' ? 201 : 200, out === undefined ? { ok: true } : out);
  };
}

module.exports = { createAdminApi, compile };

'use strict';
// Management REST API (/api/v1). Routes are built from api/spec.json - every operation in the
// spec must have a handler here, so the generated client libraries always match the server.
const { HttpError, send, sendJson, readBody, readJson, baseUrl, mimeType } = require('../util/http');
const files = require('../repos/files');
const { checkQuota, assertMutable, invalidate } = require('../policies');
const { githubList } = require('../util/git');
const { publicRule, globToRegex } = require('../plugins/router');
const { EVENT_TYPES } = require('../events');

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
  const dockerRepo = (name) => {
    const h = app.repoHandler(name);
    if (h.conf.type !== 'docker') throw new HttpError(400, `repository ${name} is not a docker repository`);
    return h;
  };
  const gitRepo = (name) => {
    const h = app.repoHandler(name);
    if (h.conf.type !== 'git') throw new HttpError(400, `repository ${name} is not a git repository`);
    return h;
  };
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
    listTasks: () => app.scheduler.list(),
    runTask: async ({ params, identity }) => {
      const t = await app.scheduler.run(params.id);
      if (!t) throw new HttpError(404, `task ${params.id} not found`);
      app.audit(identity, 'run-task', params.id);
      return t;
    },

    // ---- auth ----
    login: async ({ body }) => {
      const id = await app.auth.checkCredentialsAsync(body.username, body.password);
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
    runCleanup: ({ params, body, identity }) => app.runCleanup(params.repo, { dryRun: bool(body.dryRun), policy: body.policy }, identity),
    getRepoStats: ({ params, query }) => app.statsStore.get(params.repo, { top: query.top }),

    // ---- packages ----
    listPackages: ({ params, query }) => app.repoHandler(params.repo).listPackages(query.q || ''),
    // ---- docker ----
    listImages: ({ params }) => dockerRepo(params.repo).images(),
    listImageTags: ({ params }) => dockerRepo(params.repo).tagDetails(params.image),
    deleteImageTag: ({ params, identity }) => {
      const h = dockerRepo(params.repo);
      assertMutable(h.conf, 'deleting images');
      h.deleteTag(params.image, params.tag);
      app.events.emit('docker.delete', { repo: params.repo, name: params.image, ref: params.tag }, identity);
      app.audit(identity, 'docker-delete', `${params.repo}/${params.image}:${params.tag}`);
    },
    dockerGc: ({ params, body, identity }) => {
      const r = dockerRepo(params.repo).gc({ untagged: bool(body && body.untagged) });
      invalidate(dockerRepo(params.repo));
      app.audit(identity, 'docker-gc', `${params.repo}: ${r.blobs} blobs, ${r.manifests} manifests`);
      return r;
    },
    // ---- git ----
    listGitRepos: ({ params, query }) => gitRepo(params.repo).list(query.q || ''),
    createGitRepo: ({ params, body, identity }) => {
      const h = gitRepo(params.repo);
      if (h.conf.allowPublish === false) throw new HttpError(403, `repository ${params.repo} does not allow publishing`);
      // imports reach out to arbitrary URLs (incl. file://) - admin only
      if (body.importUrl && identity.role !== 'admin') throw new HttpError(403, 'only admin can import or mirror repositories');
      return h.create(body.name, body, identity);
    },
    githubImport: async ({ params, body, identity }) => {
      const h = gitRepo(params.repo);
      const owner = String(body.owner || '').trim();
      const token = body.token || '';
      const kind = body.kind || (owner ? 'auto' : 'mine');
      if (!owner && kind !== 'mine') throw new HttpError(400, 'owner (GitHub user or organization) is required');
      if (kind === 'mine' && !token) throw new HttpError(400, 'token is required to list your own repositories');
      const opts = { token, apiUrl: body.apiUrl };
      const limit = Math.min(Number(body.limit) || 100, 1000);
      let list;
      if (kind === 'mine') list = await githubList('/user/repos?affiliation=owner,organization_member', opts, limit);
      else if (kind === 'org') list = await githubList(`/orgs/${encodeURIComponent(owner)}/repos?type=all`, opts, limit);
      else if (kind === 'user') list = await githubList(`/users/${encodeURIComponent(owner)}/repos?type=owner`, opts, limit);
      else {
        try { list = await githubList(`/orgs/${encodeURIComponent(owner)}/repos?type=all`, opts, limit); } catch (e) {
          if (e.status !== 404) throw e;
          list = await githubList(`/users/${encodeURIComponent(owner)}/repos?type=owner`, opts, limit);
        }
      }
      const re = body.filter ? globToRegex(body.filter) : null;
      const selected = list.filter((r) => (body.includeForks || !r.fork) && (body.includeArchived || !r.archived) && (!re || re.test(r.name)));
      const results = [];
      for (const r of selected) {
        const name = body.prefix === '' ? r.name : `${body.prefix || r.owner.login}/${r.name}`;
        if (h.exists(name)) { results.push({ name, status: 'exists' }); continue; }
        try {
          await h.create(name, {
            importUrl: r.clone_url, mirror: body.mirror !== false, interval: body.interval ?? 3600, ttl: body.ttl ?? 300,
            token: token || undefined, username: 'x-access-token', description: r.description || '',
          }, identity);
          results.push({ name, status: 'created', private: r.private, from: r.html_url });
        } catch (e) {
          results.push({ name, status: 'error', error: e.message });
        }
      }
      app.audit(identity, 'github-import', `${params.repo} <- ${owner || 'me'}: ${results.filter((x) => x.status === 'created').length} created`);
      return { owner: owner || null, found: list.length, selected: selected.length, results };
    },
    getGitRepo: ({ req, params }) => gitRepo(params.repo).info(params.name, baseUrl(req, app.config)),
    updateGitRepo: ({ params, body, identity }) => gitRepo(params.repo).update(params.name, body, identity),
    deleteGitRepo: ({ params, identity }) => {
      const h = gitRepo(params.repo);
      assertMutable(h.conf, 'deleting git repositories');
      return h.remove(params.name, identity);
    },
    gitCommits: ({ params, query }) => gitRepo(params.repo).commits(params.name, query),
    gitTree: ({ params, query }) => gitRepo(params.repo).tree(params.name, query),
    gitBlob: async ({ res, params, query }) => {
      const data = await gitRepo(params.repo).blob(params.name, query);
      send(res, 200, data, { 'content-type': mimeType(String(query.path || '')), 'content-disposition': `inline; filename="${String(query.path || 'file').split('/').pop()}"` });
    },
    gitArchive: async ({ res, params, query }) => {
      const a = await gitRepo(params.repo).archive(params.name, query);
      app.statsStore.hit(params.repo, params.name);
      send(res, 200, a.data, { 'content-type': a.file.endsWith('.zip') ? 'application/zip' : 'application/gzip', 'content-disposition': `attachment; filename="${a.file}"` });
    },
    gitSync: ({ params, body, identity }) => gitRepo(params.repo).sync(params.name, ['pull', 'push', 'both'].includes(body.direction) ? body.direction : 'both', identity),
    addGitPushMirror: ({ params, body, identity }) => gitRepo(params.repo).addPushMirror(params.name, body, identity),
    deleteGitPushMirror: ({ params, identity }) => gitRepo(params.repo).removePushMirror(params.name, params.id, identity),

    uploadPackage: async ({ req, params, query, identity }) => {
      const conf = app.repoConfig(params.repo);
      if (conf.type === 'group' && !conf.deployTo) throw new HttpError(400, `group ${params.repo} has no deployTo member`);
      const repo = npmRepo(conf.type === 'group' ? conf.deployTo : params.repo);
      if (!app.auth.can(identity, 'publish', repo.conf)) throw new HttpError(403, `forbidden: publish permission required on ${repo.conf.name}`);
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
      const h = app.repoHandler(params.repo);
      let exists = false;
      try { exists = files.stat(h.dir, query.path).type === 'file'; } catch { /* new file */ }
      if (exists) assertMutable(h.conf, 'overwriting files');
      const data = await readBody(req, app.config.maxBody);
      checkQuota(h, data.length);
      const r = files.write(h.dir, query.path, data);
      invalidate(h);
      app.audit(identity, 'write-file', `${params.repo}${r.path}`);
      app.events.emit('file.upload', { repo: params.repo, path: r.path, size: r.size, overwritten: exists }, identity);
      return r;
    },
    deleteFile: ({ params, query, identity }) => {
      const h = app.repoHandler(params.repo);
      assertMutable(h.conf, 'deleting files');
      files.remove(h.dir, query.path);
      invalidate(h);
      app.audit(identity, 'delete-file', `${params.repo}${query.path}`);
      app.events.emit('file.delete', { repo: params.repo, path: query.path }, identity);
      return { ok: true };
    },
    mkdir: ({ params, query }) => files.mkdir(app.repoHandler(params.repo).dir, query.path),

    // ---- routes ----
    listRoutes: () => app.router().rules().map(publicRule),
    createRoute: ({ body, identity }) => {
      const r = app.router().create(body);
      app.audit(identity, 'create-route', r.name);
      return publicRule(r);
    },
    getRoute: ({ params }) => publicRule(app.router().get(params.id)),
    updateRoute: ({ params, body, identity }) => {
      const r = app.router().update(params.id, body);
      app.audit(identity, 'update-route', r.name);
      return publicRule(r);
    },
    deleteRoute: ({ params, identity }) => {
      app.router().remove(params.id);
      app.audit(identity, 'delete-route', params.id);
      return { ok: true };
    },
    testRoute: ({ body }) => app.router().explain(body),
    listReplications: ({ query }) => app.router().listJobs({ limit: Number(query.limit) || 100, status: query.status }),
    retryReplication: ({ params, identity }) => {
      app.audit(identity, 'retry-replication', params.id);
      return app.router().retryJob(params.id);
    },

    // ---- webhooks & events ----
    listWebhooks: () => app.events.list(),
    createWebhook: ({ body, identity }) => {
      const h = app.events.create(body);
      app.audit(identity, 'create-webhook', h.name);
      return h;
    },
    updateWebhook: ({ params, body, identity }) => {
      const h = app.events.update(params.id, body);
      app.audit(identity, 'update-webhook', h.name);
      return h;
    },
    deleteWebhook: ({ params, identity }) => {
      app.events.remove(params.id);
      app.audit(identity, 'delete-webhook', params.id);
      return { ok: true };
    },
    testWebhook: ({ params }) => app.events.test(params.id),
    listWebhookDeliveries: ({ query }) => app.events.listDeliveries({ id: query.id, limit: Number(query.limit) || 100 }),
    listEvents: ({ query }) => ({
      types: EVENT_TYPES,
      events: app.events.recent.filter((e) => !query.type || e.type === query.type).slice(-(Number(query.limit) || 100)).reverse(),
    }),

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

'use strict';
// Per-type hosts: "{type}-{app}.{domain}" (e.g. npm-registry.example.com, git-registry.example.com)
// serve one repository type at the host root, next to the main host:
//   npm-registry.<domain>/<pkg>         = registry.<domain>/<pkg>       (default npm repository, or /r/<repo>/)
//   git-registry.<domain>/<name>.git    = registry.<domain>/git/<name>.git
//   docker-registry.<domain>/v2/...     = registry.<domain>/v2/...
//   generic-registry.<domain>/<path>    = registry.<domain>/r/<generic repo>/<path>
// The API (/api/v1/), /-/ endpoints, explicit /r/<repo>/ paths, access keys (/~key/) and the web UI work on
// every type host as on the main host.
//
// Attached to the AI Tools Portal (manifest routing.dynamicHosts), the registry reports the types that have
// at least one repository; the portal adds one gateway host route per type and removes routes of types
// whose last repository was deleted.
const http = require('http');
const https = require('https');

const TYPES = ['npm', 'docker', 'git', 'generic'];
// on every type host: API, npm/registry endpoints, explicit repositories, access keys, Docker API, admin UI
const PASS_RE = /^\/(?:api\/v1(?:\/|$)|-\/|\.well-known\/|r\/|~|v2(?:\/|$)|admin(?:\/|$)|static\/|favicon\.(?:ico|svg)$)/;
// web pages of the main host, except on the generic host (where they are ordinary file paths)
const WEB_RE = /^\/(?:downloads(?:\/|$)|docs\/|install\.sh$|index\.html$)/;
const GIT_SUB_RE = /(?:\.git(?:\/.*)?|\/(?:info\/refs|git-upload-pack|git-receive-pack))$/;

class TypeHosts {
  constructor(app) {
    this.app = app;
    this.reported = null; // last list accepted by the portal (JSON)
    this.hosts = [];      // [{ name, host }] as returned by the portal
    this.timer = null;
    this.retry = 0;
    this.unsupported = false;
  }

  /** App id used in the host names ({type}-{app}); "registry" when running standalone. */
  get appId() {
    return String((this.app.portal && this.app.portal.appId) || process.env.RR_APP_ID || 'registry').toLowerCase();
  }

  /** Every name the registry answers to in host names: the app id plus "registry" and "rr" (RR_HOST_NAMES). */
  get names() {
    const extra = `${process.env.RR_HOST_NAMES || 'registry,rr'},${process.env.PORTAL_APP_ALIASES || ''}`.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    return [...new Set([this.appId, ...extra])];
  }

  /** Effective type of a repository (a group counts as the type of its members). */
  typeOf(conf, seen = new Set()) {
    if (!conf) return null;
    if (conf.type !== 'group') return conf.type;
    if (seen.has(conf.name)) return null;
    seen.add(conf.name);
    for (const m of conf.members || []) {
      const t = this.typeOf(this.app.repoConfig(m), seen);
      if (t) return t;
    }
    return null;
  }

  /** Types that have at least one repository, in a fixed order. */
  types() {
    const have = new Set(this.app.listRepos().map((r) => this.typeOf(r)).filter(Boolean));
    return TYPES.filter((t) => have.has(t));
  }

  /** Repository served at the root of the type host. */
  repoFor(type) {
    const app = this.app;
    const s = app.stores.settings.get();
    const repos = app.listRepos();
    const preferred = { npm: s.defaultRepo, docker: s.dockerRepo, git: s.gitRepo, generic: s.defaultRepo }[type];
    const pc = preferred && app.repoConfig(preferred);
    if (pc && this.typeOf(pc) === type) return pc.name;
    // a plain repository of the type first, then a group of that type
    const plain = repos.find((r) => r.type === type);
    if (plain && !(type === 'npm' || type === 'generic')) return plain.name;
    const group = repos.find((r) => r.type === 'group' && this.typeOf(r) === type);
    return (type === 'npm' || type === 'generic') && group ? group.name : plain ? plain.name : null;
  }

  /**
   * The type (and repository) of the request's host, or null for the main host:
   *   <type>-{registry|rr}.<domain>                 -> { type }               (type host)
   *   <repository>.<type>.{registry|rr}.<domain>     -> { type, repo }         (repository host)
   */
  match(req) {
    const raw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    const host = raw.replace(/:\d+$/, '');
    const labels = host.split('.');
    const names = this.names;
    let type = null;
    let repo = null;
    const m = /^([a-z]+)-(.+)$/.exec(labels[0]);
    if (m && names.includes(m[2]) && TYPES.includes(m[1])) type = m[1];
    else if (labels.length >= 3 && names.includes(labels[2]) && (TYPES.includes(labels[1]) || labels[1] === 'group')) {
      const conf = this.app.repoConfig(labels[0]) || this.app.listRepos().find((x) => x.name.toLowerCase() === labels[0]);
      if (!conf) return null;
      repo = conf.name;
      type = labels[1] === 'group' ? this.typeOf(conf) || 'generic' : labels[1];
      if (conf.type !== labels[1] && this.typeOf(conf) !== labels[1]) return null;
    }
    if (!type) return null;
    // behind a gateway the port comes separately (X-Forwarded-Port); keep it in the links unless it is the default
    let full = raw;
    const fport = String(req.headers['x-forwarded-port'] || '').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    if (!/:\d+$/.test(raw) && /^\d+$/.test(fport) && !((proto === 'https' && fport === '443') || (proto === 'http' && fport === '80'))) full = `${raw}:${fport}`;
    return { type, host: full, repo };
  }

  /**
   * Path on the main host for a path on a type host. Returns null when the type has no repository
   * (the request is answered with 404 by the caller).
   */
  rewrite(type, p) {
    if (PASS_RE.test(p) || (type !== 'generic' && WEB_RE.test(p))) return p;
    if (type === 'docker') return p;
    const repo = this.repoFor(type);
    if (!repo) return null;
    const s = this.app.stores.settings.get();
    if (type === 'git') {
      if (p === '/' || !GIT_SUB_RE.test(p)) return p; // home page and other web paths
      // "/<git repository>/<name>.git" selects another git repository (URL mask <type>-registry/<repository>/...)
      const first = decodeURIComponent(p.split('/')[1] || '');
      const fc = first && first !== repo && this.app.repoConfig(first);
      if (fc && fc.type === 'git' && !this.gitRepoExists(repo, p)) return `/r/${fc.name}${p.slice(first.length + 1)}`;
      // "git-registry/git/owner/name.git" (main host habit, or the default repository by name): the type host
      // needs no prefix - drop it instead of creating a repository called "git/owner/name"
      if (p.startsWith(`/${repo}/`) && !this.gitRepoExists(repo, p)) p = p.slice(repo.length + 1);
      else if (/^\/git\//.test(p) && !this.gitRepoExists(repo, p)) p = p.slice(4);
      return repo === s.gitRepo ? `/git${p}` : `/r/${repo}${p}`;
    }
    if (repo === s.defaultRepo) return p;
    return p === '/' ? `/r/${repo}/` : `/r/${repo}${p}`;
  }

  gitRepoExists(repo, p) {
    try {
      const h = this.app.repoHandler(repo);
      const parsed = h.parse(p);
      return !!parsed && h.exists(parsed.name);
    } catch { return false; }
  }

  /**
   * Browser page requests on a type host get the web UI of that type (git, npm, docker) with the path as
   * its route (git-registry/<owner>/<name>/tree/main/docs); the generic host keeps its file listings.
   * Returns 'spa', 'admin' (full administration lives on the main host) or null.
   */
  page(type, req, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    if (p === '/admin' || p === '/admin/' || p === '/admin/index.html') return 'admin';
    const accept = String(req.headers.accept || '');
    if (!/text\/html/.test(accept) || /application\/(json|vnd\.npm)/.test(accept)) return null;
    if (/^\/(?:api\/v1(?:\/|$)|-\/|\.well-known\/|static\/|admin\/|v2(?:\/|$)|downloads(?:\/|$)|docs\/|install\.sh$|favicon\.)/.test(p)) return null;
    if (type === 'git' && /(?:\/(?:info\/refs|git-upload-pack|git-receive-pack))$/.test(p)) return null;
    // the git type host keeps its GitHub-like application, the other types get the public browser
    return type === 'git' ? 'spa' : 'browse';
  }

  /**
   * Repository and path of a browser page from the URL path: an optional leading repository name of the type
   * ("/<repository>/<path>"), otherwise the default repository of the type. Returns { repo, path, base }.
   */
  browseTarget(type, p, prefix = '') {
    const parts = p.split('/').filter(Boolean);
    const first = parts[0] ? decodeURIComponent(parts[0]) : '';
    const conf = first && this.app.repoConfig(first);
    if (conf && (conf.type === type || this.typeOf(conf) === type)) {
      return { repo: conf.name, path: `/${parts.slice(1).join('/')}`, base: `${prefix}/${parts[0]}` };
    }
    const repo = this.repoFor(type);
    return repo ? { repo, path: `/${parts.join('/')}`, base: prefix } : null;
  }

  /** Main host of the registry (full administration): the public URL, or the type host without "{type}-". */
  mainUrl(req, th) {
    if (this.app.config.publicUrl) return this.app.config.publicUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
    if (th.repo) return `${proto}://${th.host.split('.').slice(2).join('.')}`;
    return `${proto}://${th.host.replace(new RegExp(`^${th.type}-`), '')}`;
  }

  /** Public description for the status / admin UI. */
  // host: as routed by the portal, else derived from the main host ("registry.x" -> "npm-registry.x")
  list(base) {
    let main = null;
    try { main = base ? new URL(base) : null; } catch { /* no base */ }
    const reported = new Map(this.hosts.map((h) => [h.name, h.host]));
    return this.types().map((type) => {
      // standalone on localhost / an IP: *.localhost resolves to the loopback interface
      const rest = main && !/^[\d.]+$|^\[/.test(main.hostname) && main.hostname.includes('.') ? main.hostname.split('.').slice(1).join('.') : 'localhost';
      const hostname = reported.get(type) || (main ? `${type}-${this.appId}.${rest}` : null);
      const url = hostname && main ? `${main.protocol}//${hostname}${main.port ? `:${main.port}` : ''}/` : null;
      return { type, repo: this.repoFor(type), host: hostname, url, routed: reported.has(type) };
    });
  }

  // ---------- portal synchronisation ----------
  /** Report the types to the portal soon (debounced). No-op when not attached to a portal. */
  schedule(delay = 300) {
    const p = this.app.portal;
    if (!p || !p.enabled || !p.url || !p.appId || this.unsupported) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.sync().catch(() => {}), delay);
    if (this.timer.unref) this.timer.unref();
  }

  async sync() {
    const p = this.app.portal;
    if (!p || !p.enabled || !p.url || !p.appId) return null;
    const names = this.types();
    const key = JSON.stringify(names);
    if (key === this.reported) return this.hosts;
    try {
      const r = await put(`${p.url}/_portal/api/apps/${encodeURIComponent(p.appId)}/hosts`, { names }, { authorization: `PortalApp ${p.appId} ${p.key}` });
      if (r.status === 404 || r.status === 409) {
        // portal < 1.8 or a manifest without routing.dynamicHosts: type hosts only via manual routes
        this.unsupported = true;
        this.app.log.warn(`portal does not support dynamic hosts (HTTP ${r.status}) — type hosts are not routed`);
        return null;
      }
      if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.body && r.body.error ? r.body.error : ''}`.trim());
      this.reported = key;
      this.retry = 0;
      this.hosts = Array.isArray(r.body.hosts) ? r.body.hosts : [];
      this.app.log.info(`portal type hosts: ${this.hosts.map((h) => h.host).join(', ') || '(none)'}`);
      return this.hosts;
    } catch (e) {
      this.retry = Math.min(this.retry + 1, 6);
      const wait = 5000 * 2 ** (this.retry - 1);
      this.app.log.warn(`portal type hosts: ${e.message} — retrying in ${Math.round(wait / 1000)} s`);
      this.schedule(wait);
      return null;
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

function put(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'PUT',
      timeout: 10000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { TypeHosts, TYPES };

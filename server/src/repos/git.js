'use strict';
// Git repository type - hosts bare repositories and serves them over the git smart HTTP protocol
// (git clone / fetch / push) through `git http-backend`.
//
//   git clone http://host:4873/git/<name>.git            (repository from settings.gitRepo)
//   git clone http://host:4873/r/<repo>/<name>.git       (any git repository)
//   <name> may contain slashes (owner/project), the .git suffix is optional.
//
// Storage: <data>/repos/<repo>/<name>.git/            bare repository
//                                 .../rr.json         metadata: description, pull mirror, push mirrors
//                                 .../rr-protect      protected ref patterns (read by the pre-receive hook)
//                                 .../rr-pulls.json   pull requests, issues and comments (git-pulls.js)
//
// Mirrors:  pull mirror - the repository is a read-only copy of a remote (GitHub, GitLab, ...), refreshed
//                         on schedule (interval), on access after it gets stale, by webhook or manually;
//           push mirrors - after every push the refs are pushed to remote servers (optionally creating
//                         the repository on GitHub first).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { HttpError, NotFoundLocal, send } = require('../util/http');
const { mkdirp, writeAtomic, readJsonFile, rmrf, dirSize } = require('../util/store');
const gitu = require('../util/git');
const { checkQuota, invalidate } = require('../policies');
const { pullsMixin } = require('./git-pulls');
const { manageMixin } = require('./git-manage');

const SEG = '[A-Za-z0-9_][A-Za-z0-9_.-]*';
const NAME_RE = new RegExp(`^${SEG}(?:/${SEG}){0,3}$`);
const SERVICE_RE = /(\/(?:info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/.+|info\/[^/]+))$/;
const ZERO = /^0+$/;

const PRE_RECEIVE = `#!/bin/sh
# Installed by RR Registry - protected refs and immutable repositories (patterns in rr-protect).
PROTECT="$(git rev-parse --git-dir)/rr-protect"
[ -f "$PROTECT" ] || exit 0
while read -r old new ref; do
  while IFS= read -r p || [ -n "$p" ]; do
    [ -z "$p" ] && continue
    case "$ref" in
      $p)
        case "$new" in *[!0]*) ;; *) echo "rr: deleting protected ref $ref is not allowed" >&2; exit 1 ;; esac
        case "$old" in
          *[!0]*) git merge-base --is-ancestor "$old" "$new" 2>/dev/null || { echo "rr: non fast-forward push to protected ref $ref is not allowed" >&2; exit 1; } ;;
        esac ;;
    esac
  done < "$PROTECT"
done
exit 0
`;

function mask(auth) {
  if (!auth) return null;
  return { username: auth.username || '', token: auth.token || auth.password ? '***' : '' };
}

class GitRepo {
  constructor(app, conf) {
    this.app = app;
    this.conf = conf;
    this.dir = path.join(app.config.dataDir, 'repos', conf.name);
    this.syncing = new Map();
    mkdirp(this.dir);
  }

  // ---------- paths & metadata ----------
  static validName(name) {
    return typeof name === 'string' && NAME_RE.test(name) && !name.split('/').some((s) => s === '..' || s.endsWith('.git') || s.endsWith('.lock'));
  }

  checkName(name) {
    name = String(name || '').replace(/\.git$/, '');
    if (!GitRepo.validName(name)) throw new HttpError(400, `invalid git repository name: ${name}`);
    return name;
  }

  repoDir(name) {
    return path.join(this.dir, ...`${this.checkName(name)}.git`.split('/'));
  }

  exists(name) {
    try { return fs.existsSync(path.join(this.repoDir(name), 'HEAD')); } catch { return false; }
  }

  meta(name) {
    return readJsonFile(path.join(this.repoDir(name), 'rr.json'), {});
  }

  saveMeta(name, m) {
    writeAtomic(path.join(this.repoDir(name), 'rr.json'), JSON.stringify(m, null, 2));
    fs.chmodSync(path.join(this.repoDir(name), 'rr.json'), 0o600);
  }

  requireRepo(name) {
    if (!this.exists(name)) throw new HttpError(404, `git repository ${name} not found in ${this.conf.name}`);
    return this.checkName(name);
  }

  names() {
    const out = [];
    const walk = (d, prefix, depth) => {
      let list;
      try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (!e.isDirectory()) continue;
        if (e.name.endsWith('.git')) out.push(prefix + e.name.slice(0, -4));
        else if (depth < 3) walk(path.join(d, e.name), `${prefix}${e.name}/`, depth + 1);
      }
    };
    walk(this.dir, '', 0);
    return out.sort();
  }

  /** Routing subject for matchOn=package: "/owner/name". */
  packagePath(decodedPath) {
    const p = this.parse(decodedPath);
    return p ? `/${p.name}` : null;
  }

  /** "/owner/name.git/info/refs" -> { name: "owner/name", sub: "/info/refs" } */
  parse(p) {
    let rest = String(p || '').replace(/^\/+/, '');
    let sub = '';
    const m = SERVICE_RE.exec(`/${rest}`);
    if (m) {
      sub = m[1];
      rest = rest.slice(0, rest.length - sub.length);
    }
    const name = rest.replace(/\/+$/, '').replace(/\.git$/, '');
    if (!GitRepo.validName(name)) return null;
    return { name, sub };
  }

  /** Path of the repository on the main host (/git/<name>.git) or, with `direct`, on the git type host (/<name>.git). */
  repoUrlPath(name, { direct = false } = {}) {
    const gitRepo = this.app.stores.settings.get().gitRepo;
    if (this.conf.name !== gitRepo) return `/r/${this.conf.name}/${name}.git`;
    return direct ? `/${name}.git` : `/git/${name}.git`;
  }

  cloneUrl(base, name, opts = {}) {
    return `${base}${this.repoUrlPath(name, opts)}`;
  }

  /** ssh://git@host:port/<name>.git (or git@host:<name>.git on port 22); null when the SSH server is off. */
  sshUrl(base, name) {
    const ssh = this.app.ssh;
    if (!ssh || !ssh.port) return null;
    let host = 'localhost';
    try { host = new URL(base).hostname; } catch { /* keep localhost */ }
    if (this.app.config.sshPublicHost) host = this.app.config.sshPublicHost;
    const gitRepo = this.app.stores.settings.get().gitRepo;
    const p = this.conf.name === gitRepo ? `${name}.git` : `r/${this.conf.name}/${name}.git`;
    const port = ssh.publicPort || ssh.port;
    return Number(port) === 22 ? `git@${host}:${p}` : `ssh://git@${host}:${port}/${p}`;
  }

  // ---------- configuration of a bare repository ----------
  async configure(name) {
    const cwd = this.repoDir(name);
    await gitu.git(['config', 'http.receivepack', 'true'], { cwd });
    await gitu.git(['config', 'http.uploadpack', 'true'], { cwd });
    await gitu.git(['config', 'uploadpack.allowFilter', 'true'], { cwd });
    await gitu.git(['config', 'receive.denyNonFastForwards', this.conf.immutable ? 'true' : 'false'], { cwd });
    await gitu.git(['config', 'receive.denyDeletes', this.conf.immutable ? 'true' : 'false'], { cwd });
    const hook = path.join(cwd, 'hooks', 'pre-receive');
    mkdirp(path.dirname(hook));
    fs.writeFileSync(hook, PRE_RECEIVE, { mode: 0o755 });
    this.writeProtect(name);
    await this.ensureHead(name).catch(() => {});
  }

  writeProtect(name) {
    const m = this.meta(name);
    const patterns = (m.protectedBranches || []).map((b) => (b.startsWith('refs/') ? b : `refs/heads/${b}`));
    if (this.conf.immutable) patterns.push('refs/*');
    writeAtomic(path.join(this.repoDir(name), 'rr-protect'), patterns.join('\n') + (patterns.length ? '\n' : ''));
  }

  /** Re-apply settings after the repository configuration changed (immutable etc.). */
  async reconfigureAll() {
    for (const n of this.names()) await this.configure(n).catch((e) => this.app.log.warn(`git ${n}: ${e.message}`));
  }

  // ---------- management ----------
  async create(name, opts = {}, identity) {
    if (!gitu.gitAvailable()) throw new HttpError(503, 'git is not installed on the server');
    name = this.checkName(name);
    if (name.toLowerCase() === 'new') throw new HttpError(422, '"new" is a reserved name');
    if (this.exists(name)) throw new HttpError(409, `git repository ${name} already exists`);
    checkQuota(this);
    const dir = this.repoDir(name);
    const meta = {
      description: opts.description || '',
      created: new Date().toISOString(),
      createdBy: identity ? identity.name : 'system',
      protectedBranches: Array.isArray(opts.protectedBranches) ? opts.protectedBranches : [],
      pushMirrors: [],
    };
    if (opts.private === true || opts.private === 'true' || opts.visibility === 'private') meta.private = true;
    // a repository without an owner prefix belongs to its creator (owner/name repositories to "owner")
    if (!name.includes('/') && identity && identity.name) meta.owner = identity.name;
    mkdirp(path.dirname(dir));
    try {
      if (opts.importUrl) {
        const { url, auth: urlAuth } = gitu.splitUrl(opts.importUrl);
        const auth = opts.auth || (opts.token ? { username: opts.username, token: opts.token } : urlAuth);
        const args = opts.mirror === false ? ['clone', '--bare', url, dir] : ['clone', '--mirror', url, dir];
        await gitu.git(args, { auth, timeoutMs: 60 * 60 * 1000 }, 502);
        meta.importedFrom = url;
        if (opts.mirror !== false) {
          meta.mirror = {
            url, auth, enabled: true, interval: Number(opts.interval ?? 3600), ttl: Number(opts.ttl ?? 300),
            webhookSecret: crypto.randomBytes(16).toString('hex'), lastSync: new Date().toISOString(), lastError: null, status: 'ok', ruleId: opts.ruleId || null,
          };
        } else {
          await gitu.run(['remote', 'remove', 'origin'], { cwd: dir });
        }
      } else {
        mkdirp(dir);
        await gitu.git(['init', '--bare', '--quiet'], { cwd: dir });
        await gitu.git(['symbolic-ref', 'HEAD', `refs/heads/${opts.defaultBranch || 'main'}`], { cwd: dir });
      }
      this.saveMeta(name, meta);
      if (meta.description) fs.writeFileSync(path.join(dir, 'description'), `${meta.description}\n`);
      await this.configure(name);
      if (!opts.importUrl) {
        const flag = (v) => v === true || v === 'true' || v === 'on';
        await this.initFiles(name, { readme: flag(opts.readme) || flag(opts.autoInit) || flag(opts.auto_init), gitignore: opts.gitignore || opts.gitignore_template || '', license: opts.license || opts.license_template || '', description: meta.description, defaultBranch: opts.defaultBranch || 'main' }, identity);
      }
    } catch (e) {
      rmrf(dir);
      this.pruneParents(dir);
      throw e;
    }
    this.dropRedirect(name);
    invalidate(this);
    this.app.audit(identity, 'git-create', `${this.conf.name}/${name}${opts.importUrl ? ` <- ${gitu.redact(opts.importUrl)}` : ''}`);
    this.app.events.emit('git.create', { repo: this.conf.name, name, mirror: !!meta.mirror, importedFrom: meta.importedFrom || null }, identity);
    return this.info(name);
  }

  async remove(name, identity) {
    name = this.requireRepo(name);
    rmrf(this.repoDir(name));
    this.pruneParents(this.repoDir(name));
    invalidate(this);
    this.app.audit(identity, 'git-delete', `${this.conf.name}/${name}`);
    this.app.events.emit('git.delete', { repo: this.conf.name, name }, identity);
    return { ok: true };
  }

  async refs(name, kind) {
    const out = await gitu.git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(subject)', `refs/${kind}`], { cwd: this.repoDir(name) });
    return out.split('\n').filter(Boolean).map((l) => {
      const [ref, commit, date, ...subject] = l.split('\t');
      return { name: ref, commit, date: date || null, subject: subject.join('\t') };
    });
  }

  summary(name, m = this.meta(name)) {
    return {
      name,
      description: m.description || '',
      private: !!m.private,
      owner: this.ownerOf(name, m),
      mirror: m.mirror ? { url: m.mirror.url, enabled: m.mirror.enabled, lastSync: m.mirror.lastSync, status: m.mirror.status } : null,
      pushMirrors: (m.pushMirrors || []).length,
      created: m.created,
    };
  }

  /** Repositories the caller can see (private ones only for the owner, collaborators and admins). */
  list(q = '', identity = null) {
    const out = [];
    for (const n of this.names()) {
      if (q && !n.toLowerCase().includes(String(q).toLowerCase())) continue;
      const m = this.meta(n);
      const role = this.roleIn(n, identity, m);
      if (!role) continue;
      out.push({ ...this.summary(n, m), permission: role });
    }
    return out;
  }

  listPackages(q = '', identity = null) {
    return this.list(q, identity).map((s) => ({ name: s.name, version: '', description: s.description, modified: s.mirror ? s.mirror.lastSync : s.created }));
  }

  async info(name, base = '', { identity, direct = false } = {}) {
    name = this.requireRepo(name);
    const cwd = this.repoDir(name);
    const head = await this.ensureHead(name);
    const m = this.meta(name);
    const [branches, tags] = await Promise.all([this.refs(name, 'heads'), this.refs(name, 'tags')]);
    const rel = this.loadReleases(name).items;
    const latest = rel.filter((r) => !r.draft && !r.prerelease).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
    const collab = this.loadPulls(name).items;
    const count = branches.length ? Number((await gitu.run(['rev-list', '--count', 'HEAD'], { cwd })).stdout.toString().trim()) || 0 : 0;
    return {
      repo: this.conf.name,
      name,
      description: m.description || '',
      defaultBranch: head || null,
      empty: branches.length === 0,
      branches,
      tags,
      size: dirSize(cwd).bytes,
      cloneUrl: base ? this.cloneUrl(base, name, { direct }) : undefined,
      cloneUrls: base ? { https: this.cloneUrl(base, name, { direct }), ssh: this.sshUrl(base, name) } : undefined,
      private: !!m.private,
      visibility: m.private ? 'private' : 'public',
      owner: this.ownerOf(name, m),
      collaborators: m.collaborators || {},
      permissions: this.permissions(name, identity === undefined ? null : identity, m),
      counts: {
        commits: count,
        branches: branches.length,
        tags: tags.length,
        releases: rel.filter((r) => !r.draft).length,
        openPulls: collab.filter((i) => i.type === 'pull' && i.state === 'open').length,
        openIssues: collab.filter((i) => i.type === 'issue' && i.state === 'open').length,
      },
      latestRelease: latest ? { id: latest.id, tag_name: latest.tag_name, name: latest.name, published_at: latest.published_at } : null,
      created: m.created,
      importedFrom: m.importedFrom || null,
      protectedBranches: m.protectedBranches || [],
      mirror: m.mirror ? { ...m.mirror, auth: mask(m.mirror.auth), webhookUrl: base ? `${base}/-/rr/hooks/git/${this.conf.name}/${name}` : undefined } : null,
      pushMirrors: (m.pushMirrors || []).map((p) => ({ ...p, auth: mask(p.auth) })),
    };
  }

  async update(name, body, identity) {
    name = this.requireRepo(name);
    const cwd = this.repoDir(name);
    const m = this.meta(name);
    if (body.description !== undefined) {
      m.description = String(body.description);
      fs.writeFileSync(path.join(cwd, 'description'), `${m.description}\n`);
    }
    if (body.defaultBranch) {
      if (!/^[A-Za-z0-9._/-]+$/.test(body.defaultBranch)) throw new HttpError(400, 'invalid branch name');
      await gitu.git(['symbolic-ref', 'HEAD', `refs/heads/${body.defaultBranch}`], { cwd });
    }
    if (body.protectedBranches !== undefined) {
      const list = Array.isArray(body.protectedBranches) ? body.protectedBranches : String(body.protectedBranches).split(',');
      m.protectedBranches = list.map((s) => String(s).trim()).filter(Boolean);
    }
    if (body.mirror !== undefined) {
      if (body.mirror === null || body.mirror === false) {
        delete m.mirror;
      } else {
        const cur = m.mirror || { webhookSecret: crypto.randomBytes(16).toString('hex'), lastSync: null, lastError: null, status: 'new' };
        const next = { ...cur };
        if (body.mirror.url) {
          const s = gitu.splitUrl(body.mirror.url);
          next.url = s.url;
          if (s.auth) next.auth = s.auth;
        }
        if (!next.url) throw new HttpError(400, 'mirror.url is required');
        if (body.mirror.token !== undefined) next.auth = body.mirror.token ? { username: body.mirror.username || '', token: body.mirror.token } : null;
        for (const k of ['interval', 'ttl']) if (body.mirror[k] !== undefined) next[k] = Number(body.mirror[k]) || 0;
        if (body.mirror.enabled !== undefined) next.enabled = body.mirror.enabled !== false && body.mirror.enabled !== 'false';
        if (next.enabled === undefined) next.enabled = true;
        if (next.interval === undefined) next.interval = 3600;
        if (next.ttl === undefined) next.ttl = 300;
        m.mirror = next;
        await gitu.run(['remote', 'remove', 'origin'], { cwd });
        await gitu.git(['remote', 'add', '--mirror=fetch', 'origin', next.url], { cwd });
      }
    }
    this.saveMeta(name, m);
    this.writeProtect(name);
    this.app.audit(identity, 'git-update', `${this.conf.name}/${name}`);
    return this.info(name);
  }

  async commits(name, { ref, limit = 30, path: p } = {}) {
    name = this.requireRepo(name);
    if (!ref) await this.ensureHead(name);
    const args = ['log', '--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%P%x09%s', `-n${Math.min(Number(limit) || 30, 500)}`, ref || 'HEAD'];
    if (p) args.push('--', p.replace(/^\/+/, ''));
    const r = await gitu.run(args, { cwd: this.repoDir(name) });
    if (r.code !== 0) return [];
    return r.stdout.toString().split('\n').filter(Boolean).map((l) => {
      const [commit, short, author, email, date, parents, ...subject] = l.split('\t');
      return { commit, short, author, email, date, parents: parents ? parents.split(' ') : [], subject: subject.join('\t') };
    });
  }

  async tree(name, { ref, path: p = '' } = {}) {
    name = this.requireRepo(name);
    if (!ref) await this.ensureHead(name);
    const rel = String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (rel.split('/').includes('..')) throw new HttpError(400, 'invalid path');
    const args = ['ls-tree', '-l', ref || 'HEAD'];
    if (rel) args.push('--', `${rel}/`);
    const r = await gitu.run(args, { cwd: this.repoDir(name) });
    if (r.code !== 0) throw new HttpError(404, `ref or path not found: ${ref || 'HEAD'}:${rel}`);
    const entries = r.stdout.toString().split('\n').filter(Boolean).map((l) => {
      const [meta, file] = l.split('\t');
      const [mode, type, object, size] = meta.split(/\s+/);
      return { name: file.split('/').pop(), path: file, type: type === 'tree' ? 'dir' : type === 'commit' ? 'submodule' : 'file', mode, object, size: size === '-' ? 0 : Number(size) };
    });
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ref: ref || 'HEAD', path: `/${rel}`, entries };
  }

  async blob(name, { ref, path: p }) {
    name = this.requireRepo(name);
    if (!ref) await this.ensureHead(name);
    const rel = String(p || '').replace(/^\/+/, '');
    if (!rel) throw new HttpError(400, 'path is required');
    const r = await gitu.run(['cat-file', 'blob', `${ref || 'HEAD'}:${rel}`], { cwd: this.repoDir(name) });
    if (r.code !== 0) throw new HttpError(404, `file not found: ${ref || 'HEAD'}:${rel}`);
    return r.stdout;
  }

  async archive(name, { ref, format = 'tar.gz' } = {}) {
    name = this.requireRepo(name);
    if (!ref) await this.ensureHead(name);
    if (!['tar.gz', 'tgz', 'zip', 'tar'].includes(format)) throw new HttpError(400, 'format must be tar.gz, zip or tar');
    const base = name.split('/').pop();
    const r = await gitu.run(['archive', `--format=${format === 'tgz' ? 'tar.gz' : format}`, `--prefix=${base}/`, ref || 'HEAD'], { cwd: this.repoDir(name) });
    if (r.code !== 0) throw new HttpError(404, `cannot archive ${ref || 'HEAD'}: ${r.stderr.trim()}`);
    return { data: r.stdout, file: `${base}-${String(ref || 'HEAD').replace(/[^A-Za-z0-9._-]/g, '_')}.${format === 'tgz' ? 'tar.gz' : format}` };
  }

  // ---------- mirrors ----------
  async addPushMirror(name, body, identity) {
    name = this.requireRepo(name);
    const s = gitu.splitUrl(body.url);
    const m = this.meta(name);
    const pm = {
      id: crypto.randomBytes(4).toString('hex'),
      url: s.url,
      auth: body.token ? { username: body.username || '', token: body.token } : s.auth,
      mode: body.mode === 'branches' ? 'branches' : 'mirror',
      createMissing: body.createMissing === true || body.createMissing === 'true',
      private: body.private !== false && body.private !== 'false',
      enabled: body.enabled !== false && body.enabled !== 'false',
      lastPush: null,
      lastError: null,
      status: 'new',
    };
    m.pushMirrors = [...(m.pushMirrors || []), pm];
    this.saveMeta(name, m);
    this.app.audit(identity, 'git-push-mirror-add', `${this.conf.name}/${name} -> ${pm.url}`);
    return { ...pm, auth: mask(pm.auth) };
  }

  removePushMirror(name, id, identity) {
    name = this.requireRepo(name);
    const m = this.meta(name);
    const before = (m.pushMirrors || []).length;
    m.pushMirrors = (m.pushMirrors || []).filter((p) => p.id !== id);
    if (m.pushMirrors.length === before) throw new HttpError(404, `push mirror ${id} not found`);
    this.saveMeta(name, m);
    this.app.audit(identity, 'git-push-mirror-delete', `${this.conf.name}/${name} ${id}`);
    return { ok: true };
  }

  /** Push the repository to a remote (used by push mirrors and by routing "push" rules). */
  async pushTo(name, { url, auth, mode = 'mirror', createMissing = false, private: priv = true }) {
    const cwd = this.repoDir(name);
    const gh = gitu.parseGithub(url);
    if (createMissing && gh && auth && (auth.token || auth.password)) {
      await gitu.githubEnsureRepo({ owner: gh.owner, repo: gh.repo, token: auth.token || auth.password, private: priv, description: this.meta(name).description || '' });
    }
    const args = mode === 'branches' ? ['push', '--porcelain', '--force', url, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'] : ['push', '--porcelain', '--mirror', url];
    const r = await gitu.run(args, { cwd, auth, timeoutMs: 60 * 60 * 1000 });
    if (r.code !== 0) throw new HttpError(502, `push to ${gitu.redact(url)} failed: ${r.stderr.trim().split('\n').slice(-2).join(' | ')}`);
    return { url: gitu.redact(url), output: r.stdout.toString().trim().split('\n').slice(-20) };
  }

  /** Synchronize mirrors: direction "pull" (from the pull mirror), "push" (to push mirrors) or "both". */
  async sync(name, direction = 'both', identity = null) {
    name = this.requireRepo(name);
    const key = `${name}:${direction}`;
    if (this.syncing.has(key)) return this.syncing.get(key);
    const p = this.doSync(name, direction, identity).finally(() => this.syncing.delete(key));
    this.syncing.set(key, p);
    return p;
  }

  async doSync(name, direction, identity) {
    const result = { name, pull: null, push: [] };
    const cwd = this.repoDir(name);
    if (direction === 'pull' || direction === 'both') {
      const m = this.meta(name);
      if (m.mirror && m.mirror.url) {
        const before = await this.refSnapshot(name);
        const r = await gitu.run(['fetch', '--prune', '--prune-tags', '--force', m.mirror.url, '+refs/*:refs/*'], { cwd, auth: m.mirror.auth, timeoutMs: 60 * 60 * 1000 });
        const m2 = this.meta(name);
        m2.mirror.lastSync = new Date().toISOString();
        m2.mirror.status = r.code === 0 ? 'ok' : 'error';
        m2.mirror.lastError = r.code === 0 ? null : r.stderr.trim().split('\n').slice(-2).join(' | ');
        this.saveMeta(name, m2);
        const changes = r.code === 0 ? this.diffRefs(before, await this.refSnapshot(name)) : [];
        result.pull = { ok: r.code === 0, error: m2.mirror.lastError, changes };
        invalidate(this);
        this.app.events.emit('git.sync', { repo: this.conf.name, name, direction: 'pull', ok: r.code === 0, error: m2.mirror.lastError, changes }, identity);
      }
    }
    if (direction === 'push' || direction === 'both') {
      const m = this.meta(name);
      for (const pm of m.pushMirrors || []) {
        if (!pm.enabled) continue;
        let ok = true;
        let error = null;
        try { await this.pushTo(name, pm); } catch (e) { ok = false; error = e.message; }
        const m2 = this.meta(name);
        const cur = (m2.pushMirrors || []).find((x) => x.id === pm.id);
        if (cur) {
          cur.lastPush = new Date().toISOString();
          cur.status = ok ? 'ok' : 'error';
          cur.lastError = error;
          this.saveMeta(name, m2);
        }
        result.push.push({ id: pm.id, url: pm.url, ok, error });
      }
    }
    return result;
  }

  /** Pull mirrors whose `interval` elapsed (called by the scheduler). */
  async syncDue() {
    const done = [];
    for (const n of this.names()) {
      const m = this.meta(n).mirror;
      if (!m || !m.enabled || !m.interval) continue;
      if (m.lastSync && Date.now() - Date.parse(m.lastSync) < m.interval * 1000) continue;
      const r = await this.sync(n, 'pull').catch((e) => ({ error: e.message }));
      done.push({ name: n, ok: !!(r.pull && r.pull.ok), error: r.error || (r.pull && r.pull.error) });
    }
    return done;
  }

  async refSnapshot(name) {
    const r = await gitu.run(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: this.repoDir(name) });
    const map = {};
    for (const l of r.stdout.toString().split('\n').filter(Boolean)) {
      const [obj, ref] = l.split(' ');
      map[ref] = obj;
    }
    return map;
  }

  diffRefs(before, after) {
    const out = [];
    for (const ref of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[ref] === after[ref]) continue;
      out.push({ ref, before: before[ref] || null, after: after[ref] || null, type: !before[ref] ? 'create' : !after[ref] ? 'delete' : 'update' });
    }
    return out;
  }

  /** Incoming webhook (GitHub / GitLab / generic) -> refresh the pull mirror. */
  async webhook(name, req, body) {
    name = this.requireRepo(name);
    const m = this.meta(name).mirror;
    if (!m) throw new HttpError(400, 'repository is not a pull mirror');
    const sig = req.headers['x-hub-signature-256'];
    const gitlab = req.headers['x-gitlab-token'];
    const plain = new URL(req.url, 'http://x').searchParams.get('secret');
    let ok = false;
    if (sig) {
      const expected = `sha256=${crypto.createHmac('sha256', m.webhookSecret).update(body).digest('hex')}`;
      ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } else if (gitlab) ok = gitlab === m.webhookSecret;
    else if (plain) ok = plain === m.webhookSecret;
    if (!ok) throw new HttpError(403, 'invalid webhook signature');
    if (req.headers['x-github-event'] === 'ping') return { ok: true, ping: true };
    this.sync(name, 'pull').catch((e) => this.app.log.warn(`mirror sync ${name}: ${e.message}`));
    return { ok: true, queued: true };
  }

  // ---------- cleanup ----------
  async cleanup(policy = {}, { dryRun = false } = {}) {
    const actions = [];
    for (const n of this.names()) {
      actions.push({ action: 'gc', target: n });
      if (!dryRun) await gitu.run(['gc', '--auto', '--quiet'], { cwd: this.repoDir(n) });
    }
    invalidate(this);
    return { actions, freedBytes: 0 };
  }

  // ---------- git smart HTTP ----------
  async handle(ctx) {
    const { req, res } = ctx;
    const parsed = this.parse(ctx.path);
    if (!parsed) throw new NotFoundLocal('not a git repository path');
    let { name, sub } = parsed;
    // moved / renamed repository: the old URL keeps working
    if (!this.exists(name)) {
      const red = this.resolveRedirect(name);
      if (red) {
        const target = red.repo === this.conf.name ? this : this.app.repoConfig(red.repo) && this.app.repoHandler(red.repo);
        if (target && target.conf.type === 'git' && target.exists(red.name)) {
          if (target !== this) return target.handle({ ...ctx, path: `/${red.name}.git${sub}` });
          name = red.name;
        }
      }
    }
    if (!sub) {
      // browsing the repository URL in a web browser -> the administration
      if (/text\/html/.test(req.headers.accept || '') && this.exists(name)) {
        const direct = ctx.req._typeHostType === 'git';
        const where = direct ? `/${name.split('/').map(encodeURIComponent).join('/')}` : `/admin/#/git/${encodeURIComponent(this.conf.name)}/${name.split('/').map(encodeURIComponent).join('/')}`;
        return send(res, 302, null, { location: where });
      }
      throw this.exists(name) ? new HttpError(400, 'use git clone with this URL') : new NotFoundLocal(`git repository ${name} not found`);
    }
    if (!gitu.gitAvailable()) throw new HttpError(503, 'git is not installed on the server');
    const q = new URLSearchParams(ctx.search);
    const service = sub === '/info/refs' ? q.get('service') : sub === '/git-receive-pack' ? 'git-receive-pack' : sub === '/git-upload-pack' ? 'git-upload-pack' : null;
    const write = service === 'git-receive-pack';
    res.setHeader('www-authenticate', 'Basic realm="rr-registry git"');
    let identity;
    if (write) {
      identity = this.app.auth.require(req, 'publish', this.conf);
      if (this.conf.allowPublish === false) throw new HttpError(403, `pushing to repository ${this.conf.name} is disabled`);
    } else {
      identity = this.app.auth.require(req, 'read', this.conf);
    }

    if (!this.exists(name)) {
      if (write && sub === '/info/refs' && this.conf.autoCreate !== false && name.toLowerCase() !== 'new') {
        // auto-created repositories of another owner ("bob/x" pushed by alice) need publish rights only
        await this.create(name, {}, identity);
      } else {
        throw new NotFoundLocal(`git repository ${name} not found`);
      }
    }
    // repository level: private repositories, owners and collaborators
    this.access(name, identity, write ? 'write' : 'read');
    res.removeHeader('www-authenticate');
    const meta = this.meta(name);
    if (write && meta.mirror) throw new HttpError(403, `${name} is a read-only mirror of ${meta.mirror.url}`);
    if (write) checkQuota(this);
    // pull-through mirror: refresh a stale copy before serving refs
    if (!write && sub === '/info/refs' && meta.mirror && meta.mirror.enabled && meta.mirror.ttl
        && (!meta.mirror.lastSync || Date.now() - Date.parse(meta.mirror.lastSync) > meta.mirror.ttl * 1000)) {
      await this.sync(name, 'pull').catch((e) => this.app.log.warn(`mirror refresh ${name}: ${e.message}`));
    }
    const before = write && sub === '/git-receive-pack' ? await this.refSnapshot(name) : null;
    const code = await this.backend(ctx, name, sub, identity, write);
    if (sub === '/git-upload-pack') this.app.statsStore.hit(this.conf.name, name);
    if (before && code === 0) await this.afterRefChange(name, before, identity, ctx.rootBase, 'push');
  }

  /** Run `git http-backend` as CGI, streaming request and response. Resolves with the exit code. */
  backend(ctx, name, sub, identity, write) {
    const { req, res } = ctx;
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        GIT_PROJECT_ROOT: this.dir,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${name}.git${sub}`,
        REQUEST_METHOD: req.method,
        QUERY_STRING: (ctx.search || '').replace(/^\?/, ''),
        CONTENT_TYPE: req.headers['content-type'] || '',
        REMOTE_ADDR: req.socket.remoteAddress || '',
        GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
      };
      if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
      if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
      if (req.headers['git-protocol']) env.HTTP_GIT_PROTOCOL = req.headers['git-protocol'];
      if (write && identity) env.REMOTE_USER = identity.name;
      else delete env.REMOTE_USER;
      const child = spawn('git', ['http-backend'], { env });
      let head = Buffer.alloc(0);
      let headersDone = false;
      let stderr = '';
      child.stderr.on('data', (c) => { if (stderr.length < 8192) stderr += c; });
      child.stdout.on('data', (chunk) => {
        if (headersDone) { res.write(chunk); return; }
        head = Buffer.concat([head, chunk]);
        let idx = head.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (idx < 0) { idx = head.indexOf('\n\n'); sepLen = 2; }
        if (idx < 0) return;
        const lines = head.subarray(0, idx).toString('latin1').split(/\r?\n/);
        let status = 200;
        const headers = {};
        for (const l of lines) {
          const i = l.indexOf(':');
          if (i < 0) continue;
          const k = l.slice(0, i).trim();
          const v = l.slice(i + 1).trim();
          if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
          else headers[k] = v;
        }
        headersDone = true;
        res.writeHead(status, headers);
        const rest = head.subarray(idx + sepLen);
        if (rest.length) res.write(rest);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (!headersDone) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(`git http-backend failed: ${stderr}`);
        } else res.end();
        if (code !== 0 && stderr) this.app.log.warn(`git http-backend ${name}${sub}: ${stderr.trim()}`);
        resolve(code);
      });
      req.pipe(child.stdin);
      child.stdin.on('error', () => {});
    });
  }
}

Object.assign(GitRepo.prototype, pullsMixin, manageMixin);

module.exports = { GitRepo };

'use strict';
// Management of git repositories, mixed into GitRepo:
//   access      visibility (public / private), owner and collaborators - GitHub-like permissions
//   HEAD        repair of a default branch that does not exist (first push of "master" into "main")
//   move        rename / move to another git repository (old names keep working through redirects)
//   branches    list (ahead / behind the default branch), create, rename, delete, default
//   tags        list (annotated / lightweight), create, delete
//   releases    GitHub-compatible releases with assets       <repo>.git/rr-releases.json, rr-assets/<id>/
//   contents    create / update / delete files and multi-file commits without a working tree
//   commit      detail of one commit with per-file statistics and patches
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HttpError } = require('../util/http');
const { mkdirp, writeAtomic, readJsonFile, rmrf } = require('../util/store');
const gitu = require('../util/git');
const { checkQuota, invalidate, assertMutable } = require('../policies');
const { GITIGNORE, licenseText } = require('./git-templates');

const ZERO = '0000000000000000000000000000000000000000';
const LEVEL = { read: 1, write: 2, admin: 3 };
const ROLES = ['read', 'write', 'admin'];
const fail = (status, message) => new HttpError(status, message, { message });
const now = () => new Date().toISOString();
const MAX_PATCH = 2 * 1024 * 1024;

/** Validate a path inside the repository ("docs/a.md"). */
function cleanPath(p) {
  const rel = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (!rel) throw fail(422, 'path is required');
  if (rel.split('/').some((s) => s === '..' || s === '.' || s === '.git' || s === '')) throw fail(422, `invalid path: ${p}`);
  if (/[\0\n\r]/.test(rel)) throw fail(422, 'invalid characters in path');
  return rel;
}

const manageMixin = {
  // ================================================================ access
  ownerOf(name, m = this.meta(name)) {
    if (m.owner) return m.owner;
    if (name.includes('/')) return name.split('/')[0];
    return m.createdBy && m.createdBy !== 'system' ? m.createdBy : null;
  },

  /** Permission of a caller in one git repository: 'admin' | 'write' | 'read' | null (no access). */
  roleIn(name, identity, m = this.meta(name)) {
    const auth = this.app.auth;
    if (!identity) return !m.private && auth.can(null, 'read', this.conf) ? 'read' : null;
    if (identity.role === 'admin' && !identity.readonly) return 'admin';
    const collab = m.collaborators && Object.prototype.hasOwnProperty.call(m.collaborators, identity.name) ? m.collaborators[identity.name] : null;
    const owner = this.ownerOf(name, m) === identity.name;
    let role = null;
    if (owner) role = auth.can(identity, 'publish', this.conf) ? 'admin' : 'read';
    if (collab && (!role || LEVEL[collab] > LEVEL[role])) role = collab;
    if (!role && !m.private) role = auth.can(identity, 'publish', this.conf) ? 'write' : auth.can(identity, 'read', this.conf) ? 'read' : null;
    if (role && identity.readonly) role = 'read';
    if (identity.role === 'admin') role = role || 'read';
    return role;
  },

  /**
   * Check the caller may `need` (read | write | admin) in the repository; returns the canonical name.
   * A private repository the caller cannot see answers 404 (401 for anonymous callers, so git asks for credentials).
   */
  access(name, identity, need = 'read') {
    name = this.requireRepo(name);
    const m = this.meta(name);
    const role = this.roleIn(name, identity, m);
    if (!role) {
      if (!identity) throw new HttpError(401, 'authentication required');
      throw new HttpError(404, `git repository ${name} not found in ${this.conf.name}`);
    }
    if (LEVEL[role] < LEVEL[need]) throw new HttpError(403, `forbidden: ${need} permission required in ${name}`);
    return name;
  },

  permissions(name, identity, m = this.meta(name)) {
    const role = this.roleIn(name, identity, m);
    return { role, read: !!role, write: LEVEL[role] >= 2, admin: LEVEL[role] >= 3 };
  },

  /** Visibility, owner and collaborators (admin of the repository). */
  async setAccess(name, body = {}, identity = null) {
    name = this.requireRepo(name);
    const m = this.meta(name);
    if (body.private !== undefined) m.private = body.private === true || body.private === 'true' || body.visibility === 'private';
    if (body.visibility !== undefined) m.private = body.visibility === 'private';
    if (body.owner !== undefined) {
      const o = String(body.owner || '').trim();
      if (o && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(o)) throw fail(422, 'invalid owner');
      if (o) m.owner = o; else delete m.owner;
    }
    if (body.collaborators !== undefined) {
      const c = body.collaborators || {};
      if (typeof c !== 'object' || Array.isArray(c)) throw fail(422, 'collaborators must be an object {user: read|write|admin}');
      const out = {};
      for (const [u, r] of Object.entries(c)) {
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(u)) throw fail(422, `invalid user name ${u}`);
        if (!ROLES.includes(r)) throw fail(422, `invalid role ${r} for ${u} (read, write, admin)`);
        out[u] = r;
      }
      m.collaborators = out;
    }
    this.saveMeta(name, m);
    this.app.audit(identity, 'git-access', `${this.conf.name}/${name} ${m.private ? 'private' : 'public'}`);
    return { private: !!m.private, owner: this.ownerOf(name, m), collaborators: m.collaborators || {} };
  },

  // ================================================================ HEAD / default branch
  async headName(name) {
    return (await gitu.run(['symbolic-ref', '--short', 'HEAD'], { cwd: this.repoDir(name) })).stdout.toString().trim();
  },

  /**
   * HEAD must point at an existing branch, otherwise every "default branch" view fails. A repository created
   * with HEAD -> main that received only "master" (or any other branch) gets HEAD moved to an existing branch.
   */
  async ensureHead(name) {
    const cwd = this.repoDir(name);
    const head = await this.headName(name);
    if (head && (await gitu.run(['show-ref', '--verify', '-q', `refs/heads/${head}`], { cwd })).code === 0) return head;
    const out = (await gitu.run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'], { cwd })).stdout.toString();
    const list = out.split('\n').filter(Boolean);
    if (!list.length) return head || null;
    const pick = ['main', 'master', 'trunk', 'develop'].find((b) => list.includes(b)) || list[0];
    await gitu.git(['symbolic-ref', 'HEAD', `refs/heads/${pick}`], { cwd });
    this.app.log.info(`git ${this.conf.name}/${name}: default branch ${head || '(none)'} does not exist - HEAD now ${pick}`);
    return pick;
  },

  /** After refs changed (push over HTTP / SSH, web commit, branch or tag operations). */
  async afterRefChange(name, before, identity, base = '', how = 'push') {
    const changes = this.diffRefs(before, await this.refSnapshot(name));
    if (!changes.length) return changes;
    await this.ensureHead(name).catch(() => {});
    invalidate(this);
    this.app.audit(identity, `git-${how}`, `${this.conf.name}/${name} ${changes.map((c) => c.ref.replace(/^refs\/(heads|tags)\//, '')).join(',')}`);
    this.app.events.emit('git.push', { repo: this.conf.name, name, changes, via: how, cloneUrl: base ? this.cloneUrl(base, name) : undefined }, identity);
    if ((this.meta(name).pushMirrors || []).some((p) => p.enabled)) {
      this.sync(name, 'push', identity).catch((e) => this.app.log.warn(`push mirror ${name}: ${e.message}`));
    }
    return changes;
  },

  // ================================================================ move / rename
  redirectsFile() {
    return path.join(this.dir, '.rr-redirects.json');
  },

  redirects() {
    return readJsonFile(this.redirectsFile(), {});
  },

  /** New location of a moved repository: { repo, name } or null. */
  resolveRedirect(name) {
    const r = this.redirects()[String(name || '').replace(/\.git$/, '')];
    return r || null;
  },

  pruneParents(dir) {
    let d = path.dirname(dir);
    while (d.startsWith(this.dir) && d !== this.dir) {
      try { if (fs.readdirSync(d).length) break; fs.rmdirSync(d); } catch { break; }
      d = path.dirname(d);
    }
  },

  /** Rename and/or move to another git repository: { name: newName, repo: targetRepository }. */
  async move(name, body = {}, identity = null) {
    name = this.requireRepo(name);
    assertMutable(this.conf, 'moving git repositories');
    const target = body.repo && body.repo !== this.conf.name ? this.app.repoHandler(body.repo) : this;
    if (target.conf.type !== 'git') throw fail(422, `${body.repo} is not a git repository`);
    if (target !== this) {
      assertMutable(target.conf, 'moving git repositories');
      if (identity && !this.app.auth.can(identity, 'publish', target.conf)) throw new HttpError(403, `forbidden: publish permission required on ${target.conf.name}`);
    }
    const newName = target.checkName(body.name || name);
    if (target === this && newName === name) throw fail(422, 'nothing to change: same name and repository');
    if (newName.toLowerCase() === 'new') throw fail(422, '"new" is a reserved name');
    if (target.exists(newName)) throw fail(409, `git repository ${newName} already exists in ${target.conf.name}`);
    if (target !== this) checkQuota(target);
    const from = this.repoDir(name);
    const to = target.repoDir(newName);
    mkdirp(path.dirname(to));
    fs.renameSync(from, to);
    this.pruneParents(from);
    // old URLs keep working (git clone / fetch / push and the web UI) until the name is reused
    const red = this.redirects();
    for (const [k, v] of Object.entries(red)) if (v.repo === this.conf.name && v.name === name) red[k] = { repo: target.conf.name, name: newName };
    red[name] = { repo: target.conf.name, name: newName, moved: now() };
    writeAtomic(this.redirectsFile(), JSON.stringify(red, null, 2));
    if (target !== this) {
      const tr = target.redirects();
      if (tr[newName]) { delete tr[newName]; writeAtomic(target.redirectsFile(), JSON.stringify(tr, null, 2)); }
    }
    await target.configure(newName);
    invalidate(this);
    if (target !== this) invalidate(target);
    this.app.audit(identity, 'git-move', `${this.conf.name}/${name} -> ${target.conf.name}/${newName}`);
    this.app.events.emit('git.move', { repo: this.conf.name, name, toRepo: target.conf.name, toName: newName }, identity);
    return target.info(newName);
  },

  /** A new repository under a moved name replaces the redirect. */
  dropRedirect(name) {
    const red = this.redirects();
    if (red[name]) { delete red[name]; writeAtomic(this.redirectsFile(), JSON.stringify(red, null, 2)); }
  },

  // ================================================================ branches
  async checkRefName(kind, ref) {
    const r = String(ref || '').trim();
    if (!r || r.length > 200) throw fail(422, `${kind} name is required`);
    const full = kind === 'branch' ? `refs/heads/${r}` : `refs/tags/${r}`;
    const ok = await gitu.run(['check-ref-format', full]);
    if (ok.code !== 0 || r.startsWith('-') || r === 'HEAD') throw fail(422, `invalid ${kind} name: ${r}`);
    return r;
  },

  async resolveCommit(name, ref) {
    const r = await gitu.run(['rev-parse', '--verify', '-q', `${ref || 'HEAD'}^{commit}`], { cwd: this.repoDir(name) });
    const sha = r.stdout.toString().trim();
    if (r.code !== 0 || !sha) throw fail(422, `ref not found: ${ref}`);
    return sha;
  },

  async refExists(name, full) {
    return (await gitu.run(['show-ref', '--verify', '-q', full], { cwd: this.repoDir(name) })).code === 0;
  },

  /** Branches with the last commit, ahead/behind the default branch and protection. */
  async branchList(name) {
    name = this.requireRepo(name);
    const cwd = this.repoDir(name);
    const head = await this.ensureHead(name);
    const meta = this.meta(name);
    const out = (await gitu.run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)%09%(authorname)%09%(subject)', 'refs/heads'], { cwd })).stdout.toString();
    const list = out.split('\n').filter(Boolean).map((l) => {
      const [b, sha, date, author, ...subject] = l.split('\t');
      return { name: b, commit: sha, date, author, subject: subject.join('\t'), default: b === head, protected: this.isProtected(name, b, meta), ahead: 0, behind: 0 };
    });
    await Promise.all(list.slice(0, 200).map(async (b) => {
      if (b.default || !head) return;
      const r = await gitu.run(['rev-list', '--left-right', '--count', `${head}...${b.name}`], { cwd });
      const [behind, ahead] = r.stdout.toString().trim().split(/\s+/).map(Number);
      if (r.code === 0) { b.ahead = ahead || 0; b.behind = behind || 0; }
    }));
    return list;
  },

  async createBranch(name, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const branch = await this.checkRefName('branch', body.name || body.branch);
    if (await this.refExists(name, `refs/heads/${branch}`)) throw fail(409, `branch ${branch} already exists`);
    const sha = await this.resolveCommit(name, body.from || body.sha || 'HEAD');
    const before = await this.refSnapshot(name);
    await gitu.git(['update-ref', `refs/heads/${branch}`, sha, ZERO], { cwd: this.repoDir(name) });
    await this.afterRefChange(name, before, identity, base, 'branch-create');
    return { name: branch, commit: sha };
  },

  async deleteBranch(name, branch, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const head = await this.headName(name);
    if (branch === head) throw fail(409, `${branch} is the default branch - choose another default branch first`);
    if (this.isProtected(name, branch)) throw fail(403, `branch ${branch} is protected`);
    if (!(await this.refExists(name, `refs/heads/${branch}`))) throw fail(404, `branch ${branch} not found`);
    const before = await this.refSnapshot(name);
    await gitu.git(['update-ref', '-d', `refs/heads/${branch}`], { cwd: this.repoDir(name) });
    await this.afterRefChange(name, before, identity, base, 'branch-delete');
    return { ok: true };
  },

  /** Rename a branch: the default branch, protection rules and open pull requests follow. */
  async renameBranch(name, branch, newBranch, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const to = await this.checkRefName('branch', newBranch);
    if (to === branch) return { name: to };
    if (this.isProtected(name, branch)) throw fail(403, `branch ${branch} is protected`);
    if (!(await this.refExists(name, `refs/heads/${branch}`))) throw fail(404, `branch ${branch} not found`);
    if (await this.refExists(name, `refs/heads/${to}`)) throw fail(409, `branch ${to} already exists`);
    const cwd = this.repoDir(name);
    const sha = await this.resolveCommit(name, `refs/heads/${branch}`);
    const head = await this.headName(name);
    const before = await this.refSnapshot(name);
    await gitu.git(['update-ref', `refs/heads/${to}`, sha, ZERO], { cwd });
    if (head === branch) await gitu.git(['symbolic-ref', 'HEAD', `refs/heads/${to}`], { cwd });
    await gitu.git(['update-ref', '-d', `refs/heads/${branch}`], { cwd });
    const m = this.meta(name);
    if ((m.protectedBranches || []).includes(branch)) { m.protectedBranches = m.protectedBranches.map((b) => (b === branch ? to : b)); this.saveMeta(name, m); this.writeProtect(name); }
    await this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      let changed = false;
      for (const it of db.items) {
        if (it.type !== 'pull' || it.merged) continue;
        for (const side of ['head', 'base']) if (it[side] && it[side].ref === branch) { it[side].ref = to; changed = true; }
      }
      if (changed) this.savePulls(name, db);
    });
    await this.afterRefChange(name, before, identity, base, 'branch-rename');
    return { name: to, commit: sha, default: head === branch };
  },

  assertWritable(name) {
    if (this.conf.allowPublish === false) throw fail(403, `pushing to repository ${this.conf.name} is disabled`);
    const m = this.meta(name);
    if (m.mirror) throw fail(403, `${name} is a read-only mirror of ${m.mirror.url}`);
  },

  // ================================================================ tags
  async tagList(name) {
    name = this.requireRepo(name);
    const fmt = '%(refname:short)%09%(objectname)%09%(*objectname)%09%(objecttype)%09%(taggername)%09%(taggerdate:iso-strict)%09%(creatordate:iso-strict)%09%(contents:subject)';
    const out = (await gitu.run(['for-each-ref', '--sort=-creatordate', `--format=${fmt}`, 'refs/tags'], { cwd: this.repoDir(name) })).stdout.toString();
    return out.split('\n').filter(Boolean).map((l) => {
      const [tag, obj, peeled, type, tagger, taggerDate, date, ...subject] = l.split('\t');
      const annotated = type === 'tag';
      return { name: tag, commit: annotated ? peeled : obj, object: obj, annotated, tagger: annotated ? tagger : null, date: taggerDate || date || null, message: annotated ? subject.join('\t') : '' };
    });
  },

  committerEnv(identity) {
    const n = identity ? identity.name : 'anonymous';
    return {
      GIT_AUTHOR_NAME: n, GIT_AUTHOR_EMAIL: this.userEmail(identity),
      GIT_COMMITTER_NAME: this.app.config.gitCommitterName || 'RR Registry', GIT_COMMITTER_EMAIL: this.app.config.gitCommitterEmail || 'rr@localhost',
    };
  },

  async createTag(name, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const tag = await this.checkRefName('tag', body.tag || body.name);
    if (await this.refExists(name, `refs/tags/${tag}`)) throw fail(409, `tag ${tag} already exists`);
    const sha = await this.resolveCommit(name, body.ref || body.object || body.sha || 'HEAD');
    const cwd = this.repoDir(name);
    const before = await this.refSnapshot(name);
    const message = String(body.message || '').trim();
    if (message) {
      const env = this.committerEnv(identity);
      await gitu.git(['tag', '-a', tag, sha, '-F', '-'], { cwd, input: message + '\n', env: { ...env, GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL } });
    } else {
      await gitu.git(['update-ref', `refs/tags/${tag}`, sha, ZERO], { cwd });
    }
    await this.afterRefChange(name, before, identity, base, 'tag-create');
    return (await this.tagList(name)).find((t) => t.name === tag);
  },

  async deleteTag(name, tag, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    if (this.conf.immutable) throw fail(403, `repository ${this.conf.name} is immutable`);
    if (!(await this.refExists(name, `refs/tags/${tag}`))) throw fail(404, `tag ${tag} not found`);
    const before = await this.refSnapshot(name);
    await gitu.git(['update-ref', '-d', `refs/tags/${tag}`], { cwd: this.repoDir(name) });
    await this.afterRefChange(name, before, identity, base, 'tag-delete');
    return { ok: true };
  },

  // ================================================================ releases
  releasesFile(name) {
    return path.join(this.repoDir(name), 'rr-releases.json');
  },

  loadReleases(name) {
    const db = readJsonFile(this.releasesFile(name), null) || {};
    return { seq: db.seq || 0, assetSeq: db.assetSeq || 0, items: Array.isArray(db.items) ? db.items : [] };
  },

  saveReleases(name, db) {
    writeAtomic(this.releasesFile(name), JSON.stringify(db, null, 2) + '\n');
  },

  assetDir(name, id) {
    return path.join(this.repoDir(name), 'rr-assets', String(Number(id)));
  },

  apiBase(base, name) {
    return `${base || ''}/api/v1/repos/${encodeURIComponent(this.conf.name)}/git/${encodeURIComponent(name)}`;
  },

  releaseView(r, base, name) {
    const api = this.apiBase(base, name);
    return {
      id: r.id,
      tag_name: r.tag_name,
      target_commitish: r.target_commitish,
      name: r.name,
      body: r.body,
      draft: !!r.draft,
      prerelease: !!r.prerelease,
      created_at: r.created_at,
      published_at: r.draft ? null : r.published_at,
      author: r.author || { login: 'anonymous' },
      assets: (r.assets || []).map((a) => this.assetView(a, base, name)),
      html_url: `${base || ''}/admin/#/git/${encodeURIComponent(this.conf.name)}/${name.split('/').map(encodeURIComponent).join('/')}/releases/tag/${encodeURIComponent(r.tag_name)}`,
      tarball_url: `${api}/archive?ref=${encodeURIComponent(r.tag_name)}&format=tar.gz`,
      zipball_url: `${api}/archive?ref=${encodeURIComponent(r.tag_name)}&format=zip`,
      upload_url: `${api}/releases/${r.id}/assets{?name,label}`,
    };
  },

  assetView(a, base, name) {
    return {
      id: a.id, name: a.name, label: a.label || '', content_type: a.content_type, size: a.size, download_count: a.download_count || 0,
      created_at: a.created_at, uploader: a.uploader || { login: 'anonymous' }, state: 'uploaded',
      browser_download_url: `${this.apiBase(base, name)}/releases/assets/${a.id}/download`,
    };
  },

  findRelease(db, key, { tag } = {}) {
    let r = null;
    if (tag !== undefined) r = db.items.find((x) => x.tag_name === tag);
    else if (key === 'latest') r = db.items.filter((x) => !x.draft && !x.prerelease).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
    else r = db.items.find((x) => x.id === Number(key));
    if (!r) throw fail(404, tag !== undefined ? `release for tag ${tag} not found` : `release ${key} not found`);
    return r;
  },

  async listReleases(name, { includeDrafts = false } = {}, base = '') {
    name = this.requireRepo(name);
    return this.loadReleases(name).items
      .filter((r) => includeDrafts || !r.draft)
      .sort((a, b) => String(b.published_at || b.created_at).localeCompare(String(a.published_at || a.created_at)))
      .map((r) => this.releaseView(r, base, name));
  },

  async getRelease(name, key, { includeDrafts = false, tag } = {}, base = '') {
    name = this.requireRepo(name);
    const r = this.findRelease(this.loadReleases(name), key, { tag });
    if (r.draft && !includeDrafts) throw fail(404, `release ${key} not found`);
    return this.releaseView(r, base, name);
  },

  /** Release notes: commits since the previous tag. */
  async releaseNotes(name, tag, target) {
    const cwd = this.repoDir(name);
    const ref = (await this.refExists(name, `refs/tags/${tag}`)) ? `refs/tags/${tag}` : target || 'HEAD';
    const prev = await gitu.run(['describe', '--tags', '--abbrev=0', `${ref}^`], { cwd });
    const range = prev.code === 0 ? `${prev.stdout.toString().trim()}..${ref}` : ref;
    const log = await gitu.run(['log', '--no-merges', '-n200', '--format=- %s (%h, %an)', range], { cwd });
    const lines = log.stdout.toString().trim();
    return `## Co je nového\n\n${lines || '- (žádné commity)'}\n${prev.code === 0 ? `\n**Všechny změny**: ${prev.stdout.toString().trim()}...${tag}\n` : ''}`;
  },

  async createRelease(name, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const tag = await this.checkRefName('tag', body.tag_name);
    const draft = body.draft === true || body.draft === 'true';
    const target = String(body.target_commitish || '').trim() || (await this.ensureHead(name)) || 'HEAD';
    const tagExists = await this.refExists(name, `refs/tags/${tag}`);
    if (!tagExists) await this.resolveCommit(name, target);
    let notes = body.body == null ? '' : String(body.body);
    if (body.generate_release_notes === true || body.generate_release_notes === 'true') notes = `${notes ? `${notes}\n\n` : ''}${await this.releaseNotes(name, tag, target)}`;
    const rel = await this.withPullLock(`${name}#releases`, async () => {
      const db = this.loadReleases(name);
      if (db.items.some((r) => r.tag_name === tag)) throw fail(422, `release for tag ${tag} already exists`);
      if (!tagExists && !draft) await this.createTag(name, { tag, ref: target }, identity, base);
      const t = now();
      const r = {
        id: ++db.seq, tag_name: tag, target_commitish: target, name: String(body.name || tag), body: notes,
        draft, prerelease: body.prerelease === true || body.prerelease === 'true', created_at: t, published_at: draft ? null : t,
        author: { login: identity ? identity.name : 'anonymous' }, assets: [],
      };
      db.items.push(r);
      this.saveReleases(name, db);
      return r;
    });
    this.app.audit(identity, 'git-release-create', `${this.conf.name}/${name} ${tag}`);
    this.app.events.emit('git.release', { repo: this.conf.name, name, action: draft ? 'created' : 'published', tag, id: rel.id }, identity);
    return this.releaseView(rel, base, name);
  },

  async updateRelease(name, id, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    let published = false;
    const rel = await this.withPullLock(`${name}#releases`, async () => {
      const db = this.loadReleases(name);
      const r = this.findRelease(db, id);
      if (body.tag_name !== undefined && body.tag_name !== r.tag_name) {
        const tag = await this.checkRefName('tag', body.tag_name);
        if (db.items.some((x) => x !== r && x.tag_name === tag)) throw fail(422, `release for tag ${tag} already exists`);
        r.tag_name = tag;
      }
      if (body.target_commitish !== undefined && String(body.target_commitish).trim()) r.target_commitish = String(body.target_commitish).trim();
      if (body.name !== undefined) r.name = String(body.name || r.tag_name);
      if (body.body !== undefined) r.body = body.body == null ? '' : String(body.body);
      if (body.prerelease !== undefined) r.prerelease = body.prerelease === true || body.prerelease === 'true';
      if (body.draft !== undefined) {
        const d = body.draft === true || body.draft === 'true';
        if (r.draft && !d) { r.published_at = now(); published = true; }
        r.draft = d;
      }
      if (!r.draft && !(await this.refExists(name, `refs/tags/${r.tag_name}`))) {
        await this.resolveCommit(name, r.target_commitish);
        await this.createTag(name, { tag: r.tag_name, ref: r.target_commitish }, identity, base);
      }
      this.saveReleases(name, db);
      return r;
    });
    this.app.audit(identity, 'git-release-update', `${this.conf.name}/${name} ${rel.tag_name}`);
    if (published) this.app.events.emit('git.release', { repo: this.conf.name, name, action: 'published', tag: rel.tag_name, id: rel.id }, identity);
    return this.releaseView(rel, base, name);
  },

  async deleteRelease(name, id, identity = null) {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const rel = await this.withPullLock(`${name}#releases`, async () => {
      const db = this.loadReleases(name);
      const r = this.findRelease(db, id);
      db.items = db.items.filter((x) => x !== r);
      this.saveReleases(name, db);
      return r;
    });
    rmrf(this.assetDir(name, rel.id));
    this.app.audit(identity, 'git-release-delete', `${this.conf.name}/${name} ${rel.tag_name}`);
    this.app.events.emit('git.release', { repo: this.conf.name, name, action: 'deleted', tag: rel.tag_name, id: rel.id }, identity);
    return { ok: true };
  },

  async uploadAsset(name, id, { filename, label, contentType, data }, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const file = path.basename(String(filename || '').trim());
    if (!file || file === '.' || file === '..' || /[\0/\\]/.test(file)) throw fail(422, 'asset name is required (?name=file.tgz)');
    checkQuota(this);
    const asset = await this.withPullLock(`${name}#releases`, async () => {
      const db = this.loadReleases(name);
      const r = this.findRelease(db, id);
      if ((r.assets || []).some((a) => a.name === file)) throw fail(422, `asset ${file} already exists in release ${r.tag_name}`);
      const a = { id: ++db.assetSeq, name: file, label: String(label || ''), content_type: contentType || 'application/octet-stream', size: data.length, download_count: 0, created_at: now(), uploader: { login: identity ? identity.name : 'anonymous' } };
      const dir = this.assetDir(name, r.id);
      mkdirp(dir);
      fs.writeFileSync(path.join(dir, String(a.id)), data);
      r.assets = [...(r.assets || []), a];
      this.saveReleases(name, db);
      return a;
    });
    invalidate(this);
    this.app.audit(identity, 'git-release-asset', `${this.conf.name}/${name} ${file}`);
    return this.assetView(asset, base, name);
  },

  locateAsset(db, assetId) {
    for (const r of db.items) {
      const a = (r.assets || []).find((x) => x.id === Number(assetId));
      if (a) return { r, a };
    }
    throw fail(404, `asset ${assetId} not found`);
  },

  async deleteAsset(name, assetId, identity = null) {
    name = this.requireRepo(name);
    this.assertWritable(name);
    await this.withPullLock(`${name}#releases`, async () => {
      const db = this.loadReleases(name);
      const { r, a } = this.locateAsset(db, assetId);
      r.assets = r.assets.filter((x) => x !== a);
      fs.rmSync(path.join(this.assetDir(name, r.id), String(a.id)), { force: true });
      this.saveReleases(name, db);
    });
    invalidate(this);
    this.app.audit(identity, 'git-release-asset-delete', `${this.conf.name}/${name} ${assetId}`);
    return { ok: true };
  },

  /** { file, name, contentType, size, draft } of an asset (download counter incremented). */
  async assetFile(name, assetId) {
    name = this.requireRepo(name);
    return this.withPullLock(`${name}#releases`, async () => {
      const db = this.loadReleases(name);
      const { r, a } = this.locateAsset(db, assetId);
      a.download_count = (a.download_count || 0) + 1;
      this.saveReleases(name, db);
      return { file: path.join(this.assetDir(name, r.id), String(a.id)), name: a.name, contentType: a.content_type, size: a.size, draft: !!r.draft };
    });
  },

  // ================================================================ contents (commits without a working tree)
  /**
   * Commit file changes to a branch: files [{ path, content, encoding: 'base64' | 'utf8', executable }] and
   * deletes [path]. `sha` (single file) guards against overwriting a changed file, `create` refuses existing files.
   */
  async commitFiles(name, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertWritable(name);
    const cwd = this.repoDir(name);
    const files = (Array.isArray(body.files) ? body.files : []).map((f) => ({
      path: cleanPath(f.path),
      data: Buffer.from(f.content == null ? '' : String(f.content), f.encoding === 'base64' ? 'base64' : 'utf8'),
      mode: f.executable ? '100755' : '100644',
      sha: f.sha || null,
      create: f.create === true,
    }));
    const deletes = (Array.isArray(body.deletes) ? body.deletes : []).map((d) => (typeof d === 'object' ? { path: cleanPath(d.path), sha: d.sha || null } : { path: cleanPath(d), sha: null }));
    if (!files.length && !deletes.length) throw fail(422, 'nothing to commit (files or deletes required)');
    const message = String(body.message || '').trim() || (files.length === 1 && !deletes.length ? `Update ${files[0].path}` : deletes.length && !files.length ? `Delete ${deletes.map((d) => d.path).join(', ')}` : `Update ${files.length + deletes.length} files`);
    const head = await this.ensureHead(name);
    const branch = body.branch ? await this.checkRefName('branch', body.branch) : head || 'main';
    if (this.isProtected(name, branch) && this.conf.immutable) throw fail(403, `repository ${this.conf.name} is immutable`);
    checkQuota(this);
    const parentR = await gitu.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], { cwd });
    let parent = parentR.code === 0 ? parentR.stdout.toString().trim() : '';
    // a new branch may start from another one (body.from)
    if (!parent && body.from) parent = await this.resolveCommit(name, body.from);
    const startBranch = !parentR.stdout.toString().trim();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-commit-'));
    const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
    try {
      if (parent) await gitu.git(['read-tree', parent], { cwd, env });
      const current = async (p) => {
        if (!parent) return null;
        const r = await gitu.run(['rev-parse', '--verify', '-q', `${parent}:${p}`], { cwd });
        return r.code === 0 ? r.stdout.toString().trim() : null;
      };
      for (const f of files) {
        const cur = await current(f.path);
        if (f.create && cur) throw fail(422, `${f.path} already exists`);
        if (f.sha && cur !== f.sha) throw fail(409, `${f.path} has changed (expected blob ${f.sha}, found ${cur || 'none'})`);
        const blob = (await gitu.git(['hash-object', '-w', '--stdin'], { cwd, input: f.data })).trim();
        await gitu.git(['update-index', '--add', '--cacheinfo', `${f.mode},${blob},${f.path}`], { cwd, env });
      }
      // removals through --index-info (mode 0) - works without a working tree
      const removed = [];
      for (const d of deletes) {
        const cur = await current(d.path);
        const type = cur ? (await gitu.git(['cat-file', '-t', cur], { cwd })).trim() : null;
        if (type === 'tree' || !cur) {
          // a directory: remove everything below it
          const ls = parent ? (await gitu.run(['ls-tree', '-r', '-z', '--name-only', parent, '--', `${d.path}/`], { cwd })).stdout.toString().split('\0').filter(Boolean) : [];
          if (!ls.length) throw fail(404, `${d.path} not found in ${branch}`);
          removed.push(...ls);
          continue;
        }
        if (d.sha && cur !== d.sha) throw fail(409, `${d.path} has changed`);
        removed.push(d.path);
      }
      if (removed.length) await gitu.git(['update-index', '-z', '--index-info'], { cwd, env, input: removed.map((p) => `0 ${ZERO}\t${p}\0`).join('') });
      const tree = (await gitu.git(['write-tree'], { cwd, env })).trim();
      if (parent && tree === (await gitu.git(['rev-parse', `${parent}^{tree}`], { cwd })).trim()) throw fail(422, 'no changes');
      const args = ['commit-tree', tree];
      if (parent) args.push('-p', parent);
      const sha = (await gitu.git(args, { cwd, input: `${message}\n`, env: this.committerEnv(identity) })).trim();
      const before = await this.refSnapshot(name);
      const upd = await gitu.run(['update-ref', `refs/heads/${branch}`, sha, startBranch ? ZERO : parent], { cwd });
      if (upd.code !== 0) throw fail(409, `branch ${branch} moved meanwhile - reload and try again`);
      await this.afterRefChange(name, before, identity, base, 'web-commit');
      return { commit: { sha, message, branch, parents: parent ? [parent] : [] }, files: files.map((f) => f.path), deleted: deletes.map((d) => d.path) };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },

  /** Blob sha of a path at a ref (for optimistic updates from the editor), or null. */
  async blobSha(name, ref, p) {
    const r = await gitu.run(['rev-parse', '--verify', '-q', `${ref || 'HEAD'}:${cleanPath(p)}`], { cwd: this.repoDir(name) });
    return r.code === 0 ? r.stdout.toString().trim() : null;
  },

  // ================================================================ initial files (github.com/new)
  async initFiles(name, opts, identity) {
    const files = [];
    const title = name.split('/').pop();
    if (opts.readme) files.push({ path: 'README.md', content: `# ${title}\n${opts.description ? `\n${opts.description}\n` : ''}` });
    if (opts.gitignore) {
      if (!GITIGNORE[opts.gitignore]) throw fail(422, `unknown .gitignore template ${opts.gitignore}`);
      files.push({ path: '.gitignore', content: GITIGNORE[opts.gitignore] });
    }
    if (opts.license) {
      const text = licenseText(opts.license, this.ownerOf(name) || (identity ? identity.name : 'the authors'));
      if (!text) throw fail(422, `unknown licence ${opts.license}`);
      files.push({ path: 'LICENSE', content: text });
    }
    if (!files.length) return null;
    return this.commitFiles(name, { branch: opts.defaultBranch || 'main', message: 'Initial commit', files }, identity);
  },

  // ================================================================ commit detail
  async commitDetail(name, sha) {
    name = this.requireRepo(name);
    const cwd = this.repoDir(name);
    const full = await this.resolveCommit(name, sha);
    const info = (await gitu.git(['log', '-1', '--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%cn%x00%cI%x00%P%x00%B', full], { cwd })).split('\0');
    const [commit, short, author, email, date, committer, committed, parents, ...msg] = info;
    const parentList = parents ? parents.trim().split(' ').filter(Boolean) : [];
    const diffArgs = parentList.length ? [parentList[0], full] : ['--root', full];
    const stat = (await gitu.run(['diff-tree', '-r', '-M', '--numstat', '-z', ...diffArgs], { cwd })).stdout.toString();
    const status = (await gitu.run(['diff-tree', '-r', '-M', '--name-status', '-z', ...diffArgs], { cwd })).stdout.toString();
    const files = [];
    // --name-status -z: STATUS\0path\0 (R/C: STATUS\0old\0new\0)
    const sp = status.split('\0').filter((x, i, a) => !(x === '' && i === a.length - 1));
    for (let i = 0; i < sp.length;) {
      const st = sp[i++];
      if (!st) continue;
      if (/^[RC]/.test(st)) { files.push({ status: st[0] === 'R' ? 'renamed' : 'copied', previous: sp[i++], path: sp[i++] }); }
      else files.push({ status: { A: 'added', D: 'removed', M: 'modified', T: 'changed' }[st[0]] || 'modified', path: sp[i++] });
    }
    // --numstat -z: add\tdel\tpath\0  (renames: add\tdel\t\0old\0new\0)
    const ns = stat.split('\0');
    for (let i = 0; i < ns.length;) {
      const l = ns[i++];
      if (!l) continue;
      const [a, d, p] = l.split('\t');
      let file = p;
      if (p === '') { i++; file = ns[i++]; }
      const f = files.find((x) => x.path === file);
      if (f) { f.binary = a === '-'; f.additions = a === '-' ? 0 : Number(a); f.deletions = d === '-' ? 0 : Number(d); }
    }
    const patch = await gitu.run(['diff-tree', '-r', '-M', '-p', '--no-color', '--full-index', ...diffArgs], { cwd });
    let text = patch.stdout.length > MAX_PATCH ? null : patch.stdout.toString('utf8');
    if (text) {
      const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
      for (const c of chunks) {
        const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(c);
        const f = m && files.find((x) => x.path === m[2]);
        if (f) f.patch = c.slice(c.indexOf('\n') + 1);
      }
    }
    const sum = (k) => files.reduce((n, f) => n + (f[k] || 0), 0);
    return {
      commit, short, author, email, date, committer, committed, parents: parentList,
      message: msg.join('\0').trim(), subject: msg.join('\0').trim().split('\n')[0],
      stats: { files: files.length, additions: sum('additions'), deletions: sum('deletions') },
      files, truncated: text === null,
    };
  },
};

module.exports = { manageMixin, cleanPath, ZERO };

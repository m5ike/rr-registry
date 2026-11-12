'use strict';
// Pull requests and issues of git repositories (GitHub-compatible JSON shapes), mixed into GitRepo.
//
// Storage: <data>/repos/<repo>/<name>.git/rr-pulls.json   { seq, commentSeq, items: [...] }
//   Pull requests and issues share one number sequence per git repository (like GitHub).
//   The file lives inside the bare repository, so deleting the repository deletes it and the
//   export / import of repository content (transfer.js) carries it along.
//
// Mergeability and merges run in the bare repository without a working tree:
//   git merge-tree --write-tree (git >= 2.40; older git: temporary index, see util/git.js mergeTree)
//   + git commit-tree + git update-ref <branch> <new> <old> (compare-and-swap - 409 when the base moved).
const path = require('path');
const { HttpError } = require('../util/http');
const { writeAtomic, readJsonFile } = require('../util/store');
const gitu = require('../util/git');
const { invalidate } = require('../policies');

const STATES = ['open', 'closed', 'all'];
const METHODS = ['merge', 'squash', 'rebase'];

/** HttpError whose JSON body carries GitHub's `message` next to RR's `error`. */
const fail = (status, message) => new HttpError(status, message, { message });
const now = () => new Date().toISOString();
const login = (identity) => ({ login: identity ? identity.name : 'anonymous' });
const headRef = (s) => String(s || '').split(':').pop().replace(/^refs\/heads\//, '').trim();

function globRe(pattern) {
  const full = pattern.startsWith('refs/') ? pattern : `refs/heads/${pattern}`;
  return new RegExp(`^${full.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function labelList(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const l of arr) {
    const n = String(l && typeof l === 'object' ? l.name : l).trim();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

const pullsMixin = {
  // ---------- storage ----------
  pullsFile(name) {
    return path.join(this.repoDir(name), 'rr-pulls.json');
  },

  loadPulls(name) {
    const db = readJsonFile(this.pullsFile(name), null) || {};
    return { seq: db.seq || 0, commentSeq: db.commentSeq || 0, items: Array.isArray(db.items) ? db.items : [] };
  },

  savePulls(name, db) {
    writeAtomic(this.pullsFile(name), JSON.stringify(db, null, 2) + '\n');
  },

  /** Serialize mutations of one git repository (read-modify-write of rr-pulls.json, merges). */
  withPullLock(name, fn) {
    if (!this.pullLocks) this.pullLocks = new Map();
    const prev = this.pullLocks.get(name) || Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    this.pullLocks.set(name, tail);
    tail.then(() => { if (this.pullLocks.get(name) === tail) this.pullLocks.delete(name); });
    return p;
  },

  findItem(db, number, kind) {
    const n = Number(number);
    const it = Number.isInteger(n) ? db.items.find((x) => x.number === n) : null;
    if (!it || (kind && it.type !== kind)) throw fail(404, `${kind === 'pull' ? 'pull request' : 'issue'} #${number} not found`);
    return it;
  },

  assertCollabWrite() {
    if (this.conf.allowPublish === false) throw fail(403, `pushing to repository ${this.conf.name} is disabled`);
  },

  /** { branch: sha } of all branches. */
  async branchShas(name) {
    const r = await gitu.run(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'], { cwd: this.repoDir(name) });
    const map = {};
    for (const l of r.stdout.toString().split('\n').filter(Boolean)) {
      const i = l.indexOf(' ');
      map[l.slice(i + 1).replace(/^refs\/heads\//, '')] = l.slice(0, i);
    }
    return map;
  },

  isProtected(name, branch, meta = this.meta(name)) {
    if (this.conf.immutable) return true;
    return (meta.protectedBranches || []).some((p) => globRe(p).test(`refs/heads/${branch}`));
  },

  async listBranches(name) {
    name = this.requireRepo(name);
    const map = await this.branchShas(name);
    const meta = this.meta(name);
    return Object.keys(map).sort().map((b) => ({ name: b, commit: { sha: map[b] }, protected: this.isProtected(name, b, meta) }));
  },

  // ---------- views ----------
  collabUrl(base, name, kind, number) {
    return `${base || ''}/admin/#/git/${encodeURIComponent(this.conf.name)}/${name.split('/').map(encodeURIComponent).join('/')}/${kind}/${number}`;
  },

  /** Track the live branch tips (open/closed PRs); merged PRs keep the shas recorded at merge time. */
  refreshShas(it, branches) {
    if (it.type !== 'pull' || it.merged) return false;
    let changed = false;
    for (const side of ['head', 'base']) {
      const sha = branches[it[side].ref];
      if (sha && sha !== it[side].sha) { it[side].sha = sha; changed = true; }
    }
    return changed;
  },

  pullView(it, base, name, merge) {
    const m = it.merged ? { mergeable: true, mergeable_state: 'clean' } : merge || { mergeable: null, mergeable_state: 'unknown' };
    return {
      number: it.number,
      title: it.title,
      body: it.body,
      state: it.state,
      draft: !!it.draft,
      head: { ref: it.head.ref, sha: it.head.sha },
      base: { ref: it.base.ref, sha: it.base.sha },
      html_url: this.collabUrl(base, name, 'pulls', it.number),
      merged: !!it.merged,
      merged_at: it.merged_at || null,
      merge_commit_sha: it.merge_commit_sha || null,
      mergeable: m.mergeable,
      mergeable_state: m.mergeable_state,
      user: it.user,
      labels: (it.labels || []).map((n) => ({ name: n })),
      created_at: it.created_at,
      updated_at: it.updated_at,
      closed_at: it.closed_at || null,
      merged_by: it.merged_by || null,
      comments: (it.comments || []).length,
    };
  },

  issueView(it, base, name) {
    const v = {
      number: it.number,
      title: it.title,
      body: it.body,
      state: it.state,
      labels: (it.labels || []).map((n) => ({ name: n })),
      html_url: this.collabUrl(base, name, it.type === 'pull' ? 'pulls' : 'issues', it.number),
      user: it.user,
      created_at: it.created_at,
      updated_at: it.updated_at,
      closed_at: it.closed_at || null,
      comments: (it.comments || []).length,
    };
    if (it.type === 'pull') v.pull_request = { html_url: v.html_url, merged_at: it.merged_at || null };
    return v;
  },

  commentView(c) {
    return { id: c.id, body: c.body, user: c.user, created_at: c.created_at };
  },

  async mergeability(name, it) {
    if (it.merged) return { mergeable: true, mergeable_state: 'clean' };
    if (!gitu.gitAvailable()) return { mergeable: null, mergeable_state: 'unknown' };
    if (it.head.sha === it.base.sha) return { mergeable: true, mergeable_state: 'clean' };
    const r = await gitu.mergeTree(this.repoDir(name), it.base.sha, it.head.sha);
    if (r.clean === true) return { mergeable: true, mergeable_state: 'clean' };
    if (r.clean === false) return { mergeable: false, mergeable_state: 'dirty', conflicts: r.conflicts };
    return { mergeable: null, mergeable_state: 'unknown' };
  },

  // ---------- pull requests ----------
  async listPulls(name, query = {}, base = '') {
    name = this.requireRepo(name);
    const state = STATES.includes(query.state) ? query.state : 'open';
    const head = query.head ? headRef(query.head) : null;
    const baseRef = query.base ? String(query.base).replace(/^refs\/heads\//, '') : null;
    const branches = await this.branchShas(name);
    return this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      let changed = false;
      const out = [];
      for (const it of db.items.filter((x) => x.type === 'pull')) {
        if (this.refreshShas(it, branches)) changed = true;
        if (state !== 'all' && it.state !== state) continue;
        if (head && it.head.ref !== head) continue;
        if (baseRef && it.base.ref !== baseRef) continue;
        out.push(it);
      }
      if (changed) this.savePulls(name, db);
      return out.sort((a, b) => b.number - a.number).map((it) => this.pullView(it, base, name));
    });
  },

  async createPull(name, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertCollabWrite();
    const title = String(body.title || '').trim();
    const head = headRef(body.head);
    const baseRef = String(body.base || '').replace(/^refs\/heads\//, '').trim();
    if (!title) throw fail(422, 'title is required');
    if (!head || !baseRef) throw fail(422, 'head and base are required');
    if (head === baseRef) throw fail(422, `head and base must be different branches (${head})`);
    const branches = await this.branchShas(name);
    if (!branches[head]) throw fail(422, `head branch ${head} does not exist`);
    if (!branches[baseRef]) throw fail(422, `base branch ${baseRef} does not exist`);
    const it = await this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      const t = now();
      const item = {
        number: ++db.seq, type: 'pull', title, body: body.body == null ? '' : String(body.body), state: 'open', draft: body.draft === true || body.draft === 'true',
        head: { ref: head, sha: branches[head] }, base: { ref: baseRef, sha: branches[baseRef] }, labels: labelList(body.labels),
        user: login(identity), created_at: t, updated_at: t, closed_at: null, merged: false, merged_at: null, merge_commit_sha: null, comments: [],
      };
      db.items.push(item);
      this.savePulls(name, db);
      return item;
    });
    this.app.audit(identity, 'git-pull-create', `${this.conf.name}/${name}#${it.number} ${head} -> ${baseRef}`);
    this.app.events.emit('git.pull.opened', { repo: this.conf.name, name, number: it.number, title, head, base: baseRef }, identity);
    return this.pullView(it, base, name);
  },

  async getPull(name, number, base = '') {
    name = this.requireRepo(name);
    const branches = await this.branchShas(name);
    const it = await this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      const item = this.findItem(db, number, 'pull');
      if (this.refreshShas(item, branches)) this.savePulls(name, db);
      return item;
    });
    const m = await this.mergeability(name, it);
    const v = this.pullView(it, base, name, m);
    if (m.conflicts) v.conflicts = m.conflicts;
    return v;
  },

  async updatePull(name, number, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertCollabWrite();
    const branches = await this.branchShas(name);
    let event = null;
    const it = await this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      const item = this.findItem(db, number, 'pull');
      if (body.title !== undefined) {
        if (!String(body.title).trim()) throw fail(422, 'title cannot be empty');
        item.title = String(body.title).trim();
      }
      if (body.body !== undefined) item.body = body.body == null ? '' : String(body.body);
      if (body.draft !== undefined) item.draft = body.draft === true || body.draft === 'true';
      if (body.base !== undefined) {
        const b = String(body.base).replace(/^refs\/heads\//, '').trim();
        if (item.merged) throw fail(422, 'cannot change the base of a merged pull request');
        if (!branches[b]) throw fail(422, `base branch ${b} does not exist`);
        if (b === item.head.ref) throw fail(422, `head and base must be different branches (${b})`);
        item.base = { ref: b, sha: branches[b] };
      }
      if (body.labels !== undefined) item.labels = labelList(body.labels);
      event = this.applyState(item, body.state);
      this.refreshShas(item, branches);
      item.updated_at = now();
      this.savePulls(name, db);
      return item;
    });
    this.app.audit(identity, event ? `git-pull-${event}` : 'git-pull-update', `${this.conf.name}/${name}#${it.number}`);
    if (event) this.app.events.emit(`git.pull.${event}`, { repo: this.conf.name, name, number: it.number, title: it.title }, identity);
    return this.pullView(it, base, name);
  },

  /** Apply state open|closed, maintain closed_at. Returns 'closed' | 'reopened' | null. */
  applyState(item, state) {
    if (state === undefined || state === null || state === item.state) return null;
    if (!['open', 'closed'].includes(state)) throw fail(422, 'state must be open or closed');
    if (state === 'open' && item.merged) throw fail(422, 'a merged pull request cannot be reopened');
    item.state = state;
    item.closed_at = state === 'closed' ? now() : null;
    return state === 'closed' ? 'closed' : 'reopened';
  },

  /** Hook between computing the merge commit and moving the base branch (tests use it to simulate a race). */
  async beforeMergeRefUpdate() {},

  async mergePull(name, number, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertCollabWrite();
    if (!gitu.gitAvailable()) throw fail(503, 'git is not installed on the server');
    const meta = this.meta(name);
    if (meta.mirror) throw fail(403, `${name} is a read-only mirror of ${meta.mirror.url}`);
    const method = body.merge_method || 'merge';
    if (!METHODS.includes(method)) throw fail(422, `merge_method must be one of ${METHODS.join(', ')}`);
    const cwd = this.repoDir(name);
    const result = await this.withPullLock(name, async () => {
      const db = this.loadPulls(name);
      const it = this.findItem(db, number, 'pull');
      if (it.merged) throw fail(405, 'Pull Request is already merged');
      if (it.state !== 'open') throw fail(405, 'Pull Request is closed');
      const branches = await this.branchShas(name);
      const baseSha = branches[it.base.ref];
      if (!baseSha) throw fail(405, `base branch ${it.base.ref} does not exist`);
      const headSha = branches[it.head.ref] || it.head.sha;
      if (body.sha && body.sha !== headSha) throw fail(409, 'Head branch was modified. Review and try the merge again.');
      const committer = { GIT_COMMITTER_NAME: this.app.config.gitCommitterName || 'RR Registry', GIT_COMMITTER_EMAIL: this.app.config.gitCommitterEmail || 'rr@localhost' };
      const author = { GIT_AUTHOR_NAME: identity ? identity.name : 'anonymous', GIT_AUTHOR_EMAIL: this.userEmail(identity) };
      const commit = async (tree, parents, message, env) => {
        const args = ['commit-tree', tree];
        for (const p of parents) args.push('-p', p);
        return (await gitu.git(args, { cwd, input: message, env: { ...committer, ...env } })).trim();
      };
      const extra = body.commit_message ? `\n\n${String(body.commit_message)}` : '';
      let sha;
      let message;
      if (method === 'rebase') {
        sha = await this.rebaseOnto(cwd, baseSha, headSha, committer, it.number);
        message = 'Pull Request successfully rebased and merged';
      } else {
        const mt = await gitu.mergeTree(cwd, baseSha, headSha);
        if (mt.clean !== true) throw fail(405, mt.clean === false ? `Merge conflict: ${(mt.conflicts || []).join(', ') || 'conflicting changes'}` : `Pull Request is not mergeable${mt.error ? `: ${mt.error}` : ''}`);
        if (method === 'merge') {
          const msg = `Merge pull request #${it.number} from ${it.head.ref}\n\n${String(body.commit_title || it.title)}${extra}\n`;
          sha = await commit(mt.tree, [baseSha, headSha], msg, author);
          message = 'Pull Request successfully merged';
        } else {
          const msg = `${String(body.commit_title || `${it.title} (#${it.number})`)}${extra}\n`;
          sha = await commit(mt.tree, [baseSha], msg, author);
          message = 'Pull Request successfully squashed and merged';
        }
      }
      await this.beforeMergeRefUpdate(name, it, { baseSha, headSha, sha });
      const ur = await gitu.run(['update-ref', '-m', `rr: merge pull request #${it.number} (${method})`, `refs/heads/${it.base.ref}`, sha, baseSha], { cwd });
      if (ur.code !== 0) throw fail(409, 'Base branch was modified. Review and try the merge again.');
      const t = now();
      Object.assign(it, {
        state: 'closed', merged: true, merged_at: t, closed_at: t, updated_at: t, merge_commit_sha: sha, merge_method: method,
        merged_by: login(identity), head: { ref: it.head.ref, sha: headSha }, base: { ref: it.base.ref, sha: baseSha },
      });
      this.savePulls(name, db);
      return { it, sha, message, baseSha };
    });
    const { it, sha, message, baseSha } = result;
    invalidate(this);
    this.app.audit(identity, 'git-pull-merge', `${this.conf.name}/${name}#${it.number} ${it.head.ref} -> ${it.base.ref} (${method}) ${sha.slice(0, 12)}`);
    this.app.events.emit('git.pull.merged', { repo: this.conf.name, name, number: it.number, title: it.title, head: it.head.ref, base: it.base.ref, method, sha }, identity);
    // the base branch moved like after a push: replication and push mirrors follow
    const changes = [{ ref: `refs/heads/${it.base.ref}`, before: baseSha, after: sha, type: 'update' }];
    this.app.events.emit('git.push', { repo: this.conf.name, name, changes, cloneUrl: this.cloneUrl(base, name) }, identity);
    if ((this.meta(name).pushMirrors || []).some((p) => p.enabled)) {
      this.sync(name, 'push', identity).catch((e) => this.app.log.warn(`push mirror ${name}: ${e.message}`));
    }
    return { merged: true, sha, message };
  },

  userEmail(identity) {
    if (!identity) return 'anonymous@localhost';
    const u = this.app.stores.users.get()[identity.name];
    return (u && u.email) || `${identity.name}@localhost`;
  },

  /** Replay base..head (oldest first) onto base, keeping authors and messages. Fast-forward when possible. */
  async rebaseOnto(cwd, baseSha, headSha, committer, number) {
    const ff = await gitu.run(['merge-base', '--is-ancestor', baseSha, headSha], { cwd });
    if (ff.code === 0) return headSha;
    const merges = (await gitu.git(['rev-list', '--min-parents=2', `${baseSha}..${headSha}`], { cwd })).trim();
    if (merges) throw fail(405, `Pull Request #${number} cannot be rebased: the head branch contains merge commits`);
    const list = (await gitu.git(['rev-list', '--reverse', '--topo-order', `${baseSha}..${headSha}`], { cwd })).split('\n').filter(Boolean);
    let cur = baseSha;
    for (const c of list) {
      const parent = (await gitu.run(['rev-parse', '--verify', '-q', `${c}^`], { cwd })).stdout.toString().trim();
      let tree;
      if (parent) {
        const mt = await gitu.mergeTree(cwd, cur, c, { mergeBase: parent });
        if (mt.clean !== true) throw fail(405, `Pull Request #${number} cannot be rebased: conflict in ${c.slice(0, 12)}${mt.conflicts && mt.conflicts.length ? ` (${mt.conflicts.join(', ')})` : ''}`);
        tree = mt.tree;
      } else {
        tree = (await gitu.git(['rev-parse', `${c}^{tree}`], { cwd })).trim();
      }
      const info = (await gitu.git(['log', '-1', '--date=raw', '--format=%an%x00%ae%x00%ad%x00%B', c], { cwd })).split('\0');
      const env = { ...committer, GIT_AUTHOR_NAME: info[0], GIT_AUTHOR_EMAIL: info[1], GIT_AUTHOR_DATE: info[2] };
      cur = (await gitu.git(['commit-tree', tree, '-p', cur], { cwd, input: info.slice(3).join('\0'), env })).trim();
    }
    return cur;
  },

  // ---------- issues ----------
  async listIssues(name, query = {}, base = '') {
    name = this.requireRepo(name);
    const state = STATES.includes(query.state) ? query.state : 'open';
    const labels = labelList(query.labels);
    const db = this.loadPulls(name);
    return db.items
      .filter((it) => it.type === 'issue' && (state === 'all' || it.state === state) && labels.every((l) => (it.labels || []).includes(l)))
      .sort((a, b) => b.number - a.number)
      .map((it) => this.issueView(it, base, name));
  },

  async createIssue(name, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertCollabWrite();
    const title = String(body.title || '').trim();
    if (!title) throw fail(422, 'title is required');
    const it = await this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      const t = now();
      const item = { number: ++db.seq, type: 'issue', title, body: body.body == null ? '' : String(body.body), state: 'open', labels: labelList(body.labels), user: login(identity), created_at: t, updated_at: t, closed_at: null, comments: [] };
      db.items.push(item);
      this.savePulls(name, db);
      return item;
    });
    this.app.audit(identity, 'git-issue-create', `${this.conf.name}/${name}#${it.number} ${title}`);
    this.app.events.emit('git.issue.opened', { repo: this.conf.name, name, number: it.number, title }, identity);
    return this.issueView(it, base, name);
  },

  async getIssue(name, number, base = '') {
    name = this.requireRepo(name);
    return this.issueView(this.findItem(this.loadPulls(name), number), base, name);
  },

  async updateIssue(name, number, body = {}, identity = null, base = '') {
    name = this.requireRepo(name);
    this.assertCollabWrite();
    let event = null;
    const it = await this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      const item = this.findItem(db, number);
      if (body.title !== undefined) {
        if (!String(body.title).trim()) throw fail(422, 'title cannot be empty');
        item.title = String(body.title).trim();
      }
      if (body.body !== undefined) item.body = body.body == null ? '' : String(body.body);
      if (body.labels !== undefined) item.labels = labelList(body.labels);
      event = this.applyState(item, body.state);
      item.updated_at = now();
      this.savePulls(name, db);
      return item;
    });
    const kind = it.type === 'pull' ? 'pull' : 'issue';
    this.app.audit(identity, event ? `git-${kind}-${event}` : `git-${kind}-update`, `${this.conf.name}/${name}#${it.number}`);
    if (event) this.app.events.emit(`git.${kind}.${event}`, { repo: this.conf.name, name, number: it.number, title: it.title }, identity);
    return this.issueView(it, base, name);
  },

  // ---------- comments (issues and pull requests) ----------
  async listComments(name, number, kind) {
    name = this.requireRepo(name);
    const it = this.findItem(this.loadPulls(name), number, kind);
    return (it.comments || []).map((c) => this.commentView(c));
  },

  async addComment(name, number, body = {}, identity = null, kind) {
    name = this.requireRepo(name);
    this.assertCollabWrite();
    const text = body.body == null ? '' : String(body.body);
    if (!text.trim()) throw fail(422, 'body is required');
    const { it, c } = await this.withPullLock(name, () => {
      const db = this.loadPulls(name);
      const item = this.findItem(db, number, kind);
      const comment = { id: ++db.commentSeq, body: text, user: login(identity), created_at: now() };
      item.comments = [...(item.comments || []), comment];
      item.updated_at = comment.created_at;
      this.savePulls(name, db);
      return { it: item, c: comment };
    });
    this.app.audit(identity, 'git-comment', `${this.conf.name}/${name}#${it.number}`);
    this.app.events.emit('git.comment', { repo: this.conf.name, name, number: it.number, kind: it.type, id: c.id }, identity);
    return this.commentView(c);
  },
};

module.exports = { pullsMixin, labelList, headRef };

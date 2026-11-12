'use strict';
// Git pull requests and issues (GitHub-compatible API): create / list / filter, live mergeability,
// merge | squash | rebase in the bare repository, compare-and-swap of the base branch, comments, issues and labels,
// permissions, names with slashes, the merge-tree fallback (temporary index), persistence across a restart.
//   Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { App } = require('../server/src/server');

const TOKEN = 'git-pulls-test-token-1234567890';
const hasGit = spawnSync('git', ['--version']).status === 0;
const VERSION = fs.readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
const OPTS = { apiToken: TOKEN, adminPassword: 'adminpass', upstream: '', quiet: true, logRequests: false, scheduler: false, retryScale: 0.01 };
let app;
let base;
let dataDir;
let work;
let src;

// async on purpose: the server runs in this process, spawnSync would block it (deadlock)
function git(args, cwd, env = {}) {
  return new Promise((resolve) => {
    const c = spawn('git', ['-c', 'credential.helper=', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', '-c', 'init.defaultBranch=main', ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out: out.trim(), err }));
  });
}
const ok = async (args, cwd, env) => {
  const r = await git(args, cwd, env);
  assert.strictEqual(r.code, 0, `git ${args.join(' ')}: ${r.err}`);
  return r.out;
};

const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
async function api(method, p, body, authz = `Bearer ${TOKEN}`) {
  const r = await fetch(`${base}/api/v1${p}`, {
    method, headers: { authorization: authz, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
}

const N = encodeURIComponent('team/pr');
const R = `/repos/git/git/${N}`;
const bare = (name = 'team/pr') => path.join(dataDir, 'repos', 'git', `${name}.git`);
const pushUrl = (name = 'team/pr') => `${base.replace('http://', 'http://pub:pubpass@')}/git/${name}.git`;
const write = (f, s) => fs.writeFileSync(path.join(src, f), s);
async function commit(msg, files, env) {
  for (const [f, s] of Object.entries(files)) write(f, s);
  await ok(['add', '.'], src);
  await ok(['commit', '-qm', msg], src, env);
  return ok(['rev-parse', 'HEAD'], src);
}
const remoteSha = async (ref, name) => ok(['rev-parse', `refs/heads/${ref}`], bare(name));

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pulls-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-pulls-work-'));
  app = new App({ dataDir, ...OPTS });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
  await api('POST', '/users', { name: 'pub', password: 'pubpass', role: 'publisher', email: 'pub@example.com' });
  await api('POST', '/users', { name: 'rd', password: 'rdpass', role: 'reader' });
  if (!hasGit) return;
  src = path.join(work, 'src');
  fs.mkdirSync(src);
  await ok(['init', '-q'], src);
  await commit('init', { 'a.txt': '1\n2\n3\n', 'README.md': '# pr\n' });
  await ok(['checkout', '-q', '-b', 'feature'], src);
  await commit('feature work', { 'a.txt': 'one\n2\n3\n', 'f.txt': 'feature\n' });
  await ok(['checkout', '-q', '-b', 'conflict', 'main'], src);
  await commit('conflicting work', { 'a.txt': 'uno\n2\n3\n' });
  await ok(['checkout', '-q', 'main'], src);
  await ok(['push', '-q', pushUrl(), 'main', 'feature', 'conflict'], src);
});

test.after(async () => {
  delete process.env.RR_GIT_MERGE_FALLBACK;
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test('git pulls: version, capability hints and PATCH in CORS', async () => {
  const s = await api('GET', '/status');
  assert.strictEqual(s.headers.get('x-powered-by'), `rr-registry/${VERSION}`);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(s.json.features.includes('git.pulls') && s.json.features.includes('git.issues'));
  const w = await api('GET', '/auth/whoami');
  assert.deepStrictEqual(w.json.features, s.json.features);
  assert.strictEqual(w.json.version, VERSION);
  const pj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'server', 'package.json'), 'utf8'));
  assert.strictEqual(pj.version, VERSION);
});

test('git pulls: create, validation, shared numbering, list filters, mergeable clean', { skip: !hasGit }, async () => {
  let r = await api('POST', `${R}/pulls`, { title: 'Add feature', head: 'feature', base: 'main', body: 'Popis' });
  assert.strictEqual(r.status, 201, r.text);
  const pr = r.json;
  assert.strictEqual(pr.number, 1);
  assert.strictEqual(pr.state, 'open');
  assert.strictEqual(pr.draft, false);
  assert.strictEqual(pr.merged, false);
  assert.strictEqual(pr.merged_at, null);
  assert.strictEqual(pr.merge_commit_sha, null);
  assert.strictEqual(pr.user.login, 'api-token');
  assert.strictEqual(pr.comments, 0);
  assert.strictEqual(pr.head.ref, 'feature');
  assert.strictEqual(pr.head.sha, await remoteSha('feature'));
  assert.strictEqual(pr.base.sha, await remoteSha('main'));
  assert.strictEqual(pr.html_url, `${base}/admin/#/git/git/team/pr/pulls/1`);
  for (const k of ['created_at', 'updated_at']) assert.ok(!Number.isNaN(Date.parse(pr[k])), k);

  // validation (422 with GitHub's {message}), no dedupe
  r = await api('POST', `${R}/pulls`, { title: 'x', head: 'nope', base: 'main' });
  assert.strictEqual(r.status, 422);
  assert.match(r.json.message, /head branch nope/);
  r = await api('POST', `${R}/pulls`, { title: 'x', head: 'feature', base: 'nope' });
  assert.strictEqual(r.status, 422);
  r = await api('POST', `${R}/pulls`, { title: 'x', head: 'main', base: 'main' });
  assert.strictEqual(r.status, 422);
  r = await api('POST', `${R}/pulls`, { head: 'feature', base: 'main' });
  assert.strictEqual(r.status, 422);

  // issues share the number sequence
  r = await api('POST', `${R}/issues`, { title: 'Bug', labels: ['bug'] });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.number, 2);
  r = await api('POST', `${R}/pulls`, { title: 'Draft duplicate', head: 'owner:feature', base: 'main', draft: true });
  assert.strictEqual(r.json.number, 3, 'no dedupe, owner: prefix stripped');
  assert.strictEqual(r.json.draft, true);
  assert.strictEqual(r.json.head.ref, 'feature');

  // list: newest first, head "owner:branch", base, state
  r = await api('GET', `${R}/pulls`);
  assert.deepStrictEqual(r.json.map((p) => p.number), [3, 1]);
  r = await api('GET', `${R}/pulls?head=${encodeURIComponent('team:feature')}&state=open`);
  assert.deepStrictEqual(r.json.map((p) => p.number), [3, 1]);
  r = await api('GET', `${R}/pulls?head=conflict`);
  assert.deepStrictEqual(r.json, []);
  r = await api('GET', `${R}/pulls?base=main&head=feature`);
  assert.strictEqual(r.json.length, 2);
  r = await api('GET', `${R}/pulls?base=develop`);
  assert.deepStrictEqual(r.json, []);
  r = await api('GET', `${R}/pulls?state=closed`);
  assert.deepStrictEqual(r.json, []);

  // close the duplicate through PATCH
  r = await api('PATCH', `${R}/pulls/3`, { state: 'closed', title: 'Duplicate' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.state, 'closed');
  assert.strictEqual(r.json.title, 'Duplicate');
  assert.deepStrictEqual((await api('GET', `${R}/pulls?state=closed`)).json.map((p) => p.number), [3]);
  assert.deepStrictEqual((await api('GET', `${R}/pulls?state=all`)).json.map((p) => p.number), [3, 1]);
  r = await api('PUT', `${R}/pulls/3/merge`, {});
  assert.strictEqual(r.status, 405);
  assert.match(r.json.message, /closed/);

  r = await api('GET', `${R}/pulls/1`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.mergeable, true);
  assert.strictEqual(r.json.mergeable_state, 'clean');
  assert.strictEqual((await api('GET', `${R}/pulls/2`)).status, 404, 'an issue is not a pull request');
  assert.strictEqual((await api('GET', `${R}/pulls/99`)).status, 404);

  // branches (GitHub shape)
  r = await api('GET', `${R}/branches`);
  assert.deepStrictEqual(r.json.map((b) => b.name), ['conflict', 'feature', 'main']);
  assert.strictEqual(r.json[2].commit.sha, await remoteSha('main'));
  assert.strictEqual(r.json[2].protected, false);

  assert.ok(app.events.recent.some((e) => e.type === 'git.pull.opened' && e.data.number === 1));
  assert.ok(app.events.recent.some((e) => e.type === 'git.issue.opened' && e.data.number === 2));
  assert.ok(app.logs.audit.some((e) => e.action === 'git-pull-create'));
  assert.ok(app.logs.audit.some((e) => e.action === 'git-pull-closed'));
});

test('git pulls: conflicting pull request is dirty and cannot be merged', { skip: !hasGit }, async () => {
  let r = await api('POST', `${R}/pulls`, { title: 'Conflict', head: 'conflict', base: 'feature' });
  assert.strictEqual(r.status, 201);
  const n = r.json.number;
  r = await api('GET', `${R}/pulls/${n}`);
  assert.strictEqual(r.json.mergeable, false);
  assert.strictEqual(r.json.mergeable_state, 'dirty');
  for (const m of ['merge', 'squash', 'rebase']) {
    r = await api('PUT', `${R}/pulls/${n}/merge`, { merge_method: m });
    assert.strictEqual(r.status, 405, `${m}: ${r.text}`);
    assert.ok(r.json.message);
  }
  assert.strictEqual(await remoteSha('feature'), (await api('GET', `${R}/pulls/${n}`)).json.base.sha, 'base untouched');
  r = await api('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'octopus' });
  assert.strictEqual(r.status, 422);
  await api('PATCH', `${R}/pulls/${n}`, { state: 'closed' });
});

test('git pulls: merge commit (into a protected branch), comments on the pull request', { skip: !hasGit }, async () => {
  await api('PUT', `/repos/git/git/${N}`, { protectedBranches: ['main'] });
  assert.strictEqual((await api('GET', `${R}/branches`)).json.find((b) => b.name === 'main').protected, true);
  const before = await remoteSha('main');
  const head = await remoteSha('feature');

  // comments through both endpoints
  let r = await api('POST', `${R}/issues/1/comments`, { body: 'LGTM' }, basic('pub', 'pubpass'));
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.body, 'LGTM');
  assert.strictEqual(r.json.user.login, 'pub');
  assert.ok(r.json.id);
  r = await api('POST', `${R}/pulls/1/comments`, { body: 'second' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await api('POST', `${R}/pulls/1/comments`, { body: '  ' })).status, 422);
  assert.deepStrictEqual((await api('GET', `${R}/pulls/1/comments`)).json.map((c) => c.body), ['LGTM', 'second']);
  assert.deepStrictEqual((await api('GET', `${R}/issues/1/comments`)).json.map((c) => c.body), ['LGTM', 'second']);
  assert.strictEqual((await api('GET', `${R}/pulls/1`)).json.comments, 2);
  assert.strictEqual((await api('GET', `${R}/pulls/2/comments`)).status, 404, 'issue number on the pulls alias');

  r = await api('PUT', `${R}/pulls/1/merge`, { merge_method: 'merge' }, basic('pub', 'pubpass'));
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.merged, true);
  assert.strictEqual(r.json.sha, await remoteSha('main'));
  const mergeSha = r.json.sha;
  const parents = (await ok(['log', '-1', '--format=%P', 'main'], bare())).split(' ');
  assert.deepStrictEqual(parents, [before, head]);
  assert.strictEqual(await ok(['log', '-1', '--format=%an <%ae>|%cn <%ce>', 'main'], bare()), 'pub <pub@example.com>|RR Registry <rr@localhost>');
  assert.strictEqual(await ok(['log', '-1', '--format=%B', 'main'], bare()), 'Merge pull request #1 from feature\n\nAdd feature');
  assert.strictEqual(await ok(['show', 'main:a.txt'], bare()), 'one\n2\n3');
  assert.strictEqual(await ok(['show', 'main:f.txt'], bare()), 'feature');

  r = await api('GET', `${R}/pulls/1`);
  assert.strictEqual(r.json.state, 'closed');
  assert.strictEqual(r.json.merged, true);
  assert.strictEqual(r.json.mergeable, true);
  assert.strictEqual(r.json.mergeable_state, 'clean');
  assert.strictEqual(r.json.merge_commit_sha, await remoteSha('main'));
  assert.ok(r.json.merged_at && r.json.closed_at);
  assert.strictEqual(r.json.head.sha, head);
  assert.strictEqual(r.json.base.sha, before, 'merged PR keeps the shas from merge time');
  r = await api('PUT', `${R}/pulls/1/merge`, {});
  assert.strictEqual(r.status, 405);
  assert.match(r.json.message, /already merged/);
  assert.strictEqual((await api('PATCH', `${R}/pulls/1`, { state: 'open' })).status, 422);

  // the commit API sees the merge, events and audit
  const commits = (await api('GET', `${R}/commits?ref=main&limit=1`)).json;
  assert.strictEqual(commits[0].parents.length, 2);
  assert.ok(app.events.recent.some((e) => e.type === 'git.pull.merged' && e.data.number === 1 && e.data.method === 'merge'));
  assert.ok(app.events.recent.some((e) => e.type === 'git.push' && e.data.name === 'team/pr' && e.data.changes[0].after === mergeSha));
  assert.ok(app.logs.audit.some((e) => e.action === 'git-pull-merge'));

  // deleting the head branch keeps the stored head sha
  await ok(['push', '-q', pushUrl(), ':feature'], src);
  r = await api('GET', `${R}/pulls/1`);
  assert.strictEqual(r.json.head.sha, head);
});

test('git pulls: squash merge', { skip: !hasGit }, async () => {
  await ok(['checkout', '-q', 'main'], src);
  await ok(['pull', '-q', '--ff-only', pushUrl(), 'main'], src);
  await ok(['checkout', '-q', '-b', 'sq'], src);
  await commit('sq 1', { 's1.txt': 's1\n' });
  await commit('sq 2', { 's2.txt': 's2\n' });
  await ok(['push', '-q', pushUrl(), 'sq'], src);
  let r = await api('POST', `${R}/pulls`, { title: 'Squash me', head: 'sq', base: 'main' });
  const n = r.json.number;
  const before = await remoteSha('main');
  r = await api('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'squash', commit_message: 'details' }, basic('pub', 'pubpass'));
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(await ok(['log', '-1', '--format=%P', 'main'], bare()), before, 'single parent');
  assert.strictEqual(await ok(['log', '-1', '--format=%B', 'main'], bare()), `Squash me (#${n})\n\ndetails`);
  assert.strictEqual(await ok(['log', '-1', '--format=%an', 'main'], bare()), 'pub');
  assert.strictEqual(await ok(['ls-tree', '--name-only', 'main'], bare()), ['README.md', 'a.txt', 'f.txt', 's1.txt', 's2.txt'].join('\n'));
  assert.strictEqual(await ok(['rev-list', '--count', `${before}..main`], bare()), '1');
});

test('git pulls: rebase merge replays commits and keeps authors; fast-forward when possible', { skip: !hasGit }, async () => {
  await ok(['checkout', '-q', 'main'], src);
  await ok(['pull', '-q', '--ff-only', pushUrl(), 'main'], src);
  const fork = await ok(['rev-parse', 'HEAD'], src);
  await ok(['checkout', '-q', '-b', 'rb'], src);
  const alice = { GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_AUTHOR_DATE: '2020-01-02T03:04:05Z' };
  await commit('rb first', { 'r1.txt': 'r1\n' }, alice);
  await commit('rb second', { 'a.txt': 'one\n2\nthree\n' }, alice);
  await ok(['push', '-q', pushUrl(), 'rb'], src);
  // main moves on in the meantime (not conflicting)
  await ok(['checkout', '-q', 'main'], src);
  await commit('main moves', { 'm.txt': 'm\n' });
  await ok(['push', '-q', pushUrl(), 'main'], src);
  const mainTip = await remoteSha('main');
  assert.notStrictEqual(mainTip, fork);

  let r = await api('POST', `${R}/pulls`, { title: 'Rebase me', head: 'rb', base: 'main' });
  const n = r.json.number;
  assert.strictEqual((await api('GET', `${R}/pulls/${n}`)).json.mergeable_state, 'clean');
  r = await api('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'rebase' });
  assert.strictEqual(r.status, 200, r.text);
  const log = (await ok(['log', '--format=%s|%an|%ae|%aI|%cn|%P', `${mainTip}..main`], bare())).split('\n');
  assert.strictEqual(log.length, 2);
  const rows = log.map((l) => l.split('|'));
  assert.deepStrictEqual(rows.map((x) => x[0]), ['rb second', 'rb first']);
  for (const x of rows) {
    assert.strictEqual(x[1], 'Alice');
    assert.strictEqual(x[2], 'alice@example.com');
    assert.strictEqual(Date.parse(x[3]), Date.parse('2020-01-02T03:04:05Z'));
    assert.strictEqual(x[4], 'RR Registry');
    assert.strictEqual(x[5].split(' ').length, 1, 'linear history');
  }
  assert.strictEqual(rows[1][5], mainTip, 'replayed onto the base tip');
  assert.strictEqual(await ok(['show', 'main:a.txt'], bare()), 'one\n2\nthree');
  assert.strictEqual(await ok(['show', 'main:m.txt'], bare()), 'm');
  assert.strictEqual(await ok(['show', 'main:r1.txt'], bare()), 'r1');
  assert.strictEqual(r.json.sha, await remoteSha('main'));
  assert.strictEqual((await api('GET', `${R}/pulls/${n}`)).json.merge_commit_sha, r.json.sha);

  // fast-forward
  await ok(['fetch', '-q', pushUrl(), '+main:refs/remotes/rr/main'], src);
  await ok(['checkout', '-q', '-b', 'ff', 'rr/main'], src);
  const ffSha = await commit('ff only', { 'ff.txt': 'ff\n' });
  await ok(['push', '-q', pushUrl(), 'ff'], src);
  r = await api('POST', `${R}/pulls`, { title: 'FF', head: 'ff', base: 'main' });
  r = await api('PUT', `${R}/pulls/${r.json.number}/merge`, { merge_method: 'rebase' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.sha, ffSha);
  assert.strictEqual(await remoteSha('main'), ffSha);
  await ok(['checkout', '-q', 'main'], src);
});

test('git pulls: compare-and-swap - base moved during the merge -> 409, no lost update', { skip: !hasGit }, async () => {
  await ok(['fetch', '-q', pushUrl(), '+main:refs/remotes/rr/main'], src);
  await ok(['checkout', '-q', '-b', 'cas', 'rr/main'], src);
  await commit('cas work', { 'cas.txt': 'cas\n' });
  await ok(['push', '-q', pushUrl(), 'cas'], src);
  await ok(['checkout', '-q', 'main'], src);
  let r = await api('POST', `${R}/pulls`, { title: 'CAS', head: 'cas', base: 'main' });
  const n = r.json.number;
  const h = app.repoHandler('git');
  let injected = null;
  h.beforeMergeRefUpdate = async () => {
    // somebody pushes to main between computing the merge and updating the ref
    const tree = await ok(['rev-parse', 'main^{tree}'], bare());
    injected = await ok(['commit-tree', tree, '-p', 'main', '-m', 'concurrent push'], bare());
    await ok(['update-ref', 'refs/heads/main', injected], bare());
  };
  try {
    r = await api('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'merge' });
    assert.strictEqual(r.status, 409, r.text);
    assert.match(r.json.message, /Base branch was modified/);
  } finally {
    delete h.beforeMergeRefUpdate;
  }
  assert.strictEqual(await remoteSha('main'), injected, 'the concurrent update survived');
  r = await api('GET', `${R}/pulls/${n}`);
  assert.strictEqual(r.json.state, 'open');
  assert.strictEqual(r.json.merged, false);
  assert.strictEqual(r.json.base.sha, injected, 'base sha follows the branch');
  // retry succeeds on top of the concurrent commit
  r = await api('PUT', `${R}/pulls/${n}/merge`, {});
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(await ok(['log', '-1', '--format=%P', 'main'], bare()), `${injected} ${await remoteSha('cas')}`);
  // stale head sha -> 409 as well
  await ok(['fetch', '-q', pushUrl(), '+main:refs/remotes/rr/main'], src);
  await ok(['checkout', '-q', '-b', 'cas2', 'rr/main'], src);
  await commit('cas2', { 'cas2.txt': 'x\n' });
  await ok(['push', '-q', pushUrl(), 'cas2'], src);
  await ok(['checkout', '-q', 'main'], src);
  r = await api('POST', `${R}/pulls`, { title: 'CAS2', head: 'cas2', base: 'main' });
  assert.strictEqual((await api('PUT', `${R}/pulls/${r.json.number}/merge`, { sha: '0'.repeat(40) })).status, 409);
});

test('git issues: create, labels filter, close / reopen, issue view of a pull request, comments', { skip: !hasGit }, async () => {
  let r = await api('POST', `${R}/issues`, { title: 'UI glitch', body: 'tlačítko', labels: ['bug', 'ui'] });
  assert.strictEqual(r.status, 201);
  const ui = r.json;
  assert.deepStrictEqual(ui.labels, [{ name: 'bug' }, { name: 'ui' }]);
  assert.strictEqual(ui.state, 'open');
  assert.strictEqual(ui.closed_at, null);
  assert.strictEqual(ui.html_url, `${base}/admin/#/git/git/team/pr/issues/${ui.number}`);
  assert.strictEqual((await api('POST', `${R}/issues`, { body: 'no title' })).status, 422);

  r = await api('GET', `${R}/issues`);
  assert.deepStrictEqual(r.json.map((i) => i.number), [ui.number, 2], 'issues only, newest first');
  assert.ok(r.json.every((i) => !i.pull_request));
  assert.deepStrictEqual((await api('GET', `${R}/issues?labels=bug`)).json.map((i) => i.number), [ui.number, 2]);
  assert.deepStrictEqual((await api('GET', `${R}/issues?labels=bug,ui`)).json.map((i) => i.number), [ui.number]);
  assert.deepStrictEqual((await api('GET', `${R}/issues?labels=docs`)).json, []);

  r = await api('PATCH', `${R}/issues/2`, { state: 'closed', labels: ['bug', 'wontfix'], title: 'Bug (old)' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.state, 'closed');
  assert.ok(r.json.closed_at);
  assert.deepStrictEqual(r.json.labels.map((l) => l.name), ['bug', 'wontfix']);
  assert.deepStrictEqual((await api('GET', `${R}/issues`)).json.map((i) => i.number), [ui.number]);
  assert.deepStrictEqual((await api('GET', `${R}/issues?state=closed`)).json.map((i) => i.number), [2]);
  assert.strictEqual((await api('GET', `${R}/issues?state=all`)).json.length, 2);
  r = await api('PATCH', `${R}/issues/2`, { state: 'open' });
  assert.strictEqual(r.json.closed_at, null);
  assert.strictEqual((await api('PATCH', `${R}/issues/2`, { state: 'done' })).status, 422);

  r = await api('POST', `${R}/issues/2/comments`, { body: 'reproduced' });
  assert.strictEqual(r.status, 201);
  assert.deepStrictEqual((await api('GET', `${R}/issues/2/comments`)).json.map((c) => c.body), ['reproduced']);
  assert.strictEqual((await api('GET', `${R}/issues/2`)).json.comments, 1);

  // GitHub: a pull request number works on the issues endpoints
  r = await api('GET', `${R}/issues/1`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.title, 'Add feature');
  assert.strictEqual(r.json.comments, 2);
  assert.ok(r.json.pull_request);
  assert.strictEqual((await api('GET', `${R}/issues/999`)).status, 404);
  assert.ok(app.events.recent.some((e) => e.type === 'git.issue.closed' && e.data.number === 2));
});

test('git pulls: permissions - readers and read-only tokens cannot write', { skip: !hasGit }, async () => {
  const rd = basic('rd', 'rdpass');
  assert.strictEqual((await api('GET', `${R}/pulls`, null, rd)).status, 200);
  assert.strictEqual((await api('GET', `${R}/issues/2`, null, rd)).status, 200);
  assert.strictEqual((await api('POST', `${R}/pulls`, { title: 'x', head: 'sq', base: 'main' }, rd)).status, 403);
  const t = await api('POST', '/tokens', { name: 'ro', user: 'pub', readonly: true });
  const ro = `Bearer ${t.json.token}`;
  assert.strictEqual((await api('GET', `${R}/pulls?state=all`, null, ro)).status, 200);
  for (const [m, p, b] of [
    ['POST', `${R}/pulls`, { title: 'x', head: 'sq', base: 'main' }],
    ['PATCH', `${R}/pulls/1`, { title: 'x' }],
    ['PUT', `${R}/pulls/1/merge`, {}],
    ['POST', `${R}/pulls/1/comments`, { body: 'x' }],
    ['POST', `${R}/issues`, { title: 'x' }],
    ['PATCH', `${R}/issues/2`, { state: 'closed' }],
    ['POST', `${R}/issues/2/comments`, { body: 'x' }],
  ]) {
    assert.strictEqual((await api(m, p, b, ro)).status, 403, `${m} ${p}`);
    assert.strictEqual((await api(m, p, b, rd)).status, 403, `${m} ${p} (reader)`);
  }
  assert.strictEqual((await api('POST', `${R}/issues`, { title: 'x' }, 'Bearer nope')).status, 401);
});

test('git pulls: names with several slashes', { skip: !hasGit }, async () => {
  const name = 'a/b/c';
  await ok(['push', '-q', pushUrl(name), 'main', 'sq'], src);
  const P = `/repos/git/git/${encodeURIComponent(name)}`;
  let r = await api('POST', `${P}/pulls`, { title: 'deep', head: 'sq', base: 'main' });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.number, 1, 'own number sequence per git repository');
  assert.strictEqual(r.json.html_url, `${base}/admin/#/git/git/a/b/c/pulls/1`);
  assert.strictEqual((await api('GET', `${P}/pulls?head=x:sq`)).json.length, 1);
  assert.strictEqual((await api('GET', `${P}/pulls/1`)).json.mergeable_state, 'clean');
  assert.strictEqual((await api('POST', `${P}/issues/1/comments`, { body: 'hi' })).status, 201);
  assert.strictEqual((await api('GET', `${P}/branches`)).json.length, 2);
  assert.ok(fs.existsSync(path.join(bare(name), 'rr-pulls.json')));
  // deleting the git repository deletes its pull requests
  assert.strictEqual((await api('DELETE', P)).status, 200);
  await ok(['push', '-q', pushUrl(name), 'main', 'sq'], src);
  assert.deepStrictEqual((await api('GET', `${P}/pulls?state=all`)).json, []);
});

test('git pulls: merge-tree fallback through a temporary index', { skip: !hasGit }, async () => {
  process.env.RR_GIT_MERGE_FALLBACK = '1';
  try {
    const gitu = require('../server/src/util/git');
    assert.strictEqual(gitu.hasMergeTree(), false);
    await ok(['fetch', '-q', pushUrl(), '+main:refs/remotes/rr/main'], src);
    await ok(['checkout', '-q', '-b', 'fb', 'rr/main'], src);
    await commit('fb', { 'a.txt': 'ONE\n2\nthree\n', 'fb.txt': 'fb\n' });
    await ok(['checkout', '-q', '-b', 'fb2', 'rr/main'], src);
    await commit('fb2', { 'a.txt': 'one\n2\nthree\n4\n' });
    await ok(['checkout', '-q', '-b', 'fbx', 'rr/main'], src);
    await commit('fbx', { 'a.txt': 'eins\n2\nthree\n' });
    await ok(['checkout', '-q', 'main'], src);
    await ok(['push', '-q', '-f', pushUrl(), 'fb', 'fb2', 'fbx'], src);
    // fb2 lands first, fb then needs a real three-way content merge
    let r = await api('POST', `${R}/pulls`, { title: 'fb2', head: 'fb2', base: 'main' });
    assert.strictEqual((await api('PUT', `${R}/pulls/${r.json.number}/merge`, { merge_method: 'rebase' })).status, 200);
    r = await api('POST', `${R}/pulls`, { title: 'fb', head: 'fb', base: 'main' });
    const n = r.json.number;
    assert.strictEqual((await api('GET', `${R}/pulls/${n}`)).json.mergeable_state, 'clean');
    r = await api('POST', `${R}/pulls`, { title: 'fbx', head: 'fbx', base: 'fb' });
    assert.strictEqual((await api('GET', `${R}/pulls/${r.json.number}`)).json.mergeable_state, 'dirty');
    assert.strictEqual((await api('PUT', `${R}/pulls/${r.json.number}/merge`, {})).status, 405);
    r = await api('PUT', `${R}/pulls/${n}/merge`, { merge_method: 'squash' });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(await ok(['show', 'main:a.txt'], bare()), 'ONE\n2\nthree\n4');
    assert.strictEqual(await ok(['show', 'main:fb.txt'], bare()), 'fb');
    // fallback and merge-tree agree on the tree
    delete process.env.RR_GIT_MERGE_FALLBACK;
    if (gitu.hasMergeTree()) {
      const a = await gitu.mergeTree(bare(), 'fb', 'fb2');
      process.env.RR_GIT_MERGE_FALLBACK = '1';
      const b = await gitu.mergeTree(bare(), 'fb', 'fb2');
      assert.strictEqual(a.clean, true);
      assert.deepStrictEqual(b, a);
    }
  } finally {
    delete process.env.RR_GIT_MERGE_FALLBACK;
  }
});

test('git pulls: data survive a restart of the server', { skip: !hasGit }, async () => {
  const before = (await api('GET', `${R}/pulls?state=all`)).json;
  const issues = (await api('GET', `${R}/issues?state=all`)).json;
  await app.close();
  app = new App({ dataDir, ...OPTS });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
  const after = (await api('GET', `${R}/pulls?state=all`)).json;
  assert.deepStrictEqual(after.map((p) => [p.number, p.state, p.merged, p.merge_commit_sha]), before.map((p) => [p.number, p.state, p.merged, p.merge_commit_sha]));
  assert.deepStrictEqual((await api('GET', `${R}/issues?state=all`)).json.map((i) => [i.number, i.title, i.comments]), issues.map((i) => [i.number, i.title, i.comments]));
  // numbering continues
  const r = await api('POST', `${R}/issues`, { title: 'after restart' });
  assert.strictEqual(r.json.number, Math.max(...before.map((p) => p.number), ...issues.map((i) => i.number)) + 1);
});

'use strict';
// Git repositories: smart HTTP (real git client), auto-create on push, permissions, protected branches,
// immutable repos, pull mirrors (file:// remote), push mirrors, routing pull-through and "push" replication,
// incoming mirror webhook, browsing API (tree / blob / commits / archive).   Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { App } = require('../server/src/server');

const TOKEN = 'git-test-token-1234567890';
const hasGit = spawnSync('git', ['--version']).status === 0;
let app;
let base;
let dataDir;
let work;

// async on purpose: the server runs in this process, spawnSync would block it (deadlock)
function git(args, cwd, env = {}) {
  return new Promise((resolve) => {
    const c = spawn('git', ['-c', 'credential.helper=', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', '-c', 'init.defaultBranch=main', ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

async function api(method, p, body) {
  const r = await fetch(`${base}/api/v1${p}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary */ }
  return { status: r.status, json, text };
}

const auth = (u, p) => base.replace('http://', `http://${u}:${p}@`);
const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-git-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-git-work-'));
  app = new App({ dataDir, apiToken: TOKEN, adminPassword: 'adminpass', upstream: '', quiet: true, logRequests: false, scheduler: false, retryScale: 0.01 });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
  await api('POST', '/users', { name: 'pub', password: 'pubpass', role: 'publisher' });
  await api('POST', '/users', { name: 'rd', password: 'rdpass', role: 'reader' });
});

test.after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test('git: push creates the repository, clone works anonymously, permissions are enforced', { skip: !hasGit }, async () => {
  const src = path.join(work, 'src');
  fs.mkdirSync(src);
  await git(['init', '-q'], src);
  fs.writeFileSync(path.join(src, 'README.md'), '# demo\n');
  fs.mkdirSync(path.join(src, 'lib'));
  fs.writeFileSync(path.join(src, 'lib', 'a.js'), 'module.exports = 1;\n');
  await git(['add', '.'], src);
  await git(['commit', '-qm', 'init'], src);
  await git(['tag', 'v1.0.0'], src);

  let r = await git(['push', `${base}/git/team/demo.git`, 'main'], src);
  assert.notStrictEqual(r.code, 0, 'anonymous push must fail');
  r = await git(['push', `${auth('rd', 'rdpass')}/git/team/demo.git`, 'main'], src);
  assert.notStrictEqual(r.code, 0, 'reader push must fail');
  assert.match(r.out, /403/);
  r = await git(['push', `${auth('pub', 'pubpass')}/git/team/demo.git`, 'main', '--tags'], src);
  assert.strictEqual(r.code, 0, r.out);

  const dst = path.join(work, 'clone');
  r = await git(['clone', '-q', `${base}/git/team/demo.git`, dst], work);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(fs.readFileSync(path.join(dst, 'README.md'), 'utf8'), '# demo\n');
  // also through /r/<repo>/ and without the .git suffix
  r = await git(['ls-remote', `${base}/r/git/team/demo`], work);
  assert.match(r.out, /refs\/tags\/v1\.0\.0/);

  const info = await api('GET', `/repos/git/git/${encodeURIComponent('team/demo')}`);
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.json.defaultBranch, 'main');
  assert.strictEqual(info.json.cloneUrl, `${base}/git/team/demo.git`);
  assert.deepStrictEqual(info.json.tags.map((t) => t.name), ['v1.0.0']);

  const tree = await api('GET', `/repos/git/git/team%2Fdemo/tree?ref=main`);
  assert.deepStrictEqual(tree.json.entries.map((e) => `${e.type}:${e.name}`), ['dir:lib', 'file:README.md']);
  const sub = await api('GET', `/repos/git/git/team%2Fdemo/tree?ref=v1.0.0&path=lib`);
  assert.strictEqual(sub.json.entries[0].path, 'lib/a.js');
  const blob = await api('GET', `/repos/git/git/team%2Fdemo/blob?ref=main&path=lib/a.js`);
  assert.strictEqual(blob.text, 'module.exports = 1;\n');
  const commits = await api('GET', `/repos/git/git/team%2Fdemo/commits?limit=5`);
  assert.strictEqual(commits.json[0].subject, 'init');
  const arch = await fetch(`${base}/api/v1/repos/git/git/team%2Fdemo/archive?ref=main&format=zip`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.strictEqual(arch.status, 200);
  assert.strictEqual(Buffer.from(await arch.arrayBuffer()).subarray(0, 2).toString(), 'PK');

  // browser on the clone URL is redirected to the admin
  const html = await fetch(`${base}/git/team/demo.git`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.strictEqual(html.status, 302);
  assert.match(html.headers.get('location'), /#\/git\/git\/team\/demo/);

  // the git.push event reached the event log
  assert.ok(app.events.recent.some((e) => e.type === 'git.push' && e.data.name === 'team/demo'));
  // npm package "git" must still work on the default npm repository (no /git/ collision)
  const npmGit = await fetch(`${base}/git/1.0.0`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.strictEqual(npmGit.status, 404);
  assert.match(await npmGit.text(), /package git not found/);
});

test('git: protected branches and immutable repositories reject force pushes and deletes', { skip: !hasGit }, async () => {
  const src = path.join(work, 'src');
  let r = await api('PUT', `/repos/git/git/team%2Fdemo`, { protectedBranches: ['main'] });
  assert.deepStrictEqual(r.json.protectedBranches, ['main']);
  await git(['checkout', '-q', '-b', 'feature'], src);
  fs.writeFileSync(path.join(src, 'f.txt'), 'f\n');
  await git(['add', '.'], src);
  await git(['commit', '-qm', 'feature'], src);
  r = await git(['push', `${auth('pub', 'pubpass')}/git/team/demo.git`, 'feature'], src);
  assert.strictEqual(r.code, 0, r.out);
  // rewriting history of main is refused, of feature allowed
  r = await git(['push', '-f', `${auth('pub', 'pubpass')}/git/team/demo.git`, 'feature:main'], src);
  assert.strictEqual(r.code, 0, `fast-forward to main is fine: ${r.out}`);
  await git(['reset', '-q', '--hard', 'HEAD~1'], src);
  r = await git(['push', '-f', `${auth('pub', 'pubpass')}/git/team/demo.git`, 'HEAD:main'], src);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /non fast-forward push to protected ref refs\/heads\/main/);
  r = await git(['push', `${auth('pub', 'pubpass')}/git/team/demo.git`, ':main'], src);
  assert.match(r.out, /deleting protected ref/);
  r = await git(['push', '-f', `${auth('pub', 'pubpass')}/git/team/demo.git`, 'HEAD:feature'], src);
  assert.strictEqual(r.code, 0, `unprotected branch may be rewritten: ${r.out}`);

  // immutable repository: no rewrites/deletes anywhere, deleting through the API refused
  r = await api('POST', '/repos', { name: 'frozen', type: 'git', immutable: true });
  assert.strictEqual(r.status, 201, r.text);
  r = await git(['push', `${auth('pub', 'pubpass')}/r/frozen/x.git`, 'HEAD:refs/heads/main'], src);
  assert.strictEqual(r.code, 0, r.out);
  r = await git(['push', `${auth('pub', 'pubpass')}/r/frozen/x.git`, ':main'], src);
  assert.notStrictEqual(r.code, 0);
  r = await api('DELETE', '/repos/frozen/git/x');
  assert.strictEqual(r.status, 403);
});

test('git: pull mirror from a remote, read-only, sync, webhook', { skip: !hasGit }, async () => {
  const upstream = path.join(work, 'upstream.git');
  await git(['init', '-q', '--bare', upstream], work);
  const src = path.join(work, 'src');
  await git(['push', '-q', upstream, 'main', 'feature', '--tags'], src);

  let r = await api('POST', '/repos/git/git', { name: 'mirrors/up', importUrl: `file://${upstream}`, mirror: true, interval: 0, ttl: 0 });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.mirror.status, 'ok');
  assert.ok(r.json.branches.some((b) => b.name === 'feature'));
  const secret = r.json.mirror.webhookSecret;

  // pushing into a mirror is refused
  const p = await git(['push', `${auth('pub', 'pubpass')}/git/mirrors/up.git`, 'HEAD:refs/heads/x'], src);
  assert.notStrictEqual(p.code, 0);

  // new commit upstream -> sync pulls it
  fs.writeFileSync(path.join(src, 'n.txt'), 'n\n');
  await git(['add', '.'], src);
  await git(['commit', '-qm', 'upstream change'], src);
  await git(['push', '-q', upstream, 'HEAD:refs/heads/next'], src);
  r = await api('POST', '/repos/git/git/mirrors%2Fup/sync', { direction: 'pull' });
  assert.strictEqual(r.json.pull.ok, true, r.text);
  assert.ok(r.json.pull.changes.some((c) => c.ref === 'refs/heads/next' && c.type === 'create'));

  // GitHub style webhook with HMAC signature triggers a sync, wrong signature is refused
  await git(['push', '-q', upstream, 'HEAD:refs/heads/hooked'], src);
  const body = JSON.stringify({ ref: 'refs/heads/hooked' });
  const bad = await fetch(`${base}/-/rr/hooks/git/git/mirrors/up`, { method: 'POST', headers: { 'x-hub-signature-256': 'sha256=00', 'content-type': 'application/json' }, body });
  assert.strictEqual(bad.status, 403);
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const good = await fetch(`${base}/-/rr/hooks/git/git/mirrors/up`, { method: 'POST', headers: { 'x-hub-signature-256': sig, 'x-github-event': 'push', 'content-type': 'application/json' }, body });
  assert.strictEqual(good.status, 200);
  // a GET racing with the background fetch may transiently fail (500) - keep polling
  assert.ok(await waitFor(async () => ((await api('GET', '/repos/git/git/mirrors%2Fup')).json.branches || []).some((b) => b.name === 'hooked')));

  // scheduled sync honours the interval
  await api('PUT', '/repos/git/git/mirrors%2Fup', { mirror: { interval: 1 } });
  await git(['push', '-q', upstream, 'HEAD:refs/heads/scheduled'], src);
  await new Promise((res) => setTimeout(res, 1100));
  const t = await api('POST', '/tasks/git-mirrors/run');
  assert.strictEqual(t.status, 201, t.text);
  assert.ok(t.json.lastResult.synced >= 1);
  assert.ok((await api('GET', '/repos/git/git/mirrors%2Fup')).json.branches.some((b) => b.name === 'scheduled'));

  // turning the mirror off makes it a normal repository again
  r = await api('PUT', '/repos/git/git/mirrors%2Fup', { mirror: null });
  assert.strictEqual(r.json.mirror, null);
});

test('git: push mirrors and routing (pull-through clone, push replication)', { skip: !hasGit }, async () => {
  const src = path.join(work, 'src');
  const target = path.join(work, 'target.git');
  await git(['init', '-q', '--bare', target], work);

  // push mirror -> every push to the registry is forwarded
  let r = await api('POST', '/repos/git/git/team%2Fdemo/push-mirrors', { url: `file://${target}`, mode: 'mirror' });
  assert.strictEqual(r.status, 201, r.text);
  const pmId = r.json.id;
  r = await api('POST', '/repos/git/git/team%2Fdemo/sync', { direction: 'push' });
  assert.strictEqual(r.json.push[0].ok, true, r.text);
  assert.match((await git(['ls-remote', target], work)).out, /refs\/heads\/main/);
  await git(['push', '-q', `${auth('pub', 'pubpass')}/git/team/demo.git`, 'HEAD:refs/heads/pm-test'], src);
  assert.ok(await waitFor(async () => /refs\/heads\/pm-test/.test((await git(['ls-remote', target], work)).out)), 'push mirror after git push');
  r = await api('DELETE', `/repos/git/git/team%2Fdemo/push-mirrors/${pmId}`);
  assert.strictEqual(r.status, 200);

  // pull-through: a missing repository is cloned from the rule target (another RR server = this one)
  await api('POST', '/repos', { name: 'proxy', type: 'git' });
  r = await api('POST', '/routes', { name: 'git-pt', when: 'notfound', repo: 'proxy', repoType: 'git', target: `${base}/r/git`, cacheTtl: 60 });
  assert.strictEqual(r.status, 201, r.text);
  const cl = path.join(work, 'pt');
  const c = await git(['clone', '-q', `${base}/r/proxy/team/demo.git`, cl], work);
  assert.strictEqual(c.code, 0, c.out);
  assert.ok(fs.existsSync(path.join(cl, 'README.md')));
  const pi = await api('GET', '/repos/proxy/git/team%2Fdemo');
  assert.strictEqual(pi.json.mirror.url, `${base}/r/git/team/demo.git`);
  assert.notStrictEqual((await git(['ls-remote', `${base}/r/proxy/nope/missing.git`], work)).code, 0);

  // "push" rule -> automatic push to a remote server (here another git repository of this registry)
  await api('POST', '/repos', { name: 'replica', type: 'git' });
  r = await api('POST', '/routes', { name: 'git-repl', when: 'push', repo: 'git', matchType: 'glob', pattern: '/team/**', target: `${base}/r/replica`, username: 'admin', token: 'adminpass' });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.token, '***');
  await git(['push', '-q', `${auth('pub', 'pubpass')}/git/team/demo.git`, 'HEAD:refs/heads/replicated'], src);
  assert.ok(await waitFor(async () => (await api('GET', '/replications')).json.some((j) => j.ruleName === 'git-repl' && j.status === 'ok')), 'replication job ok');
  assert.match((await git(['ls-remote', `${base}/r/replica/team/demo.git`], work)).out, /refs\/heads\/replicated/);
});

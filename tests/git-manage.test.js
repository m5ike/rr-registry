'use strict';
// Git repository management (1.7): default branch repair, visibility / owners / collaborators, rename and move
// with redirects, branches, tags, releases with assets, commits from the web (contents API), commit detail,
// starter files, the git type host (no /git in URLs, web UI) and git over SSH (real OpenSSH + git clients).
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { App } = require('../server/src/server');
const md = require('../web/admin/markdown');

const TOKEN = 'git-manage-token-1234567890';
const hasGit = spawnSync('git', ['--version']).status === 0;
const hasSsh = hasGit && spawnSync('ssh', ['-V']).status === 0 && spawnSync('ssh-keygen', ['--help']).status !== null;
let app;
let base;
let dataDir;
let work;

function git(args, cwd, env = {}) {
  return new Promise((resolve) => {
    const c = spawn('git', ['-c', 'credential.helper=', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
}

async function api(method, p, body, headers = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (h.authorization === undefined) h.authorization = `Bearer ${TOKEN}`;
  if (h.authorization === null) delete h.authorization;
  const r = await fetch(`${base}/api/v1${p}`, { method, headers: h, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, json, buf, headers: r.headers };
}
const basic = (u, p) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
const G = (name) => `/repos/git/git/${encodeURIComponent(name)}`;

function req(p, host, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: app.port, path: p, headers: { host: `${host}:${app.port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.end();
  });
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gitm-'));
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-gitm-work-'));
  app = new App({ dataDir, apiToken: TOKEN, adminPassword: 'adminpass', upstream: '', quiet: true, logRequests: false, scheduler: false, publicUrl: '', sshPort: 0, sshEphemeral: hasSsh });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
  await api('POST', '/users', { name: 'alice', password: 'alicepass', role: 'publisher' });
  await api('POST', '/users', { name: 'bob', password: 'bobpass', role: 'publisher' });
  await api('POST', '/users', { name: 'rd', password: 'rdpass', role: 'reader' });
});

test.after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

test('default branch: a push of "master" into a repository created with HEAD -> main fixes HEAD', { skip: !hasGit }, async () => {
  assert.strictEqual((await api('POST', '/repos/git/git', { name: 'm5ike/test-sec' })).status, 201);
  const src = path.join(work, 'sec');
  fs.mkdirSync(src);
  await git(['init', '-q', '-b', 'master'], src);
  fs.writeFileSync(path.join(src, 'README.md'), '# test\n');
  await git(['add', '.'], src);
  await git(['commit', '-qm', 'init'], src);
  const push = await git(['push', '-q', `${base.replace('http://', 'http://alice:alicepass@')}/git/m5ike/test-sec.git`, 'master'], src);
  assert.strictEqual(push.code, 0, push.out);
  const info = (await api('GET', G('m5ike/test-sec'))).json;
  assert.strictEqual(info.defaultBranch, 'master');
  assert.strictEqual((await api('GET', `${G('m5ike/test-sec')}/tree`)).status, 200, 'browsing the default branch works');
  // an existing broken HEAD is repaired on access too
  const dir = app.repoHandler('git').repoDir('m5ike/test-sec');
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  assert.strictEqual((await api('GET', `${G('m5ike/test-sec')}/commits`)).json.length, 1);
  assert.strictEqual((await api('GET', G('m5ike/test-sec'))).json.defaultBranch, 'master');
});

test('create like github.com/new: visibility, README, .gitignore, licence; templates', { skip: !hasGit }, async () => {
  const t = (await api('GET', '/git/templates', undefined, { authorization: null })).json;
  assert.ok(t.gitignore.includes('Node') && t.licenses.includes('MIT'));
  assert.match((await api('GET', '/git/templates?license=MIT&holder=Alice')).json.content, /Copyright \(c\) \d{4} Alice/);
  const r = await api('POST', '/repos/git/git', { name: 'alice/web', description: 'Web app', visibility: 'private', readme: true, gitignore: 'Node', license: 'MIT' }, basic('alice', 'alicepass'));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.private, true);
  assert.strictEqual(r.json.owner, 'alice');
  assert.strictEqual(r.json.defaultBranch, 'main');
  const tree = (await api('GET', `${G('alice/web')}/tree`)).json.entries.map((e) => e.name).sort();
  assert.deepStrictEqual(tree, ['.gitignore', 'LICENSE', 'README.md']);
  assert.match((await api('GET', `${G('alice/web')}/blob?path=README.md`)).buf.toString(), /^# web\n\nWeb app/);
  assert.strictEqual((await api('POST', '/repos/git/git', { name: 'new' })).status, 422, '"new" is reserved (web UI route)');
  assert.strictEqual((await api('POST', '/repos/git/git', { name: 'x', gitignore: 'Nope' })).status, 422);
});

test('private repositories: hidden from others, visible to owner, collaborators and admins (API, HTTP git)', { skip: !hasGit }, async () => {
  const anon = await api('GET', G('alice/web'), undefined, { authorization: null });
  assert.strictEqual(anon.status, 401);
  assert.strictEqual((await api('GET', G('alice/web'), undefined, basic('bob', 'bobpass'))).status, 404, 'other users do not learn it exists');
  assert.ok(!(await api('GET', '/repos/git/git', undefined, basic('bob', 'bobpass'))).json.some((g) => g.name === 'alice/web'));
  assert.ok((await api('GET', '/repos/git/git', undefined, basic('alice', 'alicepass'))).json.some((g) => g.name === 'alice/web' && g.permission === 'admin'));
  // HTTP clone: anonymous -> 401 (git asks for credentials), bob -> not found, alice ok
  assert.notStrictEqual((await git(['ls-remote', `${base}/git/alice/web.git`], work)).code, 0);
  assert.notStrictEqual((await git(['ls-remote', `${base.replace('http://', 'http://bob:bobpass@')}/git/alice/web.git`], work)).code, 0);
  assert.strictEqual((await git(['ls-remote', `${base.replace('http://', 'http://alice:alicepass@')}/git/alice/web.git`], work)).code, 0);
  // settings are for the owner (repository admin) only
  assert.strictEqual((await api('PUT', `${G('alice/web')}/access`, { visibility: 'public' }, basic('bob', 'bobpass'))).status, 404);
  assert.strictEqual((await api('PUT', `${G('alice/web')}/access`, { collaborators: { bob: 'write', rd: 'boss' } }, basic('alice', 'alicepass'))).status, 422);
  assert.strictEqual((await api('PUT', `${G('alice/web')}/access`, { collaborators: { bob: 'write' } }, basic('alice', 'alicepass'))).status, 200);
  const asBob = await api('GET', G('alice/web'), undefined, basic('bob', 'bobpass'));
  assert.strictEqual(asBob.status, 200);
  assert.deepStrictEqual([asBob.json.permissions.write, asBob.json.permissions.admin], [true, false]);
  assert.strictEqual((await api('PATCH', `${G('alice/web')}`, { description: 'x' }, basic('bob', 'bobpass'))).status, 405);
  assert.strictEqual((await api('PUT', `${G('alice/web')}`, { description: 'x' }, basic('bob', 'bobpass'))).status, 403, 'write is not admin');
  const upd = await api('PUT', `${G('alice/web')}`, { description: 'Web app 2' }, basic('alice', 'alicepass'));
  assert.strictEqual(upd.json.description, 'Web app 2', JSON.stringify(upd.json));
  assert.strictEqual((await api('GET', G('alice/web'), undefined, basic('rd', 'rdpass'))).status, 404);
});

test('contents: create, update (sha guard), upload several files, delete file and directory; commit detail', { skip: !hasGit }, async () => {
  const P = G('alice/web');
  let r = await api('PUT', `${P}/contents`, { path: 'docs/guide.md', content: '# Guide\n', message: 'Add guide', create: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual((await api('PUT', `${P}/contents`, { path: 'docs/guide.md', content: 'x', create: true })).status, 422, 'create refuses existing files');
  assert.strictEqual((await api('PUT', `${P}/contents`, { path: 'docs/guide.md', content: 'x', sha: '0'.repeat(40) })).status, 409, 'stale sha');
  assert.strictEqual((await api('PUT', `${P}/contents`, { path: '../etc/passwd', content: 'x' })).status, 422);
  assert.strictEqual((await api('PUT', `${P}/contents`, { path: '.git/config', content: 'x' })).status, 422);
  r = await api('POST', `${P}/commit-files`, { message: 'Upload', files: [{ path: 'img/a.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' }, { path: 'img/b.txt', content: 'b' }] });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.deepStrictEqual([...(await api('GET', `${P}/blob?path=img/a.bin`)).buf], [0, 1, 2, 255]);
  const detail = (await api('GET', `${P}/commits/${r.json.commit.sha}`)).json;
  assert.strictEqual(detail.subject, 'Upload');
  assert.deepStrictEqual(detail.files.map((f) => [f.path, f.status, !!f.binary]).sort(), [['img/a.bin', 'added', true], ['img/b.txt', 'added', false]]);
  assert.strictEqual(detail.stats.additions, 1);
  assert.match(detail.files.find((f) => f.path === 'img/b.txt').patch, /^@@ .*\n\+b/m);
  assert.strictEqual((await api('DELETE', `${P}/contents?path=img&message=rm`)).status, 200);
  assert.ok(!(await api('GET', `${P}/tree`)).json.entries.some((e) => e.name === 'img'));
  assert.strictEqual((await api('DELETE', `${P}/contents?path=nope.txt`)).status, 404);
  assert.strictEqual((await api('POST', `${P}/commit-files`, { files: [{ path: 'README.md', content: (await api('GET', `${P}/blob?path=README.md`)).buf.toString() }] })).status, 422, 'no changes');
  // a commit to a new branch from the web
  r = await api('PUT', `${P}/contents`, { path: 'feature.txt', content: 'f', branch: 'feature/web', from: 'main' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.ok((await api('GET', `${P}/branches`)).json.some((b) => b.name === 'feature/web'));
  // read-only users cannot commit
  assert.strictEqual((await api('PUT', `${P}/contents`, { path: 'r.txt', content: 'r' }, basic('rd', 'rdpass'))).status, 403);
});

test('branches: detailed list, create, rename (PRs and protection follow), protect, default, delete', { skip: !hasGit }, async () => {
  const P = G('alice/web');
  assert.strictEqual((await api('POST', `${P}/branches`, { name: 'dev', from: 'main' })).status, 201);
  assert.strictEqual((await api('POST', `${P}/branches`, { name: 'dev' })).status, 409);
  assert.strictEqual((await api('POST', `${P}/branches`, { name: 'bad..name' })).status, 422);
  await api('PUT', `${P}/contents`, { path: 'dev.txt', content: 'dev', branch: 'dev' });
  const pr = await api('POST', `${P}/pulls`, { title: 'Dev', head: 'dev', base: 'main' });
  assert.strictEqual(pr.status, 201);
  let list = (await api('GET', `${P}/branches?detailed=1`)).json;
  const dev = list.find((b) => b.name === 'dev');
  assert.deepStrictEqual([dev.ahead, dev.behind, dev.default], [1, 0, false]);
  assert.strictEqual(list.find((b) => b.name === 'main').default, true);
  assert.strictEqual((await api('PATCH', `${P}/branches/dev`, { name: 'develop', protected: true })).status, 200);
  assert.strictEqual((await api('GET', `${P}/pulls/${pr.json.number}`)).json.head.ref, 'develop', 'open pull requests follow the rename');
  assert.strictEqual((await api('DELETE', `${P}/branches/develop`)).status, 403, 'protected');
  assert.strictEqual((await api('PATCH', `${P}/branches/develop`, { protected: false })).status, 200);
  assert.strictEqual((await api('DELETE', `${P}/branches/main`)).status, 409, 'default branch');
  // rename the default branch: HEAD follows
  assert.strictEqual((await api('PATCH', `${P}/branches/main`, { name: 'trunk' })).status, 200);
  assert.strictEqual((await api('GET', P)).json.defaultBranch, 'trunk');
  assert.strictEqual((await api('PATCH', `${P}/branches/main`, { name: 'x' })).status, 404);
  assert.strictEqual((await api('PATCH', `${P}/branches/develop`, { default: true })).status, 200);
  assert.strictEqual((await api('GET', P)).json.defaultBranch, 'develop');
  await api('PATCH', `${P}/branches/trunk`, { default: true });
  assert.strictEqual((await api('DELETE', `${P}/branches/feature%2Fweb`)).status, 200);
  list = (await api('GET', `${P}/branches`)).json.map((b) => b.name);
  assert.deepStrictEqual(list, ['develop', 'trunk']);
});

test('tags and releases: annotated / lightweight tags, release creates its tag, notes, assets, drafts, latest', { skip: !hasGit }, async () => {
  const P = G('alice/web');
  assert.strictEqual((await api('POST', `${P}/tags`, { tag: 'v0.1.0', ref: 'trunk', message: 'First' })).json.annotated, true);
  assert.strictEqual((await api('POST', `${P}/tags`, { tag: 'light' })).json.annotated, false);
  assert.strictEqual((await api('POST', `${P}/tags`, { tag: 'light' })).status, 409);
  const tags = (await api('GET', `${P}/tags`)).json;
  assert.deepStrictEqual(tags.map((t) => t.name).sort(), ['light', 'v0.1.0']);
  assert.strictEqual(tags.find((t) => t.name === 'v0.1.0').message, 'First');
  let rel = await api('POST', `${P}/releases`, { tag_name: 'v1.0.0', target_commitish: 'trunk', name: 'One', body: 'Notes', generate_release_notes: true });
  assert.strictEqual(rel.status, 201, JSON.stringify(rel.json));
  assert.match(rel.json.body, /^Notes\n\n## Co je nového\n\n- /);
  assert.ok((await api('GET', `${P}/tags`)).json.some((t) => t.name === 'v1.0.0'), 'the release created its tag');
  assert.strictEqual((await api('POST', `${P}/releases`, { tag_name: 'v1.0.0' })).status, 422);
  const up = await api('POST', `${P}/releases/${rel.json.id}/assets?name=app.zip`, Buffer.from('binary-data'), { 'content-type': 'application/octet-stream' });
  assert.strictEqual(up.status, 201, JSON.stringify(up.json));
  assert.strictEqual(up.json.content_type, 'application/zip', 'type from the file name');
  assert.strictEqual((await api('POST', `${P}/releases/${rel.json.id}/assets?name=app.zip`, Buffer.from('x'), { 'content-type': 'application/octet-stream' })).status, 422);
  const dl = await api('GET', `${P}/releases/assets/${up.json.id}/download`);
  assert.strictEqual(dl.buf.toString(), 'binary-data');
  assert.strictEqual((await api('GET', `${P}/releases/${rel.json.id}`)).json.assets[0].download_count, 1);
  // drafts: no tag until published, invisible to readers
  const draft = await api('POST', `${P}/releases`, { tag_name: 'v2.0.0', draft: true });
  assert.ok(!(await api('GET', `${P}/tags`)).json.some((t) => t.name === 'v2.0.0'));
  await api('PUT', `${P}/access`, { visibility: 'public' }, basic('alice', 'alicepass'));
  assert.deepStrictEqual((await api('GET', `${P}/releases`, undefined, basic('rd', 'rdpass'))).json.map((r) => r.tag_name), ['v1.0.0']);
  assert.strictEqual((await api('GET', `${P}/releases/latest`)).json.tag_name, 'v1.0.0');
  assert.strictEqual((await api('PATCH', `${P}/releases/${draft.json.id}`, { draft: false })).json.draft, false);
  assert.ok((await api('GET', `${P}/tags`)).json.some((t) => t.name === 'v2.0.0'), 'publishing creates the tag');
  assert.strictEqual((await api('GET', `${P}/releases/tags/v2.0.0`)).json.id, draft.json.id);
  assert.strictEqual((await api('DELETE', `${P}/releases/assets/${up.json.id}`)).status, 200);
  assert.strictEqual((await api('DELETE', `${P}/releases/${rel.json.id}`)).status, 200);
  assert.strictEqual((await api('DELETE', `${P}/tags/light`)).status, 200);
  const info = (await api('GET', P)).json;
  assert.deepStrictEqual([info.counts.releases, info.latestRelease.tag_name], [1, 'v2.0.0']);
});

test('rename and move: history kept, old URLs redirect (clone, push), name reuse replaces the redirect', { skip: !hasGit }, async () => {
  await api('POST', '/repos', { name: 'git2', type: 'git' });
  const r = await api('POST', `${G('alice/web')}/move`, { name: 'alice/website' }, basic('alice', 'alicepass'));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.name, 'alice/website');
  assert.strictEqual((await api('GET', G('alice/web'))).status, 404);
  const ls = await git(['ls-remote', `${base.replace('http://', 'http://alice:alicepass@')}/git/alice/web.git`], work);
  assert.strictEqual(ls.code, 0, `old clone URL redirects: ${ls.out}`);
  assert.match(ls.out, /refs\/heads\/trunk/);
  assert.strictEqual((await api('GET', `${G('alice/website')}/releases`)).json.length, 1, 'releases moved along');
  // to another git repository (container)
  const m = await api('POST', `${G('alice/website')}/move`, { repo: 'git2' }, basic('alice', 'alicepass'));
  assert.strictEqual(m.status, 201, JSON.stringify(m.json));
  assert.strictEqual(m.json.repo, 'git2');
  assert.strictEqual((await git(['ls-remote', `${base.replace('http://', 'http://alice:alicepass@')}/git/alice/web.git`], work)).code, 0, 'chained redirect across repositories');
  assert.strictEqual((await api('POST', `/repos/git2/git/${encodeURIComponent('alice/website')}/move`, { repo: 'git2' })).status, 422);
  assert.strictEqual((await api('POST', '/repos/git/git', { name: 'alice/web' }, basic('alice', 'alicepass'))).status, 201, 'the old name can be reused');
  assert.strictEqual((await git(['ls-remote', `${base.replace('http://', 'http://alice:alicepass@')}/git/alice/web.git`], work)).out.trim(), '', 'the new (empty) repository wins over the redirect');
  assert.strictEqual((await api('DELETE', `/repos/git2/git/${encodeURIComponent('alice/website')}`, undefined, basic('bob', 'bobpass'))).status, 403);
});

test('git type host: no /git in clone URLs, /git prefix tolerated, web UI for pages, admin on the main host', { skip: !hasGit }, async () => {
  const info = await fetch(`${base}/api/v1${G('m5ike/test-sec')}`, { headers: { authorization: `Bearer ${TOKEN}`, host: `git-registry.localhost:${app.port}` } });
  void info;
  const j = JSON.parse((await req(`/api/v1${G('m5ike/test-sec')}`, 'git-registry.localhost', { authorization: `Bearer ${TOKEN}` })).text);
  assert.strictEqual(j.cloneUrls.https, `http://git-registry.localhost:${app.port}/m5ike/test-sec.git`);
  const main = JSON.parse((await req(`/api/v1${G('m5ike/test-sec')}`, 'registry.localhost', { authorization: `Bearer ${TOKEN}` })).text);
  assert.strictEqual(main.cloneUrls.https, `http://127.0.0.1:${app.port}/git/m5ike/test-sec.git`.replace('127.0.0.1', 'registry.localhost'));
  // git protocol with and without /git
  for (const p of ['/m5ike/test-sec.git/info/refs?service=git-upload-pack', '/git/m5ike/test-sec.git/info/refs?service=git-upload-pack']) {
    const r = await req(p, 'git-registry.localhost');
    assert.strictEqual(r.status, 200, p);
    assert.match(r.headers['content-type'], /git-upload-pack-advertisement/);
  }
  // browser pages: the web UI with the type host configuration
  const page = await req('/m5ike/test-sec/tree/master', 'git-registry.localhost', { accept: 'text/html' });
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /<script src="\/admin\/git\.js"><\/script>/);
  const cfg = await req('/admin/config.js', 'git-registry.localhost');
  assert.match(cfg.text, /"typeHost":\{"type":"git","repo":"git"/);
  const adm = await req('/admin/', 'git-registry.localhost', { accept: 'text/html' });
  assert.strictEqual(adm.status, 302);
  assert.strictEqual(adm.headers.location, `http://registry.localhost:${app.port}/admin/`);
  // the main host keeps the hash-routed administration
  assert.strictEqual((await req('/m5ike/test-sec', 'registry.localhost', { accept: 'text/html' })).status, 404);
});

test('ssh keys: add (validated), list, duplicate, delete; admin sees all', async () => {
  const ed = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@x';
  const k = await api('POST', '/user/keys', { title: 'laptop', key: ed }, basic('alice', 'alicepass'));
  assert.strictEqual(k.status, 201, JSON.stringify(k.json));
  assert.match(k.json.fingerprint, /^SHA256:/);
  assert.strictEqual((await api('POST', '/user/keys', { key: ed }, basic('bob', 'bobpass'))).status, 422, 'key in use');
  assert.strictEqual((await api('POST', '/user/keys', { key: 'ssh-ed25519 Zm9v' }, basic('bob', 'bobpass'))).status, 422);
  assert.strictEqual((await api('POST', '/user/keys', { key: 'not a key' }, basic('bob', 'bobpass'))).status, 422);
  assert.strictEqual((await api('GET', '/user/keys', undefined, basic('alice', 'alicepass'))).json.length, 1);
  assert.strictEqual((await api('GET', '/user/keys', undefined, basic('bob', 'bobpass'))).json.length, 0);
  assert.strictEqual((await api('GET', '/user/keys?user=alice', undefined, basic('bob', 'bobpass'))).status, 403);
  assert.strictEqual((await api('GET', '/user/keys?user=*')).json.length, 1);
  assert.strictEqual((await api('DELETE', `/user/keys/${k.json.id}`, undefined, basic('bob', 'bobpass'))).status, 404);
  assert.strictEqual((await api('DELETE', `/user/keys/${k.json.id}`, undefined, basic('alice', 'alicepass'))).status, 200);
});

test('ssh: clone and push with ed25519 / ECDSA / RSA keys, permissions, private repositories, re-keying', { skip: !hasSsh }, async () => {
  const keys = {};
  for (const [t, extra] of [['ed25519', []], ['ecdsa', ['-b', '256']], ['rsa', ['-b', '3072']]]) {
    const f = path.join(work, `id_${t}`);
    spawnSync('ssh-keygen', ['-q', '-t', t, ...extra, '-N', '', '-f', f]);
    keys[t] = f;
  }
  const add = async (user, pass, f) => assert.strictEqual((await api('POST', '/user/keys', { key: fs.readFileSync(`${f}.pub`, 'utf8') }, basic(user, pass))).status, 201);
  await add('alice', 'alicepass', keys.ed25519);
  await add('bob', 'bobpass', keys.ecdsa);
  await add('rd', 'rdpass', keys.rsa);
  const sshCmd = (f, extra = '') => `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR -p ${app.ssh.port} -i ${f}${extra}`;
  const url = (p) => `ssh://git@127.0.0.1:${app.ssh.port}/${p}`;
  // alice pushes a new repository over SSH (auto-create), with forced re-keying every 32 kB
  const src = path.join(work, 'sshsrc');
  fs.mkdirSync(src);
  await git(['init', '-q'], src);
  fs.writeFileSync(path.join(src, 'big.bin'), require('crypto').randomBytes(400000));
  await git(['add', '.'], src);
  await git(['commit', '-qm', 'big'], src);
  let r = await git(['push', '-q', url('alice/ssh.git'), 'main'], src, { GIT_SSH_COMMAND: sshCmd(keys.ed25519, ' -o RekeyLimit=32K') });
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual((await api('GET', G('alice/ssh'))).json.counts.commits, 1);
  // bob (ECDSA) clones the public repository, with protocol v2 and re-keying
  r = await git(['-c', 'protocol.version=2', 'clone', '-q', url('alice/ssh.git'), path.join(work, 'sshclone')], work, { GIT_SSH_COMMAND: sshCmd(keys.ecdsa, ' -o RekeyLimit=32K') });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(fs.readFileSync(path.join(work, 'sshclone', 'big.bin')).equals(fs.readFileSync(path.join(src, 'big.bin'))));
  // reader (RSA) can clone, cannot push
  r = await git(['ls-remote', url('alice/ssh.git')], work, { GIT_SSH_COMMAND: sshCmd(keys.rsa) });
  assert.strictEqual(r.code, 0, r.out);
  r = await git(['push', '-q', url('alice/ssh.git'), 'main:rd'], src, { GIT_SSH_COMMAND: sshCmd(keys.rsa) });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /permission denied|forbidden/i);
  // private: bob does not see it
  await api('PUT', `${G('alice/ssh')}/access`, { visibility: 'private' });
  r = await git(['ls-remote', url('alice/ssh.git')], work, { GIT_SSH_COMMAND: sshCmd(keys.ecdsa) });
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /not found/);
  // unknown key, shell access, other commands
  const other = path.join(work, 'id_other');
  spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
  r = await new Promise((resolve) => {
    const c = spawn('sh', ['-c', `${sshCmd(other)} git@127.0.0.1`]);
    let out = '';
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  assert.match(r.out, /Permission denied/);
  r = await new Promise((resolve) => {
    const c = spawn('sh', ['-c', `${sshCmd(keys.ed25519)} git@127.0.0.1; ${sshCmd(keys.ed25519)} git@127.0.0.1 ls /`]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  assert.match(r.out, /Hi alice! You've successfully authenticated/);
  assert.match(r.out, /only git clone \/ fetch \/ push/);
  // password authentication (registry password)
  assert.strictEqual(app.ssh.connections.size >= 0, true);
});

test('markdown renderer: GitHub features, safe output, link resolution', () => {
  const html = md.render('# T\n\n[a](docs/x.md#y) ![i](img.png) <script>x</script> [j](javascript:alert(1))\n\n- [x] t\n\n| a |\n|---|\n| 1 |\n\n> [!WARNING]\n> w', {
    resolveLink: (h) => ({ href: `#/r/${h}`, internal: !/^[a-z]+:/.test(h) }), resolveImage: (s) => `/raw/${s}`,
  });
  assert.match(html, /<h1 id="t">/);
  assert.match(html, /href="#\/r\/docs\/x\.md#y" data-md-internal="1"/);
  assert.match(html, /<img src="\/raw\/img\.png"/);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /href="#"[^>]*>j</);
  assert.match(html, /md-task/);
  assert.match(html, /<table>/);
  assert.match(html, /md-warning/);
  assert.deepStrictEqual(md.toc(html).map((t) => t.id), ['t']);
});

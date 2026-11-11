'use strict';
// Per-type hosts ({type}-{app}.<domain>) and their registration in the AI Tools Portal.
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { App } = require('../server/src/server');
const { Portal } = require('../server/src/portal');
const { gitAvailable } = require('../server/src/util/git');

const KEY = crypto.randomBytes(32).toString('hex');
const TOKEN = 'typehosts-test-token-123456';
let app;
let port;
let portal;
let portalMode = 'ok';
const puts = [];
let dataDir;

// fake portal: answers PUT /_portal/api/apps/registry/hosts like portal 1.8
function startFakePortal() {
  portal = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (portalMode === 'old') return send(404, { error: 'unknown API endpoint' });
      if (req.method !== 'PUT' || req.url !== '/_portal/api/apps/registry/hosts' || req.headers.authorization !== `PortalApp registry ${KEY}`) return send(401, { error: 'invalid app credentials' });
      const { names } = JSON.parse(body);
      puts.push(names);
      send(200, { template: '{name}-{app}.{domain}', hosts: names.map((n) => ({ name: n, host: `${n}-registry.localhost` })) });
    });
  });
  return new Promise((r) => portal.listen(0, '127.0.0.1', r));
}

function req(method, p, host, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test.before(async () => {
  await startFakePortal();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-typehosts-test-'));
  app = new App({ dataDir, port: 0, host: '127.0.0.1', apiToken: TOKEN, adminPassword: 'adminpass', quiet: true, logRequests: false, publicUrl: 'http://registry.localhost' });
  app.portal = new Portal({ PORTAL_IDENTITY_KEY: KEY, PORTAL_APP_ID: 'registry', PORTAL_INTERNAL_URL: `http://127.0.0.1:${portal.address().port}` });
  await app.listen(0, '127.0.0.1');
  port = app.port;
});

test.after(async () => {
  await app.close();
  portal.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('every repository type with a repository is reported to the portal at startup', async () => {
  await waitFor(() => puts.length >= 1);
  assert.deepStrictEqual(puts[0], ['npm', 'docker', 'git', 'generic']);
  const st = await req('GET', '/api/v1/status', 'registry.localhost', auth);
  assert.deepStrictEqual(st.json.typeHosts.map((t) => [t.type, t.repo, t.host, t.routed]), [
    ['npm', 'npm', 'npm-registry.localhost', true],
    ['docker', 'docker', 'docker-registry.localhost', true],
    ['git', 'git', 'git-registry.localhost', true],
    ['generic', 'files', 'generic-registry.localhost', true],
  ]);
});

test('npm host: packages and the API at the root, links point to the npm host', async () => {
  const doc = await req('GET', '/@m5ike%2frr-client', 'npm-registry.localhost', { accept: 'application/json' });
  assert.strictEqual(doc.status, 200);
  assert.strictEqual(doc.headers['x-rr-type-host'], 'npm');
  const v = doc.json.versions[doc.json['dist-tags'].latest];
  assert.match(v.dist.tarball, new RegExp(`^http://npm-registry\\.localhost:${port}/`));
  assert.strictEqual((await req('GET', new URL(v.dist.tarball).pathname, 'npm-registry.localhost')).status, 200);
  assert.strictEqual((await req('GET', '/api/v1/repos', 'npm-registry.localhost', auth)).status, 200, 'API on the type host');
  assert.strictEqual((await req('GET', '/-/ping', 'npm-registry.localhost')).status, 200);
  // the main host keeps its public URL
  const main = await req('GET', '/@m5ike%2frr-client', 'registry.localhost', { accept: 'application/json' });
  assert.match(main.json.versions[main.json['dist-tags'].latest].dist.tarball, /^http:\/\/registry\.localhost\//);
});

test('generic host: the generic repository at the root, explicit /r/<repo>/ still works', async () => {
  assert.strictEqual((await req('PUT', '/docs/hello.txt', 'generic-registry.localhost', auth, 'hello type host')).status, 201);
  assert.strictEqual((await req('GET', '/r/files/docs/hello.txt', 'registry.localhost')).text, 'hello type host');
  assert.strictEqual((await req('GET', '/docs/hello.txt', 'generic-registry.localhost')).text, 'hello type host');
  assert.strictEqual((await req('GET', '/r/files/docs/hello.txt', 'generic-registry.localhost')).text, 'hello type host');
});

test('docker host: Docker Registry API v2 at the root', async () => {
  const r = await req('GET', '/v2/', 'docker-registry.localhost');
  assert.ok([200, 401].includes(r.status), `status ${r.status}`);
  assert.strictEqual(r.headers['x-rr-type-host'], 'docker');
  assert.ok(r.headers['docker-distribution-api-version']);
});

test('git host: clone from git-registry/<name>.git what was pushed to registry/git/<name>.git', { skip: !gitAvailable() && 'git not installed' }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-typehosts-git-'));
  const git = (args, cwd) => new Promise((resolve) => {
    const c = spawn('git', ['-c', 'credential.helper=', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', '-c', 'init.defaultBranch=main', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, out }));
  });
  try {
    const src = path.join(work, 'src');
    fs.mkdirSync(src);
    assert.strictEqual((await git(['init', '-q'], src)).code, 0);
    fs.writeFileSync(path.join(src, 'README.md'), 'type hosts\n');
    await git(['add', '.'], src);
    await git(['commit', '-qm', 'init'], src);
    const push = await git(['push', '-q', `http://admin:adminpass@127.0.0.1:${port}/git/demo.git`, 'main'], src);
    assert.strictEqual(push.code, 0, push.out);
    // *.localhost resolves to the loopback interface (git/curl); fall back to an explicit resolve if it does not
    const cloneUrl = `http://git-registry.localhost:${port}/demo.git`;
    let clone = await git(['clone', '-q', cloneUrl, 'out'], work);
    if (clone.code !== 0) clone = await git(['-c', `http.curloptResolve=git-registry.localhost:${port}:127.0.0.1`, 'clone', '-q', cloneUrl, 'out'], work);
    assert.strictEqual(clone.code, 0, clone.out);
    assert.strictEqual(fs.readFileSync(path.join(work, 'out', 'README.md'), 'utf8'), 'type hosts\n');
    const refs = await req('GET', '/demo.git/info/refs?service=git-upload-pack', 'git-registry.localhost');
    assert.strictEqual(refs.status, 200);
    assert.strictEqual(refs.headers['x-rr-type-host'], 'git');
    // the web UI is served on the git host as well
    assert.strictEqual((await req('GET', '/', 'git-registry.localhost', { accept: 'text/html' })).status, 200);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('other hosts are the main host; a type without repositories is removed from the portal', async () => {
  const other = await req('GET', '/-/ping', 'svn-registry.localhost');
  assert.strictEqual(other.status, 200);
  assert.strictEqual(other.headers['x-rr-type-host'], undefined);
  assert.strictEqual((await req('GET', '/-/ping', 'npm-other.localhost')).headers['x-rr-type-host'], undefined);
  const n = puts.length;
  assert.strictEqual((await req('DELETE', '/api/v1/repos/files', 'registry.localhost', auth)).status, 200);
  await waitFor(() => puts.length > n);
  assert.deepStrictEqual(puts[puts.length - 1], ['npm', 'docker', 'git']);
  assert.strictEqual((await req('GET', '/docs/hello.txt', 'generic-registry.localhost')).status, 404);
  // a group of generic repositories brings the type back
  assert.strictEqual((await req('POST', '/api/v1/repos', 'registry.localhost', { ...auth, 'content-type': 'application/json' }, JSON.stringify({ name: 'raw', type: 'generic' }))).status, 201);
  await waitFor(() => puts[puts.length - 1].includes('generic'));
  assert.strictEqual(app.typeHosts.repoFor('generic'), 'raw');
});

test('a portal without dynamic hosts (before 1.8) is detected and not retried', async () => {
  portalMode = 'old';
  const n = puts.length;
  app.typeHosts.reported = null;
  assert.strictEqual(await app.typeHosts.sync(), null);
  assert.strictEqual(app.typeHosts.unsupported, true);
  app.typeHosts.schedule(0);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(puts.length, n);
  // type hosts keep working (routes can still be added manually in the portal)
  assert.strictEqual((await req('GET', '/-/ping', 'npm-registry.localhost')).headers['x-rr-type-host'], 'npm');
});

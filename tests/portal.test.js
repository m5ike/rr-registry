'use strict';
// AI Tools Portal single sign-on: signed identity header + portal credential checks.  Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { App } = require('../server/src/server');
const { Portal } = require('../server/src/portal');

const KEY = crypto.randomBytes(32).toString('hex');
let app;
let base;
let portal;
let portalCalls = 0;
let dataDir;

// fake portal: eva/eva-pass-123 is a publisher, bob/bob-pass-123 has no access to the registry
function startFakePortal() {
  portal = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      portalCalls++;
      const send = (st, obj) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url !== '/_portal/api/auth/verify' || req.headers.authorization !== `PortalApp registry ${KEY}`) return send(401, { error: 'app' });
      const { username, password } = JSON.parse(body);
      if (username === 'eva' && password === 'eva-pass-123') return send(200, { user: 'eva', role: 'publisher' });
      if (username === 'bob' && password === 'bob-pass-123') return send(403, { error: 'no access' });
      return send(401, { error: 'invalid credentials' });
    });
  });
  return new Promise((r) => portal.listen(0, '127.0.0.1', r));
}

function identity(user, role, key = KEY, ts = Math.floor(Date.now() / 1000)) {
  const data = `${user}|${role}|${ts}`;
  return `${data}|${crypto.createHmac('sha256', key).update(data).digest('hex')}`;
}

function req(method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${base}${p}`, { method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

test.before(async () => {
  await startFakePortal();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-portal-test-'));
  app = new App({ dataDir, port: 0, host: '127.0.0.1', apiToken: 'portal-test-token-123456', adminPassword: 'adminpass', quiet: true, logRequests: false, publicUrl: '' });
  app.portal = new Portal({ PORTAL_IDENTITY_KEY: KEY, PORTAL_APP_ID: 'registry', PORTAL_INTERNAL_URL: `http://127.0.0.1:${portal.address().port}` });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
});

test.after(async () => {
  await app.close();
  portal.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('signed portal identity logs the user in with the role granted by the portal', async () => {
  const r = await req('GET', '/api/v1/auth/whoami', { 'x-portal-identity': identity('eva', 'publisher') });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual({ name: r.json.name, role: r.json.role, via: r.json.via }, { name: 'eva', role: 'publisher', via: 'portal' });
});

test('forged, stale or unknown-role identities are ignored', async () => {
  assert.strictEqual((await req('GET', '/api/v1/auth/whoami', { 'x-portal-identity': identity('eva', 'admin', 'f'.repeat(64)) })).status, 401);
  assert.strictEqual((await req('GET', '/api/v1/auth/whoami', { 'x-portal-identity': identity('eva', 'admin', KEY, Math.floor(Date.now() / 1000) - 3600) })).status, 401);
  assert.strictEqual((await req('GET', '/api/v1/auth/whoami', { 'x-portal-identity': identity('eva', 'superuser') })).status, 401);
});

test('without the portal environment the header is not trusted (standalone)', async () => {
  const saved = app.portal;
  app.portal = new Portal({});
  try {
    assert.strictEqual((await req('GET', '/api/v1/auth/whoami', { 'x-portal-identity': identity('eva', 'admin') })).status, 401);
  } finally {
    app.portal = saved;
  }
});

test('CLI Basic auth with the portal password (docker login / git)', async () => {
  const r = await req('GET', '/api/v1/auth/whoami', { authorization: basic('eva', 'eva-pass-123') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.role, 'publisher');
  assert.strictEqual(r.json.via, 'portal-password');
  const calls = portalCalls;
  await req('GET', '/api/v1/auth/whoami', { authorization: basic('eva', 'eva-pass-123') });
  assert.strictEqual(portalCalls, calls, 'successful checks are cached');
  assert.strictEqual((await req('GET', '/api/v1/auth/whoami', { authorization: basic('eva', 'wrong-pass') })).status, 401);
  assert.strictEqual((await req('GET', '/api/v1/auth/whoami', { authorization: basic('bob', 'bob-pass-123') })).status, 401, 'no access in the portal');
  assert.strictEqual((await req('GET', '/api/v1/auth/whoami', { authorization: basic('admin', 'adminpass') })).json.role, 'admin', 'local accounts still work');
});

test('npm login and web login accept portal accounts', async () => {
  const npm = await req('PUT', '/-/user/org.couchdb.user:eva', {}, { name: 'eva', password: 'eva-pass-123' });
  assert.strictEqual(npm.status, 201);
  const who = await req('GET', '/-/whoami', { authorization: `Bearer ${npm.json.token}` });
  assert.strictEqual(who.json.username, 'eva');
  const web = await req('POST', '/api/v1/auth/login', {}, { username: 'eva', password: 'eva-pass-123' });
  assert.ok(web.status >= 200 && web.status < 300, `login status ${web.status}`);
  assert.strictEqual(web.json.user.role, 'publisher');
});

test('admin login form offers the portal sign-in only when attached', async () => {
  assert.match((await req('GET', '/admin/config.js')).text, /"portal":true/);
  const saved = app.portal;
  app.portal = new Portal({});
  try {
    assert.match((await req('GET', '/admin/config.js')).text, /"portal":false/);
  } finally {
    app.portal = saved;
  }
});

test('the Docker image ships the portal manifest (served at /.well-known/portal-app.json)', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^COPY portal\.app\.json \.\/$/m);
  const ignored = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(!ignored.includes('portal.app.json'));
});


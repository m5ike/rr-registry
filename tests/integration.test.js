'use strict';
// Integration tests: real server on a random port + mock upstream registry.  Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { App } = require('../server/src/server');
const tar = require('../server/src/util/tar');
// load generated client the same way it is shipped
function loadClient() {
  const m = { exports: {} };
  new Function('module', 'exports', require('../tools/gen-clients').js(require('../api/spec.json'), 'test'))(m, m.exports);
  return m.exports;
}

const TOKEN = 'integration-test-token-123456';
let app;
let base;
let upstream;
let upstreamBase;
let upstreamHits = 0;
let dataDir;

function pkgTarball(name, version, extra = {}) {
  return tar.create([
    { name: 'package/package.json', data: JSON.stringify({ name, version, description: `${name} desc`, keywords: ['demo'], ...extra }) },
    { name: 'package/index.js', data: 'module.exports = 42;\n' },
    { name: 'package/README.md', data: `# ${name}\n` },
  ]);
}

function npmPublishBody(name, version, tag = 'latest') {
  const tgz = pkgTarball(name, version);
  const file = `${name.split('/').pop()}-${version}.tgz`;
  return {
    _id: name, name, description: `${name} desc`, 'dist-tags': { [tag]: version },
    versions: { [version]: { name, version, description: `${name} desc`, dist: { tarball: `http://x/${name}/-/${file}`, shasum: crypto.createHash('sha1').update(tgz).digest('hex') } } },
    _attachments: { [file]: { content_type: 'application/octet-stream', data: tgz.toString('base64'), length: tgz.length } },
  };
}

async function req(method, p, { body, headers = {}, token = TOKEN, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let b = body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(base + p, { method, headers: h, body: b });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, headers: r.headers, json, buf: raw ? buf : undefined, text: buf.toString() };
}

test.before(async () => {
  // mock upstream registry: serves "remote-pkg" and "@ext/lib"
  const remoteTgz = pkgTarball('remote-pkg', '2.0.0');
  upstream = http.createServer((q, s) => {
    upstreamHits++;
    const u = decodeURIComponent(q.url.split('?')[0]);
    const send = (st, obj, type = 'application/json') => { const b = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj)); s.writeHead(st, { 'content-type': type }); s.end(b); };
    if (u === '/remote-pkg') {
      return send(200, { name: 'remote-pkg', 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { name: 'remote-pkg', version: '2.0.0', dist: { tarball: `${upstreamBase}/remote-pkg/-/remote-pkg-2.0.0.tgz` } } } });
    }
    if (u === '/remote-pkg/-/remote-pkg-2.0.0.tgz') return send(200, remoteTgz, 'application/octet-stream');
    if (u === '/@ext/lib') {
      return send(200, { name: '@ext/lib', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: '@ext/lib', version: '1.0.0', dist: { tarball: 'https://cdn.elsewhere.example/lib.tgz' } } } });
    }
    if (u === '/mirror/files/a.txt') return send(200, Buffer.from('remote file'), 'text/plain');
    if (u === '/-/npm/v1/security/advisories/bulk') return send(200, { upstream: 'audit' });
    return send(404, { error: 'not found' });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-test-'));
  app = new App({ dataDir, port: 0, host: '127.0.0.1', apiToken: TOKEN, adminPassword: 'adminpass', upstream: upstreamBase, quiet: true, logRequests: false, publicUrl: '' });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
});

test.after(async () => {
  await app.close();
  upstream.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('homepage, admin, static, downloads, install.sh', async () => {
  let r = await req('GET', '/', { headers: { accept: 'text/html' } });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /rr_bash-cli/);
  assert.match(r.text, /m5ike/);
  r = await req('GET', '/admin/', { headers: { accept: 'text/html' } });
  assert.match(r.text, /admin\.js/);
  r = await req('GET', '/admin/rr-client.js');
  assert.match(r.text, /class RRClient/);
  r = await req('GET', '/static/rr-client.js');
  assert.strictEqual(r.status, 200);
  r = await req('GET', '/downloads/');
  assert.strictEqual(r.json.length, 4);
  r = await req('GET', `/downloads/${r.json[0].file}`, { raw: true });
  assert.strictEqual(r.status, 200);
  assert.ok(tar.readPackageJson(r.buf).name.startsWith('@m5ike/'));
  r = await req('GET', '/install.sh');
  assert.match(r.text, new RegExp(base.replace(/[.]/g, '\\.')));
});

test('client packages are published in the registry with maintainer m5ike', async () => {
  for (const name of ['@m5ike/rr-client', '@m5ike/rr_bash-cli', '@m5ike/rr_bash-gui', '@m5ike/rr_web-guicli']) {
    const r = await req('GET', `/${name.replace('/', '%2f')}`, { token: '' });
    assert.strictEqual(r.status, 200, name);
    assert.strictEqual(r.json.maintainers[0].name, 'm5ike');
    const t = await req('GET', new URL(r.json.versions[r.json['dist-tags'].latest].dist.tarball).pathname, { token: '', raw: true });
    assert.strictEqual(t.status, 200);
  }
});

test('npm protocol: publish, fetch, version, tarball, dist-tags, deprecate, unpublish', async () => {
  let r = await req('PUT', '/@demo%2fpkg', { body: npmPublishBody('@demo/pkg', '1.0.0'), token: '' });
  assert.strictEqual(r.status, 401);
  r = await req('PUT', '/@demo%2fpkg', { body: npmPublishBody('@demo/pkg', '1.0.0') });
  assert.strictEqual(r.status, 201, r.text);
  r = await req('PUT', '/@demo%2fpkg', { body: npmPublishBody('@demo/pkg', '1.0.0') });
  assert.strictEqual(r.status, 403, 'republish same version must fail');
  r = await req('PUT', '/@demo%2fpkg', { body: npmPublishBody('@demo/pkg', '1.1.0-beta.1', 'beta') });
  assert.strictEqual(r.status, 201);

  r = await req('GET', '/@demo%2fpkg', { token: '' });
  assert.deepStrictEqual(r.json['dist-tags'], { latest: '1.0.0', beta: '1.1.0-beta.1' });
  assert.strictEqual(r.json.readme, '# @demo/pkg\n');
  const tb = r.json.versions['1.0.0'].dist.tarball;
  assert.strictEqual(tb, `${base}/@demo/pkg/-/pkg-1.0.0.tgz`);
  assert.match(r.json.versions['1.0.0'].dist.integrity, /^sha512-/);
  const t = await req('GET', '/@demo/pkg/-/pkg-1.0.0.tgz', { token: '', raw: true });
  assert.strictEqual(crypto.createHash('sha1').update(t.buf).digest('hex'), r.json.versions['1.0.0'].dist.shasum);

  r = await req('GET', '/@demo%2fpkg/beta', { token: '' });
  assert.strictEqual(r.json.version, '1.1.0-beta.1');

  r = await req('PUT', '/-/package/@demo%2fpkg/dist-tags/next', { body: '"1.1.0-beta.1"', headers: { 'content-type': 'application/json' } });
  assert.strictEqual(r.status, 201);
  r = await req('GET', '/-/package/@demo%2fpkg/dist-tags', { token: '' });
  assert.strictEqual(r.json.next, '1.1.0-beta.1');
  r = await req('DELETE', '/-/package/@demo%2fpkg/dist-tags/next');
  assert.strictEqual(r.status, 200);

  // npm deprecate: PUT full document
  const doc = (await req('GET', '/@demo%2fpkg')).json;
  doc.versions['1.0.0'].deprecated = 'use 2.x';
  r = await req('PUT', '/@demo%2fpkg', { body: doc });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await req('GET', '/@demo%2fpkg')).json.versions['1.0.0'].deprecated, 'use 2.x');

  // npm unpublish pkg@version: PUT -rev without that version
  const doc2 = (await req('GET', '/@demo%2fpkg')).json;
  delete doc2.versions['1.1.0-beta.1'];
  r = await req('PUT', `/@demo%2fpkg/-rev/${doc2._rev}`, { body: doc2 });
  assert.strictEqual(r.status, 201);
  r = await req('GET', '/@demo%2fpkg');
  assert.deepStrictEqual(Object.keys(r.json.versions), ['1.0.0']);
  assert.strictEqual(r.json['dist-tags'].beta, undefined);

  // search
  r = await req('GET', '/-/v1/search?text=demo&size=5', { token: '' });
  assert.ok(r.json.objects.some((o) => o.package.name === '@demo/pkg'));
  assert.ok(r.json.objects[0].package.maintainers[0].username);

  // full unpublish
  r = await req('DELETE', `/@demo%2fpkg/-rev/${r.json._rev || 'x'}`);
  assert.strictEqual(r.status, 200);
  r = await req('GET', '/@demo%2fpkg', { headers: { 'x-rr-key': 'none' } });
  assert.notStrictEqual(r.status, 200);
});

test('npm login (legacy), whoami, logout', async () => {
  let r = await req('POST', '/api/v1/users', { body: { name: 'bob', password: 'bobpass', role: 'publisher' } });
  assert.strictEqual(r.status, 201);
  r = await req('PUT', '/-/user/org.couchdb.user:bob', { body: { name: 'bob', password: 'wrong' }, token: '' });
  assert.strictEqual(r.status, 401);
  r = await req('PUT', '/-/user/org.couchdb.user:bob', { body: { name: 'bob', password: 'bobpass' }, token: '' });
  assert.strictEqual(r.status, 201);
  const tok = r.json.token;
  r = await req('GET', '/-/whoami', { token: tok });
  assert.strictEqual(r.json.username, 'bob');
  r = await req('PUT', '/bobs-pkg', { body: npmPublishBody('bobs-pkg', '0.1.0'), token: tok });
  assert.strictEqual(r.status, 201);
  r = await req('POST', '/api/v1/repos', { body: { name: 'x' }, token: tok });
  assert.strictEqual(r.status, 403, 'publisher cannot manage repos');
  r = await req('DELETE', `/-/user/token/${tok}`, { token: tok });
  r = await req('GET', '/-/whoami', { token: tok });
  assert.strictEqual(r.status, 401);
  r = await req('GET', '/-/whoami', { token: '', headers: { authorization: `Basic ${Buffer.from('bob:bobpass').toString('base64')}` } });
  assert.strictEqual(r.json.username, 'bob');
});

test('routing: fallback proxy with cache and tarball rewrite', async () => {
  upstreamHits = 0;
  let r = await req('GET', '/remote-pkg', { token: '' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('x-rr-cache'), 'MISS');
  assert.strictEqual(r.headers.get('x-rr-route'), 'npmjs-fallback');
  const tb = r.json.versions['2.0.0'].dist.tarball;
  assert.strictEqual(tb, `${base}/remote-pkg/-/remote-pkg-2.0.0.tgz`);
  r = await req('GET', '/remote-pkg', { token: '' });
  assert.strictEqual(r.headers.get('x-rr-cache'), 'HIT');
  assert.strictEqual(upstreamHits, 1);
  r = await req('GET', '/remote-pkg/-/remote-pkg-2.0.0.tgz', { token: '', raw: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(tar.readPackageJson(r.buf).version, '2.0.0');
  r = await req('GET', '/does-not-exist-anywhere', { token: '' });
  assert.strictEqual(r.status, 404);

  // tarball hosted elsewhere -> signed passthrough URL
  r = await req('GET', '/@ext%2flib', { token: '' });
  assert.match(r.json.versions['1.0.0'].dist.tarball, /\/-\/rr\/t\/npmjs\//);
  r = await req('GET', new URL(r.json.versions['1.0.0'].dist.tarball).pathname.replace(/\/[^/]+\/([^/]+)$/, '/AAAAinvalidsig/$1'), { token: '' });
  assert.strictEqual(r.status, 403);

  // cache API
  r = await req('GET', '/api/v1/cache');
  assert.ok(r.json.entries >= 2);
  assert.ok(r.json.hits >= 1);
  r = await req('GET', '/api/v1/cache/entries?q=remote-pkg');
  assert.ok(r.json.entries.length >= 1);
  r = await req('DELETE', '/api/v1/cache?q=remote-pkg');
  assert.ok(r.json.removed >= 1);
  r = await req('GET', '/remote-pkg', { token: '' });
  assert.strictEqual(r.headers.get('x-rr-cache'), 'MISS');

  // npm audit is forwarded (POST allowed by default rule)
  r = await req('POST', '/-/npm/v1/security/advisories/bulk', { body: {}, token: '' });
  assert.deepStrictEqual(r.json, { upstream: 'audit' });
});

test('routing: always rule, key routing, generic repo mirror, test endpoint', async () => {
  // local package that also exists "remotely": always-rule with key forces upstream
  await req('PUT', '/remote-pkg', { body: npmPublishBody('remote-pkg', '0.0.1') });
  let r = await req('GET', '/remote-pkg', { token: '' });
  assert.deepStrictEqual(Object.keys(r.json.versions), ['0.0.1'], 'local wins without key');

  r = await req('POST', '/api/v1/routes', { body: { name: 'upstream-key', when: 'always', key: 'up', target: upstreamBase, priority: 5 } });
  assert.strictEqual(r.status, 201, r.text);
  const ruleId = r.json.id;
  r = await req('GET', '/~up/remote-pkg', { token: '' });
  assert.deepStrictEqual(Object.keys(r.json.versions), ['2.0.0'], 'key prefix routes upstream');
  assert.strictEqual(r.json.versions['2.0.0'].dist.tarball, `${base}/~up/remote-pkg/-/remote-pkg-2.0.0.tgz`);
  r = await req('GET', '/remote-pkg', { token: '', headers: { 'x-rr-key': 'up' } });
  assert.deepStrictEqual(Object.keys(r.json.versions), ['2.0.0'], 'key header routes upstream');
  r = await req('GET', '/remote-pkg?rr_key=up', { token: '' });
  assert.deepStrictEqual(Object.keys(r.json.versions), ['2.0.0'], 'key query routes upstream');

  r = await req('POST', '/api/v1/routes/test', { body: { path: '/remote-pkg', key: 'up' } });
  assert.strictEqual(r.json.always.name, 'upstream-key');
  r = await req('POST', '/api/v1/routes/test', { body: { path: '/remote-pkg' } });
  assert.strictEqual(r.json.always, null);

  r = await req('PUT', `/api/v1/routes/${ruleId}`, { body: { enabled: false } });
  assert.strictEqual(r.json.enabled, false);
  r = await req('GET', '/~up/remote-pkg', { token: '' });
  assert.deepStrictEqual(Object.keys(r.json.versions), ['0.0.1']);
  await req('DELETE', `/api/v1/routes/${ruleId}`);

  // generic repo with mirror rule (glob + stripPrefix/addPrefix)
  r = await req('POST', '/api/v1/routes', { body: { name: 'mirror', when: 'notfound', repo: 'files', matchOn: 'path', matchType: 'glob', pattern: '/mirror/**', target: upstreamBase, cacheTtl: 60 } });
  assert.strictEqual(r.status, 201);
  r = await req('GET', '/r/files/mirror/files/a.txt', { token: '' });
  assert.strictEqual(r.text, 'remote file');
  r = await req('GET', '/r/files/other/a.txt', { token: '' });
  assert.strictEqual(r.status, 404);
  r = await req('POST', '/api/v1/routes', { body: { name: 'bad', target: 'nope' } });
  assert.strictEqual(r.status, 400);
});

test('generic repository: upload, list, download, delete', async () => {
  let r = await req('PUT', '/r/files/dir/sub/hello.txt', { body: 'hello world', headers: { 'content-type': 'text/plain' } });
  assert.strictEqual(r.status, 201, r.text);
  r = await req('GET', '/r/files/dir/sub/hello.txt', { token: '' });
  assert.strictEqual(r.text, 'hello world');
  r = await req('GET', '/r/files/dir/', { token: '' });
  assert.strictEqual(r.json.children[0].name, 'sub');
  r = await req('GET', '/r/files/../config/users.json', { token: '' });
  assert.notStrictEqual(r.status, 200);
  r = await req('DELETE', '/r/files/dir/sub/hello.txt');
  assert.strictEqual(r.status, 200);
  r = await req('GET', '/r/files/dir/sub/hello.txt', { token: '' });
  assert.strictEqual(r.status, 404);
});

test('management API via generated JS client library', async () => {
  const RRClient = loadClient();
  const anon = new RRClient({ baseUrl: base });
  await assert.rejects(() => anon.listRoutes(), (e) => e.status === 401);
  const s = await anon.status();
  assert.strictEqual(s.maintainer, 'm5ike');

  const rr = new RRClient({ baseUrl: base });
  const login = await rr.signIn('admin', 'adminpass');
  assert.strictEqual(login.user.role, 'admin');
  assert.strictEqual((await rr.whoami()).name, 'admin');

  const repo = await rr.createRepo({ name: 'internal', type: 'npm', description: 'Interní' });
  assert.strictEqual(repo.path, '/r/internal/');
  await assert.rejects(() => rr.createRepo({ name: 'internal' }), (e) => e.status === 409);
  await rr.updateRepo('internal', { description: 'změněno', public: false });
  assert.strictEqual((await rr.getRepo('internal')).public, false);

  const up = await rr.uploadPackage('internal', pkgTarball('@corp/utils', '3.1.4'), { tag: 'latest' });
  assert.strictEqual(up.version, '3.1.4');
  const list = await rr.listPackages('internal');
  assert.strictEqual(list[0].name, '@corp/utils');
  const doc = await rr.getPackage('internal', '@corp/utils');
  assert.strictEqual(doc.versions['3.1.4'].dist.tarball, `${base}/r/internal/@corp/utils/-/utils-3.1.4.tgz`);
  await rr.setDistTag('internal', '@corp/utils', 'stable', { version: '3.1.4' });
  await rr.deprecateVersion('internal', '@corp/utils', '3.1.4', { message: 'pozor' });
  const bytes = await rr.downloadTarball('internal', '@corp/utils', 'stable');
  assert.ok(bytes instanceof Uint8Array && bytes.length > 50);

  // private repo: anonymous read denied, token read allowed
  let r = await req('GET', '/r/internal/@corp%2futils', { token: '' });
  assert.strictEqual(r.status, 401);
  r = await req('GET', '/r/internal/@corp%2futils');
  assert.strictEqual(r.status, 200);

  const found = await rr.search({ q: 'utils' });
  assert.ok(found.objects.some((o) => o.package.name === '@corp/utils'));

  const tree = await rr.tree('internal', { path: '/', depth: 3 });
  assert.strictEqual(tree.children[0].name, '@corp');
  const st = await rr.stat('internal', { path: '/@corp/utils/packument.json' });
  assert.strictEqual(st.type, 'file');
  await rr.writeFile('files', new TextEncoder().encode('abc'), { path: '/notes/a.txt' });
  assert.strictEqual(new TextDecoder().decode(await rr.readFile('files', { path: '/notes/a.txt' })), 'abc');
  await rr.mkdir('files', { path: '/empty' });
  await rr.deleteFile('files', { path: '/notes' });
  await assert.rejects(() => rr.stat('files', { path: '/notes/a.txt' }), (e) => e.status === 404);
  await assert.rejects(() => rr.readFile('files', { path: '../../etc/passwd' }), (e) => e.status === 400);

  await rr.deleteVersion('internal', '@corp/utils', '3.1.4');
  await assert.rejects(() => rr.getPackage('internal', '@corp/utils'), (e) => e.status === 404);

  const u = await rr.createUser({ name: 'carol', password: 'carolpw', role: 'reader' });
  assert.strictEqual(u.role, 'reader');
  await rr.updateUser('carol', { role: 'publisher' });
  const t = await rr.createToken({ name: 'ci', user: 'carol', readonly: true });
  assert.match(t.token, /^rr_/);
  const ro = new RRClient({ baseUrl: base, token: t.token });
  assert.strictEqual((await ro.whoami()).readonly, true);
  await assert.rejects(() => ro.uploadPackage('npm', pkgTarball('ro-pkg', '1.0.0')), (e) => e.status === 403);
  assert.ok((await rr.listTokens()).some((x) => x.id === t.id));
  await rr.revokeToken(t.id);
  await assert.rejects(() => ro.whoami(), (e) => e.status === 401);
  await rr.deleteUser('carol');

  const settings = await rr.updateSettings({ title: 'Test RR', cacheTtl: 120 });
  assert.strictEqual(settings.title, 'Test RR');
  await assert.rejects(() => rr.updateSettings({ defaultRepo: 'nope' }), (e) => e.status === 400);
  await assert.rejects(() => rr.updateSettings({ bogus: 1 }), (e) => e.status === 400);
  assert.ok((await rr.listPlugins()).some((p) => p.name === 'router' && p.enabled));
  const logs = await rr.getLogs({ limit: 5 });
  assert.ok(logs.audit.length > 0);
  assert.strictEqual((await rr.listClients()).length, 4);
  assert.strictEqual((await rr.getSpec()).operations.length, Object.keys(RRClient.operations).length);
  await assert.rejects(() => rr.deleteRepo('npm'), (e) => e.status === 400);
  await rr.deleteRepo('internal', { purge: 1 });
  await rr.logout();
  await assert.rejects(() => rr.whoami(), (e) => e.status === 401);
});

test('anonymous read can be disabled', async () => {
  let r = await req('PUT', '/api/v1/settings', { body: { anonymousRead: false } });
  assert.strictEqual(r.status, 200);
  r = await req('GET', '/remote-pkg', { token: '' });
  assert.strictEqual(r.status, 401);
  r = await req('GET', '/remote-pkg');
  assert.strictEqual(r.status, 200);
  await req('PUT', '/api/v1/settings', { body: { anonymousRead: true } });
});

test('rebuild clients via API is idempotent', async () => {
  const r = await req('POST', '/api/v1/clients/rebuild');
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.packages.length, 4);
  assert.deepStrictEqual(r.json.published, []);
});

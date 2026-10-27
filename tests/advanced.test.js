'use strict';
// Advanced repository features: webhooks (HMAC, retries, formats), quotas, immutability, per-repo ACL,
// group repositories, cleanup/retention policies, download statistics, scheduled tasks and
// "push" replication of npm / generic content to another registry.   Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { App } = require('../server/src/server');
const tar = require('../server/src/util/tar');

const TOKEN = 'adv-test-token-1234567890';
let app;
let base;
let dataDir;
let remote;
let remoteBase;
let remoteDir;
let hookServer;
let hookUrl;
const received = [];
let failNext = 0;

const tgz = (name, version) => tar.create([
  { name: 'package/package.json', data: JSON.stringify({ name, version, description: `${name} desc` }) },
  { name: 'package/index.js', data: `module.exports = ${JSON.stringify(version)};\n` },
]);

async function req(method, p, { body, token = TOKEN, headers = {}, b = base } = {}) {
  const h = { ...headers };
  if (token) h.authorization = token.includes(':') ? `Basic ${Buffer.from(token).toString('base64')}` : `Bearer ${token}`;
  let data = body;
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(b + p, { method, headers: h, body: data });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test.before(async () => {
  hookServer = http.createServer((q, s) => {
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => {
      if (failNext > 0) { failNext--; s.writeHead(500); s.end('fail'); return; }
      received.push({ headers: q.headers, body: Buffer.concat(chunks).toString() });
      s.writeHead(200); s.end('ok');
    });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${hookServer.address().port}/hook`;

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-adv-'));
  remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-adv-remote-'));
  app = new App({ dataDir, apiToken: TOKEN, adminPassword: 'adminpass', upstream: '', quiet: true, logRequests: false, scheduler: false, retryScale: 0.01 });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
  remote = new App({ dataDir: remoteDir, apiToken: 'remote-token-123456789', adminPassword: 'x', upstream: '', quiet: true, logRequests: false, scheduler: false });
  await remote.listen(0, '127.0.0.1');
  remoteBase = `http://127.0.0.1:${remote.port}`;
});

test.after(async () => {
  await app.close();
  await remote.close();
  hookServer.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(remoteDir, { recursive: true, force: true });
});

test('webhooks: filtered delivery, HMAC signature, retries, slack format, test ping', async () => {
  let r = await req('POST', '/api/v1/webhooks', { body: { name: 'ci', url: hookUrl, events: ['npm.*'], repos: ['npm'], secret: 's3cret' } });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.secret, '***');
  const id = r.json.id;
  r = await req('POST', '/api/v1/webhooks', { body: { name: 'bad', url: hookUrl, events: ['nope.event'] } });
  assert.strictEqual(r.status, 400);

  received.length = 0;
  await req('POST', '/api/v1/repos/npm/packages', { body: tgz('hooked', '1.0.0') });
  await req('PUT', '/r/files/x.txt', { body: 'x' }); // not subscribed
  assert.ok(await waitFor(() => received.length >= 1));
  await new Promise((res) => setTimeout(res, 100));
  assert.strictEqual(received.length, 1);
  const d = received[0];
  assert.strictEqual(d.headers['x-rr-event'], 'npm.publish');
  const expected = `sha256=${crypto.createHmac('sha256', 's3cret').update(d.body).digest('hex')}`;
  assert.strictEqual(d.headers['x-rr-signature-256'], expected);
  const payload = JSON.parse(d.body);
  assert.strictEqual(payload.data.name, 'hooked');
  assert.deepStrictEqual(payload.data.versions, ['1.0.0']);

  // failed deliveries are retried
  received.length = 0;
  failNext = 1;
  await req('POST', '/api/v1/repos/npm/packages', { body: tgz('hooked', '1.0.1') });
  assert.ok(await waitFor(() => received.length >= 1), 'retried delivery');
  r = await req('GET', `/api/v1/webhooks/deliveries?id=${id}`);
  assert.ok(r.json.some((x) => !x.ok && x.attempt === 1) && r.json.some((x) => x.ok && x.attempt === 2));

  // slack format + test ping
  r = await req('PUT', `/api/v1/webhooks/${id}`, { body: { format: 'slack', secret: '***' } });
  assert.strictEqual(r.json.format, 'slack');
  received.length = 0;
  r = await req('POST', `/api/v1/webhooks/${id}/test`);
  assert.strictEqual(r.json.ok, true);
  assert.ok(JSON.parse(received[0].body).text.includes('ping'));
  assert.strictEqual(received[0].headers['x-rr-signature-256'], `sha256=${crypto.createHmac('sha256', 's3cret').update(received[0].body).digest('hex')}`, 'secret kept when "***" is sent back');
  r = await req('GET', '/api/v1/events?limit=10');
  assert.ok(r.json.types.includes('git.push'));
  assert.ok(r.json.events.some((e) => e.type === 'npm.publish'));
  await req('DELETE', `/api/v1/webhooks/${id}`);
});

test('quota: writes beyond the repository quota are refused (507)', async () => {
  let r = await req('POST', '/api/v1/repos', { body: { name: 'small', type: 'generic', quotaMb: 0.001 } });
  assert.strictEqual(r.status, 201, r.text);
  r = await req('PUT', '/r/small/a.bin', { body: Buffer.alloc(800) });
  assert.strictEqual(r.status, 201);
  r = await req('PUT', '/r/small/b.bin', { body: Buffer.alloc(800) });
  assert.strictEqual(r.status, 507);
  assert.match(r.json.error, /quota exceeded/);
  r = await req('GET', '/api/v1/repos/small');
  assert.ok(r.json.quota.usedBytes >= 800);
  r = await req('PUT', '/api/v1/repos/small', { body: { quotaMb: 0 } });
  r = await req('PUT', '/r/small/b.bin', { body: Buffer.alloc(800) });
  assert.strictEqual(r.status, 201);
});

test('immutable repositories: no unpublish, no overwrite, no delete', async () => {
  await req('POST', '/api/v1/repos', { body: { name: 'release', type: 'npm', immutable: true } });
  let r = await req('POST', '/api/v1/repos/release/packages', { body: tgz('stable-lib', '1.0.0') });
  assert.strictEqual(r.status, 201);
  r = await req('DELETE', '/api/v1/repos/release/packages/stable-lib/versions/1.0.0');
  assert.strictEqual(r.status, 403);
  r = await req('DELETE', '/api/v1/repos/release/packages/stable-lib');
  assert.strictEqual(r.status, 403);
  await req('POST', '/api/v1/repos', { body: { name: 'artifacts', type: 'generic', immutable: true } });
  r = await req('PUT', '/r/artifacts/app-1.0.zip', { body: 'v1' });
  assert.strictEqual(r.status, 201);
  r = await req('PUT', '/r/artifacts/app-1.0.zip', { body: 'v2' });
  assert.strictEqual(r.status, 403);
  r = await req('DELETE', '/r/artifacts/app-1.0.zip');
  assert.strictEqual(r.status, 403);
  r = await req('POST', '/api/v1/repos/artifacts/cleanup', { body: { dryRun: false, policy: { maxVersions: 1 } } });
  assert.strictEqual(r.status, 403);
});

test('ACL: per-repository access overrides user roles', async () => {
  await req('POST', '/api/v1/users', { body: { name: 'alice', password: 'alicepw', role: 'publisher' } });
  await req('POST', '/api/v1/users', { body: { name: 'bob', password: 'bobpass', role: 'reader' } });
  let r = await req('POST', '/api/v1/repos', { body: { name: 'secret', type: 'generic', public: false, acl: { bob: 'publish', alice: 'none' } } });
  assert.strictEqual(r.status, 201, r.text);
  r = await req('PUT', '/r/secret/f.txt', { body: 'bob was here', token: 'bob:bobpass' });
  assert.strictEqual(r.status, 201, 'reader with publish ACL may upload');
  r = await req('GET', '/r/secret/f.txt', { token: 'alice:alicepw' });
  assert.strictEqual(r.status, 403, 'publisher with ACL none is denied');
  r = await req('GET', '/r/secret/f.txt', { token: '' });
  assert.strictEqual(r.status, 401);
  r = await req('GET', '/r/secret/f.txt');
  assert.strictEqual(r.text, 'bob was here', 'admin token always allowed');
  r = await req('PUT', '/api/v1/repos/secret', { body: { acl: { bob: 'superuser' } } });
  assert.strictEqual(r.status, 400);
});

test('group repository: merged npm metadata, search, publish through deployTo', async () => {
  await req('POST', '/api/v1/repos', { body: { name: 'team', type: 'npm' } });
  await req('POST', '/api/v1/repos/npm/packages', { body: tgz('shared', '1.0.0') });
  await req('POST', '/api/v1/repos/team/packages', { body: tgz('shared', '2.0.0') });
  await req('POST', '/api/v1/repos/team/packages', { body: tgz('team-only', '0.1.0') });
  let r = await req('POST', '/api/v1/repos', { body: { name: 'all', type: 'group', members: 'team,npm', deployTo: 'team' } });
  assert.strictEqual(r.status, 201, r.text);
  r = await req('POST', '/api/v1/repos', { body: { name: 'mixed', type: 'group', members: ['npm', 'files'] } });
  assert.strictEqual(r.status, 400, 'members must share a type');

  r = await req('GET', '/r/all/shared', { token: '' });
  assert.deepStrictEqual(Object.keys(r.json.versions).sort(), ['1.0.0', '2.0.0']);
  assert.strictEqual(r.json['dist-tags'].latest, '2.0.0');
  const tb = r.json.versions['1.0.0'].dist.tarball;
  assert.strictEqual(tb, `${base}/r/all/shared/-/shared-1.0.0.tgz`);
  const t = await fetch(tb);
  assert.strictEqual(t.status, 200);
  r = await req('GET', '/r/all/-/v1/search?text=team', { token: '' });
  assert.ok(r.json.objects.some((o) => o.package.name === 'team-only'));
  r = await req('GET', '/api/v1/repos/all/packages');
  assert.ok(r.json.some((p) => p.name === 'team-only' && p.member === 'team'));

  // npm publish through the group lands in deployTo
  const pkg = tgz('via-group', '1.0.0');
  r = await req('PUT', '/r/all/via-group', {
    body: {
      name: 'via-group', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'via-group', version: '1.0.0' } },
      _attachments: { 'via-group-1.0.0.tgz': { data: pkg.toString('base64'), length: pkg.length } },
    },
  });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual((await req('GET', '/r/team/via-group')).status, 200);
  r = await req('GET', '/r/all/nothing-here', { token: '' });
  assert.strictEqual(r.status, 404);
});

test('cleanup policies: npm versions, generic files, dry run, scheduled task', async () => {
  await req('POST', '/api/v1/repos', { body: { name: 'nightly', type: 'npm' } });
  for (const v of ['1.0.0', '1.1.0', '1.2.0', '2.0.0-beta.1', '2.0.0-beta.2', '2.0.0']) await req('POST', '/api/v1/repos/nightly/packages', { body: tgz('nl', v), token: TOKEN });
  await req('PUT', '/api/v1/repos/nightly/packages/nl/dist-tags/legacy', { body: { version: '1.0.0' } });
  let r = await req('POST', '/api/v1/repos/nightly/cleanup', { body: { dryRun: true, policy: { maxVersions: 2 } } });
  assert.strictEqual(r.status, 201, r.text);
  assert.deepStrictEqual(r.json.actions.map((a) => a.target).sort(), ['nl@1.1.0', 'nl@1.2.0', 'nl@2.0.0-beta.1'], 'keeps newest 2 and the tagged legacy version');
  assert.strictEqual(Object.keys((await req('GET', '/api/v1/repos/nightly/packages/nl')).json.versions).length, 6, 'dry run changes nothing');
  r = await req('PUT', '/api/v1/repos/nightly', { body: { cleanup: { enabled: true, maxVersions: 1, prereleaseOnly: true } } });
  assert.strictEqual(r.json.cleanup.prereleaseOnly, true);
  r = await req('POST', '/api/v1/tasks/cleanup/run');
  assert.ok(r.json.lastResult.repos.some((x) => x.repo === 'nightly'));
  r = await req('GET', '/api/v1/repos/nightly/packages/nl');
  assert.deepStrictEqual(Object.keys(r.json.versions).sort(), ['1.0.0', '1.1.0', '1.2.0', '2.0.0', '2.0.0-beta.2'], 'only the old pre-release was removed');
  r = await req('POST', '/api/v1/repos/nightly/cleanup', { body: { dryRun: false, policy: {} } });
  assert.strictEqual(r.status, 201, 'falls back to the stored policy');

  await req('POST', '/api/v1/repos', { body: { name: 'builds', type: 'generic' } });
  for (let i = 1; i <= 4; i++) {
    await req('PUT', `/r/builds/app/build-${i}.zip`, { body: `b${i}` });
    await new Promise((res) => setTimeout(res, 15));
  }
  r = await req('POST', '/api/v1/repos/builds/cleanup', { body: { policy: { maxVersions: 2, pattern: '/app/*.zip' } } });
  assert.deepStrictEqual(r.json.actions.map((a) => a.target).sort(), ['/app/build-1.zip', '/app/build-2.zip']);
  assert.strictEqual((await req('GET', '/r/builds/app/build-1.zip')).status, 404);
  assert.strictEqual((await req('GET', '/r/builds/app/build-4.zip')).status, 200);
  r = await req('POST', '/api/v1/repos/builds/cleanup', { body: { policy: { maxVersions: 0, maxAgeDays: 0 } } });
  assert.strictEqual(r.status, 400, 'a policy needs a rule');
});

test('download statistics per repository and item', async () => {
  for (let i = 0; i < 3; i++) await req('GET', '/r/builds/app/build-4.zip', { token: '' });
  const doc = (await req('GET', '/hooked')).json;
  await fetch(doc.versions['1.0.0'].dist.tarball);
  let r = await req('GET', '/api/v1/repos/builds/stats');
  assert.strictEqual(r.json.top[0].item, '/app/build-4.zip');
  assert.ok(r.json.top[0].downloads >= 3);
  assert.strictEqual(r.json.days.length, 30);
  r = await req('GET', '/api/v1/repos/npm/stats');
  assert.ok(r.json.top.some((t) => t.item === 'hooked'));
  app.statsStore.flush();
  assert.ok(fs.existsSync(path.join(dataDir, 'stats.json')));
});

test('push replication: npm publish and generic uploads are copied to another registry', async () => {
  await req('POST', '/api/v1/repos', { body: { name: 'mirror-out', type: 'generic' }, b: remoteBase, token: 'remote-token-123456789' });
  let r = await req('POST', '/api/v1/routes', { body: { name: 'to-remote-npm', when: 'push', repo: 'team', target: remoteBase, token: 'remote-token-123456789' } });
  assert.strictEqual(r.status, 201, r.text);
  r = await req('POST', '/api/v1/routes', { body: { name: 'to-remote-files', when: 'push', repo: 'builds', matchOn: 'path', matchType: 'prefix', pattern: '/app/', target: `${remoteBase}/r/mirror-out`, token: 'remote-token-123456789', replicateDeletes: true } });
  assert.strictEqual(r.status, 201, r.text);

  await req('POST', '/api/v1/repos/team/packages', { body: tgz('@corp/replicated', '3.1.0') });
  const ok = await waitFor(async () => (await req('GET', '/@corp%2freplicated', { b: remoteBase, token: '' })).status === 200);
  assert.ok(ok, `package replicated: ${JSON.stringify((await req('GET', '/api/v1/replications')).json)}`);
  const rd = (await req('GET', '/@corp%2freplicated', { b: remoteBase, token: '' })).json;
  assert.ok(rd.versions['3.1.0']);
  const tgzRemote = await fetch(rd.versions['3.1.0'].dist.tarball);
  assert.strictEqual(tar.readPackageJson(Buffer.from(await tgzRemote.arrayBuffer())).version, '3.1.0');

  await req('PUT', '/r/builds/app/build-9.zip', { body: 'nine' });
  await req('PUT', '/r/builds/other/skip.zip', { body: 'no' });
  assert.ok(await waitFor(async () => (await req('GET', '/r/mirror-out/app/build-9.zip', { b: remoteBase, token: '' })).text === 'nine'));
  assert.strictEqual((await req('GET', '/r/mirror-out/other/skip.zip', { b: remoteBase, token: '' })).status, 404, 'pattern not matched');
  await req('DELETE', '/r/builds/app/build-9.zip');
  assert.ok(await waitFor(async () => (await req('GET', '/r/mirror-out/app/build-9.zip', { b: remoteBase, token: '' })).status === 404), 'delete replicated');

  // failing target -> retries, then error + replication.failed event, then manual retry
  await req('POST', '/api/v1/routes', { body: { name: 'broken', when: 'push', repo: 'builds', matchOn: 'path', pattern: '/broken/', target: 'http://127.0.0.1:9', token: 'x' } });
  await req('PUT', '/r/builds/broken/x.zip', { body: 'x' });
  assert.ok(await waitFor(async () => (await req('GET', '/api/v1/replications?status=error')).json.some((j) => j.ruleName === 'broken' && j.attempts === 3), 8000));
  assert.ok(app.events.recent.some((e) => e.type === 'replication.failed'));
  const job = (await req('GET', '/api/v1/replications?status=error')).json.find((j) => j.ruleName === 'broken');
  r = await req('POST', `/api/v1/replications/${job.id}/retry`);
  assert.strictEqual(r.status, 201);
  r = await req('GET', '/api/v1/routes');
  assert.ok(r.json.every((x) => !x.token || x.token === '***'), 'tokens are masked');
});

test('tasks are listed and runnable', async () => {
  const r = await req('GET', '/api/v1/tasks');
  assert.deepStrictEqual(r.json.map((t) => t.id).sort(), ['cache-expired', 'cleanup', 'git-mirrors', 'stats-flush']);
  const run = await req('POST', '/api/v1/tasks/cache-expired/run');
  assert.strictEqual(run.json.runs, 1);
  assert.strictEqual((await req('POST', '/api/v1/tasks/nope/run')).status, 404);
});

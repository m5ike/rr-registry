'use strict';
// Export / import (Settings -> Export / Import): encrypted bundle, ordered sections, plan with
// dependencies and conflicts, selection, approval of remote imports, workspace extraction.
//   Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { App } = require('../server/src/server');
const tar = require('../server/src/util/tar');

const SRC_TOKEN = 'transfer-source-token-123456';
const DST_TOKEN = 'transfer-target-token-123456';
const PASS = 'correct horse battery';
let src;
let dst;
let srcBase;
let dstBase;
const dirs = [];

const tgz = (name, version) => tar.create([{ name: 'package/package.json', data: JSON.stringify({ name, version, description: name }) }]);

async function api(base, token, method, p, body, raw) {
  const headers = { authorization: `Bearer ${token}` };
  let data = body;
  if (body !== undefined && !Buffer.isBuffer(body)) { data = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  const r = await fetch(`${base}/api/v1${p}`, { method, headers, body: data });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString()); } catch { /* binary */ }
  return { status: r.status, json, buf, text: raw ? null : buf.toString() };
}
const S = (...a) => api(srcBase, SRC_TOKEN, ...a);
const D = (...a) => api(dstBase, DST_TOKEN, ...a);

async function newApp(token) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-transfer-'));
  dirs.push(dataDir);
  const app = new App({ dataDir, apiToken: token, adminPassword: 'adminpass', upstream: '', quiet: true, logRequests: false, scheduler: false });
  await app.listen(0, '127.0.0.1');
  return app;
}

test.before(async () => {
  src = await newApp(SRC_TOKEN);
  srcBase = `http://127.0.0.1:${src.port}`;
  dst = await newApp(DST_TOKEN);
  dstBase = `http://127.0.0.1:${dst.port}`;
  // source content: users, token, repos (incl. group), packages, files, route, webhook, settings, plugin
  await S('POST', '/users', { name: 'alice', password: 'alicepw1', role: 'publisher' });
  const tok = await S('POST', '/tokens', { name: 'ci', user: 'alice' });
  src.aliceToken = tok.json.token;
  await S('POST', '/repos', { name: 'internal', type: 'npm', description: 'interní', quotaMb: 100, acl: { alice: 'publish' } });
  await S('POST', '/repos/internal/packages', tgz('@corp/utils', '1.0.0'));
  await S('POST', '/repos/internal/packages', tgz('@corp/utils', '1.1.0'));
  await S('POST', '/repos', { name: 'everything', type: 'group', members: 'internal,npm', deployTo: 'internal' });
  await fetch(`${srcBase}/r/files/docs/a.txt`, { method: 'PUT', headers: { authorization: `Bearer ${SRC_TOKEN}` }, body: 'hello transfer' });
  await S('POST', '/routes', { name: 'corp', when: 'notfound', repo: 'internal', target: 'https://npm.corp.example', token: 'secret-upstream' });
  await S('POST', '/webhooks', { name: 'ci-hook', url: 'http://127.0.0.1:9/x', secret: 'hooksecret' });
  await S('PUT', '/settings', { title: 'Zdrojový registr', clientsRepo: 'internal', motd: 'ahoj' });
  fs.mkdirSync(path.join(src.config.dataDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(src.config.dataDir, 'plugins', 'hello.js'), "module.exports = { name: 'hello', create: () => ({}) };\n");
});

test.after(async () => {
  await src.close();
  await dst.close();
  dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

let exportId;
let bundle;

test('export: sections in order, encrypted file, list and download', async () => {
  const sec = await S('GET', '/transfer/sections');
  assert.deepStrictEqual(sec.json.sections.map((s) => s.id), ['server', 'secret', 'plugins', 'users', 'tokens', 'repos', 'content', 'routes', 'webhooks', 'settings', 'stats', 'audit', 'cache']);
  assert.ok(sec.json.sections.find((s) => s.id === 'content').items.some((i) => i.id === 'internal' && i.files > 0));

  let r = await S('POST', '/exports', { passphrase: 'short' });
  assert.strictEqual(r.status, 400);
  r = await S('POST', '/exports', { passphrase: PASS, note: 'test' });
  assert.strictEqual(r.status, 201, r.text);
  exportId = r.json.id;
  assert.ok(r.json.size > 1000);
  assert.ok(!r.json.sections.some((s) => s.id === 'cache'), 'cache not exported by default');
  r = await S('GET', '/exports');
  assert.strictEqual(r.json[0].id, exportId);
  r = await S('GET', `/exports/${exportId}/download`, undefined, true);
  assert.strictEqual(r.status, 200);
  bundle = r.buf;
  assert.strictEqual(bundle.subarray(0, 4).toString(), 'RRX1');
  const text = bundle.toString('latin1');
  for (const secret of [SRC_TOKEN, 'adminpass', 'hooksecret', 'secret-upstream', 'hello transfer']) assert.ok(!text.includes(secret), `${secret} must not be readable`);
});

test('import: wrong passphrase, plan with dependencies and conflicts, selection, run', async () => {
  let r = await D('POST', '/imports', bundle);
  assert.strictEqual(r.status, 201, r.text);
  const id = r.json.id;
  assert.strictEqual(r.json.status, 'locked');
  r = await D('POST', `/imports/${id}/unlock`, { passphrase: 'wrong passphrase' });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.error, /wrong passphrase/);
  r = await D('POST', `/imports/${id}/unlock`, { passphrase: PASS });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.status, 'ready');
  const ops = r.json.ops;
  // order follows the sections; the group repository comes after its members
  const order = ops.map((o) => o.section);
  assert.deepStrictEqual(order, [...order].sort((a, b) => r.json.plan.order.indexOf(a) - r.json.plan.order.indexOf(b)));
  const ri = ops.map((o) => o.id);
  assert.ok(ri.indexOf('repos:everything') > ri.indexOf('repos:internal'));
  assert.ok(ops.every((o) => o.approved), 'local upload: operations pre-approved');
  assert.ok(ops.find((o) => o.id === 'repos:npm').exists, 'npm exists locally -> conflict');
  assert.strictEqual(ops.find((o) => o.id === 'repos:npm').action, 'skip');
  assert.strictEqual(ops.find((o) => o.id === 'repos:internal').action, 'create');

  // deselect users -> token depends on alice -> blocked
  r = await D('PUT', `/imports/${id}`, { select: { users: false } });
  const tokOp = r.json.ops.find((o) => o.section === 'tokens');
  assert.ok(tokOp.blocked);
  assert.ok(r.json.plan.blocked.includes(tokOp.id));
  r = await D('POST', `/imports/${id}/run`, { confirmPaths: true });
  assert.strictEqual(r.status, 409);
  // deselect repos internal -> content, group, route, settings depend on it
  r = await D('PUT', `/imports/${id}`, { select: { 'repos:internal': false } });
  assert.ok(r.json.ops.find((o) => o.id === 'content:internal').blocked);
  assert.ok(r.json.ops.find((o) => o.id === 'repos:everything').blocked);
  // include dependencies brings them back
  r = await D('PUT', `/imports/${id}`, { includeDependencies: true });
  assert.deepStrictEqual(r.json.plan.blocked, []);
  assert.ok(r.json.ops.find((o) => o.id === 'users:alice').selected);

  // paths must be confirmed
  r = await D('POST', `/imports/${id}/run`, {});
  assert.strictEqual(r.status, 400);
  assert.ok(r.json.targets.length);
  r = await D('PUT', `/imports/${id}`, { overrides: { 'settings:settings': 'overwrite', 'server:server': 'skip' } });
  r = await D('POST', `/imports/${id}/run`, { confirmPaths: true });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.status, 'done', JSON.stringify(r.json.results.filter((x) => x.status === 'failed')));

  // everything arrived and works
  const repos = (await D('GET', '/repos')).json.map((x) => x.name);
  assert.ok(repos.includes('internal') && repos.includes('everything'));
  const pkg = await fetch(`${dstBase}/r/internal/@corp%2futils`, { headers: { authorization: `Bearer ${DST_TOKEN}` } });
  assert.deepStrictEqual(Object.keys((await pkg.json()).versions).sort(), ['1.0.0', '1.1.0']);
  const tb = await fetch(`${dstBase}/r/internal/@corp/utils/-/utils-1.1.0.tgz`, { headers: { authorization: `Bearer ${DST_TOKEN}` } });
  assert.strictEqual(tar.readPackageJson(Buffer.from(await tb.arrayBuffer())).version, '1.1.0');
  assert.strictEqual(await (await fetch(`${dstBase}/r/files/docs/a.txt`)).text(), 'hello transfer');
  const who = await fetch(`${dstBase}/-/whoami`, { headers: { authorization: `Bearer ${src.aliceToken}` } });
  assert.strictEqual((await who.json()).username, 'alice', 'imported token works');
  const basic = await fetch(`${dstBase}/-/whoami`, { headers: { authorization: `Basic ${Buffer.from('alice:alicepw1').toString('base64')}` } });
  assert.strictEqual(basic.status, 200, 'imported password works');
  assert.strictEqual((await D('GET', '/settings')).json.title, 'Zdrojový registr');
  assert.strictEqual((await D('GET', '/routes')).json.find((x) => x.name === 'corp').token, '***');
  assert.ok((await D('GET', '/webhooks')).json.some((h) => h.name === 'ci-hook'));
  assert.ok((await D('GET', '/plugins')).json.some((p) => p.name === 'hello'), 'custom plugin loaded');
  assert.ok(!fs.existsSync(path.join(dst.config.dataDir, 'imports', id, 'payload.tar')), 'decrypted payload removed');
  // server credentials were skipped -> destination keeps its own token
  assert.strictEqual((await D('GET', '/auth/whoami')).status, 200);
});

test('import: server credentials + secret apply immediately; repository rename', async () => {
  let r = await D('POST', '/imports', bundle);
  const id = r.json.id;
  r = await D('POST', `/imports/${id}/unlock`, { passphrase: PASS });
  const all = Object.fromEntries(r.json.ops.map((o) => [o.id, false]));
  r = await D('PUT', `/imports/${id}`, { select: { ...all, 'repos:internal': true, 'content:internal': true }, renames: { internal: 'internal-copy' } });
  assert.strictEqual(r.json.ops.find((o) => o.id === 'content:internal').target, path.join(dst.config.dataDir, 'repos', 'internal-copy'));
  r = await D('POST', `/imports/${id}/run`, { confirmPaths: true });
  assert.strictEqual(r.json.status, 'done');
  const p = await fetch(`${dstBase}/r/internal-copy/@corp%2futils`, { headers: { authorization: `Bearer ${DST_TOKEN}` } });
  assert.strictEqual(p.status, 200);

  r = await D('POST', '/imports', bundle);
  const id2 = r.json.id;
  r = await D('POST', `/imports/${id2}/unlock`, { passphrase: PASS });
  const none = Object.fromEntries(r.json.ops.map((o) => [o.id, false]));
  r = await D('PUT', `/imports/${id2}`, { select: { ...none, 'server:server': true, 'secret:secret': true }, conflict: 'overwrite' });
  r = await D('POST', `/imports/${id2}/run`, { confirmPaths: true });
  assert.strictEqual(r.json.status, 'done', JSON.stringify(r.json));
  assert.strictEqual(dst.secret, src.secret);
  // the destination now accepts the source's api token, from memory and after a restart (server.json)
  const w = await fetch(`${dstBase}/api/v1/auth/whoami`, { headers: { authorization: `Bearer ${SRC_TOKEN}` } });
  assert.strictEqual(w.status, 200);
  assert.ok(fs.existsSync(path.join(dst.config.dataDir, 'config', 'server.json')));
  const { loadConfig } = require('../server/src/config');
  assert.strictEqual(loadConfig({ dataDir: dst.config.dataDir }).apiToken, SRC_TOKEN);
});

test('workspace import extracts files without changing the registry', async () => {
  let r = await api(dstBase, SRC_TOKEN, 'POST', '/imports', bundle);
  const id = r.json.id;
  await api(dstBase, SRC_TOKEN, 'POST', `/imports/${id}/unlock`, { passphrase: PASS });
  r = await api(dstBase, SRC_TOKEN, 'PUT', `/imports/${id}`, { target: { mode: 'workspace', path: 'kontrola/2026' } });
  assert.ok(r.json.ops.every((o) => !o.selected || o.action === 'extract'));
  r = await api(dstBase, SRC_TOKEN, 'PUT', `/imports/${id}`, { target: { mode: 'workspace', path: '../../etc' } });
  assert.strictEqual(r.status, 400);
  const before = (await api(dstBase, SRC_TOKEN, 'GET', '/repos')).json.length;
  r = await api(dstBase, SRC_TOKEN, 'POST', `/imports/${id}/run`, { confirmPaths: true });
  assert.strictEqual(r.json.status, 'done', JSON.stringify(r.json));
  const ws = path.join(dst.config.dataDir, 'workspaces', 'kontrola', '2026');
  assert.ok(fs.existsSync(path.join(ws, 'content', 'internal', '@corp', 'utils', 'packument.json')));
  assert.ok(fs.existsSync(path.join(ws, 'users', 'users.json')));
  assert.strictEqual((await api(dstBase, SRC_TOKEN, 'GET', '/repos')).json.length, before);
});

test('remote import from another server needs approval of every operation', async () => {
  let r = await api(dstBase, SRC_TOKEN, 'POST', '/imports/remote', { url: srcBase, mode: 'server', token: SRC_TOKEN, passphrase: PASS, sections: ['users', 'repos', 'content'] });
  assert.strictEqual(r.status, 201, r.text);
  assert.strictEqual(r.json.status, 'ready');
  assert.strictEqual(r.json.source.kind, 'remote');
  const id = r.json.id;
  assert.ok(r.json.ops.length > 0 && r.json.ops.every((o) => !o.approved));
  assert.deepStrictEqual([...new Set(r.json.ops.map((o) => o.section))], ['users', 'repos', 'content']);
  assert.ok((await S('GET', '/exports')).json.every((e) => e.id !== r.json.source.remoteId), 'remote export removed after download');
  r = await api(dstBase, SRC_TOKEN, 'POST', `/imports/${id}/run`, { confirmPaths: true });
  assert.strictEqual(r.status, 409);
  assert.ok(r.json.unapproved.length > 0);
  r = await api(dstBase, SRC_TOKEN, 'PUT', `/imports/${id}`, { approve: ['users:alice'] });
  assert.ok(r.json.plan.unapproved.length > 0);
  r = await api(dstBase, SRC_TOKEN, 'PUT', `/imports/${id}`, { approve: 'selected', conflict: 'overwrite' });
  assert.deepStrictEqual(r.json.plan.unapproved, []);
  r = await api(dstBase, SRC_TOKEN, 'POST', `/imports/${id}/run`, { confirmPaths: true });
  assert.strictEqual(r.json.status, 'done', JSON.stringify(r.json));
  assert.ok(r.json.results.some((x) => x.id === 'content:internal' && x.status === 'done'));

  // plain file URL
  r = await api(dstBase, SRC_TOKEN, 'POST', '/imports/remote', { url: `${srcBase}/api/v1/exports/${exportId}/download`, token: SRC_TOKEN });
  assert.strictEqual(r.json.status, 'locked');
  r = await api(dstBase, SRC_TOKEN, 'POST', `/imports/${r.json.id}/unlock`, { passphrase: PASS });
  assert.strictEqual(r.json.status, 'ready');
  r = await api(dstBase, SRC_TOKEN, 'GET', '/imports');
  assert.ok(r.json.length >= 2);
  r = await api(dstBase, SRC_TOKEN, 'DELETE', `/imports/${r.json[0].id}`);
  assert.strictEqual(r.status, 200);
  r = await api(dstBase, SRC_TOKEN, 'POST', '/imports/remote', { url: 'ftp://x' });
  assert.strictEqual(r.status, 400);
  r = await S('DELETE', `/exports/${exportId}`);
  assert.strictEqual(r.status, 200);
});

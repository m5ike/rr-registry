'use strict';
// Docker Registry HTTP API v2: chunked + monolithic blob uploads, manifests, tags, catalog,
// cross-repository mount, image index, auth (Basic user/password and token), management API, GC.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { App } = require('../server/src/server');

const TOKEN = 'docker-test-token-123456';
let app;
let base;
let dataDir;

const digestOf = (buf) => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
const basic = (u, p) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}` });
const admin = basic('admin', 'adminpass');

async function req(method, url, { headers = {}, body } = {}) {
  const r = await fetch(base + url, { method, headers, body, redirect: 'manual' });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, buf, json: () => JSON.parse(buf.toString('utf8') || 'null') };
}

/** Push a blob the way docker does: POST → PATCH (chunks) → PUT ?digest= */
async function pushBlobChunked(name, data, auth) {
  const start = await req('POST', `/v2/${name}/blobs/uploads/`, { headers: auth });
  assert.strictEqual(start.status, 202);
  let loc = start.headers.get('location');
  const half = Math.floor(data.length / 2);
  for (const part of [data.subarray(0, half), data.subarray(half)]) {
    const r = await req('PATCH', loc, { headers: { ...auth, 'content-type': 'application/octet-stream' }, body: part });
    assert.strictEqual(r.status, 202);
    loc = r.headers.get('location');
  }
  const done = await req('PUT', `${loc}?digest=${digestOf(data)}`, { headers: auth });
  assert.strictEqual(done.status, 201, done.buf.toString());
  assert.strictEqual(done.headers.get('docker-content-digest'), digestOf(data));
  return digestOf(data);
}

function manifest(config, layers) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.length, digest: digestOf(config) },
      layers: layers.map((l) => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: l.length, digest: digestOf(l) })),
    }),
  );
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-docker-'));
  app = new App({ dataDir, port: 0, host: '127.0.0.1', apiToken: TOKEN, adminPassword: 'adminpass', quiet: true, logRequests: false, publicUrl: '' });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.port}`;
});

test.after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('docker: version check, auth challenge, push (chunked + monolithic), pull, tags, catalog', async () => {
  const v = await req('GET', '/v2/');
  assert.strictEqual(v.status, 200, 'anonymous read of a public docker repo');
  assert.strictEqual(v.headers.get('docker-distribution-api-version'), 'registry/2.0');
  assert.strictEqual((await req('GET', '/v2/', { headers: basic('admin', 'wrong') })).status, 401);
  const anonPush = await req('POST', '/v2/agentconf/node/blobs/uploads/');
  assert.strictEqual(anonPush.status, 401);
  assert.match(anonPush.headers.get('www-authenticate'), /^Basic realm=/);
  assert.strictEqual(anonPush.json().errors[0].code, 'UNAUTHORIZED');

  const layer = crypto.randomBytes(300_000);
  const config = Buffer.from(JSON.stringify({ architecture: 'arm64', os: 'linux', rootfs: { type: 'layers', diff_ids: [digestOf(layer)] } }));
  const layerDigest = await pushBlobChunked('agentconf/node', layer, admin);
  // monolithic upload, authenticated with a token as the Basic password (docker login -u x -p <token>)
  const mono = await req('POST', `/v2/agentconf/node/blobs/uploads/?digest=${digestOf(config)}`, { headers: { ...basic('ci', TOKEN), 'content-type': 'application/octet-stream' }, body: config });
  assert.strictEqual(mono.status, 201, mono.buf.toString());
  const head = await req('HEAD', `/v2/agentconf/node/blobs/${layerDigest}`);
  assert.strictEqual(head.status, 200);
  assert.strictEqual(Number(head.headers.get('content-length')), layer.length);
  // a wrong digest is refused
  const bad = await req('POST', `/v2/agentconf/node/blobs/uploads/?digest=${digestOf(Buffer.from('x'))}`, { headers: admin, body: Buffer.from('y') });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.json().errors[0].code, 'DIGEST_INVALID');

  // manifest referencing an unknown blob is refused, the real one is accepted
  const ghost = manifest(config, [crypto.randomBytes(10)]);
  const g = await req('PUT', '/v2/agentconf/node/manifests/broken', { headers: { ...admin, 'content-type': 'application/vnd.docker.distribution.manifest.v2+json' }, body: ghost });
  assert.strictEqual(g.json().errors[0].code, 'MANIFEST_BLOB_UNKNOWN');
  const man = manifest(config, [layer]);
  const put = await req('PUT', '/v2/agentconf/node/manifests/v1', { headers: { ...admin, 'content-type': 'application/vnd.docker.distribution.manifest.v2+json' }, body: man });
  assert.strictEqual(put.status, 201, put.buf.toString());
  assert.strictEqual(put.headers.get('docker-content-digest'), digestOf(man));
  await req('PUT', '/v2/agentconf/node/manifests/latest', { headers: { ...admin, 'content-type': 'application/vnd.docker.distribution.manifest.v2+json' }, body: man });

  const pulled = await req('GET', '/v2/agentconf/node/manifests/v1', { headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' } });
  assert.strictEqual(pulled.status, 200);
  assert.ok(pulled.buf.equals(man));
  assert.strictEqual(pulled.headers.get('content-type'), 'application/vnd.docker.distribution.manifest.v2+json');
  const byDigest = await req('GET', `/v2/agentconf/node/manifests/${digestOf(man)}`);
  assert.strictEqual(byDigest.status, 200);
  const blob = await req('GET', `/v2/agentconf/node/blobs/${layerDigest}`);
  assert.ok(blob.buf.equals(layer));
  const ranged = await req('GET', `/v2/agentconf/node/blobs/${layerDigest}`, { headers: { range: 'bytes=10-19' } });
  assert.strictEqual(ranged.status, 206);
  assert.ok(ranged.buf.equals(layer.subarray(10, 20)));

  assert.deepStrictEqual((await req('GET', '/v2/agentconf/node/tags/list')).json(), { name: 'agentconf/node', tags: ['latest', 'v1'] });
  const page = await req('GET', '/v2/agentconf/node/tags/list?n=1');
  assert.deepStrictEqual(page.json().tags, ['latest']);
  assert.match(page.headers.get('link'), /last=latest/);
  assert.strictEqual((await req('GET', '/v2/agentconf/missing/manifests/v1')).json().errors[0].code, 'MANIFEST_UNKNOWN');

  // cross-repository mount: the layer is already here
  const mount = await req('POST', `/v2/agentconf/python/blobs/uploads/?mount=${layerDigest}&from=agentconf/node`, { headers: admin });
  assert.strictEqual(mount.status, 201);
  // image index (multi-platform) pointing at the manifest
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ mediaType: 'application/vnd.docker.distribution.manifest.v2+json', digest: digestOf(man), size: man.length, platform: { architecture: 'arm64', os: 'linux' } }] }));
  const pi = await req('PUT', '/v2/agentconf/python/manifests/3.12', { headers: { ...admin, 'content-type': 'application/vnd.oci.image.index.v1+json' }, body: index });
  assert.strictEqual(pi.status, 201, pi.buf.toString());
  assert.deepStrictEqual((await req('GET', '/v2/_catalog')).json(), { repositories: ['agentconf/node', 'agentconf/python'] });
});

test('docker: management API — images, tags, delete, garbage collection', async () => {
  const api = (method, url, body) => req(method, `/api/v1${url}`, { headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const repos = (await api('GET', '/repos')).json();
  assert.ok(repos.some((r) => r.name === 'docker' && r.type === 'docker' && r.dockerDefault), JSON.stringify(repos));
  const images = (await api('GET', '/repos/docker/images')).json();
  const node = images.find((i) => i.name === 'agentconf/node');
  assert.strictEqual(node.tags, 2);
  assert.ok(node.size > 300_000);
  const tags = (await api('GET', `/repos/docker/images/${encodeURIComponent('agentconf/node')}/tags`)).json();
  assert.deepStrictEqual(tags.map((t) => t.tag), ['latest', 'v1']);
  // removing the python index and its tag → nothing of python survives GC, node keeps its blobs
  assert.strictEqual((await api('DELETE', `/repos/docker/images/${encodeURIComponent('agentconf/python')}/tags/3.12`)).status, 200);
  const blobsBefore = fs.readdirSync(path.join(dataDir, 'repos', 'docker', 'blobs', 'sha256')).length;
  const gc = (await api('POST', '/repos/docker/gc', { untagged: true })).json();
  assert.strictEqual(gc.manifests, 1, JSON.stringify(gc));
  assert.ok(gc.blobs >= 1);
  assert.strictEqual(fs.readdirSync(path.join(dataDir, 'repos', 'docker', 'blobs', 'sha256')).length, blobsBefore - gc.blobs);
  const still = await req('GET', '/v2/agentconf/node/manifests/latest');
  assert.strictEqual(still.status, 200, 'tagged images survive GC');
  // a docker repository cannot become the npm default
  assert.strictEqual((await api('PUT', '/settings', { defaultRepo: 'docker' })).status, 400);
  assert.strictEqual((await api('POST', '/repos', { name: 'v2', type: 'docker' })).status, 400, 'v2 is reserved');
});

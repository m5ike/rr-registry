'use strict';
// Public repository browser (1.7.4): listings of every repository type with README, filters (allow / deny),
// downloads with a speed limit, archives (zip / tar.gz / tar.bz2), the design config and the URL masks
//   <type>-{registry|rr}.<domain>/[<repo>/]   <repo>.<type>.{registry|rr}.<domain>/   {registry|rr}.<domain>/<type>/<repo>/
// Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { App } = require('../server/src/server');
const { normalize, makeFilter, zipStream } = require('../server/src/browse');

const TOKEN = 'browse-test-token-1234567890';
const hasGit = spawnSync('git', ['--version']).status === 0;
const hasBzip2 = spawnSync('bzip2', ['--help'], { stdio: 'ignore' }).status !== null;
let app;
let dataDir;

function req(method, p, { host = 'registry.localhost', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: app.port, path: p, method, headers: { host: `${host}:${app.port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString(), json });
      });
    });
    r.on('error', reject);
    r.end(body);
  });
}
const api = (method, p, body) => req(method, `/api/v1${p}`, { headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
const put = (p, data) => req('PUT', p, { headers: { authorization: `Bearer ${TOKEN}` }, body: data });
const html = { accept: 'text/html,application/xhtml+xml' };

/** Entries of a ZIP (central directory). */
function zipNames(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10);
  let off = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < n; i++) {
    const len = buf.readUInt16LE(off + 28);
    out.push(buf.subarray(off + 46, off + 46 + len).toString());
    off += 46 + len + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return out.sort();
}
/** Names in a tar archive. */
function tarNames(buf) {
  const out = [];
  for (let o = 0; o + 512 <= buf.length;) {
    const name = buf.subarray(o, o + 100).toString().replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.subarray(o + 124, o + 136).toString().replace(/\0.*$/s, '').trim(), 8) || 0;
    out.push(name);
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return out.sort();
}

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-browse-'));
  app = new App({ dataDir, apiToken: TOKEN, adminPassword: 'adminpass', upstream: '', quiet: true, logRequests: false, scheduler: false, publicUrl: '' });
  await app.listen(0, '127.0.0.1');
  await put('/r/files/README.md', '# Soubory\n\nViz [docs](docs/) a [průvodce](docs/guide.md).\n');
  await put('/r/files/docs/guide.md', '# Průvodce\n');
  await put('/r/files/builds/app-1.0.tgz', Buffer.alloc(60000, 7));
  await put('/r/files/builds/debug.log', 'log');
  await put('/r/files/secret/key.pem', 'SECRET');
  await put('/r/files/.env', 'X=1');
});

test.after(async () => {
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('design config is normalized (unknown keys dropped, values clamped, logo checked)', () => {
  const c = normalize({ theme: 'nope', header: 'hero', radius: 99, views: ['grid', 'x'], view: 'list', columns: ['size', 'evil'], logo: 'javascript:alert(1)', rateLimitKBps: -5, filter: { mode: 'allow', patterns: '*.tgz\n docs/ ' }, font: 'Comic<script>', evil: 1 });
  assert.strictEqual(c.theme, 'amber');
  assert.strictEqual(c.header, 'hero');
  assert.strictEqual(c.radius, 28);
  assert.deepStrictEqual(c.views, ['grid']);
  assert.strictEqual(c.view, 'grid', 'the default view must be allowed');
  assert.deepStrictEqual(c.columns, ['size']);
  assert.strictEqual(c.logo, '');
  assert.strictEqual(c.rateLimitKBps, 0);
  assert.deepStrictEqual(c.filter, { mode: 'allow', patterns: ['*.tgz', 'docs/'] });
  assert.strictEqual(c.font, 'Inter');
  assert.strictEqual(c.evil, undefined);
  assert.strictEqual(normalize({ logo: 'data:image/png;base64,iVBORw0KGgo=' }).logo, 'data:image/png;base64,iVBORw0KGgo=');
});

test('filter rules: deny / allow, directories, hidden files', () => {
  const deny = makeFilter(normalize({ filter: { mode: 'deny', patterns: ['*.log', 'secret/', 'builds/**/*.tmp'] } }));
  assert.strictEqual(deny('builds/debug.log', false), false);
  assert.strictEqual(deny('a/b/c.log', false), false, 'a mask without / applies at any depth');
  assert.strictEqual(deny('secret', true), false);
  assert.strictEqual(deny('secret/key.pem', false), false, 'files in a denied directory');
  assert.strictEqual(deny('builds/x/y.tmp', false), false);
  assert.strictEqual(deny('docs/guide.md', false), true);
  assert.strictEqual(deny('.env', false), false, 'hidden files are hidden by default');
  assert.strictEqual(makeFilter(normalize({ showHidden: true }))('.env', false), true);
  const allow = makeFilter(normalize({ filter: { mode: 'allow', patterns: ['*.tgz', '*.md'] } }));
  assert.strictEqual(allow('builds', true), true, 'directories stay browsable');
  assert.strictEqual(allow('builds/app.tgz', false), true);
  assert.strictEqual(allow('builds/debug.log', false), false);
});

test('generic: listing with README, file details, hidden files, raw download', async () => {
  const l = (await req('GET', '/-/rr/browse/files/list?path=/')).json;
  assert.strictEqual(l.kind, 'dir');
  assert.deepStrictEqual(l.entries.map((e) => e.name), ['builds', 'docs', 'secret', 'README.md']);
  assert.match(l.readme.text, /^# Soubory/);
  const f = (await req('GET', '/-/rr/browse/files/list?path=/docs/guide.md')).json;
  assert.deepStrictEqual([f.kind, f.file.name, f.file.size], ['file', 'guide.md', 12]);
  const raw = await req('GET', '/-/rr/browse/files/raw?path=docs/guide.md');
  assert.strictEqual(raw.text, '# Průvodce\n');
  assert.match(raw.headers['content-disposition'], /^attachment; filename\*=UTF-8''guide\.md/);
  assert.match((await req('GET', '/-/rr/browse/files/raw?path=docs/guide.md&inline=1')).headers['content-disposition'], /^inline/);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/raw?path=.env')).status, 404);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/raw?path=../../etc/passwd')).status, 400);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/list?path=/nope')).status, 404);
});

test('archives: zip, tar.gz, tar.bz2 of selected paths (directories recursive, filtered)', async () => {
  const zip = await req('GET', '/-/rr/browse/files/archive?format=zip&p=/docs&p=/builds&p=/README.md&base=/');
  assert.strictEqual(zip.status, 200);
  assert.strictEqual(zip.headers['content-type'], 'application/zip');
  assert.deepStrictEqual(zipNames(zip.buf), ['README.md', 'builds/app-1.0.tgz', 'builds/debug.log', 'docs/guide.md']);
  const tgz = await req('POST', '/-/rr/browse/files/archive', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'format=tar.gz&base=%2Fbuilds&p=%2Fbuilds%2Fapp-1.0.tgz' });
  assert.deepStrictEqual(tarNames(zlib.gunzipSync(tgz.buf)), ['app-1.0.tgz'], 'names relative to the current directory');
  if (hasBzip2) {
    const bz = await req('GET', '/-/rr/browse/files/archive?format=tar.bz2&p=/docs&base=/');
    assert.strictEqual(bz.status, 200);
    const out = spawnSync('bzip2', ['-dc'], { input: bz.buf });
    assert.deepStrictEqual(tarNames(out.stdout), ['docs/guide.md']);
  }
  assert.strictEqual((await req('GET', '/-/rr/browse/files/archive?format=rar&p=/docs')).status, 400);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/archive?format=zip')).status, 400);
});

test('repository rules: filter, disabled formats, multi-select off, speed limit, browser off, private repository', async () => {
  let r = await api('PUT', '/repos/files', { browser: { filter: { mode: 'deny', patterns: ['*.log', 'secret/'] }, formats: ['zip'], rateLimitKBps: 30 } });
  assert.strictEqual(r.status, 200, r.text);
  const l = (await req('GET', '/-/rr/browse/files/list?path=/')).json;
  assert.deepStrictEqual(l.entries.map((e) => e.name), ['builds', 'docs', 'README.md']);
  assert.deepStrictEqual(l.formats, ['zip']);
  assert.deepStrictEqual((await req('GET', '/-/rr/browse/files/list?path=/builds')).json.entries.map((e) => e.name), ['app-1.0.tgz']);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/raw?path=secret/key.pem')).status, 404);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/archive?format=tar.gz&p=/docs')).status, 400);
  assert.deepStrictEqual(zipNames((await req('GET', '/-/rr/browse/files/archive?format=zip&p=/builds&base=/')).buf), ['builds/app-1.0.tgz']);
  const t0 = Date.now();
  const big = await req('GET', '/-/rr/browse/files/raw?path=builds/app-1.0.tgz');
  assert.strictEqual(big.buf.length, 60000);
  assert.ok(Date.now() - t0 >= 1500, `60 kB at 30 kB/s takes about 2 s (took ${Date.now() - t0} ms)`);
  assert.strictEqual((await req('GET', '/r/files/builds/debug.log')).status, 200, 'registry clients are not filtered');
  await api('PUT', '/repos/files', { browser: { multiSelect: false } });
  assert.deepStrictEqual((await req('GET', '/-/rr/browse/files/list?path=/')).json.formats, []);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/archive?format=zip&p=/docs')).status, 403);
  await api('PUT', '/repos/files', { browser: { enabled: false } });
  assert.strictEqual((await req('GET', '/-/rr/browse/files/list?path=/')).status, 404);
  await api('PUT', '/repos/files', { browser: {}, public: false });
  assert.strictEqual((await req('GET', '/-/rr/browse/files/list?path=/')).status, 401);
  assert.strictEqual((await req('GET', '/-/rr/browse/files/list?path=/', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  await api('PUT', '/repos/files', { public: true });
  const b = (await api('GET', '/repos/files/browser')).json;
  assert.deepStrictEqual(b.urls.map((u) => u.url), [
    `http://generic-registry.localhost:${app.port}/files/`, `http://files.generic.registry.localhost:${app.port}/`, `http://127.0.0.1:${app.port}/generic/files/`,
  ].map((u) => u.replace('127.0.0.1', 'registry.localhost')).map((u, i) => (i === 2 ? u : u)));
  assert.ok(b.meta.themes.ocean && b.meta.fonts.includes('Inter'));
});

test('npm: packages, package page (versions, README, install), tarball download', async () => {
  const tgz = fs.readdirSync(path.join(__dirname, '..', 'dist', 'packages')).find((f) => /rr-client-.*\.tgz$/.test(f));
  if (tgz) {
    const pub = await req('PUT', '/-/rr/upload', { headers: { authorization: `Bearer ${TOKEN}` }, body: fs.readFileSync(path.join(__dirname, '..', 'dist', 'packages', tgz)) });
    void pub;
  }
  const list = (await req('GET', '/-/rr/browse/npm/list?path=/')).json;
  assert.strictEqual(list.kind, 'packages');
  const name = list.entries[0] && list.entries[0].name;
  if (!name) return;
  const p = (await req('GET', `/-/rr/browse/npm/list?path=/${name}`)).json;
  assert.strictEqual(p.kind, 'package');
  assert.match(p.info.install, new RegExp(`^npm install ${name.replace('/', '\\/')} --registry `));
  const v = p.entries[0];
  assert.ok(v.download);
  const dl = await req('GET', `/-/rr/browse/npm/raw?path=${encodeURIComponent(v.path)}`);
  assert.strictEqual(dl.status, 200);
  assert.strictEqual(dl.buf.length, v.size);
  assert.strictEqual((await req('GET', `/-/rr/browse/npm/list?path=${encodeURIComponent(v.path)}`)).json.kind, 'file');
});

test('git: repositories, files of the default branch, README, archive; private repositories hidden', { skip: !hasGit }, async () => {
  await api('POST', '/repos/git/git', { name: 'team/web', readme: true, license: 'MIT' });
  await api('POST', '/repos/git/git', { name: 'team/secret', readme: true, visibility: 'private' });
  await api('POST', '/repos/git/git/team%2Fweb/commit-files', { message: 'docs', files: [{ path: 'docs/a.md', content: '# A' }] });
  const root = (await req('GET', '/-/rr/browse/git/list?path=/')).json;
  assert.deepStrictEqual(root.entries.map((e) => e.name), ['team/web']);
  const repo = (await req('GET', '/-/rr/browse/git/list?path=/team/web')).json;
  assert.strictEqual(repo.kind, 'repo');
  assert.deepStrictEqual(repo.entries.map((e) => e.name).sort(), ['LICENSE', 'README.md', 'docs']);
  assert.match(repo.readme.text, /^# web/);
  assert.match(repo.info.cloneUrls.https, /\/git\/team\/web\.git$/);
  assert.strictEqual((await req('GET', '/-/rr/browse/git/list?path=/team/web/docs/a.md')).json.kind, 'file');
  assert.strictEqual((await req('GET', '/-/rr/browse/git/raw?path=team/web/docs/a.md')).text, '# A');
  assert.strictEqual((await req('GET', '/-/rr/browse/git/list?path=/team/secret')).status, 404);
  assert.strictEqual((await req('GET', '/-/rr/browse/git/raw?path=team/secret/README.md')).status, 404);
  const z = await req('GET', '/-/rr/browse/git/archive?format=zip&p=/team/web/docs&p=/team/web/README.md&base=/team/web');
  assert.deepStrictEqual(zipNames(z.buf), ['README.md', 'docs/a.md']);
});

test('URL masks open the browser page; clients keep working on the repository host', async () => {
  const page = (p, host) => req('GET', p, { host, headers: html });
  const check = async (p, host, repo, base, path0) => {
    const r = await page(p, host);
    assert.strictEqual(r.status, 200, `${host}${p}`);
    const boot = JSON.parse(/window\.RR_BROWSE = (\{.*?\});<\/script>/s.exec(r.text)[1]);
    assert.deepStrictEqual([boot.repo, boot.base, boot.path], [repo, base, path0], `${host}${p}`);
  };
  await check('/generic/files/docs/', 'registry.localhost', 'files', '/generic/files', '/docs');
  await check('/generic/docs', 'rr.localhost', 'files', '/generic', '/docs');
  await check('/r/files/', 'registry.localhost', 'files', '/r/files', '/');
  await check('/files/docs', 'generic-registry.localhost', 'files', '/files', '/docs');
  await check('/docs', 'generic-rr.localhost', 'files', '', '/docs');
  await check('/docs', 'files.generic.registry.localhost', 'files', '', '/docs');
  await check('/', 'npm.npm.rr.localhost', 'npm', '', '/');
  await check('/', 'npm-registry.localhost', 'npm', '', '/');
  // the git type host keeps the GitHub-like application
  assert.match((await page('/team/web', 'git-registry.localhost')).text, /\/admin\/git\.js/);
  assert.match((await page('/team/web', 'git.git.registry.localhost')).text, /RR_BROWSE/);
  // non-HTML clients are unchanged
  assert.strictEqual((await req('GET', '/docs/guide.md', { host: 'files.generic.registry.localhost' })).text, '# Průvodce\n', 'files via the repository host');
  assert.strictEqual((await req('GET', '/r/files/README.md')).status, 200);
  assert.strictEqual((await req('GET', '/', { host: 'nope.generic.registry.localhost', headers: html })).status, 200, 'unknown repository on a repository host falls back to the main host');
  const theme = await page('/generic/files/', 'registry.localhost');
  assert.match(theme.text, /fonts\.googleapis\.com\/css2\?family=Inter/);
  assert.match(theme.text, /<script src="\/static\/browse\.js"><\/script>/);
});

test('a private or unknown repository answers browsers with an HTML page', async () => {
  await api('PUT', '/repos/files', { public: false });
  const r = await req('GET', '/generic/files/', { headers: html });
  assert.strictEqual(r.status, 401);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.match(r.text, /Vyžaduje přihlášení/);
  await api('PUT', '/repos/files', { public: true, browser: { enabled: false } });
  assert.strictEqual((await req('GET', '/generic/files/', { headers: html })).status, 404);
  await api('PUT', '/repos/files', { browser: {} });
  assert.strictEqual((await req('GET', '/generic/files/', { headers: html })).status, 200);
});

test('zip writer produces archives other tools read', async () => {
  const chunks = [];
  for await (const c of zipStream([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'dir/b.bin', data: Buffer.alloc(10000, 1) }])) chunks.push(c);
  const f = path.join(dataDir, 't.zip');
  fs.writeFileSync(f, Buffer.concat(chunks));
  const t = spawnSync('unzip', ['-t', f], { encoding: 'utf8' });
  if (t.error) return;
  assert.strictEqual(t.status, 0, t.stdout + t.stderr);
  assert.match(t.stdout, /No errors detected/);
});

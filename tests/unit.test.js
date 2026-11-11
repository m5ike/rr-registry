'use strict';
// Unit tests: tar, semver, routing rules, client generators.  Run: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tar = require('../server/src/util/tar');
const semver = require('../server/src/util/semver');
const router = require('../server/src/plugins/router');
const gen = require('../tools/gen-clients');
const { safeJoin } = require('../server/src/util/store');

const spec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'spec.json'), 'utf8'));

test('tar: create + extract roundtrip incl. long paths', () => {
  const long = `package/${'a'.repeat(80)}/${'b'.repeat(60)}.txt`;
  const tgz = tar.create([
    { name: 'package/package.json', data: JSON.stringify({ name: 'x', version: '1.2.3' }) },
    { name: 'package/README.md', data: '# X' },
    { name: long, data: Buffer.alloc(1500, 7), mode: 0o755 },
  ]);
  const e = tar.extract(tgz);
  assert.strictEqual(e.length, 3);
  assert.strictEqual(e[2].name, long);
  assert.strictEqual(e[2].data.length, 1500);
  assert.strictEqual(e[2].mode, 0o755);
  assert.deepStrictEqual(tar.readPackageJson(tgz), { name: 'x', version: '1.2.3' });
  assert.strictEqual(tar.readReadme(tgz), '# X');
});

test('semver: compare and maxStable', () => {
  assert.ok(semver.compare('1.10.0', '1.9.0') > 0);
  assert.ok(semver.compare('1.0.0', '1.0.0-beta.2') > 0);
  assert.ok(semver.compare('1.0.0-beta.10', '1.0.0-beta.2') > 0);
  assert.ok(semver.compare('1.0.0-alpha', '1.0.0-beta') < 0);
  assert.strictEqual(semver.maxStable(['1.0.0', '2.0.0-rc.1', '1.5.0']), '1.5.0');
  assert.strictEqual(semver.maxStable(['2.0.0-rc.1']), '2.0.0-rc.1');
  assert.ok(!semver.valid('latest'));
});

test('router: pattern matching types', () => {
  assert.ok(router.testPattern('prefix', '/@corp/', '/@corp/utils'));
  assert.ok(!router.testPattern('prefix', '/@corp/', '/@other/utils'));
  assert.ok(router.testPattern('glob', '/@corp/*', '/@corp/utils'));
  assert.ok(!router.testPattern('glob', '/@corp/*', '/@corp/utils/-/x.tgz'));
  assert.ok(router.testPattern('glob', '/@corp/**', '/@corp/utils/-/x.tgz'));
  assert.ok(router.testPattern('regex', '^/(react|vue)', '/react-dom'));
  assert.ok(router.testPattern('contains', 'lodash', '/lodash.merge'));
  assert.ok(router.testPattern('exact', '/a', '/a'));
  assert.ok(!router.testPattern('exact', '/a', '/ab'));
  assert.ok(router.testPattern('prefix', '', '/anything'));
});

test('router: rule normalization and validation', () => {
  const r = router.normalizeRule({ name: 'x', target: 'https://example.com/', methods: 'get, head' });
  assert.strictEqual(r.target, 'https://example.com');
  assert.deepStrictEqual(r.methods, ['GET', 'HEAD']);
  assert.strictEqual(r.when, 'notfound');
  assert.throws(() => router.normalizeRule({ name: 'x', target: 'ftp://x' }), /target/);
  assert.throws(() => router.normalizeRule({ name: 'x', target: 'http://x', matchType: 'regex', pattern: '(' }), /regex/);
  assert.throws(() => router.normalizeRule({ target: 'http://x' }), /name/);
});

test('store: safeJoin refuses path traversal', () => {
  assert.ok(safeJoin('/tmp/repo', 'a/b').endsWith('/tmp/repo/a/b'));
  assert.throws(() => safeJoin('/tmp/repo', '../etc/passwd'));
  assert.throws(() => safeJoin('/tmp/repo', '/../../etc'));
});

test('generator: JS client has a method for every operation and loads', () => {
  const code = gen.js(spec, '9.9.9');
  const m = { exports: {} };
  new Function('module', 'exports', code)(m, m.exports);
  const RRClient = m.exports;
  assert.strictEqual(RRClient.version, '9.9.9');
  for (const op of spec.operations) assert.strictEqual(typeof RRClient.prototype[op.id], 'function', op.id);
  assert.match(gen.dts(spec, '9.9.9'), /listRepos\(/);
});

test('generator: bash client defines a function for every operation', () => {
  const code = gen.bash(spec, '9.9.9');
  for (const op of spec.operations) assert.ok(code.includes(`rr_api_${gen.snake(op.id)}() {`), op.id);
  assert.strictEqual(gen.snake('listCache'), 'list_cache');
});

test('spec: operation ids unique and paths valid', () => {
  const ids = new Set();
  for (const op of spec.operations) {
    assert.ok(!ids.has(op.id), `duplicate ${op.id}`);
    ids.add(op.id);
    assert.match(op.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
    assert.match(op.auth, /^(none|user|read|publish|admin)$/);
    assert.ok(op.path.startsWith('/'));
  }
});

#!/usr/bin/env node
'use strict';
// Build ("compile") step:
//   1. generate client libraries from api/spec.json (JS, TypeScript types, bash) and docs/API.md
//   2. assemble client packages in dist/clients/<pkg>/
//   3. pack them into npm tarballs dist/packages/*.tgz + dist/packages/index.json
// The server publishes these packages into its registry on start (maintainer m5ike)
// and offers them for download on the homepage.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gen = require('./gen-clients');
const tar = require('../server/src/util/tar');

const ROOT = path.resolve(__dirname, '..');

const PACKAGES = [
  { dir: 'rr-client', generated: { 'rr-client.js': 'js', 'rr-client.d.ts': 'dts' } },
  { dir: 'rr_bash-cli', generated: { 'lib/rr-api.sh': 'bash' }, shared: ['rr-common.sh'] },
  { dir: 'rr_bash-gui', generated: { 'lib/rr-api.sh': 'bash' }, shared: ['rr-common.sh'] },
  { dir: 'rr_web-guicli', generated: { 'lib/rr-client.js': 'js', 'web/rr-client.js': 'js' }, web: true },
];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

function build({ quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim();
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'spec.json'), 'utf8'));
  spec.version = version;
  const outputs = { js: gen.js(spec, version), dts: gen.dts(spec, version), bash: gen.bash(spec, version) };

  fs.writeFileSync(path.join(ROOT, 'docs', 'API.md'), gen.markdown(spec, version));

  const dist = path.join(ROOT, 'dist');
  const clientsDir = path.join(dist, 'clients');
  const pkgDir = path.join(dist, 'packages');
  fs.rmSync(clientsDir, { recursive: true, force: true });
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });

  const index = [];
  for (const p of PACKAGES) {
    const dst = path.join(clientsDir, p.dir);
    copyDir(path.join(ROOT, 'clients', p.dir), dst);
    for (const [file, kind] of Object.entries(p.generated)) {
      fs.mkdirSync(path.dirname(path.join(dst, file)), { recursive: true });
      fs.writeFileSync(path.join(dst, file), outputs[kind]);
    }
    for (const f of p.shared || []) fs.copyFileSync(path.join(ROOT, 'clients', 'shared', f), path.join(dst, 'lib', f));
    if (p.web) {
      copyDir(path.join(ROOT, 'web', 'admin'), path.join(dst, 'web'));
    }
    const pjFile = path.join(dst, 'package.json');
    const pj = JSON.parse(fs.readFileSync(pjFile, 'utf8'));
    pj.version = version;
    pj.author = 'm5ike';
    pj.maintainers = [{ name: 'm5ike', email: 'm5ike@users.noreply.github.com' }];
    pj.license = pj.license || 'MIT';
    fs.writeFileSync(pjFile, JSON.stringify(pj, null, 2) + '\n');

    const files = listFiles(dst);
    const entries = files.map((rel) => {
      const exec = rel.startsWith('bin/') || rel.endsWith('.sh');
      if (exec) fs.chmodSync(path.join(dst, rel), 0o755);
      return { name: `package/${rel}`, data: fs.readFileSync(path.join(dst, rel)), mode: exec ? 0o755 : 0o644 };
    });
    const tgz = tar.create(entries);
    const file = `${pj.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
    fs.writeFileSync(path.join(pkgDir, file), tgz);
    index.push({
      name: pj.name,
      version,
      description: pj.description,
      bin: pj.bin ? Object.keys(pj.bin) : [],
      file,
      size: tgz.length,
      integrity: `sha512-${crypto.createHash('sha512').update(tgz).digest('base64')}`,
      maintainer: 'm5ike',
      files: files.length,
    });
    log(`  packed ${pj.name}@${version} -> dist/packages/${file} (${files.length} files, ${tgz.length} B)`);
  }
  fs.writeFileSync(path.join(pkgDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  log(`build ok: ${index.length} client packages, docs/API.md (${spec.operations.length} operations)`);
  return { version, packages: index };
}

module.exports = { build, PACKAGES };

if (require.main === module) build();

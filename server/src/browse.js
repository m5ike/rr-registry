'use strict';
// Public (anonymous) browser of repositories - a themable HTML view of every repository type:
//   generic  directories and files            npm     packages -> versions (tarballs), README of the package
//   docker   images -> tags (pull commands)    git     repositories -> files of the default branch
//   group    the members merged (npm / generic)
// README.md of the current directory / package / git repository is rendered below the listing; the repository
// can add its own introduction (browser.intro).
//
// URL masks (HTML pages; see typehosts.js):
//   http(s)://<type>-{registry|rr}.<domain>/[<repository>/]<path>      type host (git keeps its GitHub-like UI)
//   http(s)://<repository>.<type>.{registry|rr}.<domain>/<path>        repository host
//   http(s)://{registry|rr}.<domain>/<type>/[<repository>/]<path>      main host
// Data for the page (no authentication needed when the repository is readable anonymously):
//   GET  /-/rr/browse/<repository>/list?path=        listing, README, details
//   GET  /-/rr/browse/<repository>/raw?path=         one file (speed limit, filter)
//   GET|POST /-/rr/browse/<repository>/archive       selected paths as zip, tar.gz or tar.bz2
// The design (repository config `browser`) is edited in the administration (Repozitáře -> detail).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Readable, Transform, PassThrough, pipeline } = require('stream');
const { spawn, spawnSync } = require('child_process');
const { HttpError, send, sendJson, mimeType, readBody } = require('./util/http');
const { tarStream } = require('./util/archive');
const files = require('./repos/files');
const gitu = require('./util/git');

const THEMES = {
  amber: '#F5A524', ocean: '#0EA5E9', forest: '#16A34A', grape: '#8B5CF6', rose: '#E11D48',
  sunset: '#F97316', teal: '#14B8A6', slate: '#64748B', mono: '#111827',
};
const FONTS = ['Inter', 'Space Grotesk', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'IBM Plex Sans', 'Source Sans 3', 'Work Sans', 'DM Sans', 'Manrope', 'Outfit', 'Raleway', 'Merriweather', 'Playfair Display', 'Lora', 'Fraunces', 'Bitter'];
const MONO_FONTS = ['JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro', 'Roboto Mono', 'Space Mono'];
const VIEWS = ['list', 'grid', 'tiles', 'details'];
const COLUMNS = ['size', 'modified', 'type', 'version', 'description'];
const SORTS = ['name', 'modified', 'size', 'type'];
const HEADERS = ['bar', 'hero', 'minimal', 'none'];
const BUTTONS = ['rounded', 'pill', 'square', 'outline', 'soft'];
const DENSITY = ['compact', 'comfortable', 'spacious'];
const MODES = ['auto', 'light', 'dark'];
const ALL_FORMATS = ['zip', 'tar.gz', 'tar.bz2'];
const MAX_ARCHIVE_FILES = 5000;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

const DEFAULTS = {
  enabled: true, title: '', subtitle: '', logo: '', header: 'bar', theme: 'amber', accent: '', mode: 'auto',
  font: 'Inter', headingFont: '', monoFont: 'JetBrains Mono', buttons: 'rounded', radius: 12, density: 'comfortable',
  view: 'list', views: [...VIEWS], columns: ['size', 'modified'], search: true, sort: 'name', sortDir: 'asc', allowSort: true,
  multiSelect: true, formats: [...ALL_FORMATS], rateLimitKBps: 0, filter: { mode: 'deny', patterns: [] }, showHidden: false,
  readme: true, intro: '', footer: '', showInstall: true, preview: true,
};

let bzip2Ok = null;
const hasBzip2 = () => {
  if (bzip2Ok === null) { const t = spawnSync('bzip2', ['--help'], { stdio: 'ignore' }); bzip2Ok = !t.error && t.status !== null; }
  return bzip2Ok;
};
const formatsAvailable = () => ALL_FORMATS.filter((f) => f !== 'tar.bz2' || hasBzip2());

// ------------------------------------------------------------------ config
const pick = (v, list, d) => (list.includes(v) ? v : d);
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);

/** Sanitized design of the public browser (unknown keys dropped, values clamped). */
function normalize(input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const c = { ...DEFAULTS, filter: { ...DEFAULTS.filter } };
  if (i.enabled !== undefined) c.enabled = i.enabled !== false && i.enabled !== 'false';
  c.title = str(i.title ?? c.title, 120);
  c.subtitle = str(i.subtitle ?? c.subtitle, 300);
  const logo = str(i.logo ?? '', 400 * 1024).trim();
  c.logo = /^https?:\/\/[^\s"'<>]{1,500}$/.test(logo) || /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo) ? logo : '';
  c.header = pick(i.header, HEADERS, c.header);
  c.theme = pick(i.theme, Object.keys(THEMES), c.theme);
  c.accent = /^#[0-9a-fA-F]{6}$/.test(i.accent || '') ? i.accent : '';
  c.mode = pick(i.mode, MODES, c.mode);
  const font = (v, lst, d) => (lst.includes(v) ? v : /^[A-Za-z0-9 ]{2,40}$/.test(v || '') ? v : d);
  c.font = font(i.font, FONTS, c.font);
  c.headingFont = i.headingFont ? font(i.headingFont, FONTS, '') : '';
  c.monoFont = font(i.monoFont, MONO_FONTS, c.monoFont);
  c.buttons = pick(i.buttons, BUTTONS, c.buttons);
  c.radius = Math.max(0, Math.min(28, Number(i.radius ?? c.radius) || 0));
  c.density = pick(i.density, DENSITY, c.density);
  c.views = list(i.views ?? c.views).filter((v) => VIEWS.includes(v));
  if (!c.views.length) c.views = ['list'];
  c.view = pick(i.view, c.views, c.views[0]);
  c.columns = i.columns !== undefined ? list(i.columns).filter((v) => COLUMNS.includes(v)) : [...DEFAULTS.columns];
  c.search = i.search !== undefined ? i.search !== false && i.search !== 'false' : c.search;
  c.sort = pick(i.sort, SORTS, c.sort);
  c.sortDir = pick(i.sortDir, ['asc', 'desc'], c.sortDir);
  for (const k of ['allowSort', 'multiSelect', 'showHidden', 'readme', 'showInstall', 'preview']) if (i[k] !== undefined) c[k] = i[k] === true || i[k] === 'true';
  c.formats = i.formats !== undefined ? list(i.formats).filter((f) => ALL_FORMATS.includes(f)) : [...ALL_FORMATS];
  c.rateLimitKBps = Math.max(0, Math.min(10 * 1024 * 1024, Math.round(Number(i.rateLimitKBps) || 0)));
  const f = i.filter && typeof i.filter === 'object' ? i.filter : {};
  c.filter = { mode: pick(f.mode, ['deny', 'allow'], 'deny'), patterns: list(f.patterns).slice(0, 50).map((p) => p.slice(0, 200)) };
  c.intro = str(i.intro ?? '', 20000);
  c.footer = str(i.footer ?? '', 500);
  return c;
}

function globRe(glob) {
  let re = '';
  for (let k = 0; k < glob.length; k++) {
    const ch = glob[k];
    if (ch === '*') { if (glob[k + 1] === '*') { re += '.*'; k++; } else re += '[^/]*'; } else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Visibility rule of the browser: hidden files and the allow / deny masks (relative paths, "a/b.txt"). */
function makeFilter(cfg) {
  const rules = cfg.filter.patterns.map((p) => {
    const clean = p.replace(/^\/+/, '');
    return { re: globRe(clean.replace(/\/$/, '')), dirOnly: clean.endsWith('/'), anyDepth: !clean.includes('/') };
  });
  const hit = (rel, isDir) => rules.some((r) => {
    if (r.dirOnly && !isDir) return false;
    if (r.anyDepth) return rel.split('/').some((seg) => r.re.test(seg));
    return r.re.test(rel) || (isDir && r.re.test(`${rel}/`));
  });
  // a file inside a denied directory is denied too
  const ancestorsDenied = (rel) => { const parts = rel.split('/'); for (let k = 1; k < parts.length; k++) if (hit(parts.slice(0, k).join('/'), true)) return true; return false; };
  return (relPath, isDir) => {
    const rel = String(relPath || '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!rel) return true;
    if (!cfg.showHidden && rel.split('/').some((s) => s.startsWith('.'))) return false;
    if (!rules.length) return true;
    if (cfg.filter.mode === 'deny') return !hit(rel, isDir) && !ancestorsDenied(rel);
    // allow: directories stay browsable, files must match
    return isDir ? true : hit(rel, false);
  };
}

// ------------------------------------------------------------------ streams
/** Token-bucket speed limit (bytes per second) as a Transform stream. */
class Throttle extends Transform {
  constructor(bytesPerSec) {
    super();
    this.rate = bytesPerSec;
    this.start = Date.now();
    this.sent = 0;
  }

  _transform(chunk, enc, done) {
    const pieces = [];
    for (let o = 0; o < chunk.length; o += 16384) pieces.push(chunk.subarray(o, o + 16384));
    const next = () => {
      const p = pieces.shift();
      if (!p) return done();
      this.sent += p.length;
      this.push(p);
      const due = this.start + (this.sent / this.rate) * 1000 - Date.now();
      return due > 0 ? setTimeout(next, due) : setImmediate(next);
    };
    next();
  }
}

let CRC_TABLE = null;
function crc32(buf, crc = 0) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf, crc);
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
  }
  let c = ~crc;
  for (let k = 0; k < buf.length; k++) c = CRC_TABLE[(c ^ buf[k]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(ms) {
  const d = new Date(ms);
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** Streaming ZIP (deflate, data descriptors, UTF-8 names) of entries { name, data } | { name, file }. */
async function* zipStream(entries) {
  const central = [];
  let offset = 0;
  for await (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    let data = e.data;
    let mtime = e.mtime || Date.now();
    if (data === undefined) {
      try { data = fs.readFileSync(e.file); mtime = fs.statSync(e.file).mtimeMs; } catch { continue; }
    }
    data = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const comp = zlib.deflateRawSync(data);
    const store = comp.length >= data.length;
    const body = store ? data : comp;
    const crc = crc32(data);
    const { time, date } = dosTime(mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    yield local; yield name; yield body;
    central.push({ name, crc, csize: body.length, size: data.length, method: store ? 0 : 8, time, date, offset });
    offset += 30 + name.length + body.length;
  }
  let size = 0;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(0x031e, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE((0o100644 << 16) >>> 0, 38); h.writeUInt32LE(c.offset, 42);
    yield h; yield c.name;
    size += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  yield end;
}

// ------------------------------------------------------------------ the browser
class Browser {
  constructor(app) {
    this.app = app;
  }

  config(conf) {
    return normalize(conf.browser || {});
  }

  /** Options for the design editor. */
  meta() {
    return { themes: THEMES, fonts: FONTS, monoFonts: MONO_FONTS, views: VIEWS, columns: COLUMNS, sorts: SORTS, headers: HEADERS, buttons: BUTTONS, density: DENSITY, modes: MODES, formats: formatsAvailable(), defaults: DEFAULTS };
  }

  /** The repository for a browser request; enforces read access and browser.enabled. */
  open(req, name) {
    const conf = this.app.repoConfig(name);
    if (!conf) throw new HttpError(404, `repository ${name} not found`);
    const cfg = this.config(conf);
    if (!cfg.enabled) throw new HttpError(404, `the public browser of ${name} is disabled`);
    const identity = this.app.auth.require(req, 'read', conf);
    const type = conf.type === 'group' ? this.app.typeHosts.typeOf(conf) || 'generic' : conf.type;
    return { conf, cfg, type, identity, handler: this.app.repoHandler(name), visible: makeFilter(cfg) };
  }

  // ---------- generic (also group of generic repositories: first member wins) ----------
  roots(r) {
    if (r.conf.type === 'group') return r.handler.readable(r.identity).filter((h) => h.conf.type === 'generic').map((h) => h.dir);
    return [r.handler.dir];
  }

  genericList(r, p) {
    const seen = new Map();
    let found = false;
    for (const root of this.roots(r)) {
      let t;
      try { t = files.tree(root, p, 1); } catch { continue; }
      if (t.type !== 'dir') throw new HttpError(400, `${p} is a file`);
      found = true;
      for (const c of t.children || []) if (!seen.has(c.name)) seen.set(c.name, { ...c, root });
    }
    if (!found) throw new HttpError(404, `${p} not found`);
    const entries = [...seen.values()]
      .filter((c) => r.visible(c.path, c.type === 'dir'))
      .map((c) => ({ name: c.name, path: c.path, type: c.type, size: c.size, modified: c.modified, download: c.type === 'file' }));
    const rd = [...seen.values()].find((c) => c.type === 'file' && /^readme(\.(md|markdown|txt))?$/i.test(c.name) && r.visible(c.path, false));
    const readme = rd ? { name: rd.name, path: rd.path, text: fs.readFileSync(path.join(rd.root, rd.path)).toString('utf8').slice(0, 512 * 1024) } : null;
    return { kind: 'dir', entries, readme };
  }

  genericFile(r, p) {
    for (const root of this.roots(r)) {
      try {
        const st = files.stat(root, p);
        if (st.type === 'file') return { file: path.join(root, p.replace(/^\/+/, '')), size: st.size, modified: st.modified };
      } catch { /* next member */ }
    }
    return null;
  }

  // ---------- npm ----------
  npmDoc(r, name) {
    if (r.conf.type === 'group') return r.handler.mergedPackument(name, r.identity);
    return r.handler.read(name);
  }

  npmTarballFile(r, name, file) {
    const hs = r.conf.type === 'group' ? r.handler.readable(r.identity).filter((h) => h.conf.type === 'npm') : [r.handler];
    for (const h of hs) {
      if (!/^[^/\\]+\.tgz$/.test(file)) return null;
      const f = path.join(h.pkgDir(name), file);
      if (fs.existsSync(f)) return f;
    }
    return null;
  }

  npmList(r, p, base) {
    const rel = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!rel) {
      const pk = r.handler.listPackages('');
      const entries = pk.filter((x) => r.visible(x.name, true)).map((x) => ({ name: x.name, path: `/${x.name}`, type: 'package', version: x.version, description: x.description, modified: x.modified, size: x.versions || 0 }));
      return { kind: 'packages', entries, readme: null };
    }
    const name = rel.split('/-/')[0];
    const doc = this.npmDoc(r, name);
    if (!doc || !r.visible(name, true)) throw new HttpError(404, `package ${name} not found`);
    const latest = doc['dist-tags'].latest;
    const m = doc.versions[latest] || {};
    const tags = doc['dist-tags'] || {};
    const entries = Object.keys(doc.versions).reverse().map((v) => {
      const file = path.basename(String((doc.versions[v].dist || {}).tarball || `${name.split('/').pop()}-${v}.tgz`));
      const tf = this.npmTarballFile(r, name, file);
      let size = 0;
      try { size = tf ? fs.statSync(tf).size : 0; } catch { /* missing */ }
      const t = Object.keys(tags).filter((k) => tags[k] === v);
      return { name: file, path: `/${name}/-/${file}`, type: 'file', version: v, size, modified: (doc.time || {})[v] || null, description: [t.join(', '), doc.versions[v].deprecated ? `deprecated: ${doc.versions[v].deprecated}` : ''].filter(Boolean).join(' · '), download: !!tf };
    }).filter((e) => r.visible(e.path, false));
    const reg = `${base}${this.app.repoPrefix(r.conf.name)}/`;
    return {
      kind: 'package',
      entries,
      readme: doc.readme ? { name: 'README.md', path: `/${name}/README.md`, text: String(doc.readme).slice(0, 512 * 1024) } : null,
      info: {
        name, version: latest, description: doc.description || m.description || '', license: m.license || '', homepage: m.homepage || '',
        keywords: m.keywords || [], author: typeof m.author === 'object' ? m.author.name : m.author || '', distTags: tags,
        install: `npm install ${name} --registry ${reg}`,
      },
    };
  }

  // ---------- docker ----------
  dockerList(r, p, base) {
    const rel = p.replace(/^\/+/, '').replace(/\/+$/, '');
    const host = base.replace(/^https?:\/\//, '');
    if (!rel) {
      const entries = r.handler.images().filter((x) => r.visible(x.name, true)).map((x) => ({ name: x.name, path: `/${x.name}`, type: 'image', size: x.size, modified: x.updated, version: `${x.tags} tag(ů)` }));
      return { kind: 'images', entries, readme: null, info: { pull: `docker pull ${host}/<image>:<tag>` } };
    }
    if (!r.visible(rel, true)) throw new HttpError(404, `image ${rel} not found`);
    const tags = r.handler.tagDetails(rel);
    const entries = tags.map((t) => ({ name: t.tag, path: `/${rel}:${t.tag}`, type: 'tag', size: t.size, modified: t.created, description: t.digest ? t.digest.slice(0, 19) : '', pull: `docker pull ${host}/${rel}:${t.tag}` }));
    return { kind: 'image', entries, readme: null, info: { name: rel, pull: `docker pull ${host}/${rel}:${tags.some((t) => t.tag === 'latest') ? 'latest' : (tags[0] || {}).tag || 'latest'}` } };
  }

  // ---------- git ----------
  gitSplit(r, rel, identity) {
    const parts = rel.split('/').filter(Boolean);
    for (let k = Math.min(parts.length, 4); k >= 1; k--) {
      const cand = parts.slice(0, k).join('/').replace(/\.git$/, '');
      if (r.handler.exists(cand)) {
        if (!r.handler.roleIn(cand, identity)) return null;
        return { name: cand, path: parts.slice(k).join('/') };
      }
    }
    return null;
  }

  async gitList(r, p, base, identity) {
    const rel = p.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!rel) {
      const entries = r.handler.list('', identity).filter((g) => r.visible(g.name, true)).map((g) => ({ name: g.name, path: `/${g.name}`, type: 'repo', description: g.description, modified: g.created, private: g.private }));
      return { kind: 'repos', entries, readme: null };
    }
    const sp = this.gitSplit(r, rel, identity);
    if (!sp) throw new HttpError(404, `${rel} not found`);
    const g = r.handler;
    const ref = await g.ensureHead(sp.name);
    const meta = g.meta(sp.name);
    const info = { name: sp.name, description: meta.description || '', defaultBranch: ref, cloneUrls: { https: g.cloneUrl(base, sp.name), ssh: g.sshUrl(base, sp.name) } };
    if (!ref || !(await g.refExists(sp.name, `refs/heads/${ref}`))) return { kind: 'repo', entries: [], readme: null, info: { ...info, empty: true } };
    const t = await g.tree(sp.name, { ref, path: sp.path });
    const entries = t.entries
      .filter((e) => e.type !== 'submodule' && r.visible(`${sp.name}/${e.path}`, e.type === 'dir'))
      .map((e) => ({ name: e.name, path: `/${sp.name}/${e.path}`, type: e.type, size: e.size, download: e.type === 'file' }));
    const rd = t.entries.find((e) => e.type === 'file' && /^readme(\.(md|markdown|txt))?$/i.test(e.name) && r.visible(`${sp.name}/${e.path}`, false));
    const readme = rd ? { name: rd.name, path: `/${sp.name}/${rd.path}`, text: (await g.blob(sp.name, { ref, path: rd.path })).toString('utf8').slice(0, 512 * 1024) } : null;
    return { kind: sp.path ? 'dir' : 'repo', entries, readme, info };
  }

  // ---------- API ----------
  async list(req, name, p, base) {
    const r = this.open(req, name);
    const identity = this.app.auth.authenticate(req);
    const clean = `/${String(p || '').replace(/^\/+/, '')}`;
    if (clean.split('/').includes('..')) throw new HttpError(400, 'invalid path');
    let out;
    // a file: its details (the page shows a preview and a download button)
    const file = await this.fileAt(r, clean, identity);
    if (file) return { repo: r.conf.name, type: r.type, path: clean, kind: 'file', file, entries: [], readme: null, formats: [] };
    if (r.type === 'npm') out = this.npmList(r, clean, base);
    else if (r.type === 'docker') out = this.dockerList(r, clean, base);
    else if (r.type === 'git') out = await this.gitList(r, clean, base, identity);
    else out = this.genericList(r, clean);
    return { repo: r.conf.name, type: r.type, path: clean, ...out, formats: r.cfg.multiSelect ? r.cfg.formats.filter((f) => formatsAvailable().includes(f)) : [] };
  }

  /** Details of a file at `p` ({ name, path, size, modified }) or null when `p` is not a file. */
  async fileAt(r, p, identity) {
    const rel = p.replace(/^\/+/, '');
    if (!rel) return null;
    if (r.type === 'generic') {
      const f = this.genericFile(r, p);
      if (!f) return null;
      if (!r.visible(rel, false)) throw new HttpError(404, `${rel} not found`);
      return { name: path.basename(rel), path: p, size: f.size, modified: f.modified };
    }
    if (r.type === 'npm') {
      const m = /^(.+)\/-\/([^/]+\.tgz)$/.exec(rel);
      const f = m && this.npmTarballFile(r, m[1], m[2]);
      if (!f) return null;
      if (!r.visible(p, false)) throw new HttpError(404, `${rel} not found`);
      return { name: m[2], path: p, size: fs.statSync(f).size, modified: fs.statSync(f).mtime.toISOString() };
    }
    if (r.type === 'git') {
      const sp = this.gitSplit(r, rel, identity);
      if (!sp || !sp.path) return null;
      const ref = await r.handler.ensureHead(sp.name);
      const t = await gitu.run(['cat-file', '-s', `${ref}:${sp.path}`], { cwd: r.handler.repoDir(sp.name) });
      const ty = await gitu.run(['cat-file', '-t', `${ref}:${sp.path}`], { cwd: r.handler.repoDir(sp.name) });
      if (t.code !== 0 || ty.stdout.toString().trim() !== 'blob') return null;
      if (!r.visible(`${sp.name}/${sp.path}`, false)) throw new HttpError(404, `${rel} not found`);
      return { name: path.basename(sp.path), path: p, size: Number(t.stdout.toString().trim()) || 0, repo: sp.name };
    }
    return null;
  }

  /** { file | data, name, size } of one downloadable path, or 404. */
  async resolveFile(r, p, identity) {
    const rel = String(p || '').replace(/^\/+/, '');
    if (!rel || rel.split('/').includes('..')) throw new HttpError(400, 'invalid path');
    if (r.type === 'npm') {
      const m = /^(.+)\/-\/([^/]+\.tgz)$/.exec(rel);
      const f = m && r.visible(`/${rel}`, false) ? this.npmTarballFile(r, m[1], m[2]) : null;
      if (!f) throw new HttpError(404, `${rel} not found`);
      return { file: f, name: m[2], size: fs.statSync(f).size };
    }
    if (r.type === 'git') {
      const sp = this.gitSplit(r, rel, identity);
      if (!sp || !sp.path || !r.visible(`${sp.name}/${sp.path}`, false)) throw new HttpError(404, `${rel} not found`);
      const data = await r.handler.blob(sp.name, { path: sp.path });
      return { data, name: path.basename(sp.path), size: data.length };
    }
    if (r.type !== 'generic') throw new HttpError(400, 'no files to download in this repository type');
    if (!r.visible(rel, false)) throw new HttpError(404, `${rel} not found`);
    const f = this.genericFile(r, `/${rel}`);
    if (!f) throw new HttpError(404, `${rel} not found`);
    return { file: f.file, name: path.basename(rel), size: f.size };
  }

  async raw(req, res, name, p, { inline = false } = {}) {
    const r = this.open(req, name);
    const identity = this.app.auth.authenticate(req);
    const f = await this.resolveFile(r, p, identity);
    const headers = {
      'content-type': mimeType(f.name), 'content-length': f.size, 'x-content-type-options': 'nosniff',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
    };
    this.app.stats.downloads++;
    this.app.statsStore.hit(r.conf.name, String(p));
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const src = f.file ? fs.createReadStream(f.file) : Readable.from([f.data]);
    return this.pipe(src, res, r.cfg);
  }

  pipe(src, res, cfg) {
    return new Promise((resolve) => {
      const chain = [src];
      if (cfg.rateLimitKBps) chain.push(new Throttle(cfg.rateLimitKBps * 1024));
      chain.push(res);
      pipeline(...chain, () => resolve());
    });
  }

  /** Files of the selected paths (directories recursively), filtered; [{ name (in the archive), file | data }]. */
  async collect(r, paths, baseDir, identity) {
    const out = [];
    let bytes = 0;
    const add = (e, size) => {
      if (out.length >= MAX_ARCHIVE_FILES) throw new HttpError(413, `more than ${MAX_ARCHIVE_FILES} files - select less`);
      bytes += size || 0;
      if (bytes > MAX_ARCHIVE_BYTES) throw new HttpError(413, 'the selection is too large for one archive');
      out.push(e);
    };
    const base = String(baseDir || '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const inArchive = (rel) => (base && rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : rel);
    for (const p0 of paths) {
      const rel = String(p0).replace(/^\/+/, '').replace(/\/+$/, '');
      if (!rel || rel.split('/').includes('..')) continue;
      if (r.type === 'generic') {
        for (const root of this.roots(r)) {
          let st;
          try { st = files.stat(root, `/${rel}`); } catch { continue; }
          if (st.type === 'file') { if (r.visible(rel, false)) add({ name: inArchive(rel), file: path.join(root, rel) }, st.size); break; }
          const walk = (d) => {
            for (const c of files.tree(root, `/${d}`, 1).children || []) {
              const cr = c.path.replace(/^\/+/, '');
              if (!r.visible(cr, c.type === 'dir')) continue;
              if (c.type === 'dir') walk(cr); else add({ name: inArchive(cr), file: path.join(root, cr) }, c.size);
            }
          };
          if (r.visible(rel, true)) walk(rel);
          break;
        }
      } else if (r.type === 'npm') {
        const m = /^(.+)\/-\/([^/]+\.tgz)$/.exec(rel);
        if (m) {
          const f = r.visible(`/${rel}`, false) && this.npmTarballFile(r, m[1], m[2]);
          if (f) add({ name: m[2], file: f }, fs.statSync(f).size);
        } else {
          const doc = this.npmDoc(r, rel);
          if (!doc || !r.visible(rel, true)) continue;
          for (const v of Object.keys(doc.versions)) {
            const file = path.basename(String((doc.versions[v].dist || {}).tarball || ''));
            const f = file && this.npmTarballFile(r, rel, file);
            if (f) add({ name: `${rel.replace('/', '__')}/${file}`, file: f }, fs.statSync(f).size);
          }
        }
      } else if (r.type === 'git') {
        const sp = this.gitSplit(r, rel, identity);
        if (!sp) continue;
        const g = r.handler;
        const ref = await g.ensureHead(sp.name);
        const cwd = g.repoDir(sp.name);
        const ls = await gitu.run(['ls-tree', '-r', '-z', '-l', ref, ...(sp.path ? ['--', sp.path] : [])], { cwd });
        if (ls.code !== 0) continue;
        for (const line of ls.stdout.toString().split('\0').filter(Boolean)) {
          const [meta, fp] = line.split('\t');
          const [, type, , size] = meta.split(/\s+/);
          if (type !== 'blob' || !r.visible(`${sp.name}/${fp}`, false)) continue;
          if (sp.path && fp !== sp.path && !fp.startsWith(`${sp.path}/`)) continue;
          const data = await g.blob(sp.name, { ref, path: fp });
          add({ name: inArchive(`${sp.name}/${fp}`), data }, Number(size) || data.length);
        }
      }
    }
    if (!out.length) throw new HttpError(404, 'nothing to download (empty selection or filtered out)');
    return out;
  }

  async archive(req, res, name, query) {
    const r = this.open(req, name);
    if (!r.cfg.multiSelect) throw new HttpError(403, 'downloading several files is disabled in this repository');
    let params = { ...query };
    if (req.method === 'POST') {
      const body = (await readBody(req, 1024 * 1024)).toString('utf8');
      const ct = String(req.headers['content-type'] || '');
      if (/json/.test(ct)) params = { ...params, ...JSON.parse(body || '{}') };
      else { const sp = new URLSearchParams(body); params = { ...params, format: sp.get('format') || params.format, base: sp.get('base') || params.base, paths: sp.getAll('p') }; }
    }
    const paths = Array.isArray(params.paths) ? params.paths : [].concat(params.p || []).filter(Boolean);
    const format = params.format || 'zip';
    if (!r.cfg.formats.includes(format) || !formatsAvailable().includes(format)) throw new HttpError(400, `format must be one of ${r.cfg.formats.filter((f) => formatsAvailable().includes(f)).join(', ')}`);
    if (!paths.length) throw new HttpError(400, 'select at least one path');
    const identity = this.app.auth.authenticate(req);
    const entries = await this.collect(r, paths.slice(0, 1000), params.base, identity);
    const stem = `${r.conf.name}-${new Date().toISOString().slice(0, 10)}`;
    this.app.statsStore.hit(r.conf.name, `archive.${format}`);
    res.writeHead(200, {
      'content-type': { zip: 'application/zip', 'tar.gz': 'application/gzip', 'tar.bz2': 'application/x-bzip2' }[format],
      'content-disposition': `attachment; filename="${stem}.${format}"`,
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    if (format === 'zip') return this.pipe(Readable.from(zipStream(entries)), res, r.cfg);
    const tar = Readable.from(tarStream(entries));
    if (format === 'tar.gz') {
      const gz = zlib.createGzip();
      tar.pipe(gz);
      return this.pipe(gz, res, r.cfg);
    }
    const bz = spawn('bzip2', ['-c']);
    tar.pipe(bz.stdin);
    bz.stdin.on('error', () => {});
    const out = new PassThrough();
    bz.stdout.pipe(out);
    return this.pipe(out, res, r.cfg);
  }

  // ---------- page ----------
  /** HTML shell of the browser (the page renders itself from /-/rr/browse/... data). */
  page(req, res, { name, base, path: p }) {
    let r;
    try { r = this.open(req, name); } catch (e) {
      if (!e.status || e.status >= 500) throw e;
      // a readable HTML answer for people (private or disabled repository, unknown name)
      const msg = e.status === 401 ? 'Tento repozitář není veřejný – přihlaste se.' : e.status === 404 ? 'Repozitář nebo jeho veřejný prohlížeč neexistuje.' : e.message;
      const html = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e.status === 401 ? 'Přihlášení' : 'Nenalezeno'}</title><link rel="stylesheet" href="/static/browse.css"></head>
<body><main class="wrap" style="padding-top:12vh"><section class="card pad empty"><h1>${e.status === 401 ? 'Vyžaduje přihlášení' : 'Nenalezeno'}</h1><p>${msg.replace(/[&<>"']/g, '')}</p><p><a class="btn primary" href="/admin/">Přihlásit</a> <a class="btn" href="/">Úvodní stránka</a></p></section></main></body></html>`;
      return send(res, e.status, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(e.status === 401 ? { 'www-authenticate': 'Bearer realm="rr-registry"' } : {}) });
    }
    const cfg = r.cfg;
    const s = this.app.stores.settings.get();
    const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    const fams = [...new Set([cfg.font, cfg.headingFont, cfg.monoFont].filter(Boolean))];
    const fontsUrl = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`).join('&')}&display=swap`;
    const title = cfg.title || r.conf.description || r.conf.name;
    const boot = {
      repo: r.conf.name, type: r.type, base, path: p || '/', api: `/-/rr/browse/${encodeURIComponent(r.conf.name)}`,
      cfg, themes: THEMES, registry: { title: s.title, version: this.app.config.version }, description: r.conf.description || '',
    };
    const nonce = crypto.randomBytes(12).toString('base64');
    const html = `<!doctype html>
<html lang="cs" data-mode="${esc(cfg.mode)}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(cfg.subtitle || r.conf.description || `${r.type} repozitář ${r.conf.name}`)}">
<link rel="icon" href="${cfg.logo && cfg.logo.startsWith('data:') ? esc(cfg.logo) : '/favicon.svg'}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" id="rb-fonts" href="${esc(fontsUrl)}">
<link rel="stylesheet" href="/static/browse.css">
</head>
<body class="rb-loading">
<div id="rb"></div>
<noscript><p style="padding:20px">Prohlížeč potřebuje JavaScript. Soubory lze stahovat i přímo přes API registru.</p></noscript>
<script nonce="${nonce}">window.RR_BROWSE = ${JSON.stringify(boot).replace(/</g, '\\u003c')};</script>
<script src="/admin/markdown.js"></script>
<script src="/static/browse.js"></script>
</body></html>`;
    return send(res, 200, html, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-frame-options': 'SAMEORIGIN' });
  }

  /** Requests under /-/rr/browse/<repo>/... */
  async handleApi(req, res, url) {
    const m = /^\/-\/rr\/browse\/([^/]+)\/(list|raw|archive)$/.exec(url.pathname);
    if (!m) throw new HttpError(404, 'unknown browser endpoint');
    const name = decodeURIComponent(m[1]);
    const q = Object.fromEntries(url.searchParams);
    q.p = url.searchParams.getAll('p');
    const base = require('./util/http').baseUrl(req, this.app.config);
    if (m[2] === 'list') return sendJson(res, 200, await this.list(req, name, q.path || '/', base));
    if (m[2] === 'raw') return this.raw(req, res, name, q.path, { inline: q.inline === '1' });
    return this.archive(req, res, name, q);
  }
}

module.exports = { Browser, normalize, makeFilter, zipStream, Throttle, THEMES, FONTS, DEFAULTS, formatsAvailable };

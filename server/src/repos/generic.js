'use strict';
// Generic (raw files) repository - any artifacts: archives, wheels, binaries, docs...
//   GET    /r/<repo>/<path>   download file or list directory (JSON, or HTML for browsers)
//   PUT    /r/<repo>/<path>   upload file (publish permission)
//   DELETE /r/<repo>/<path>   delete file or directory (publish permission)
const path = require('path');
const crypto = require('crypto');
const { HttpError, NotFoundLocal, send, sendJson, readBody, mimeType } = require('../util/http');
const { mkdirp } = require('../util/store');
const files = require('./files');
const { checkQuota, assertMutable, invalidate } = require('../policies');

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

class GenericRepo {
  constructor(app, conf) {
    this.app = app;
    this.conf = conf;
    this.dir = path.join(app.config.dataDir, 'repos', conf.name);
    mkdirp(this.dir);
  }

  packagePath() {
    return null;
  }

  listPackages(q = '') {
    const t = files.tree(this.dir, '/', 3);
    const out = [];
    const walk = (n) => {
      if (n.type === 'file' && (!q || n.path.includes(q))) out.push({ name: n.path, version: '', description: `${n.size} B`, modified: n.modified });
      (n.children || []).forEach(walk);
    };
    walk(t);
    return out;
  }

  /**
   * Retention policy (repo.cleanup): in every directory keep the newest `maxVersions` files and/or delete
   * files older than `maxAgeDays`; `pattern` (glob on the file path) limits which files are considered.
   */
  cleanup(policy = {}, { dryRun = false } = {}) {
    const { globToRegex } = require('../plugins/router');
    const re = policy.pattern ? globToRegex(policy.pattern) : null;
    const max = Number(policy.maxVersions) || 0;
    const age = Number(policy.maxAgeDays) || 0;
    const actions = [];
    const walk = (node) => {
      const kids = node.children || [];
      const fileList = kids.filter((c) => c.type === 'file' && (!re || re.test(c.path))).sort((a, b) => b.modified.localeCompare(a.modified));
      fileList.forEach((f, i) => {
        const old = age && Date.now() - Date.parse(f.modified) > age * 86400000;
        if ((max && i >= max) || old) actions.push({ action: 'delete-file', target: f.path, size: f.size, reason: old ? `older than ${age} days` : `more than ${max} files in directory` });
      });
      kids.filter((c) => c.type === 'dir').forEach(walk);
    };
    walk(files.tree(this.dir, '/', 20));
    let freedBytes = 0;
    if (!dryRun) {
      for (const a of actions) {
        try { files.remove(this.dir, a.target); freedBytes += a.size; } catch { /* already gone */ }
      }
      invalidate(this);
    }
    return { actions, freedBytes };
  }

  async handle(ctx) {
    const { req, res, method } = ctx;
    const rel = ctx.path;
    if (method === 'GET' || method === 'HEAD') {
      this.app.auth.require(req, 'read', this.conf);
      let st;
      try { st = files.stat(this.dir, rel); } catch { throw new NotFoundLocal(`${rel} not found`); }
      if (st.type === 'dir') {
        const t = files.tree(this.dir, rel, 1);
        if (/text\/html/.test(req.headers.accept || '')) {
          const prefix = ctx.base + (t.path === '/' ? '' : t.path);
          const rows = (t.children || []).map((c) => `<tr><td><a href="${esc(prefix)}/${esc(c.name)}${c.type === 'dir' ? '/' : ''}">${esc(c.name)}${c.type === 'dir' ? '/' : ''}</a></td><td>${c.type === 'dir' ? '' : c.size}</td><td>${c.modified}</td></tr>`).join('');
          return send(res, 200, `<!doctype html><meta charset="utf-8"><title>${esc(this.conf.name)}${esc(t.path)}</title><body style="font-family:sans-serif"><h2>${esc(this.conf.name)}${esc(t.path)}</h2><table cellpadding="4">${rows}</table></body>`, { 'content-type': 'text/html; charset=utf-8' });
        }
        return sendJson(res, 200, t);
      }
      const f = files.read(this.dir, rel);
      const etag = `"${crypto.createHash('sha1').update(f.data).digest('hex')}"`;
      if (req.headers['if-none-match'] === etag) return send(res, 304, null, { etag });
      this.app.stats.downloads++;
      if (method === 'GET') this.app.statsStore.hit(this.conf.name, rel);
      return send(res, 200, f.data, { 'content-type': mimeType(rel), etag, 'last-modified': f.stat.mtime.toUTCString() });
    }
    if (method === 'PUT') {
      const id = this.app.auth.require(req, 'publish', this.conf);
      if (this.conf.allowPublish === false) throw new HttpError(403, 'publishing disabled');
      let exists = false;
      try { exists = files.stat(this.dir, rel).type === 'file'; } catch { /* new file */ }
      if (exists) assertMutable(this.conf, 'overwriting files');
      checkQuota(this, Number(req.headers['content-length']) || 0);
      const data = await readBody(req, this.app.config.maxBody);
      checkQuota(this, data.length);
      const r = files.write(this.dir, rel, data);
      invalidate(this);
      this.app.audit(id, 'upload', `${this.conf.name}${r.path}`);
      this.app.events.emit('file.upload', { repo: this.conf.name, path: r.path, size: r.size, overwritten: exists }, id);
      return sendJson(res, 201, { ok: true, ...r });
    }
    if (method === 'DELETE') {
      const id = this.app.auth.require(req, 'publish', this.conf);
      assertMutable(this.conf, 'deleting files');
      files.remove(this.dir, rel);
      invalidate(this);
      this.app.audit(id, 'delete', `${this.conf.name}${rel}`);
      this.app.events.emit('file.delete', { repo: this.conf.name, path: rel }, id);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(405, 'method not allowed');
  }
}

module.exports = { GenericRepo };

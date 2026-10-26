'use strict';
// Static web: homepage, web administration (/admin/), assets, client downloads, installer.
const fs = require('fs');
const path = require('path');
const { send, baseUrl, mimeType } = require('./util/http');
const { safeJoin } = require('./util/store');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtSize(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} kB`;
}

function createWeb(app) {
  const c = app.config;
  const fileOr = (full) => {
    try {
      const st = fs.statSync(full);
      return st.isFile() ? fs.readFileSync(full) : null;
    } catch { return null; }
  };
  const clientJs = () => fileOr(path.join(c.distDir, 'clients', 'rr-client', 'rr-client.js'));

  function homepage(req) {
    const base = baseUrl(req, c);
    const s = app.stores.settings.get();
    const st = app.status(base);
    const clients = app.clientList(base);
    const rows = clients.map((p) => `
      <div class="card client">
        <div class="client-head"><h3>${esc(p.name)}</h3><span class="badge">v${esc(p.version)}</span></div>
        <p>${esc(p.description)}</p>
        <pre><code>${esc(p.npmInstall)}</code></pre>
        <div class="row"><a class="btn" href="${esc(p.download)}">⬇ ${esc(p.file)}</a><span class="muted">${fmtSize(p.size)} · maintainer ${esc(p.maintainer)}</span></div>
      </div>`).join('');
    const repos = app.listRepos().map((r) => `<tr><td><code>${esc(r.name)}</code>${r.name === s.defaultRepo ? ' <span class="badge">výchozí</span>' : ''}</td><td>${esc(r.type)}</td><td><code>${esc(base)}${r.name === s.defaultRepo ? '/' : `/r/${esc(r.name)}/`}</code></td><td>${esc(r.description)}</td></tr>`).join('');
    const tpl = fs.readFileSync(path.join(c.webDir, 'home', 'index.html'), 'utf8');
    const vars = {
      TITLE: esc(s.title), VERSION: esc(c.version), BASE: esc(base), HOST: esc(base.replace(/^https?:/, '')), CLIENTS: rows, REPOS: repos,
      MOTD: s.motd ? `<div class="motd">${esc(s.motd)}</div>` : '', PACKAGES: st.packages, REPOCOUNT: st.repos, UPTIME: Math.round(st.uptime / 60),
    };
    return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }

  async function serve(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const p = url.pathname;
    const accept = String(req.headers.accept || '');
    const html = { 'content-type': 'text/html; charset=utf-8' };

    if ((p === '/' && !/^application\/(json|vnd\.npm)/.test(accept)) || p === '/index.html') {
      send(res, 200, homepage(req), html);
      return true;
    }
    if (p === '/favicon.ico' || p === '/favicon.svg') {
      send(res, 200, fs.readFileSync(path.join(c.webDir, 'assets', 'logo.svg')), { 'content-type': 'image/svg+xml' });
      return true;
    }
    if (p === '/admin' && /text\/html/.test(accept)) {
      send(res, 302, null, { location: '/admin/' });
      return true;
    }
    if (p.startsWith('/admin/')) {
      const rel = p.slice('/admin/'.length) || 'index.html';
      if (rel === 'config.js') {
        send(res, 200, 'window.RR_CONFIG = { baseUrl: "" };\n', { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return true;
      }
      const data = rel === 'rr-client.js' ? clientJs() : fileOr(safeJoin(path.join(c.webDir, 'admin'), rel));
      if (!data) return false;
      send(res, 200, data, { 'content-type': mimeType(rel), 'cache-control': 'no-cache' });
      return true;
    }
    if (p.startsWith('/static/')) {
      const rel = p.slice('/static/'.length);
      const data = rel === 'rr-client.js' ? clientJs() : fileOr(safeJoin(path.join(c.webDir, 'assets'), rel));
      if (!data) return false;
      send(res, 200, data, { 'content-type': mimeType(rel), 'cache-control': 'public, max-age=300' });
      return true;
    }
    if (p === '/downloads' || p === '/downloads/') {
      send(res, 200, JSON.stringify(app.clientList(baseUrl(req, c)), null, 2), { 'content-type': 'application/json; charset=utf-8' });
      return true;
    }
    if (p.startsWith('/downloads/')) {
      const rel = path.basename(decodeURIComponent(p.slice('/downloads/'.length)));
      const data = fileOr(path.join(c.distDir, 'packages', rel));
      if (!data) return false;
      app.stats.downloads++;
      send(res, 200, data, { 'content-type': mimeType(rel), 'content-disposition': `attachment; filename="${rel}"` });
      return true;
    }
    if (p === '/install.sh') {
      const tpl = fs.readFileSync(path.join(c.root, 'clients', 'shared', 'install-clients.sh'), 'utf8');
      send(res, 200, tpl.replace(/__RR_SERVER__/g, baseUrl(req, c)), { 'content-type': 'text/x-shellscript; charset=utf-8' });
      return true;
    }
    if (p.startsWith('/docs/')) {
      const rel = path.basename(p.slice('/docs/'.length));
      const data = rel === 'README.md' ? fileOr(path.join(c.root, 'README.md')) : fileOr(path.join(c.root, 'docs', rel));
      if (!data) return false;
      send(res, 200, data, { 'content-type': 'text/plain; charset=utf-8' });
      return true;
    }
    return false;
  }

  return { serve, homepage };
}

module.exports = { createWeb };

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
    const ICON = {
      download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
      npm: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
      docker: 'M3 10h18v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 10V6h4v4M10 10V6h4v4M14 10V7h3v3',
      git: 'M6 4v10M18 4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM6 14a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM18 9c0 4-4 5-9.5 6.5',
      generic: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
      group: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    };
    const svg = (d, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
    const rows = clients.map((p) => `
      <article class="card client">
        <div class="client-head"><h3>${esc(p.name)}</h3><span class="badge">v${esc(p.version)}</span></div>
        <p>${esc(p.description)}</p>
        <code class="cmd-line">${esc(p.npmInstall)}</code>
        <div class="row"><a class="btn ghost" href="${esc(p.download)}">${svg(ICON.download, 17)}${esc(p.file)}</a><span class="muted small">${fmtSize(p.size)} · ${esc((p.bin || []).join(', ') || 'knihovna')}</span></div>
      </article>`).join('');
    const repoUrl = (r) => (r.type === 'docker' ? `${base.replace(/^https?:\/\//, '')}/<image>` : r.type === 'git' ? `${base}${r.name === s.gitRepo ? '/git' : `/r/${r.name}`}/<název>.git` : `${base}${r.name === s.defaultRepo ? '/' : `/r/${r.name}/`}`);
    const repos = app.listRepos().map((r) => `<tr><td><span class="repo-name"><span class="tile ${esc(r.type)}">${svg(ICON[r.type] || ICON.generic, 16)}</span><b>${esc(r.name)}</b>${r.name === s.defaultRepo ? ' <span class="badge">výchozí</span>' : ''}</span></td><td><span class="pill">${esc(r.type)}</span></td><td><code>${esc(repoUrl(r))}</code></td><td class="muted">${esc(r.description)}</td></tr>`).join('');
    const tpl = fs.readFileSync(path.join(c.webDir, 'home', 'index.html'), 'utf8');
    const vars = {
      TITLE: esc(s.title), VERSION: esc(c.version), BASE: esc(base), HOST: esc(base.replace(/^https?:/, '')), CLIENTS: rows, REPOS: repos,
      MOTD: s.motd ? `<div class="motd">${esc(s.motd)}</div>` : '', PACKAGES: st.packages, REPOCOUNT: st.repos, UPTIME: Math.round(st.uptime / 60),
      GITREPOS: st.gitRepos || 0, DOCKERHOST: esc(base.replace(/^https?:\/\//, '')),
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
        // portal: attached to the AI Tools Portal -> the login form offers "sign in with the portal account"
        const portal = !!(app.portal && app.portal.enabled);
        send(res, 200, `window.RR_CONFIG = { baseUrl: "", portal: ${portal} };\n`, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
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

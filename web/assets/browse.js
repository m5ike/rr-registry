/* RR Registry - public repository browser. Boot data: window.RR_BROWSE (browse.js on the server).
   Views: list (řádky), grid (náhled), tiles (bloky), details (tabulka). The design editor of the administration
   previews changes live through postMessage({ type: 'rr-browse-preview', cfg }). */
(function () {
  'use strict';
  const B = window.RR_BROWSE;
  let cfg = B.cfg;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = { get: (k) => { try { return localStorage.getItem(`rb.${B.repo}.${k}`); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(`rb.${B.repo}.${k}`, v); } catch { /* private mode */ } } };
  const P = {
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
    image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9.5a1 1 0 1 0 0-.01',
    code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14',
    archive: 'M4 7h16v13H4zM3 4h18v3H3zM10 11h4',
    pkg: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    docker: 'M3 10h18v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 10V6h4v4M10 10V6h4v4M14 10V7h3v3',
    git: 'M6 4v10M18 4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM6 14a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM18 9c0 4-4 5-9.5 6.5',
    tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
    download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
    list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    tiles: 'M4 5h16v6H4zM4 13h16v6H4z',
    table: 'M3 5h18v14H3zM3 10h18M3 15h18M9 5v14',
    sun: 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    up: 'M12 19V5M5 12l7-7 7 7',
    sort: 'M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4',
    x: 'M6 6l12 12M18 6 6 18',
  };
  const ic = (n, s = 18) => `<svg class="i" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="${P[n] || P.file}"/></svg>`;
  const fmtSize = (n) => (n == null || n === '' ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const fmtDate = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const IMG = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
  const MD = /\.(md|markdown)$/i;
  const TEXT = /\.(txt|json|ya?ml|toml|ini|cfg|conf|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|sql|log|csv|env|lock|gitignore|dockerfile)$|^(dockerfile|makefile|license|readme)$/i;
  const fileIcon = (name) => (IMG.test(name) ? 'image' : /\.(zip|tgz|gz|tar|bz2|xz|7z|rar|whl|jar)$/i.test(name) ? 'archive' : TEXT.test(name) || MD.test(name) ? 'code' : 'file');
  const typeIcon = (e) => ({ dir: 'folder', repo: 'git', package: 'pkg', image: 'docker', tag: 'tag' }[e.type] || fileIcon(e.name));
  const rawUrl = (p, inline) => `${B.api}/raw?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;
  const urlFor = (p) => `${B.base}${p === '/' ? '/' : p}` || '/';
  const parentOf = (p) => { const s = p.replace(/\/+$/, '').split('/'); s.pop(); return s.join('/') || '/'; };
  const joinPath = (dir, rel) => {
    const out = [];
    for (const part of (rel.startsWith('/') ? rel.slice(1) : `${dir.replace(/^\/+/, '')}/${rel}`).split('/')) {
      if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
    }
    return `/${out.join('/')}`;
  };

  const state = { path: B.path || '/', data: null, q: '', sort: LS.get('sort') || cfg.sort, dir: LS.get('dir') || cfg.sortDir, view: LS.get('view') || cfg.view, sel: new Set(), error: null };
  const root = $('#rb');

  // ------------------------------------------------------------------ theme
  function applyTheme() {
    const acc = cfg.accent || B.themes[cfg.theme] || '#F5A524';
    const r = document.documentElement.style;
    r.setProperty('--acc', acc);
    r.setProperty('--r', `${cfg.radius}px`);
    r.setProperty('--font', `'${cfg.font}', system-ui, -apple-system, 'Segoe UI', sans-serif`);
    r.setProperty('--hfont', cfg.headingFont ? `'${cfg.headingFont}', var(--font)` : 'var(--font)');
    r.setProperty('--mono', `'${cfg.monoFont}', ui-monospace, Menlo, monospace`);
    // readable text on the accent colour
    const n = parseInt(acc.slice(1), 16);
    const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    r.setProperty('--on-acc', lum > 0.62 ? '#14171C' : '#ffffff');
    const user = LS.get('mode');
    const mode = user || cfg.mode;
    const dark = mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.body.className = `hdr-${cfg.header} btn-${cfg.buttons} dens-${cfg.density}`;
    const fams = [...new Set([cfg.font, cfg.headingFont, cfg.monoFont].filter(Boolean))];
    const href = `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700`).join('&')}&display=swap`;
    const link = $('#rb-fonts');
    if (link && link.getAttribute('href') !== href) link.setAttribute('href', href);
    if (!cfg.views.includes(state.view)) state.view = cfg.view;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.parentNode && t.parentNode.removeChild(t), 2200);
  }
  const copy = (text) => { if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Zkopírováno')); };

  // ------------------------------------------------------------------ data
  async function load(p, push) {
    state.path = p || '/';
    state.sel.clear();
    state.q = '';
    if (push) history.pushState({ p: state.path }, '', urlFor(state.path));
    render(true);
    try {
      const r = await fetch(`${B.api}/list?path=${encodeURIComponent(state.path)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status });
      state.data = j;
      state.error = null;
    } catch (e) {
      state.data = null;
      state.error = e;
    }
    render();
  }

  // ------------------------------------------------------------------ render
  function header() {
    const t = cfg.title || B.description || B.repo;
    const logo = cfg.logo ? `<img class="logo" src="${esc(cfg.logo)}" alt="">` : `<span class="logo mark" aria-hidden="true">${esc((cfg.title || B.repo).slice(0, 1).toUpperCase())}</span>`;
    const userMode = LS.get('mode');
    const dark = document.documentElement.dataset.theme === 'dark';
    return `<header class="hdr"><div class="wrap">${logo}<div><h1><a href="${esc(urlFor('/'))}" data-nav="/" style="color:inherit">${esc(t)}</a></h1>${cfg.subtitle ? `<p>${esc(cfg.subtitle)}</p>` : `<p>${esc(B.type)} · ${esc(B.repo)}</p>`}</div>
      <span class="spacer"></span><button type="button" class="btn icon" id="mode" title="${dark ? 'Světlý režim' : 'Tmavý režim'}" aria-label="Přepnout světlý a tmavý režim" data-user="${userMode || ''}">${ic(dark ? 'sun' : 'moon')}</button></div></header>`;
  }

  function crumbs() {
    const parts = state.path.split('/').filter(Boolean);
    const out = [`<a href="${esc(urlFor('/'))}" data-nav="/">${ic(B.type === 'git' ? 'git' : B.type === 'npm' ? 'pkg' : B.type === 'docker' ? 'docker' : 'folder', 16)} ${esc(B.repo)}</a>`];
    parts.forEach((seg, i) => {
      const p = `/${parts.slice(0, i + 1).join('/')}`;
      out.push('<span class="sep">/</span>');
      out.push(i === parts.length - 1 ? `<b>${esc(decodeURIComponent(seg))}</b>` : `<a href="${esc(urlFor(p))}" data-nav="${esc(p)}">${esc(decodeURIComponent(seg))}</a>`);
    });
    return `<nav class="crumbs" aria-label="Umístění">${out.join('')}</nav>`;
  }

  function sorted(list) {
    const q = state.q.trim().toLowerCase();
    let l = q ? list.filter((e) => `${e.name} ${e.description || ''} ${e.version || ''}`.toLowerCase().includes(q)) : list.slice();
    const k = state.sort;
    const dir = state.dir === 'desc' ? -1 : 1;
    const folders = (e) => (['dir', 'repo', 'package', 'image'].includes(e.type) ? 0 : 1);
    l.sort((a, b) => {
      if (k === 'name' || k === 'type') { const f = folders(a) - folders(b); if (f) return f; }
      const va = k === 'size' ? Number(a.size) || 0 : k === 'modified' ? Date.parse(a.modified || 0) || 0 : k === 'type' ? `${a.type}.${(a.name.split('.').pop() || '')}` : a.name.toLowerCase();
      const vb = k === 'size' ? Number(b.size) || 0 : k === 'modified' ? Date.parse(b.modified || 0) || 0 : k === 'type' ? `${b.type}.${(b.name.split('.').pop() || '')}` : b.name.toLowerCase();
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
    return l;
  }

  const navigable = (e) => ['dir', 'repo', 'package', 'image'].includes(e.type);
  const selectable = (e) => cfg.multiSelect && (state.data.formats || []).length && e.type !== 'tag' && e.type !== 'image';
  const metaBits = (e) => {
    const bits = [];
    const col = cfg.columns;
    if (e.version && (col.includes('version') || e.type === 'package' || e.type === 'image')) bits.push(esc(e.version));
    if (col.includes('size') && e.size && e.type !== 'package') bits.push(fmtSize(e.size));
    if (col.includes('modified') && e.modified) bits.push(fmtDate(e.modified));
    if (col.includes('type')) bits.push(esc(e.type === 'file' ? (e.name.includes('.') ? e.name.split('.').pop().toUpperCase() : 'soubor') : { dir: 'složka', repo: 'repozitář', package: 'balíček', image: 'image', tag: 'tag' }[e.type] || e.type));
    return bits;
  };
  const link = (e) => (navigable(e) ? `href="${esc(urlFor(e.path))}" data-nav="${esc(e.path)}"` : e.type === 'tag' ? `href="#" data-copy="${esc(e.pull || '')}" title="Zkopírovat docker pull"` : `href="${esc(urlFor(e.path))}" data-nav="${esc(e.path)}"`);
  const check = (e) => (selectable(e) ? `<input type="checkbox" data-sel="${esc(e.path)}" ${state.sel.has(e.path) ? 'checked' : ''} aria-label="Vybrat ${esc(e.name)}">` : '');
  const dlBtn = (e) => (e.download ? `<a class="btn sm icon dl" href="${esc(rawUrl(e.path))}" download title="Stáhnout ${esc(e.name)}" aria-label="Stáhnout ${esc(e.name)}">${ic('download', 16)}</a>` : '');

  function entriesHtml(list) {
    if (!list.length) return `<div class="card empty">${state.q ? 'Nic neodpovídá hledání.' : 'Tady nic není.'}</div>`;
    const v = state.view;
    if (v === 'details') {
      const cols = [['name', 'Název'], ...cfg.columns.filter((c) => c !== 'description').map((c) => [c, { size: 'Velikost', modified: 'Změněno', type: 'Typ', version: 'Verze' }[c]])];
      const sortable = (k) => cfg.allowSort && ['name', 'size', 'modified', 'type'].includes(k);
      return `<div class="tbl-wrap"><table class="det"><thead><tr>${cfg.multiSelect && list.some(selectable) ? `<th style="width:34px"><input type="checkbox" id="selAll" aria-label="Vybrat vše"></th>` : ''}${cols.map(([k, l]) => `<th${k === 'size' ? ' class="num"' : ''}>${sortable(k) ? `<button type="button" data-sortby="${k}">${l}${state.sort === k ? (state.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>` : l}</th>`).join('')}<th></th></tr></thead><tbody>
        ${list.map((e) => `<tr>${cfg.multiSelect && list.some(selectable) ? `<td>${check(e)}</td>` : ''}<td><div class="nmcell"><span class="e"><span class="ic ${esc(e.type)}">${ic(typeIcon(e), 17)}</span></span><div><a ${link(e)}>${esc(e.name)}</a>${cfg.columns.includes('description') && e.description ? `<div class="muted" style="font-size:12.5px">${esc(e.description)}</div>` : ''}</div></div></td>
          ${cols.slice(1).map(([k]) => `<td class="${k === 'size' ? 'num' : 'muted'}">${k === 'size' ? (e.type === 'package' ? '' : fmtSize(e.size)) : k === 'modified' ? fmtDate(e.modified) : k === 'version' ? esc(e.version || '') : esc(metaBits({ ...e, version: '' }).slice(-1)[0] || '')}</td>`).join('')}
          <td style="text-align:right">${dlBtn(e)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    return `<ul class="entries">${list.map((e) => {
      const bits = metaBits(e);
      const desc = cfg.columns.includes('description') || ['package', 'repo', 'image'].includes(e.type) ? e.description : '';
      if (v === 'grid') {
        const thumb = e.download && IMG.test(e.name) ? `<img loading="lazy" src="${esc(rawUrl(e.path, true))}" alt="">` : ic(typeIcon(e), 42);
        return `<li class="e">${check(e)}<a class="thumb" ${link(e)} tabindex="-1" aria-hidden="true">${thumb}</a><div class="nm"><a ${link(e)}>${esc(e.name)}</a>${desc ? `<small>${esc(desc)}</small>` : ''}</div><div class="side">${bits.join(' · ')}</div></li>`;
      }
      if (v === 'tiles') {
        return `<li class="e">${check(e)}<span class="ic ${esc(e.type)}">${ic(typeIcon(e), 22)}</span><div class="nm"><a ${link(e)}>${esc(e.name)}</a><small>${esc(desc || bits.join(' · '))}</small></div><div class="side">${desc ? bits.map((b) => `<span>${b}</span>`).join('') : ''}${dlBtn(e)}</div></li>`;
      }
      return `<li class="e">${check(e)}<span class="ic ${esc(e.type)}">${ic(typeIcon(e), 18)}</span><div class="nm"><a ${link(e)}>${esc(e.name)}</a>${desc ? `<small>${esc(desc)}</small>` : ''}</div><div class="side">${bits.map((b, i) => `<span class="${i ? 'opt' : ''}">${b}</span>`).join('')}</div>${dlBtn(e)}</li>`;
    }).join('')}</ul>`;
  }

  function toolbar(list) {
    const views = [['list', 'list', 'Řádky'], ['grid', 'grid', 'Náhled'], ['tiles', 'tiles', 'Bloky'], ['details', 'table', 'Detail']].filter(([v]) => cfg.views.includes(v));
    return `<div class="toolbar">
      ${cfg.search ? `<label class="search grow"><span class="sr">Hledat</span>${ic('search', 17)}<input id="q" type="search" placeholder="Hledat v ${list.length} položkách…" value="${esc(state.q)}" autocomplete="off"></label>` : '<span class="grow"></span>'}
      ${cfg.allowSort ? `<label class="sr" for="sortSel">Řadit</label><select id="sortSel" aria-label="Řadit podle">${[['name', 'Název'], ['modified', 'Datum'], ['size', 'Velikost'], ['type', 'Typ']].map(([k, l]) => `<option value="${k}"${state.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <button type="button" class="btn icon" id="sortDir" title="${state.dir === 'asc' ? 'Vzestupně' : 'Sestupně'}" aria-label="Směr řazení">${ic('sort', 17)}</button>` : ''}
      ${views.length > 1 ? `<div class="seg" role="group" aria-label="Zobrazení">${views.map(([v, i, l]) => `<button type="button" data-view="${v}" aria-pressed="${state.view === v}" title="${l}" aria-label="${l}">${ic(i, 17)}</button>`).join('')}</div>` : ''}
    </div>`;
  }

  function infoBox(d) {
    const i = d.info || {};
    if (d.kind === 'package') {
      return `<section class="card pad"><div class="info"><h2>${esc(i.name)}</h2><span class="chip acc">${esc(i.version)}</span>${i.license ? `<span class="chip">${esc(i.license)}</span>` : ''}</div>
        ${i.description ? `<p class="muted" style="margin:6px 0 10px">${esc(i.description)}</p>` : ''}
        <div class="info">${cfg.showInstall ? `<div class="cmd"><code>${esc(i.install)}</code><button type="button" class="btn sm icon" data-copy="${esc(i.install)}" aria-label="Kopírovat">${ic('copy', 15)}</button></div>` : ''}
        <div class="meta">${Object.entries(i.distTags || {}).map(([t, v]) => `<span>${ic('tag', 14)} ${esc(t)}: ${esc(v)}</span>`).join('')}${i.author ? `<span>autor ${esc(i.author)}</span>` : ''}${i.homepage ? `<a href="${esc(i.homepage)}" target="_blank" rel="noopener">${esc(i.homepage)}</a>` : ''}</div></div></section>`;
    }
    if (d.kind === 'image' || (d.kind === 'images' && cfg.showInstall)) {
      return `<section class="card pad"><div class="info">${d.kind === 'image' ? `<h2>${esc(i.name)}</h2>` : ''}<div class="cmd"><code>${esc(i.pull)}</code><button type="button" class="btn sm icon" data-copy="${esc(i.pull)}" aria-label="Kopírovat">${ic('copy', 15)}</button></div></div>${d.kind === 'image' ? '<p class="muted" style="margin:8px 0 0">Klepnutím na tag zkopírujete příkaz docker pull.</p>' : ''}</section>`;
    }
    if ((d.kind === 'repo' || d.kind === 'dir') && B.type === 'git' && i.name) {
      const urls = Object.entries(i.cloneUrls || {}).filter(([, u]) => u);
      return `<section class="card pad"><div class="info"><h2>${ic('git')} ${esc(i.name)}</h2>${i.defaultBranch ? `<span class="chip acc">${ic('git', 13)}${esc(i.defaultBranch)}</span>` : ''}</div>
        ${i.description ? `<p class="muted" style="margin:6px 0 10px">${esc(i.description)}</p>` : ''}
        ${cfg.showInstall ? `<div class="info">${urls.map(([k, u]) => `<div class="cmd"><span class="chip">${k.toUpperCase()}</span><code>git clone ${esc(u)}</code><button type="button" class="btn sm icon" data-copy="git clone ${esc(u)}" aria-label="Kopírovat">${ic('copy', 15)}</button></div>`).join('')}</div>` : ''}
        ${i.empty ? '<p class="muted">Repozitář je zatím prázdný.</p>' : ''}</section>`;
    }
    return '';
  }

  function readmeHtml(rd, dir) {
    if (!rd || !cfg.readme) return '';
    const html = MD.test(rd.name) && window.RRMarkdown ? window.RRMarkdown.render(rd.text, {
      slugPrefix: 'md-',
      resolveLink: (h) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return { href: h, internal: false };
        if (h.startsWith('#')) return { href: `#md-${h.slice(1).toLowerCase()}`, internal: true };
        const target = joinPath(dir, decodeURIComponent(h.split('#')[0]));
        return { href: urlFor(target), internal: true };
      },
      resolveImage: (s) => (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') ? s : rawUrl(joinPath(dir, decodeURIComponent(s.split('?')[0])), true)),
    }) : `<pre style="white-space:pre-wrap">${esc(rd.text)}</pre>`;
    return `<article class="card readme"><header>${ic('file', 16)}${esc(rd.name)}</header><div class="markdown-body">${html}</div></article>`;
  }

  function introHtml() {
    if (!cfg.intro || state.path !== '/' || !window.RRMarkdown) return '';
    return `<article class="card readme"><div class="markdown-body">${window.RRMarkdown.render(cfg.intro, { slugPrefix: 'mdi-', resolveLink: (h) => ({ href: /^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('#') ? h : urlFor(joinPath('/', h)), internal: !/^[a-z][a-z0-9+.-]*:/i.test(h) }), resolveImage: (s) => (/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : rawUrl(joinPath('/', s), true)) })}</div></article>`;
  }

  async function fileView(f) {
    const box = $('#fileBody');
    if (!box) return;
    const dir = parentOf(f.path);
    if (IMG.test(f.name)) { box.innerHTML = `<div class="img"><img src="${esc(rawUrl(f.path, true))}" alt="${esc(f.name)}"></div>`; return; }
    if (!cfg.preview || f.size > 1024 * 1024 || !(TEXT.test(f.name) || MD.test(f.name) || !f.name.includes('.'))) { box.innerHTML = `<div class="empty">${ic(fileIcon(f.name), 40)}<p>${esc(f.name)} · ${fmtSize(f.size)}</p><a class="btn primary" href="${esc(rawUrl(f.path))}" download>${ic('download', 16)}Stáhnout</a></div>`; return; }
    const r = await fetch(rawUrl(f.path, true), { credentials: 'same-origin' });
    const text = await r.text();
    if (MD.test(f.name)) box.innerHTML = readmeHtml({ name: f.name, text }, dir).replace(/^<article class="card readme"><header>.*?<\/header>/, '').replace(/<\/article>$/, '');
    else box.innerHTML = `<pre class="code">${esc(text)}</pre>`;
    wireMarkdown(box);
  }

  function render(loading) {
    applyTheme();
    const d = state.data;
    let body = '';
    if (loading) body = `${crumbs()}<div>${'<div class="skel"></div>'.repeat(6)}</div>`;
    else if (state.error) {
      body = `${crumbs()}<section class="card pad empty"><h2>${state.error.status === 401 ? 'Vyžaduje přihlášení' : state.error.status === 404 ? 'Nenalezeno' : 'Chyba'}</h2><p>${esc(state.error.message)}</p>
        <p><a class="btn" href="${esc(urlFor('/'))}" data-nav="/">${ic('up', 16)}Na začátek</a>${state.error.status === 401 ? ` <a class="btn primary" href="/admin/">Přihlásit</a>` : ''}</p></section>`;
    } else if (d.kind === 'file') {
      body = `${crumbs()}<section class="card fileview"><header>${ic(fileIcon(d.file.name), 17)}<b>${esc(d.file.name)}</b><span class="muted">${fmtSize(d.file.size)}</span><span style="flex:1"></span>
        <a class="btn" href="${esc(urlFor(parentOf(d.path)))}" data-nav="${esc(parentOf(d.path))}">${ic('up', 16)}Zpět</a><a class="btn primary" href="${esc(rawUrl(d.path))}" download>${ic('download', 16)}Stáhnout</a></header><div id="fileBody"><div class="skel" style="margin:14px"></div></div></section>`;
    } else {
      const list = sorted(d.entries || []);
      const dir = d.kind === 'dir' || d.kind === 'repo' ? d.path : d.path;
      body = `${crumbs()}${introHtml()}${infoBox(d)}${toolbar(d.entries || [])}<section class="v-${state.view}" aria-label="Obsah">${entriesHtml(list)}</section>
        ${state.sel.size ? `<div class="selbar" role="region" aria-label="Vybrané položky"><span><b>${state.sel.size}</b> vybráno</span><span style="flex:1"></span>
          <label class="sr" for="fmt">Formát</label><select id="fmt">${(d.formats || []).map((f) => `<option>${f}</option>`).join('')}</select>
          <button type="button" class="btn primary" id="dlSel">${ic('download', 16)}Stáhnout</button><button type="button" class="btn" id="clearSel">${ic('x', 16)}Zrušit výběr</button></div>` : ''}
        ${readmeHtml(d.readme, dir)}`;
    }
    root.innerHTML = `${header()}<main class="wrap" id="main">${body}</main>
      <footer class="foot"><div class="wrap">${cfg.footer ? `<span>${esc(cfg.footer)}</span>` : ''}<span class="muted">${esc(B.registry.title || 'RR Registry')} ${esc(B.registry.version || '')}</span></div></footer>`;
    document.body.classList.remove('rb-loading');
    wire();
    if (!loading && d && d.kind === 'file') fileView(d.file);
  }

  function wireMarkdown(el) {
    $$('a[href^="#md-"], a[href^="#mdi-"]', el).forEach((a) => { a.onclick = (e) => { e.preventDefault(); const t = document.getElementById(a.getAttribute('href').slice(1)); if (t) t.scrollIntoView({ behavior: 'smooth' }); }; });
    $$('a[data-md-internal]', el).forEach((a) => {
      const href = a.getAttribute('href');
      if (!href.startsWith(B.base || '/')) return;
      a.onclick = (e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); load(decodeURI(href.slice((B.base || '').length) || '/'), true); };
    });
  }

  function wire() {
    const m = $('#mode');
    if (m) m.onclick = () => { const dark = document.documentElement.dataset.theme === 'dark'; LS.set('mode', dark ? 'light' : 'dark'); render(); };
    $$('[data-nav]').forEach((a) => { a.onclick = (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); load(a.dataset.nav, true); }; });
    $$('[data-copy]').forEach((b) => { b.onclick = (e) => { e.preventDefault(); copy(b.dataset.copy); }; });
    const q = $('#q');
    if (q) {
      q.oninput = () => { state.q = q.value; const sec = $('section[class^="v-"]'); if (sec) { sec.innerHTML = entriesHtml(sorted(state.data.entries || [])); wire(); const nq = $('#q'); if (nq !== q) nq.focus(); } };
    }
    const ss = $('#sortSel');
    if (ss) ss.onchange = () => { state.sort = ss.value; LS.set('sort', state.sort); render(); };
    const sd = $('#sortDir');
    if (sd) sd.onclick = () => { state.dir = state.dir === 'asc' ? 'desc' : 'asc'; LS.set('dir', state.dir); render(); };
    $$('[data-sortby]').forEach((b) => { b.onclick = () => { if (state.sort === b.dataset.sortby) state.dir = state.dir === 'asc' ? 'desc' : 'asc'; else { state.sort = b.dataset.sortby; state.dir = 'asc'; } LS.set('sort', state.sort); LS.set('dir', state.dir); render(); }; });
    $$('[data-view]').forEach((b) => { b.onclick = () => { state.view = b.dataset.view; LS.set('view', state.view); render(); }; });
    $$('[data-sel]').forEach((c) => { c.onchange = () => { if (c.checked) state.sel.add(c.dataset.sel); else state.sel.delete(c.dataset.sel); render(); }; });
    const all = $('#selAll');
    if (all) {
      const sel = sorted(state.data.entries || []).filter(selectable);
      all.checked = sel.length && sel.every((e) => state.sel.has(e.path));
      all.onchange = () => { sel.forEach((e) => (all.checked ? state.sel.add(e.path) : state.sel.delete(e.path))); render(); };
    }
    const cl = $('#clearSel');
    if (cl) cl.onclick = () => { state.sel.clear(); render(); };
    const dl = $('#dlSel');
    if (dl) {
      dl.onclick = () => {
        const f = document.createElement('form');
        f.method = 'POST';
        f.action = `${B.api}/archive`;
        f.style.display = 'none';
        const add = (k, v) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); };
        add('format', $('#fmt').value);
        add('base', state.path);
        state.sel.forEach((p) => add('p', p));
        document.body.appendChild(f);
        f.submit();
        setTimeout(() => f.parentNode && f.parentNode.removeChild(f), 1000);
        toast('Připravuji archiv…');
      };
    }
    $$('.markdown-body').forEach(wireMarkdown);
  }

  // ------------------------------------------------------------------ boot
  window.addEventListener('popstate', (e) => load((e.state && e.state.p) || pathFromUrl(), false));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!LS.get('mode') && cfg.mode === 'auto') render(); });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && $('#q')) { e.preventDefault(); $('#q').focus(); } });
  // live preview from the design editor (same origin only)
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'rr-browse-preview') return;
    cfg = { ...cfg, ...e.data.cfg, filter: cfg.filter };
    if (!cfg.views.includes(state.view)) state.view = cfg.view;
    if (e.data.resetView) { state.view = cfg.view; state.sort = cfg.sort; state.dir = cfg.sortDir; }
    render();
  });
  function pathFromUrl() {
    const p = decodeURI(location.pathname);
    const base = decodeURI(B.base || '');
    return (base && p.startsWith(base) ? p.slice(base.length) : p) || '/';
  }
  history.replaceState({ p: state.path }, '', location.href);
  load(state.path, false);
})();

/* RR Registry - web administration. All server calls go through the generated RRClient library,
   UI building blocks (tables, windows, palette, charts, icons) come from ui.js (RRUI). */
(function () {
  'use strict';
  const CFG = window.RR_CONFIG || {};
  const LS = {
    get(k) { try { return localStorage.getItem(`rr.${k}`) || ''; } catch { return ''; } },
    set(k, v) { try { if (v) localStorage.setItem(`rr.${k}`, v); else localStorage.removeItem(`rr.${k}`); } catch { /* ignore */ } },
  };
  const { icon, wm } = RRUI;
  let rr = null;
  let me = null;
  let refreshTimer = null;
  let repoCache = [];

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const fmtDate = (s) => (s ? new Date(s).toLocaleString() : '');
  const fmtNum = (n) => Number(n || 0).toLocaleString('cs-CZ');
  const yes = (b) => (b ? '<span class="badge ok">ano</span>' : '<span class="badge off">ne</span>');
  const serverBase = () => (rr.baseUrl || location.origin);
  const registryUrl = (repo, def) => `${serverBase()}${def ? '' : `/r/${repo}`}/`;
  const isAdmin = () => me && me.role === 'admin';
  const TYPE_ICON = { npm: 'package', docker: 'image', git: 'git', generic: 'folder', group: 'layers', dir: 'folder', file: 'file' };
  const tile = (type, ic) => `<span class="tile ${esc(type)}">${icon(ic || TYPE_ICON[type] || 'file', 16)}</span>`;
  const cellMain = (type, title, sub, ic) => `<div class="cell-main">${tile(type, ic)}<div class="t"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`;
  const iconBtn = (attr, ic, label, cls = '') => `<button type="button" class="btn small ghost ${cls}" ${attr} title="${esc(label)}" aria-label="${esc(label)}">${icon(ic, 16)}</button>`;

  function ago(s) {
    if (!s) return '–';
    const d = (Date.now() - Date.parse(s)) / 1000;
    if (d < 0) return `za ${Math.round(-d / 60)} min`;
    if (d < 60) return 'právě teď';
    if (d < 3600) return `před ${Math.round(d / 60)} min`;
    if (d < 86400) return `před ${Math.round(d / 3600)} h`;
    if (d < 86400 * 30) return `před ${Math.round(d / 86400)} d`;
    return new Date(s).toLocaleDateString();
  }
  const when = (s) => (s ? `<span title="${esc(fmtDate(s))}">${esc(ago(s))}</span>` : '–');
  const age = (s) => {
    if (!s) return 'neznámé';
    const d = (Date.now() - Date.parse(s)) / 86400000;
    return d < 1 ? 'dnes' : d < 7 ? 'tento týden' : d < 31 ? 'tento měsíc' : d < 365 ? 'tento rok' : 'starší';
  };

  function toast(msg, err) {
    const t = $('#toast');
    t.innerHTML = `${icon(err ? 'alert' : 'check', 18)}<span></span>`;
    t.querySelector('span').textContent = msg;
    t.className = `toast${err ? ' err' : ''}`;
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 2600);
  }

  async function run(fn, okMsg) {
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      return r;
    } catch (e) {
      if (e.status === 401) { logout(); }
      toast(e.message || String(e), true);
      throw e;
    }
  }

  let modalKey = null;
  function modal(html, onMount) {
    const m = $('#modal');
    $('#modalBody').innerHTML = html;
    const h = $('#modalBody > h2');
    $('#modalTitle').textContent = h ? h.textContent : '';
    if (h) h.remove();
    m.classList.remove('hidden');
    const close = () => {
      m.classList.add('hidden');
      if (modalKey) document.removeEventListener('keydown', modalKey);
      modalKey = null;
    };
    if (modalKey) document.removeEventListener('keydown', modalKey);
    modalKey = (e) => { if (e.key === 'Escape') { const c = $('#modal [data-close]'); if (c) c.click(); else close(); } };
    document.addEventListener('keydown', modalKey);
    m.onclick = (e) => { if (e.target === m) close(); };
    $$('[data-close]', m).forEach((b) => { b.onclick = close; });
    if (onMount) onMount($('#modalBody'), close);
    const first = $('#modalBody input:not([type=checkbox]):not([disabled]),#modalBody select,#modalBody textarea');
    if (first) first.focus();
    return close;
  }

  function confirmBox(text) {
    return new Promise((resolve) => {
      modal(`<h2>Potvrzení</h2><p style="margin:0">${esc(text)}</p><div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn danger" id="cfOk">Potvrdit</button></div>`, (el, close) => {
        $('#cfOk', el).onclick = () => { close(); resolve(true); };
        $$('[data-close]', $('#modal')).forEach((b) => { b.onclick = () => { close(); resolve(false); }; });
      });
    });
  }

  function formData(form) {
    const o = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') o[el.name] = el.checked;
      else if (el.type === 'number') o[el.name] = el.value === '' ? null : Number(el.value);
      else o[el.name] = el.value;
    }
    return o;
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  const readFile = (file) => file.arrayBuffer().then((b) => new Uint8Array(b));

  function setView(title, html, ic) {
    $('#title').innerHTML = `${ic ? icon(ic, 22) : ''}<span></span>`;
    $('#title span').textContent = title;
    $('#view').innerHTML = html;
    return $('#view');
  }

  function repoSelect(repos, current, onlyNpm, id = 'repoSel') {
    return `<label class="dt-select">${icon('repo', 16)}<span class="sr">Repozitář</span><select id="${id}">${repos.filter((r) => !onlyNpm || r.type === 'npm' || r.type === 'group').map((r) => `<option value="${esc(r.name)}"${r.name === current ? ' selected' : ''}>${esc(r.name)} · ${esc(r.type)}</option>`).join('')}</select></label>`;
  }

  /** Mount an RRUI table into a container inside the view (by selector). */
  const table = (host, opts) => RRUI.table(typeof host === 'string' ? $(host) : host, opts);

  // ------------------------------------------------------------------ windows
  async function pkgWindow(repo, name) {
    wm.open({
      id: `pkg:${repo}/${name}`, title: `${name} · ${repo}`, icon: 'package', width: 660, height: 500,
      render: async (body, w) => {
        const d = await rr.getPackage(repo, name);
        const reg = registryUrl(repo, (repoCache.find((r) => r.name === repo) || {}).default);
        const versions = Object.keys(d.versions).reverse();
        let tab = w.tab || 'versions';
        const draw = () => {
          body.innerHTML = `<div class="tabs">${[['versions', `Verze (${versions.length})`], ['install', 'Instalace'], ['readme', 'README'], ['json', 'package.json']].map(([k, l]) => `<button type="button" data-t="${k}" class="${tab === k ? 'active' : ''}">${l}</button>`).join('')}
            <span class="spacer"></span><a class="btn small ghost" href="#/pkg/${enc(repo)}/${enc(name)}">${icon('popout', 15)}Otevřít stránku</a></div>
            ${tab === 'versions' ? `<div class="feed">${versions.map((v) => { const m = d.versions[v]; const tags = Object.entries(d['dist-tags']).filter(([, x]) => x === v).map(([t]) => `<span class="badge warn">${esc(t)}</span>`).join(' '); return `<li>${tile('npm', 'tag')}<div class="tx"><b class="mono">${esc(v)}</b> ${tags} ${m.deprecated ? '<span class="badge off">deprecated</span>' : ''}<div class="when">${when(d.time[v])} · ${fmtBytes(m.dist.size)} · ${esc((m._npmUser || {}).name || '')}</div></div><button type="button" class="btn small" data-dl="${esc(v)}">${icon('download', 15)}tgz</button></li>`; }).join('')}</div>` : ''}
            ${tab === 'install' ? `<pre>npm install ${esc(d.name)} --registry ${esc(reg)}\n\n# .npmrc\nregistry=${esc(reg)}\n${esc(reg.replace(/^https?:/, ''))}:_authToken=&lt;token&gt;</pre>` : ''}
            ${tab === 'readme' ? `<pre style="white-space:pre-wrap">${esc(d.readme || '(bez README)')}</pre>` : ''}
            ${tab === 'json' ? `<pre>${esc(JSON.stringify(d.versions[d['dist-tags'].latest], null, 2))}</pre>` : ''}`;
          $$('[data-t]', body).forEach((b) => { b.onclick = () => { tab = w.tab = b.dataset.t; draw(); }; });
          $$('[data-dl]', body).forEach((b) => { b.onclick = async () => download(await run(() => rr.downloadTarball(repo, name, b.dataset.dl)), `${name.split('/').pop()}-${b.dataset.dl}.tgz`); });
        };
        draw();
      },
    });
  }

  async function fileWindow(title, loader, opts = {}) {
    wm.open({
      id: `file:${title}`, title, icon: opts.icon || 'file', width: 720, height: 520,
      render: async (body) => {
        const { bytes, size, modified } = await loader();
        const text = bytes.length < 1024 * 1024 && !bytes.slice(0, 8000).includes(0) ? new TextDecoder().decode(bytes) : null;
        let content = text;
        if (text !== null && /\.json$/i.test(title)) { try { content = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ } }
        body.innerHTML = `<div class="row"><span class="muted small">${fmtBytes(size ?? bytes.length)}${modified ? ` · ${esc(fmtDate(modified))}` : ''}</span><span class="spacer"></span><button type="button" class="btn small" data-dl>${icon('download', 15)}Stáhnout</button></div>
          <pre style="flex:1;max-height:none">${content === null ? '(binární soubor – použijte stažení)' : esc(content)}</pre>`;
        $('[data-dl]', body).onclick = () => download(bytes, title.split('/').pop());
      },
    });
  }

  function liveLogWindow() {
    if (!isAdmin()) return toast('Logy vidí jen administrátor.', true);
    wm.open({
      id: 'livelog', title: 'Živý log požadavků', icon: 'terminal', width: 760, height: 360,
      html: '<div class="term" data-term></div>',
      onMount: (body, w) => {
        body.classList.add('flush');
        const draw = async () => {
          const l = await rr.getLogs({ limit: 120, type: 'requests' }).catch(() => null);
          if (!l) return;
          const term = $('[data-term]', body);
          const atBottom = term.scrollTop + term.clientHeight >= term.scrollHeight - 20;
          term.innerHTML = l.requests.slice().reverse().map((r) => `<span class="t">${esc(new Date(r.time).toLocaleTimeString())}</span> <span class="s${String(r.status)[0]}">${r.status}</span> ${esc(r.method.padEnd(6))} ${esc(r.url)} <span class="x">${r.ms} ms ${esc(r.user)} ${esc(r.cache || '')}</span>`).join('\n');
          if (atBottom) term.scrollTop = term.scrollHeight;
        };
        draw();
        w.every(2000, draw);
      },
    });
  }

  // ------------------------------------------------------------------ views
  const views = {};

  // ---------------------------------------------------------------- dashboard (widgets)
  async function loadDash() {
    const [st, repos] = await Promise.all([rr.status(), rr.listRepos()]);
    repoCache = repos;
    const stats = await Promise.all(repos.map((r) => rr.getRepoStats(r.name).catch(() => null)));
    const admin = isAdmin();
    const [logs, cache, tasks, repl] = admin
      ? await Promise.all([rr.getLogs({ limit: 1000 }).catch(() => null), rr.cacheStats().catch(() => null), rr.listTasks().catch(() => []), rr.listReplications({ limit: 50 }).catch(() => [])])
      : [null, null, [], []];
    return { st, repos, stats, logs, cache, tasks, repl };
  }

  const ACT_ICON = (a) => (/publish|unpublish/.test(a) ? ['package', 'npm'] : /git/.test(a) ? ['git', 'git'] : /docker/.test(a) ? ['image', 'docker'] : /delete|purge/.test(a) ? ['trash', ''] : /login/.test(a) ? ['key', ''] : /route|replic/.test(a) ? ['route', ''] : /cleanup/.test(a) ? ['broom', ''] : /upload|file/.test(a) ? ['upload', ''] : ['activity', '']);

  const WIDGETS = [
    {
      id: 'traffic', title: 'Provoz – poslední hodina', icon: 'activity', size: 'w8', admin: true,
      render(el, c) {
        if (!c.logs) { el.innerHTML = '<p class="muted">Bez dat.</p>'; return; }
        const now = Date.now();
        const buckets = Array.from({ length: 60 }, (_, i) => ({ title: `před ${59 - i} min`, values: { hit: 0, proxy: 0, local: 0, err: 0 } }));
        let total = 0;
        let errs = 0;
        for (const r of c.logs.requests) {
          const m = Math.floor((now - Date.parse(r.time)) / 60000);
          if (m < 0 || m > 59) continue;
          const b = buckets[59 - m].values;
          total++;
          if (r.status >= 500) { b.err++; errs++; } else if (/HIT|STALE/.test(r.cache)) b.hit++; else if (r.cache) b.proxy++; else b.local++;
        }
        const series = [{ key: 'local', label: 'lokálně', color: 'var(--accent)' }, { key: 'hit', label: 'z cache', color: 'var(--ok)' }, { key: 'proxy', label: 'upstream', color: 'var(--info)' }, { key: 'err', label: 'chyby 5xx', color: 'var(--err)' }];
        el.innerHTML = `<div class="row between"><div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>
          <span class="mono small muted">${fmtNum(total)} požadavků · ${(total / 60).toFixed(1)}/min · chyby ${errs}</span></div>
          ${RRUI.bars(buckets, series, { height: 170 })}<div class="axis"><span>−60 min</span><span>−30 min</span><span>teď</span></div>`;
      },
    },
    {
      id: 'cache', title: 'Cache', icon: 'cache', size: 'w4', admin: true,
      render(el, c) {
        const s = c.cache || { hits: 0, misses: 0, entries: 0, bytes: 0, expired: 0, stale: 0 };
        const rate = s.hits + s.misses ? s.hits / (s.hits + s.misses) : 0;
        el.innerHTML = `<div class="row" style="gap:18px;align-items:center">${RRUI.ring(rate, { size: 124, label: 'Úspěšnost cache', sub: 'hit rate' })}
          <div style="display:flex;flex-direction:column;gap:6px;font-size:13px;flex:1;min-width:140px">
            <div class="row between"><span class="muted">položek</span><b class="mono">${fmtNum(s.entries)}</b></div>
            <div class="row between"><span class="muted">velikost</span><b class="mono">${fmtBytes(s.bytes)}</b></div>
            <div class="row between"><span class="muted">hit / miss</span><b class="mono">${fmtNum(s.hits)} / ${fmtNum(s.misses)}</b></div>
            <div class="row between"><span class="muted">expirované</span><b class="mono">${fmtNum(s.expired)}</b></div></div></div>
          <div class="row"><button type="button" class="btn small" data-purge>${icon('broom', 15)}Smazat expirované</button><a class="btn small ghost" href="#/cache">Správa cache</a></div>`;
        $('[data-purge]', el).onclick = async () => { const r = await run(() => rr.purgeCache({ expired: 1 })); toast(`Smazáno: ${r.removed}`); };
      },
    },
    {
      id: 'activity', title: 'Aktivita', icon: 'bell', size: 'w6', admin: true,
      render(el, c) {
        const list = c.logs ? c.logs.audit.slice(0, 9) : [];
        el.innerHTML = list.length ? `<ul class="feed">${list.map((a) => { const [ic, ty] = ACT_ICON(a.action); return `<li>${tile(ty || 'x', ic)}<div class="tx"><b>${esc(a.user)}</b> ${esc(a.action.replace(/-/g, ' '))} <code>${esc(a.target)}</code><div class="when">${when(a.time)}</div></div></li>`; }).join('')}</ul><a class="small" href="#/logs?tab=audit">Celý audit →</a>` : '<p class="muted">Zatím žádná aktivita.</p>';
      },
    },
    {
      id: 'repos', title: 'Repozitáře', icon: 'repo', size: 'w6',
      render(el, c) {
        el.innerHTML = `<div class="repo-cards">${c.repos.map((r) => {
          const count = r.packages ?? r.images ?? r.gitRepos;
          const unit = r.type === 'docker' ? 'image' : r.type === 'git' ? 'repozitářů' : r.type === 'generic' ? '' : 'balíčků';
          const q = r.quota ? Math.min(100, Math.round((r.quota.usedBytes / r.quota.limitBytes) * 100)) : null;
          return `<a class="repo-card" href="#/repo/${enc(r.name)}"><div class="top">${tile(r.type)}<span class="ty">${esc(r.type)}${r.default ? ' · výchozí' : ''}</span></div>
            <div><b>${esc(r.name)}</b><div class="muted small">${count !== undefined ? `${fmtNum(count)} ${unit}` : esc(r.description || 'soubory')}</div></div>
            ${q !== null ? `<span class="meter" title="kvóta ${q} %" style="width:100%"><i style="width:${q}%;background:${q > 85 ? 'var(--err)' : 'var(--accent)'}"></i></span>` : `<span class="small muted">${r.immutable ? 'neměnný · ' : ''}${r.public ? 'veřejný' : 'soukromý'}</span>`}</a>`;
        }).join('')}</div>`;
      },
    },
    {
      id: 'downloads', title: 'Stažení – 30 dní', icon: 'download', size: 'w8',
      render(el, c) {
        const types = { npm: 'var(--accent)', docker: 'var(--info)', git: 'var(--ok)', generic: 'var(--muted)', group: 'var(--text2)' };
        const days = (c.stats.find(Boolean) || { days: [] }).days.map((d) => ({ title: d.day, values: {} }));
        c.stats.forEach((s, i) => {
          if (!s) return;
          const t = c.repos[i].type;
          s.days.forEach((d, j) => { if (days[j]) days[j].values[t] = (days[j].values[t] || 0) + d.downloads; });
        });
        const present = Object.keys(types).filter((t) => days.some((d) => d.values[t]));
        const series = (present.length ? present : ['npm']).map((t) => ({ key: t, label: t, color: types[t] }));
        const total = days.reduce((n, d) => n + Object.values(d.values).reduce((a, b) => a + b, 0), 0);
        const top = c.stats.flatMap((s, i) => (s ? s.top.slice(0, 3).map((t) => ({ ...t, repo: c.repos[i].name })) : [])).sort((a, b) => b.downloads - a.downloads).slice(0, 5);
        el.innerHTML = `<div class="row between">${RRUI.legend(series)}<span class="mono small muted">celkem ${fmtNum(total)}</span></div>
          ${RRUI.bars(days, series, { height: 150 })}<div class="axis"><span>${esc((days[0] || {}).title || '')}</span><span>dnes</span></div>
          ${top.length ? `<div class="small muted">Nejstahovanější: ${top.map((t) => `<code>${esc(t.item)}</code> <span class="mono">${fmtNum(t.downloads)}</span>`).join(' · ')}</div>` : ''}`;
      },
    },
    {
      id: 'jobs', title: 'Úlohy a replikace', icon: 'clock', size: 'w4', admin: true,
      render(el, c) {
        const failed = c.repl.filter((j) => j.status === 'error').length;
        el.innerHTML = `<ul class="feed">${c.tasks.map((t) => `<li>${tile(t.lastError ? 'x' : 'git', t.lastError ? 'alert' : 'clock')}<div class="tx"><b>${esc(t.name)}</b><div class="when">další ${esc(ago(t.nextRun))}${t.lastError ? ` · <span class="error">${esc(t.lastError)}</span>` : ''}</div></div>
          <button type="button" class="btn small ghost" data-run="${esc(t.id)}" aria-label="Spustit ${esc(t.name)}">${icon('play', 14)}</button></li>`).join('')}</ul>
          <a href="#/jobs" class="row small">${failed ? `<span class="badge off">${failed} neúspěšných replikací</span>` : `<span class="badge ok">replikace v pořádku</span>`}<span>→</span></a>`;
        $$('[data-run]', el).forEach((b) => { b.onclick = async () => { await run(() => rr.runTask(b.dataset.run), 'Úloha dokončena'); }; });
      },
    },
    {
      id: 'connect', title: 'Připojení klientů', icon: 'link', size: 'w12',
      render(el, c) {
        const reg = c.st.registry;
        const host = reg.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const snippets = {
          npm: `npm config set registry ${reg}\nnpm login --registry ${reg} --auth-type=legacy\n# nebo .npmrc:\n${reg.replace(/^https?:/, '')}:_authToken=<token>\n\nyarn config set npmRegistryServer ${reg}\npnpm config set registry ${reg}`,
          docker: `docker login ${host} -u <uživatel>        # heslo nebo token\ndocker tag moje-image ${host}/tym/moje-image:1.0\ndocker push ${host}/tym/moje-image:1.0`,
          git: `git remote add rr ${reg}git/tym/projekt.git\ngit push rr main          # repozitář se vytvoří\ngit clone ${reg}git/tym/projekt.git`,
          klienti: `curl -fsSL ${reg}install.sh | bash      # rr, rr-gui, rr-web\nrr login admin && rr status`,
        };
        // per-type hosts ({type}-registry.<domain>): every repository type at its own host root
        const th = c.st.typeHosts || [];
        if (th.length) {
          const ex = { npm: (u) => `npm config set registry ${u}`, docker: (u) => `docker login ${u.replace(/^https?:\/\//, '').replace(/\/$/, '')}`, git: (u) => `git clone ${u}tym/projekt.git`, generic: (u) => `curl -O ${u}cesta/soubor.tgz` };
          const w = Math.max(...th.map((t) => t.type.length));
          snippets.hosty = th.map((t) => `# ${t.type.padEnd(w)}  ${t.url}   (repozitář ${t.repo}${t.routed ? '' : ', v portálu zatím nesměrováno'})\n${ex[t.type] ? ex[t.type](t.url) : ''}`).join('\n\n');
        }
        let cur = 'npm';
        const draw = () => {
          el.innerHTML = `<div class="tabs">${Object.keys(snippets).map((k) => `<button type="button" data-s="${k}" class="${k === cur ? 'active' : ''}">${k}</button>`).join('')}<span class="spacer"></span><button type="button" class="btn small ghost" data-copy>${icon('copy', 15)}Kopírovat</button></div><pre>${esc(snippets[cur])}</pre>`;
          $$('[data-s]', el).forEach((b) => { b.onclick = () => { cur = b.dataset.s; draw(); }; });
          $('[data-copy]', el).onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(snippets[cur]); toast('Zkopírováno'); };
        };
        draw();
      },
    },
  ];

  function kpis(c) {
    const s = c.st;
    const images = c.repos.reduce((n, r) => n + (r.images || 0), 0);
    const daySeries = (c.stats.find(Boolean) || { days: [] }).days.map((d, j) => c.stats.reduce((n, x) => n + (x ? x.days[j].downloads : 0), 0));
    const dl30 = daySeries.reduce((a, b) => a + b, 0);
    const minute = [];
    if (c.logs) {
      const now = Date.now();
      for (let i = 29; i >= 0; i--) minute.push(c.logs.requests.filter((r) => Math.floor((now - Date.parse(r.time)) / 60000) === i).length);
    }
    const rate = c.cache && c.cache.hits + c.cache.misses ? Math.round((c.cache.hits / (c.cache.hits + c.cache.misses)) * 100) : null;
    const k = (label, value, sub, ic, ty, spark, color) => `<article class="kpi"><div class="kpi-top"><span class="tile ${ty}">${icon(ic, 18)}</span>${esc(label)}</div>
      <div class="kpi-row"><div><div class="kpi-v">${value}</div><div class="kpi-d">${sub}</div></div>${spark && spark.length > 1 ? RRUI.sparkline(spark, { color }) : ''}</div></article>`;
    return [
      k('Balíčky', fmtNum(s.packages), `${c.repos.filter((r) => r.type === 'npm').length} npm repozitáře`, 'package', 'npm', null),
      k('Stažení · 30 dní', fmtNum(dl30), `dnes ${fmtNum(daySeries[daySeries.length - 1] || 0)}`, 'download', 'git', daySeries, 'var(--ok)'),
      k('Docker image', fmtNum(images), `${s.gitRepos || 0} git repozitářů`, 'image', 'docker', null),
      k('Požadavky', fmtNum(s.stats.requests), `chyby ${fmtNum(s.stats.errors)} · proxy ${fmtNum(s.stats.proxied)}`, 'activity', 'npm', minute, 'var(--accent)'),
      rate !== null ? k('Cache hit', `${rate} %`, `${fmtNum(c.cache.entries)} položek`, 'cache', 'git', null) : k('Uptime', `${Math.round(s.uptime / 3600)} h`, `Node ${esc(s.node)}`, 'clock', 'git', null),
    ].join('');
  }

  views.dashboard = async () => {
    const c = await loadDash();
    const hidden = RRUI.LS.get('dash.hidden', []);
    const avail = WIDGETS.filter((w) => !w.admin || isAdmin());
    const hour = new Date().getHours();
    const hello = hour < 10 ? 'Dobré ráno' : hour < 18 ? 'Dobrý den' : 'Dobrý večer';
    const v = setView('Přehled', `
      <div class="hero-hello"><div><h2 style="margin:0;font-size:24px">${hello}, ${esc(me.name)}</h2><span class="muted">${esc(c.st.title)} ${esc(c.st.version)} · běží ${Math.round(c.st.uptime / 3600)} h · ${c.repos.length} repozitářů</span></div>
        <div class="row"><button type="button" class="btn small" id="editDash">${icon('edit', 15)}Upravit přehled</button>${isAdmin() ? `<button type="button" class="btn small" id="logWin">${icon('terminal', 15)}Živý log</button>` : ''}</div></div>
      <div class="widget-pick hidden" id="pick">${avail.map((w) => `<label class="check"><input type="checkbox" data-wid="${w.id}"${hidden.includes(w.id) ? '' : ' checked'}> ${esc(w.title)}</label>`).join('')}</div>
      <section class="kpis" aria-label="Klíčové ukazatele">${kpis(c)}</section>
      <section class="widgets">${avail.filter((w) => !hidden.includes(w.id)).map((w) => `<article class="widget ${w.size}" data-w="${w.id}">
        <header class="widget-head"><h2>${icon(w.icon, 17)}${esc(w.title)}</h2>
          <button type="button" class="wbtn" data-wa="refresh" title="Obnovit" aria-label="Obnovit ${esc(w.title)}">${icon('refresh', 15)}</button>
          <button type="button" class="wbtn" data-wa="pop" title="Otevřít v okně" aria-label="Otevřít ${esc(w.title)} v okně">${icon('popout', 15)}</button>
          <button type="button" class="wbtn" data-wa="hide" title="Skrýt" aria-label="Skrýt ${esc(w.title)}">${icon('x', 15)}</button></header>
        <div class="widget-body"></div></article>`).join('')}</section>`, 'grid');
    for (const w of avail) {
      const card = $(`[data-w="${w.id}"]`, v);
      if (card) { try { w.render($('.widget-body', card), c); } catch (e) { $('.widget-body', card).innerHTML = `<p class="error">${esc(e.message)}</p>`; } }
    }
    $$('[data-wa]', v).forEach((b) => {
      const id = b.closest('[data-w]').dataset.w;
      const w = WIDGETS.find((x) => x.id === id);
      b.onclick = async () => {
        if (b.dataset.wa === 'hide') { RRUI.LS.set('dash.hidden', [...new Set([...hidden, id])]); route(); }
        if (b.dataset.wa === 'refresh') { const body = $(`[data-w="${id}"] .widget-body`, v); body.style.opacity = '0.5'; w.render(body, await loadDash()); body.style.opacity = ''; }
        if (b.dataset.wa === 'pop') {
          wm.open({
            id: `widget:${id}`, title: w.title, icon: w.icon, width: w.size === 'w4' ? 420 : 720, height: 420,
            render: async (body, win) => { w.render(body, await loadDash()); if (!win.refreshing) { win.refreshing = true; win.every(15000, async () => w.render(body, await loadDash())); } },
          });
        }
      };
    });
    $('#editDash', v).onclick = () => $('#pick', v).classList.toggle('hidden');
    $$('[data-wid]', v).forEach((cb) => {
      cb.onchange = () => {
        const h = new Set(RRUI.LS.get('dash.hidden', []));
        if (cb.checked) h.delete(cb.dataset.wid); else h.add(cb.dataset.wid);
        RRUI.LS.set('dash.hidden', [...h]);
        route();
      };
    });
    const lw = $('#logWin', v);
    if (lw) lw.onclick = liveLogWindow;
    return v;
  };

  // ---------------------------------------------------------------- repositories
  views.repos = async () => {
    const repos = await rr.listRepos();
    repoCache = repos;
    const v = setView('Repozitáře', '<div id="t"></div>', 'repo');
    table('#t', {
      id: 'repos', rows: repos, rowKey: (r) => r.name, placeholder: 'Hledat repozitář…',
      sort: { key: 'name', dir: 1 },
      groups: [{ key: 'type', label: 'typ', value: (r) => r.type }, { key: 'vis', label: 'viditelnost', value: (r) => (r.public ? 'veřejné' : 'soukromé') }],
      toolbar: isAdmin() ? `<button type="button" class="btn small primary" data-new>${icon('plus', 15)}Nový repozitář</button>` : '',
      columns: [
        { key: 'name', label: 'Název', render: (r) => `${cellMain(r.type, r.name, r.description)}` },
        { key: 'type', label: 'Typ', render: (r) => `<span class="pill">${esc(r.type)}</span>${r.default ? ' <span class="badge blue">výchozí</span>' : ''}` },
        { key: 'count', label: 'Položek', align: 'right', value: (r) => r.packages ?? r.images ?? r.gitRepos ?? -1, render: (r) => `<span class="mono">${r.packages ?? r.images ?? r.gitRepos ?? '–'}</span>` },
        { key: 'public', label: 'Veřejný', toggle: true, render: (r) => yes(r.public) },
        { key: 'allowPublish', label: 'Publikace', toggle: true, render: (r) => yes(r.allowPublish) },
        { key: 'flags', label: 'Politiky', toggle: true, sort: false, render: (r) => [r.immutable ? '<span class="badge warn">neměnný</span>' : '', r.quotaMb ? `<span class="badge plain">kvóta ${r.quotaMb} MB</span>` : '', r.acl && Object.keys(r.acl).length ? '<span class="badge blue">ACL</span>' : '', r.cleanup && r.cleanup.enabled ? '<span class="badge ok">čištění</span>' : ''].join(' ') },
        { key: 'path', label: 'URL', toggle: true, hidden: true, render: (r) => `<code>${esc(r.path)}</code>` },
        { key: 'actions', label: '', sort: false, align: 'right', render: (r) => (isAdmin() ? `${iconBtn(`data-edit="${esc(r.name)}"`, 'edit', 'Upravit')}${iconBtn(`data-del="${esc(r.name)}"`, 'trash', 'Smazat', 'danger')}` : '') },
      ],
      onRow: (r) => { location.hash = `#/repo/${enc(r.name)}`; },
      onRender: (el) => {
        const n = $('[data-new]', el);
        if (n) n.onclick = () => repoForm();
        $$('[data-edit]', el).forEach((b) => { b.onclick = () => repoForm(repos.find((r) => r.name === b.dataset.edit)); });
        $$('[data-del]', el).forEach((b) => { b.onclick = () => deleteRepo(b.dataset.del); });
      },
    });
    return v;
  };

  const REPO_TYPES = [['npm', 'npm (npm, yarn, pnpm, bun, deno)'], ['generic', 'generic (soubory)'], ['docker', 'docker (Docker / OCI image, API /v2/)'], ['git', 'git (git clone / push přes HTTP)'], ['group', 'group (skupina npm/generic repozitářů)']];

  function repoForm(r) {
    const c = (r && r.cleanup) || {};
    const acl = r && r.acl ? Object.entries(r.acl).map(([u, l]) => `${u}:${l}`).join(',') : '';
    modal(`<h2>${r ? `Upravit repozitář ${esc(r.name)}` : 'Nový repozitář'}</h2>
      <form class="form" id="f">
        <label>Název <input name="name" value="${esc(r ? r.name : '')}" ${r ? 'disabled' : 'required pattern="[a-z0-9][a-z0-9._-]*"'}></label>
        <label>Typ <select name="type" id="rtype" ${r ? 'disabled' : ''}>${REPO_TYPES.map(([v, l]) => `<option value="${v}"${r && r.type === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label style="grid-column:1/-1">Popis <input name="description" value="${esc(r ? r.description : '')}"></label>
        <label class="check"><input type="checkbox" name="public" ${!r || r.public ? 'checked' : ''}> veřejné čtení (anonymně)</label>
        <label class="check"><input type="checkbox" name="allowPublish" ${!r || r.allowPublish ? 'checked' : ''}> povolit publikaci</label>
        <label class="check"><input type="checkbox" name="immutable" ${r && r.immutable ? 'checked' : ''}> neměnný (zákaz mazání a přepisu verzí, force-push)</label>
        <label class="check" data-only="git"><input type="checkbox" name="autoCreate" ${!r || r.autoCreate !== false ? 'checked' : ''}> git: vytvořit repozitář při prvním push</label>
        <label>Kvóta úložiště (MB, 0 = bez limitu) <input type="number" name="quotaMb" value="${r && r.quotaMb ? r.quotaMb : 0}" min="0"></label>
        <label>Přístupová práva <input name="acl" value="${esc(acl)}" placeholder="alice:publish,bob:read,eve:none"></label>
        <label data-only="group">Členové skupiny <input name="members" value="${esc(r && r.members ? r.members.join(',') : '')}" placeholder="npm,internal"></label>
        <label data-only="group">Publikovat do (deployTo) <input name="deployTo" value="${esc(r && r.deployTo ? r.deployTo : '')}" placeholder="internal"></label>
      </form>
      <h2 style="margin-top:6px">Pravidla čištění (retence)</h2>
      <form class="form" id="fc">
        <label class="check"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> automaticky čistit</label>
        <label>Ponechat nejnovějších N <input type="number" name="maxVersions" value="${c.maxVersions || 0}" min="0"></label>
        <label>Mazat starší než (dní) <input type="number" name="maxAgeDays" value="${c.maxAgeDays || 0}" min="0"></label>
        <label>Interval (hodiny) <input type="number" name="intervalHours" value="${c.intervalHours || 24}" min="1"></label>
        <label class="check"><input type="checkbox" name="prereleaseOnly" ${c.prereleaseOnly ? 'checked' : ''}> npm: jen pre-release verze</label>
        <label>generic: glob cest <input name="pattern" value="${esc(c.pattern || '')}" placeholder="/builds/**"></label>
      </form>
      <p class="muted small">npm: verze balíčku (verze s dist-tagem zůstávají) · docker: tagy image (latest zůstává) · generic: soubory v adresáři · git: git gc.</p>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="save">Uložit</button></div>`, (el, close) => {
      const sync = () => { const t = r ? r.type : $('#rtype', el).value; $$('[data-only]', el).forEach((x) => x.classList.toggle('hidden', x.dataset.only !== t)); };
      $('#rtype', el).onchange = sync;
      sync();
      $('#save', el).onclick = async () => {
        const d = formData($('#f', el));
        const type = r ? r.type : d.type;
        const body = { description: d.description, public: d.public, allowPublish: d.allowPublish, immutable: d.immutable, quotaMb: d.quotaMb || 0, acl: d.acl, cleanup: formData($('#fc', el)) };
        if (type === 'git') body.autoCreate = d.autoCreate;
        if (type === 'group') { body.members = d.members; body.deployTo = d.deployTo; }
        if (r) await run(() => rr.updateRepo(r.name, body), 'Uloženo');
        else await run(() => rr.createRepo({ name: d.name, type, ...body }), `Repozitář ${d.name} vytvořen`);
        close(); route();
      };
    });
  }

  async function deleteRepo(name) {
    if (!(await confirmBox(`Smazat repozitář ${name}? (soubory zůstanou na disku, pokud nezvolíte purge)`))) return;
    const purge = await confirmBox(`Smazat i všechna data repozitáře ${name} z disku?`);
    await run(() => rr.deleteRepo(name, { purge: purge ? 1 : '' }), 'Smazáno');
    location.hash = '#/repos';
  }

  function usage(r, reg) {
    const host = serverBase().replace(/^https?:\/\//, '');
    if (r.type === 'npm' || (r.type === 'group' && r.packages !== undefined)) return `npm install <balíček> --registry ${reg}\nnpm publish --registry ${reg}\n\n# .npmrc\nregistry=${reg}\n${reg.replace(/^https?:/, '')}:_authToken=<token>\n\n# pouze scope na tento repozitář\n@firma:registry=${reg}`;
    if (r.type === 'git') {
      const g = r.gitDefault ? `${serverBase()}/git` : `${serverBase()}/r/${r.name}`;
      return `git clone ${g}/<název>.git\ngit remote add rr ${g}/tym/projekt.git\ngit push rr main        # repozitář se vytvoří automaticky${r.autoCreate === false ? ' (vypnuto)' : ''}`;
    }
    if (r.type === 'docker') return `docker login ${host}\ndocker tag app ${host}/tym/app:1.0\ndocker push ${host}/tym/app:1.0`;
    return `curl -O ${reg}cesta/k/souboru.zip\ncurl -T soubor.zip -H "Authorization: Bearer <token>" ${reg}cesta/soubor.zip\ncurl -X DELETE -H "Authorization: Bearer <token>" ${reg}cesta/soubor.zip`;
  }

  function barChart(days) {
    const max = Math.max(1, ...days.map((d) => d.downloads));
    return `<div class="bars">${days.map((d) => `<div class="bar" title="${esc(d.day)}: ${d.downloads}"><span style="height:${Math.round((d.downloads / max) * 100)}%"></span></div>`).join('')}</div>`;
  }

  views.repo = async (name) => {
    const r = await rr.getRepo(name);
    const stats = await rr.getRepoStats(name, { top: 10 }).catch(() => null);
    const reg = r.type === 'git' ? `${serverBase()}${r.path}` : registryUrl(r.name, r.default);
    const count = r.packages ?? r.images ?? r.gitRepos;
    const c = r.cleanup || {};
    const v = setView(`Repozitář ${r.name}`, `
      <div class="grid">
        <div class="card"><div class="muted">Typ</div><div class="stat">${esc(r.type)}</div>${r.members ? `<div class="muted small">členové: ${esc(r.members.join(', '))}${r.deployTo ? ` · deploy → ${esc(r.deployTo)}` : ''}</div>` : ''}</div>
        <div class="card"><div class="muted">${r.type === 'docker' ? 'Image' : r.type === 'git' ? 'Git repozitáře' : 'Balíčky'}</div><div class="stat">${count ?? '–'}</div></div>
        <div class="card"><div class="muted">Úložiště</div><div class="stat">${fmtBytes(r.storage.bytes)}</div><div class="muted small">${r.storage.files} souborů${r.quota ? ` · kvóta ${fmtBytes(r.quota.limitBytes)} (${Math.round((r.quota.usedBytes / r.quota.limitBytes) * 100)} %)` : ''}</div></div>
        <div class="card"><div class="muted">Stažení</div><div class="stat">${stats ? stats.total : '–'}</div><div class="muted small">posledních 30 dní</div>${stats ? barChart(stats.days) : ''}</div>
      </div>
      <div class="card"><h2>${esc(r.description || r.name)}</h2>
        <p>Veřejný ${yes(r.public)} · Publikace ${yes(r.allowPublish)} · Neměnný ${yes(r.immutable)} · vytvořen ${fmtDate(r.created)}</p>
        ${r.acl && Object.keys(r.acl).length ? `<p>Přístup: ${Object.entries(r.acl).map(([u, l]) => `<span class="badge">${esc(u)}: ${esc(l)}</span>`).join(' ')}</p>` : ''}
        <p class="muted small">Úložiště: <code>${esc(r.storage.dir)}</code></p>
        <div class="row">
          ${r.type === 'npm' || r.type === 'group' ? `<a class="btn primary" href="#/packages/${enc(r.name)}">${icon('package', 16)}Balíčky</a>` : ''}
          ${r.type === 'git' ? `<a class="btn primary" href="#/git/${enc(r.name)}">${icon('git', 16)}Git repozitáře</a>` : ''}
          ${r.type === 'docker' ? `<a class="btn primary" href="#/images/${enc(r.name)}">${icon('image', 16)}Image</a>` : ''}
          <a class="btn" href="#/files/${enc(r.name)}">${icon('folder', 16)}Soubory</a>
          <button class="btn" id="edit">Upravit</button><button class="btn danger" id="del">Smazat</button>
        </div></div>
      <div class="card"><h2>Čištění (retence)</h2>
        <p>${c.enabled ? '<span class="badge ok">automaticky</span>' : '<span class="badge">ručně</span>'} ponechat ${c.maxVersions || '∞'} · max. stáří ${c.maxAgeDays ? `${c.maxAgeDays} dní` : '∞'}${c.prereleaseOnly ? ' · jen pre-release' : ''}${c.pattern ? ` · ${esc(c.pattern)}` : ''} · poslední běh ${r.cleanupLastRun ? fmtDate(r.cleanupLastRun) : '–'}</p>
        <div class="row"><button class="btn" id="preview">Náhled čištění</button><button class="btn danger" id="clean" ${r.immutable ? 'disabled' : ''}>Spustit čištění</button></div>
        <div id="cleanOut"></div></div>
      ${stats && stats.top.length ? `<div class="card table-wrap"><h2>Nejstahovanější</h2><table><tr><th>Položka</th><th>Stažení</th></tr>${stats.top.map((t) => `<tr><td>${esc(t.item)}</td><td>${t.downloads}</td></tr>`).join('')}</table></div>` : ''}
      <div class="card"><h2>Použití</h2><pre>${esc(usage(r, reg))}</pre></div>`, 'repo');
    $('#edit', v).onclick = () => repoForm(r);
    $('#del', v).onclick = () => deleteRepo(r.name);
    const showClean = (res) => {
      $('#cleanOut', v).innerHTML = `<p>${res.dryRun ? 'Náhled' : 'Hotovo'}: ${res.actions.length} akcí${res.dryRun ? '' : `, uvolněno ${fmtBytes(res.freedBytes)}`}</p>
        <div class="table-wrap"><table>${res.actions.slice(0, 200).map((a) => `<tr><td>${esc(a.action)}</td><td><code>${esc(a.target)}</code></td><td class="muted small">${esc(a.reason || '')}</td></tr>`).join('')}</table></div>`;
    };
    $('#preview', v).onclick = async () => showClean(await run(() => rr.runCleanup(r.name, { dryRun: true })));
    $('#clean', v).onclick = async () => { if (await confirmBox(`Spustit čištění repozitáře ${r.name}? Smazaná data nelze obnovit.`)) showClean(await run(() => rr.runCleanup(r.name, { dryRun: false }), 'Čištění dokončeno')); };
  };

  // ---------------------------------------------------------------- packages
  views.packages = async (repoName) => {
    const repos = (await rr.listRepos()).filter((r) => r.type === 'npm' || r.type === 'group');
    repoCache = await rr.listRepos();
    if (!repos.length) return setView('Balíčky', '<div class="card">Žádný npm repozitář.</div>', 'package');
    const repo = repoName || (repos.find((r) => r.default) || repos[0]).name;
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const list = await rr.listPackages(repo);
    const isGroup = (repos.find((r) => r.name === repo) || {}).type === 'group';
    const v = setView('Balíčky', '<div id="t"></div>', 'package');
    table('#t', {
      id: 'packages', rows: list, rowKey: (p) => `${p.member || repo}/${p.name}`, q, placeholder: 'Hledat balíček, popis, verzi…',
      sort: { key: 'modified', dir: -1 },
      search: (p) => `${p.name} ${p.description} ${p.version} ${Object.keys(p.distTags || {}).join(' ')} ${(p.keywords || []).join(' ')}`,
      groups: [
        { key: 'scope', label: 'scope', value: (p) => (p.name.startsWith('@') ? p.name.split('/')[0] : 'bez scope') },
        { key: 'age', label: 'stáří', value: (p) => age(p.modified) },
        ...(isGroup ? [{ key: 'member', label: 'člen skupiny', value: (p) => p.member }] : []),
      ],
      toolbar: `${repoSelect(repos, repo, true)}
        <label class="btn small" title="Publikovat .tgz">${icon('upload', 15)}Publikovat .tgz<input type="file" id="upload" accept=".tgz,.tar.gz" multiple class="sr"></label>
        <label class="dt-select"><span>dist-tag</span><input id="tag" value="latest" style="width:90px;min-height:0;border:0;background:transparent;padding:0 4px"></label>`,
      columns: [
        { key: 'name', label: 'Balíček', render: (p) => cellMain('npm', p.name, p.description) },
        { key: 'version', label: 'Poslední', value: (p) => p.version, render: (p) => `<span class="mono">${esc(p.version)}</span>` },
        { key: 'versions', label: 'Verzí', align: 'right', render: (p) => `<span class="mono">${p.versions}</span>` },
        { key: 'tags', label: 'Tagy', toggle: true, sort: false, render: (p) => Object.entries(p.distTags || {}).filter(([t]) => t !== 'latest').map(([t, ver]) => `<span class="badge warn">${esc(t)} ${esc(ver)}</span>`).join(' ') },
        { key: 'member', label: 'Repozitář', toggle: true, hidden: !isGroup, value: (p) => p.member || repo },
        { key: 'license', label: 'Licence', toggle: true, hidden: true, value: (p) => p.license || '' },
        { key: 'modified', label: 'Změněno', value: (p) => p.modified, render: (p) => when(p.modified), nowrap: true },
        { key: 'act', label: '', sort: false, align: 'right', render: (p) => iconBtn(`data-win="${esc(p.name)}" data-m="${esc(p.member || repo)}"`, 'popout', 'Otevřít v okně') },
      ],
      actions: [{ label: 'Smazat vybrané', icon: 'trash', danger: true, run: async (sel) => {
        if (!(await confirmBox(`Smazat ${sel.length} balíčků se všemi verzemi?`))) return;
        for (const p of sel) await run(() => rr.deletePackage(p.member || repo, p.name));
        toast(`Smazáno: ${sel.length}`); route();
      } }],
      onRow: (p) => { location.hash = `#/pkg/${enc(p.member || repo)}/${enc(p.name)}`; },
      onRender: (el) => {
        $$('[data-win]', el).forEach((b) => { b.onclick = () => pkgWindow(b.dataset.m, b.dataset.win); });
      },
    });
    $('#repoSel', v).onchange = (e) => { location.hash = `#/packages/${enc(e.target.value)}`; };
    $('#upload', v).onchange = async (e) => {
      for (const f of e.target.files) await run(async () => rr.uploadPackage(repo, await readFile(f), { tag: $('#tag', v).value }), `Publikováno: ${f.name}`);
      route();
    };
    return v;
  };

  views.pkg = async (repo, name) => {
    const d = await rr.getPackage(repo, name);
    const versions = Object.keys(d.versions);
    const reg = registryUrl(repo, (await rr.getRepo(repo)).default);
    const latest = d['dist-tags'].latest;
    const v = setView(name, `
      <div class="row"><a class="btn small ghost" href="#/packages/${enc(repo)}">${icon('up', 15)}Balíčky v ${esc(repo)}</a><span class="spacer"></span>
        <button type="button" class="btn small" id="winPkg">${icon('popout', 15)}Otevřít v okně</button>
        <button type="button" class="btn small danger" id="delPkg">${icon('trash', 15)}Smazat balíček</button></div>
      <div class="kpis">
        <article class="kpi"><div class="kpi-top"><span class="tile npm">${icon('package', 18)}</span>Poslední verze</div><div class="kpi-v">${esc(latest)}</div><div class="kpi-d">${when(d.time[latest])}</div></article>
        <article class="kpi"><div class="kpi-top"><span class="tile git">${icon('tag', 18)}</span>Verzí</div><div class="kpi-v">${versions.length}</div><div class="kpi-d">${Object.keys(d['dist-tags']).length} dist-tagů</div></article>
        <article class="kpi"><div class="kpi-top"><span class="tile docker">${icon('users', 18)}</span>Správci</div><div class="kpi-v" style="font-size:20px">${(d.maintainers || []).map((m) => esc(m.name)).join(', ') || '–'}</div><div class="kpi-d">vytvořeno ${when(d.time.created)}</div></article>
      </div>
      <div class="card"><h2>${icon('terminal', 17)}Instalace</h2><p class="muted" style="margin:0 0 10px">${esc(d.description)}</p><pre>npm install ${esc(d.name)} --registry ${esc(reg)}</pre></div>
      <div class="card"><h2>${icon('tag', 17)}Dist-tagy</h2>
        <div class="row">${Object.entries(d['dist-tags']).map(([t, ver]) => `<span class="badge warn">${esc(t)} → ${esc(ver)}${t !== 'latest' ? ` <a href="#" data-untag="${esc(t)}" aria-label="Smazat tag ${esc(t)}">${icon('x', 12)}</a>` : ''}</span>`).join(' ')}</div>
        <div class="row" style="margin-top:12px"><input id="tagName" placeholder="tag (např. beta)" style="width:180px"><select id="tagVer" style="width:180px">${versions.slice().reverse().map((x) => `<option>${esc(x)}</option>`).join('')}</select><button class="btn" id="setTag">Nastavit tag</button></div>
      </div>
      <div id="vt"></div>
      <div class="card"><h2>${icon('file', 17)}README</h2><pre style="white-space:pre-wrap">${esc(d.readme || '(bez README)')}</pre></div>
      <div class="card"><h2>${icon('file', 17)}package.json (${esc(latest)})</h2><pre>${esc(JSON.stringify(d.versions[latest], null, 2))}</pre></div>`, 'package');
    const rows = versions.map((ver) => ({ ver, m: d.versions[ver], time: d.time[ver], tags: Object.entries(d['dist-tags']).filter(([, x]) => x === ver).map(([t]) => t) }));
    table('#vt', {
      id: 'versions', rows, rowKey: (r) => r.ver, placeholder: 'Hledat verzi…', sort: { key: 'time', dir: -1 },
      groups: [{ key: 'major', label: 'hlavní verze', value: (r) => `${r.ver.split('.')[0]}.x` }, { key: 'kind', label: 'druh', value: (r) => (r.ver.includes('-') ? 'pre-release' : 'stabilní') }],
      columns: [
        { key: 'ver', label: 'Verze', value: (r) => r.ver, render: (r) => `<b class="mono">${esc(r.ver)}</b> ${r.tags.map((t) => `<span class="badge warn">${esc(t)}</span>`).join(' ')}` },
        { key: 'time', label: 'Publikováno', value: (r) => r.time, render: (r) => when(r.time) },
        { key: 'size', label: 'Velikost', align: 'right', value: (r) => r.m.dist.size || 0, render: (r) => `<span class="mono">${fmtBytes(r.m.dist.size)}</span>` },
        { key: 'user', label: 'Publikoval', toggle: true, value: (r) => (r.m._npmUser || {}).name || '' },
        { key: 'dep', label: 'Stav', value: (r) => (r.m.deprecated ? 1 : 0), render: (r) => (r.m.deprecated ? `<span class="badge off" title="${esc(r.m.deprecated)}">deprecated</span>` : '<span class="badge ok">aktivní</span>') },
        { key: 'act', label: '', sort: false, align: 'right', render: (r) => `${iconBtn(`data-dl="${esc(r.ver)}"`, 'download', 'Stáhnout tgz')}${iconBtn(`data-dep="${esc(r.ver)}"`, 'alert', 'Deprecate')}${iconBtn(`data-delv="${esc(r.ver)}"`, 'trash', 'Smazat verzi', 'danger')}` },
      ],
      onRender: (el) => {
        $$('[data-dl]', el).forEach((b) => { b.onclick = async () => download(await run(() => rr.downloadTarball(repo, name, b.dataset.dl)), `${name.split('/').pop()}-${b.dataset.dl}.tgz`); });
        $$('[data-dep]', el).forEach((b) => {
          b.onclick = () => modal(`<h2>Deprecate ${esc(name)}@${esc(b.dataset.dep)}</h2><label>Zpráva (prázdná = zrušit) <input id="msg"></label>
            <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Uložit</button></div>`, (m, close) => {
            $('#ok', m).onclick = async () => { await run(() => rr.deprecateVersion(repo, name, b.dataset.dep, { message: $('#msg', m).value }), 'Uloženo'); close(); route(); };
          });
        });
        $$('[data-delv]', el).forEach((b) => { b.onclick = async () => { if (await confirmBox(`Smazat ${name}@${b.dataset.delv}?`)) { await run(() => rr.deleteVersion(repo, name, b.dataset.delv), 'Verze smazána'); route(); } }; });
      },
    });
    $('#winPkg', v).onclick = () => pkgWindow(repo, name);
    $('#delPkg', v).onclick = async () => { if (await confirmBox(`Smazat ${name} se všemi verzemi?`)) { await run(() => rr.deletePackage(repo, name), 'Smazáno'); location.hash = `#/packages/${enc(repo)}`; } };
    $('#setTag', v).onclick = async () => { await run(() => rr.setDistTag(repo, name, $('#tagName', v).value, { version: $('#tagVer', v).value }), 'Tag nastaven'); route(); };
    $$('[data-untag]', v).forEach((a) => { a.onclick = async (e) => { e.preventDefault(); await run(() => rr.deleteDistTag(repo, name, a.dataset.untag), 'Tag smazán'); route(); }; });
    return v;
  };

  // ---------------------------------------------------------------- files
  views.files = async (repoName, ...rest) => {
    const repos = await rr.listRepos();
    const repo = repoName || (repos.find((r) => r.type === 'generic') || repos.find((r) => r.default) || repos[0]).name;
    const path = `/${rest.map(decodeURIComponent).join('/')}`.replace(/\/+$/, '') || '/';
    const t = await rr.tree(repo, { path, depth: 1 });
    const parts = path.split('/').filter(Boolean);
    const link = (i) => `#/files/${enc(repo)}/${parts.slice(0, i).map(enc).join('/')}`;
    const full = (n) => `${path === '/' ? '' : path}/${n}`;
    const v = setView('Soubory', `
      <div class="card row" style="padding:10px 14px">
        <nav class="crumbs" aria-label="Cesta"><a href="${link(0)}">${icon('folder', 16)}${esc(repo)}</a>${parts.map((p, i) => ` <span class="muted">/</span> <a href="${link(i + 1)}">${esc(p)}</a>`).join('')}</nav>
        <span class="spacer"></span>${path !== '/' ? `<a class="btn small ghost" href="${link(parts.length - 1)}">${icon('up', 15)}Výš</a>` : ''}
      </div>
      <div id="t"></div>`, 'folder');
    const rows = (t.children || []).map((c) => ({ ...c, ext: c.type === 'dir' ? 'adresáře' : (c.name.includes('.') ? c.name.split('.').pop().toLowerCase() : 'bez přípony') }));
    table('#t', {
      id: 'files', rows, rowKey: (r) => r.name, placeholder: 'Hledat v adresáři…', sort: { key: 'name', dir: 1 }, group: 'type',
      groups: [{ key: 'type', label: 'druh', value: (r) => (r.type === 'dir' ? 'adresáře' : 'soubory') }, { key: 'ext', label: 'přípona', value: (r) => r.ext }, { key: 'age', label: 'stáří', value: (r) => age(r.modified) }],
      empty: 'Prázdný adresář.',
      toolbar: `${repoSelect(repos, repo)}<label class="btn small">${icon('upload', 15)}Nahrát<input type="file" id="up" multiple class="sr"></label><button type="button" class="btn small" id="mk">${icon('plus', 15)}Adresář</button>`,
      columns: [
        { key: 'name', label: 'Název', render: (r) => cellMain(r.type === 'dir' ? 'git' : 'x', r.name, r.type === 'dir' ? 'adresář' : '', r.type === 'dir' ? 'folder' : 'file') },
        { key: 'size', label: 'Velikost', align: 'right', value: (r) => (r.type === 'dir' ? -1 : r.size), render: (r) => (r.type === 'dir' ? '' : `<span class="mono">${fmtBytes(r.size)}</span>`) },
        { key: 'modified', label: 'Změněno', value: (r) => r.modified, render: (r) => when(r.modified) },
        { key: 'act', label: '', sort: false, align: 'right', render: (r) => `${r.type === 'file' ? `${iconBtn(`data-view="${esc(r.name)}"`, 'popout', 'Náhled v okně')}${iconBtn(`data-get="${esc(r.name)}"`, 'download', 'Stáhnout')}` : ''}${iconBtn(`data-rm="${esc(r.name)}"`, 'trash', 'Smazat', 'danger')}` },
      ],
      actions: [{ label: 'Smazat vybrané', icon: 'trash', danger: true, run: async (sel) => {
        if (!(await confirmBox(`Smazat ${sel.length} položek?`))) return;
        for (const r of sel) await run(() => rr.deleteFile(repo, { path: full(r.name) }));
        toast(`Smazáno: ${sel.length}`); route();
      } }],
      onRow: (r) => {
        if (r.type === 'dir') location.hash = `${link(parts.length)}${parts.length ? '/' : ''}${enc(r.name)}`;
        else viewFile(repo, full(r.name));
      },
      onRender: (el) => {
        $$('[data-view]', el).forEach((b) => { b.onclick = () => viewFile(repo, full(b.dataset.view)); });
        $$('[data-get]', el).forEach((b) => { b.onclick = async () => download(await run(() => rr.readFile(repo, { path: full(b.dataset.get) })), b.dataset.get); });
        $$('[data-rm]', el).forEach((b) => { b.onclick = async () => { if (await confirmBox(`Smazat ${full(b.dataset.rm)}?`)) { await run(() => rr.deleteFile(repo, { path: full(b.dataset.rm) }), 'Smazáno'); route(); } }; });
      },
    });
    $('#repoSel', v).onchange = (e) => { location.hash = `#/files/${enc(e.target.value)}`; };
    $('#up', v).onchange = async (e) => {
      for (const f of e.target.files) await run(async () => rr.writeFile(repo, await readFile(f), { path: full(f.name) }), `Nahráno: ${f.name}`);
      route();
    };
    $('#mk', v).onclick = () => modal(`<h2>Nový adresář v ${esc(path)}</h2><label>Název <input id="dn"></label>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
      $('#ok', el).onclick = async () => { await run(() => rr.mkdir(repo, { path: full($('#dn', el).value) })); close(); route(); };
    });
    return v;
  };

  function viewFile(repo, path) {
    fileWindow(`${repo}:${path}`, async () => {
      const st = await rr.stat(repo, { path });
      const bytes = st.size < 5 * 1024 * 1024 ? await rr.readFile(repo, { path }) : new Uint8Array([0]);
      return { bytes, size: st.size, modified: st.modified };
    });
  }

  // ---------------------------------------------------------------- docker images
  views.images = async (repoName, ...rest) => {
    const repos = (await rr.listRepos()).filter((r) => r.type === 'docker');
    if (!repos.length) return setView('Docker image', '<div class="card"><p class="muted">Žádný docker repozitář – vytvořte ho v sekci Repozitáře (typ docker).</p></div>', 'image');
    const repo = repos.find((r) => r.name === repoName) || repos.find((r) => r.dockerDefault) || repos[0];
    const image = rest.length ? rest.join('/') : '';
    const host = location.host;
    if (image) {
      const tags = await rr.listImageTags(repo.name, image);
      const v = setView(image, `
        <div class="row"><a class="btn small ghost" href="#/images/${enc(repo.name)}">${icon('up', 15)}Image</a></div>
        <div class="card"><h2>${icon('terminal', 17)}Stažení</h2><pre>docker pull ${esc(host)}/${esc(image)}:${esc(tags[0] ? tags[0].tag : 'latest')}</pre></div>
        <div id="t"></div>`, 'image');
      table('#t', {
        id: 'imgtags', rows: tags, rowKey: (t) => t.tag, placeholder: 'Hledat tag…', sort: { key: 'created', dir: -1 },
        groups: [{ key: 'digest', label: 'digest', value: (t) => (t.digest || '').slice(7, 19) }, { key: 'kind', label: 'typ manifestu', value: (t) => (/index|list/.test(t.mediaType || '') ? 'multi-platform' : 'image') }],
        columns: [
          { key: 'tag', label: 'Tag', render: (t) => cellMain('docker', t.tag, '', 'tag') },
          { key: 'digest', label: 'Digest', render: (t) => `<code title="${esc(t.digest)}">${esc((t.digest || '').slice(0, 19))}…</code>` },
          { key: 'mediaType', label: 'Typ', toggle: true, render: (t) => `<span class="small muted">${esc((t.mediaType || '').replace('application/vnd.', ''))}</span>` },
          { key: 'size', label: 'Velikost', align: 'right', render: (t) => `<span class="mono">${fmtBytes(t.size)}</span>` },
          { key: 'created', label: 'Vytvořen', render: (t) => when(t.created) },
          { key: 'act', label: '', sort: false, align: 'right', render: (t) => iconBtn(`data-del="${esc(t.tag)}"`, 'trash', 'Smazat tag', 'danger') },
        ],
        onRender: (el) => {
          $$('[data-del]', el).forEach((b) => {
            b.onclick = async () => {
              if (!(await confirmBox(`Smazat tag ${image}:${b.dataset.del}? Data uvolní garbage collection.`))) return;
              await run(() => rr.deleteImageTag(repo.name, image, b.dataset.del), 'Tag smazán');
              route();
            };
          });
        },
      });
      return v;
    }
    const images = await rr.listImages(repo.name);
    const v = setView('Docker image', `<div class="card"><h2>${icon('terminal', 17)}Použití</h2><pre>docker login ${esc(host)}\ndocker push ${esc(host)}/tym/aplikace:1.0</pre></div><div id="t"></div>`, 'image');
    table('#t', {
      id: 'images', rows: images, rowKey: (i) => i.name, placeholder: 'Hledat image…', sort: { key: 'updated', dir: -1 },
      groups: [{ key: 'ns', label: 'jmenný prostor', value: (i) => (i.name.includes('/') ? i.name.split('/')[0] : '(kořen)') }],
      toolbar: `${repos.length > 1 ? `<label class="dt-select">${icon('repo', 16)}<select id="dockerRepo">${repos.map((r) => `<option value="${esc(r.name)}"${r.name === repo.name ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>` : ''}${isAdmin() ? `<button type="button" class="btn small" id="gc">${icon('broom', 15)}Garbage collection</button>` : ''}`,
      empty: 'Zatím žádné image.',
      columns: [
        { key: 'name', label: 'Image', render: (i) => cellMain('docker', i.name, `${esc(host)}/${i.name}`) },
        { key: 'tags', label: 'Tagů', align: 'right', render: (i) => `<span class="mono">${i.tags}</span>` },
        { key: 'size', label: 'Velikost (latest)', align: 'right', render: (i) => `<span class="mono">${fmtBytes(i.size)}</span>` },
        { key: 'updated', label: 'Aktualizace', render: (i) => when(i.updated) },
      ],
      onRow: (i) => { location.hash = `#/images/${enc(repo.name)}/${i.name.split('/').map(enc).join('/')}`; },
    });
    const sel = $('#dockerRepo', v);
    if (sel) sel.onchange = () => { location.hash = `#/images/${enc(sel.value)}`; };
    const gc = $('#gc', v);
    if (gc) gc.onclick = async () => {
      const untagged = await confirmBox('Smazat i manifesty bez tagu? (Zrušit = jen nepoužívaná data)');
      const r = await run(() => rr.dockerGc(repo.name, { untagged }));
      if (r) toast(`Uvolněno ${fmtBytes(r.bytes)} – ${r.blobs} blobů, ${r.manifests} manifestů`);
      route();
    };
    return v;
  };

  // ---------------------------------------------------------------- search
  views.search = async () => {
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const res = q ? await rr.search({ q, size: 200 }) : { objects: [], total: 0 };
    const v = setView('Hledání', `
      <form class="card row" id="sf" style="padding:12px"><label class="dt-search" style="flex:1">${icon('search', 18)}<span class="sr">Hledat</span><input id="q" type="search" value="${esc(q)}" placeholder="název, popis, keywords:xyz, scope:firma, maintainer:m5ike"></label><button class="btn primary">Hledat</button></form>
      <div id="t"></div>`, 'search');
    $('#sf', v).onsubmit = (e) => { e.preventDefault(); location.hash = `#/search?q=${enc($('#q', v).value)}`; };
    if (!q) { $('#t', v).innerHTML = `<div class="card dt-empty">${icon('search', 28)}<p>Zadejte hledaný výraz. Tip: <kbd>⌘K</kbd> hledá odkudkoli.</p></div>`; return v; }
    table('#t', {
      id: 'search', rows: res.objects, rowKey: (o) => `${o.repository}/${o.package.name}`, placeholder: 'Filtrovat výsledky…', sort: { key: 'score', dir: -1 }, group: 'repo',
      groups: [{ key: 'repo', label: 'repozitář', value: (o) => o.repository }, { key: 'scope', label: 'scope', value: (o) => o.package.scope }],
      columns: [
        { key: 'name', label: 'Balíček', value: (o) => o.package.name, render: (o) => cellMain('npm', o.package.name, o.package.description) },
        { key: 'version', label: 'Verze', value: (o) => o.package.version, render: (o) => `<span class="mono">${esc(o.package.version)}</span>` },
        { key: 'repo', label: 'Repozitář', value: (o) => o.repository },
        { key: 'score', label: 'Shoda', align: 'right', value: (o) => o.searchScore, render: (o) => `<span class="meter"><i style="width:${Math.min(100, o.searchScore * 10)}%"></i></span>` },
      ],
      onRow: (o) => { location.hash = `#/pkg/${enc(o.repository)}/${enc(o.package.name)}`; },
    });
    return v;
  };

  // ---------------------------------------------------------------- git list
  views.git = async (repoName, ...rest) => {
    const repos = (await rr.listRepos()).filter((r) => r.type === 'git');
    if (!repos.length) return setView('Git', '<div class="card"><p class="muted">Žádný repozitář typu git – vytvořte ho v sekci Repozitáře (typ git).</p></div>', 'git');
    const repo = repos.find((r) => r.name === repoName) || repos.find((r) => r.gitDefault) || repos[0];
    // …/<název>/pulls[/<n>] and …/<název>/issues[/<n>] (html_url of the pull request / issue API)
    let sub = null;
    const kindAt = rest.length >= 3 && /^\d+$/.test(rest[rest.length - 1]) ? rest.length - 2 : rest.length >= 2 ? rest.length - 1 : -1;
    if (kindAt > 0 && ['pulls', 'issues'].includes(rest[kindAt])) {
      sub = { tab: rest[kindAt], number: rest[kindAt + 1] ? Number(rest[kindAt + 1]) : null };
      rest = rest.slice(0, kindAt);
    }
    const name = rest.join('/');
    if (name) return gitDetail(repo, name, sub);
    const list = await rr.listGitRepos(repo.name);
    const v = setView('Git repozitáře', `
      <div class="card"><h2>${icon('terminal', 17)}Klonování a push</h2><pre>git clone ${esc(gitBase(repo))}/&lt;název&gt;.git
git remote add rr ${esc(gitBase(repo))}/tym/projekt.git
git push rr main      # ${repo.autoCreate === false ? 'automatické vytvoření je vypnuto' : 'repozitář se při prvním push vytvoří automaticky'}</pre></div>
      <div id="t"></div>`, 'git');
    table('#t', {
      id: 'gitrepos', rows: list, rowKey: (g) => g.name, placeholder: 'Hledat git repozitář…', sort: { key: 'name', dir: 1 },
      groups: [{ key: 'owner', label: 'vlastník', value: (g) => (g.name.includes('/') ? g.name.split('/')[0] : '(kořen)') }, { key: 'kind', label: 'druh', value: (g) => (g.mirror ? 'zrcadla' : 'vlastní') }],
      toolbar: `${repos.length > 1 ? `<label class="dt-select">${icon('repo', 16)}<select id="gitRepo">${repos.map((r) => `<option value="${esc(r.name)}"${r.name === repo.name ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>` : ''}
        <button type="button" class="btn small primary" id="new">${icon('plus', 15)}Nový</button><button type="button" class="btn small" id="imp">${icon('download', 15)}Import / zrcadlo</button><button type="button" class="btn small" id="gh">${icon('git', 15)}GitHub import</button>`,
      empty: 'Zatím žádné git repozitáře – pošlete první push.',
      columns: [
        { key: 'name', label: 'Název', render: (g) => cellMain('git', g.name, g.description) },
        { key: 'mirror', label: 'Pull zrcadlo', value: (g) => (g.mirror ? g.mirror.status : ''), render: (g) => (g.mirror ? `<span class="badge ${g.mirror.status === 'ok' ? 'ok' : g.mirror.status === 'error' ? 'off' : 'blue'}">${esc(g.mirror.status || '')}</span> <span class="small muted">${esc(g.mirror.url)}</span>` : '–') },
        { key: 'sync', label: 'Synchronizace', toggle: true, value: (g) => (g.mirror ? g.mirror.lastSync : ''), render: (g) => (g.mirror ? when(g.mirror.lastSync) : '–') },
        { key: 'pushMirrors', label: 'Push zrcadla', align: 'right', render: (g) => (g.pushMirrors ? `<span class="pill">${g.pushMirrors}</span>` : '–') },
        { key: 'created', label: 'Vytvořeno', toggle: true, render: (g) => when(g.created) },
      ],
      onRow: (g) => { location.hash = gitHash(repo, g.name); },
    });
    return gitListActions(v, repo);
  };

  function gitListActions(v, repo) {
    const sel = $('#gitRepo', v);
    if (sel) sel.onchange = () => { location.hash = `#/git/${enc(sel.value)}`; };
    $('#new', v).onclick = () => modal(`<h2>Nový git repozitář</h2><form class="form" id="f">
        <label>Název <input name="name" required placeholder="tym/projekt"></label><label>Výchozí větev <input name="defaultBranch" value="main"></label>
        <label style="grid-column:1/-1">Popis <input name="description"></label></form>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
      $('#ok', el).onclick = async () => { const d = formData($('#f', el)); await run(() => rr.createGitRepo(repo.name, d), 'Vytvořeno'); close(); location.hash = gitHash(repo, d.name); };
    });
    $('#imp', v).onclick = () => modal(`<h2>Import / zrcadlo git repozitáře</h2><form class="form" id="f">
        <label style="grid-column:1/-1">URL zdroje <input name="importUrl" id="iu" required placeholder="https://github.com/owner/repo.git"></label>
        <label>Název v registru <input name="name" id="in" required></label>
        <label>Token (privátní repozitáře) <input name="token" type="password"></label>
        <label>Uživatel (výchozí x-access-token) <input name="username"></label>
        <label>Interval synchronizace (s) <input name="interval" type="number" value="3600"></label>
        <label class="check"><input type="checkbox" name="mirror" checked> udržovat jako zrcadlo (jen pro čtení)</label></form>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Importovat</button></div>`, (el, close) => {
      $('#iu', el).oninput = (e) => { $('#in', el).value = e.target.value.replace(/^[a-z]+:\/\/[^/]+\//, '').replace(/\.git$/, ''); };
      $('#ok', el).onclick = async () => {
        const d = formData($('#f', el));
        toast('Klonuji…');
        const g = await run(() => rr.createGitRepo(repo.name, d), 'Importováno');
        close(); location.hash = gitHash(repo, g.name);
      };
    });
    $('#gh', v).onclick = () => modal(`<h2>Import z GitHubu</h2><form class="form" id="f">
        <label>Uživatel nebo organizace <input name="owner" placeholder="prázdné = moje repozitáře (token)"></label>
        <label>Druh <select name="kind"><option value="auto">automaticky</option><option value="org">organizace</option><option value="user">uživatel</option><option value="mine">moje (dle tokenu)</option></select></label>
        <label>GitHub token <input name="token" type="password" placeholder="nutný pro privátní repozitáře"></label>
        <label>Filtr názvů (glob) <input name="filter" placeholder="api-*"></label>
        <label>Max. počet <input name="limit" type="number" value="50"></label>
        <label>Prefix názvu (výchozí owner) <input name="prefix" placeholder="owner"></label>
        <label>Interval synchronizace (s) <input name="interval" type="number" value="3600"></label>
        <label class="check"><input type="checkbox" name="mirror" checked> jako zrcadla</label>
        <label class="check"><input type="checkbox" name="includeForks"> včetně forků</label>
        <label class="check"><input type="checkbox" name="includeArchived"> včetně archivovaných</label></form>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Importovat</button></div>`, (el, close) => {
      $('#ok', el).onclick = async () => {
        const d = formData($('#f', el));
        if (!d.owner && d.kind === 'auto') d.kind = 'mine';
        if (!d.prefix) delete d.prefix;
        toast('Importuji z GitHubu…');
        const r = await run(() => rr.githubImport(repo.name, d));
        close();
        modal(`<h2>Import dokončen</h2><p>Nalezeno ${r.found}, vybráno ${r.selected}.</p><div class="table-wrap"><table>${r.results.map((x) => `<tr><td><span class="badge ${x.status === 'created' ? 'ok' : x.status === 'error' ? 'off' : ''}">${esc(x.status)}</span></td><td>${esc(x.name)}</td><td class="small muted">${esc(x.error || '')}</td></tr>`).join('') || '<tr><td class="muted">nic</td></tr>'}</table></div>
          <div class="row"><span class="spacer"></span><button class="btn primary" data-close>Hotovo</button></div>`);
        route();
      };
    });
    return v;
  }

  // ---------------------------------------------------------------- git
  const gitBase = (repo) => `${serverBase()}${repo.gitDefault ? '/git' : `/r/${repo.name}`}`;
  const gitHash = (repo, name, params) => `#/git/${enc(repo.name)}/${name.split('/').map(enc).join('/')}${params ? `?${new URLSearchParams(params)}` : ''}`;

  const collabHash = (repo, name, kind, n, params) => `#/git/${enc(repo.name)}/${name.split('/').map(enc).join('/')}/${kind}${n ? `/${n}` : ''}${params ? `?${new URLSearchParams(params)}` : ''}`;
  const canWrite = () => me && me.role !== 'reader' && !me.readonly;
  const STATE_BADGE = (it) => (it.merged ? '<span class="badge blue">sloučeno</span>' : it.state === 'open' ? `<span class="badge ok">otevřeno</span>${it.draft ? ' <span class="badge plain">koncept</span>' : ''}` : '<span class="badge off">zavřeno</span>');
  const labelBadges = (it) => (it.labels || []).map((l) => `<span class="badge plain">${esc(l.name)}</span>`).join(' ');
  const MERGE_STATE = { clean: ['ok', 'Lze sloučit bez konfliktů'], dirty: ['off', 'Konflikty – nelze sloučit automaticky'], unknown: ['', 'Slučitelnost nelze určit'] };

  async function gitDetail(repo, name, sub) {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const tab = (sub && sub.tab) || q.get('tab') || 'files';
    const info = await rr.getGitRepo(repo.name, name);
    const ref = q.get('ref') || info.defaultBranch || 'HEAD';
    const path = q.get('path') || '';
    const link = (params) => gitHash(repo, name, { tab: ['pulls', 'issues'].includes(tab) ? 'files' : tab, ref, path, ...params });
    const tabs = [['files', 'Soubory'], ['commits', 'Commity'], ['branches', `Větve a tagy (${info.branches.length}/${info.tags.length})`], ['pulls', 'Pull requesty'], ['issues', 'Issues'], ['settings', 'Zrcadla a nastavení']];
    let body = '';
    let collab = null;
    if (tab === 'pulls' || tab === 'issues') {
      collab = await gitCollab(repo, name, info, tab, sub && sub.number, q);
      body = collab.html;
    } else if (info.empty && tab !== 'settings') {
      body = `<div class="card"><p class="muted">Prázdný repozitář. Pošlete první commit:</p><pre>git remote add rr ${esc(info.cloneUrl)}\ngit push rr main</pre></div>`;
    } else if (tab === 'files' || tab === 'file') {
      const parts = path.split('/').filter(Boolean);
      const crumbs = `<div class="crumbs"><a href="${link({ tab: 'files', path: '' })}">${icon('folder', 15)}${esc(name.split('/').pop())}</a>${parts.map((p, i) => ` / <a href="${link({ tab: 'files', path: parts.slice(0, i + 1).join('/') })}">${esc(p)}</a>`).join('')}</div>`;
      if (tab === 'file') {
        const bytes = await rr.gitBlob(repo.name, name, { ref, path });
        const text = bytes.length < 512 * 1024 && !bytes.slice(0, 8000).includes(0) ? new TextDecoder().decode(bytes) : null;
        body = `<div class="card">${crumbs}<div class="row" style="margin:8px 0"><span class="muted small">${fmtBytes(bytes.length)}</span><span class="spacer"></span><button class="btn small" id="dlf">${icon('download', 15)}Stáhnout</button></div>
          <pre>${text === null ? '(binární soubor)' : esc(text)}</pre></div>`;
      } else {
        const t = await rr.gitTree(repo.name, name, { ref, path });
        const readme = t.entries.find((e) => e.type === 'file' && /^readme(\.md|\.txt)?$/i.test(e.name));
        let readmeText = '';
        if (readme) readmeText = new TextDecoder().decode(await rr.gitBlob(repo.name, name, { ref, path: readme.path }));
        body = `<div class="card">${crumbs}<div class="table-wrap"><table>
          ${path ? `<tr class="click" data-up="1"><td>${icon('up', 14)} ..</td><td></td></tr>` : ''}
          ${t.entries.map((e) => `<tr class="click" data-e="${esc(e.path)}" data-t="${e.type}"><td><span class="cell-main">${tile(e.type === 'dir' ? 'git' : 'x', e.type === 'dir' ? 'folder' : e.type === 'submodule' ? 'link' : 'file')}${esc(e.name)}</span></td><td>${e.type === 'file' ? fmtBytes(e.size) : ''}</td></tr>`).join('')}
          </table></div></div>${readmeText ? `<div class="card"><h2>${esc(readme.name)}</h2><pre>${esc(readmeText)}</pre></div>` : ''}`;
      }
    } else if (tab === 'commits') {
      const commits = await rr.gitCommits(repo.name, name, { ref, limit: 100 });
      body = `<div class="card table-wrap"><table><tr><th>Commit</th><th>Zpráva</th><th>Autor</th><th>Datum</th></tr>
        ${commits.map((c) => `<tr><td><a href="${link({ ref: c.commit, tab: 'files', path: '' })}"><code>${esc(c.short)}</code></a></td><td>${esc(c.subject)}</td><td>${esc(c.author)}</td><td>${fmtDate(c.date)}</td></tr>`).join('')}</table></div>`;
    } else if (tab === 'branches') {
      const row = (b, kind) => `<tr><td><a href="${link({ ref: b.name, tab: 'files', path: '' })}"><b>${esc(b.name)}</b></a> ${b.name === info.defaultBranch ? '<span class="badge blue">výchozí</span>' : ''}${info.protectedBranches.includes(b.name) ? ` <span class="badge warn">${icon('lock', 12)}chráněná</span>` : ''}</td>
        <td><code>${esc(b.commit.slice(0, 8))}</code></td><td>${esc(b.subject)}</td><td>${fmtDate(b.date)}</td>
        <td class="actions"><button class="btn small" data-arch="${esc(b.name)}">${icon('download', 14)}tar.gz</button> <button class="btn small" data-zip="${esc(b.name)}">${icon('download', 14)}zip</button>${kind === 'branch' && b.name !== info.defaultBranch ? ` <button class="btn small" data-def="${esc(b.name)}">Výchozí</button>` : ''}</td></tr>`;
      body = `<div class="card table-wrap"><h2>Větve</h2><table>${info.branches.map((b) => row(b, 'branch')).join('')}</table></div>
        <div class="card table-wrap"><h2>Tagy</h2><table>${info.tags.map((b) => row(b, 'tag')).join('') || '<tr><td class="muted">žádné tagy</td></tr>'}</table></div>`;
    } else {
      const m = info.mirror;
      body = `<div class="card"><h2>Nastavení</h2><form class="form" id="fs">
          <label style="grid-column:1/-1">Popis <input name="description" value="${esc(info.description)}"></label>
          <label>Výchozí větev <select name="defaultBranch">${info.branches.map((b) => `<option${b.name === info.defaultBranch ? ' selected' : ''}>${esc(b.name)}</option>`).join('') || `<option>${esc(info.defaultBranch || 'main')}</option>`}</select></label>
          <label>Chráněné větve (zákaz force-push a smazání) <input name="protectedBranches" value="${esc(info.protectedBranches.join(','))}" placeholder="main,release/*"></label></form>
          <div class="row" style="margin-top:8px"><button class="btn primary" id="saveS">Uložit</button><span class="spacer"></span><button class="btn danger" id="delG">Smazat repozitář</button></div></div>
        <div class="card"><h2>⇣ Pull zrcadlo (zdroj)</h2>
          ${m ? `<p>Stav <span class="badge ${m.status === 'ok' ? 'ok' : m.status === 'error' ? 'off' : ''}">${esc(m.status)}</span> · poslední synchronizace ${fmtDate(m.lastSync) || '–'}${m.lastError ? ` · <span class="error">${esc(m.lastError)}</span>` : ''}</p>
            <p class="small">Webhook pro okamžitou synchronizaci (GitHub → Settings → Webhooks, content type JSON): <code>${esc(m.webhookUrl)}</code>, secret <code>${esc(m.webhookSecret)}</code></p>` : '<p class="muted">Repozitář není zrcadlem. Nastavením URL se z něj stane zrcadlo jen pro čtení.</p>'}
          <form class="form" id="fm">
            <label style="grid-column:1/-1">URL zdroje <input name="url" value="${esc(m ? m.url : '')}" placeholder="https://github.com/owner/repo.git"></label>
            <label>Token <input name="token" type="password" placeholder="${m && m.auth && m.auth.token ? '*** (beze změny)' : ''}"></label>
            <label>Interval synchronizace (s, 0 = jen ručně) <input name="interval" type="number" value="${m ? m.interval : 3600}"></label>
            <label>Obnovit při přístupu po (s) <input name="ttl" type="number" value="${m ? m.ttl : 300}"></label>
            <label class="check"><input type="checkbox" name="enabled" ${!m || m.enabled ? 'checked' : ''}> zapnuto</label></form>
          <div class="row" style="margin-top:8px"><button class="btn" id="saveM">Uložit zrcadlo</button>${m ? '<button class="btn" id="pull">⇣ Synchronizovat teď</button><button class="btn danger" id="offM">Zrušit zrcadlo</button>' : ''}</div></div>
        <div class="card"><h2>⇡ Push zrcadla (cíle)</h2><p class="muted small">Po každém push do registru se repozitář odešle na tyto servery (GitHub, GitLab, Gitea…).</p>
          <div class="table-wrap"><table><tr><th>URL</th><th>Režim</th><th>Stav</th><th>Poslední push</th><th></th></tr>
          ${info.pushMirrors.map((p) => `<tr><td><code>${esc(p.url)}</code></td><td>${esc(p.mode)}${p.createMissing ? ' · vytváří' : ''}</td><td><span class="badge ${p.status === 'ok' ? 'ok' : p.status === 'error' ? 'off' : ''}">${esc(p.status)}</span> <span class="small error">${esc(p.lastError || '')}</span></td><td>${fmtDate(p.lastPush)}</td>
            <td class="actions"><button class="btn small danger" data-rmpm="${esc(p.id)}">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">žádná push zrcadla</td></tr>'}</table></div>
          <form class="form" id="fp" style="margin-top:10px">
            <label style="grid-column:1/-1">Cílová URL <input name="url" placeholder="https://github.com/firma/projekt.git"></label>
            <label>Token <input name="token" type="password"></label><label>Uživatel (výchozí x-access-token) <input name="username"></label>
            <label>Režim <select name="mode"><option value="mirror">mirror (vše včetně mazání)</option><option value="branches">jen větve a tagy</option></select></label>
            <label class="check"><input type="checkbox" name="createMissing"> GitHub: vytvořit, pokud neexistuje</label>
            <label class="check"><input type="checkbox" name="private" checked> jako privátní</label></form>
          <div class="row" style="margin-top:8px"><button class="btn" id="addPm">+ Přidat push zrcadlo</button>${info.pushMirrors.length ? '<button class="btn" id="push">⇡ Odeslat teď</button>' : ''}</div></div>`;
    }
    const v = setView(name, `
      <div class="row"><a href="#/git/${enc(repo.name)}">← git repozitáře</a></div>
      <div class="card"><div class="row"><h2 style="margin:0">${esc(name)}</h2>${info.mirror ? '<span class="badge blue">zrcadlo</span>' : ''}<span class="spacer"></span>
        <select id="ref">${[...info.branches.map((b) => b.name), ...info.tags.map((t) => t.name)].map((x) => `<option${x === ref ? ' selected' : ''}>${esc(x)}</option>`).join('')}${[...info.branches, ...info.tags].some((x) => x.name === ref) ? '' : `<option selected>${esc(ref)}</option>`}</select></div>
        <p class="muted">${esc(info.description)}</p>
        <div class="row"><code style="flex:1;min-width:0;overflow:auto">git clone ${esc(info.cloneUrl)}</code><button class="btn small" id="copy">Kopírovat</button>
          <button class="btn small" id="tgz">${icon('download', 14)}tar.gz</button><button class="btn small" id="zip">${icon('download', 14)}zip</button><span class="muted small">${fmtBytes(info.size)}</span></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${(tab === k || (tab === 'file' && k === 'files')) ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${body}`, 'git');
    const archive = async (r, format) => download(await run(() => rr.gitArchive(repo.name, name, { ref: r, format })), `${name.split('/').pop()}-${r}.${format}`);
    $$('[data-tab]', v).forEach((b) => { b.onclick = () => { location.hash = ['pulls', 'issues'].includes(b.dataset.tab) ? collabHash(repo, name, b.dataset.tab) : link({ tab: b.dataset.tab }); }; });
    if (collab) collab.mount(v);
    $('#ref', v).onchange = (e) => { location.hash = link({ ref: e.target.value, path: tab === 'file' ? '' : path, tab: tab === 'file' ? 'files' : tab }); };
    $('#copy', v).onclick = () => { navigator.clipboard && navigator.clipboard.writeText(`git clone ${info.cloneUrl}`); toast('Zkopírováno'); };
    $('#tgz', v).onclick = () => archive(ref, 'tar.gz');
    $('#zip', v).onclick = () => archive(ref, 'zip');
    $$('tr[data-e]', v).forEach((tr) => { tr.onclick = () => { location.hash = link({ tab: tr.dataset.t === 'dir' ? 'files' : 'file', path: tr.dataset.e }); }; });
    const up = $('tr[data-up]', v);
    if (up) up.onclick = () => { location.hash = link({ tab: 'files', path: path.split('/').slice(0, -1).join('/') }); };
    const dlf = $('#dlf', v);
    if (dlf) dlf.onclick = async () => download(await run(() => rr.gitBlob(repo.name, name, { ref, path })), path.split('/').pop());
    $$('[data-arch]', v).forEach((b) => { b.onclick = () => archive(b.dataset.arch, 'tar.gz'); });
    $$('[data-zip]', v).forEach((b) => { b.onclick = () => archive(b.dataset.zip, 'zip'); });
    $$('[data-def]', v).forEach((b) => { b.onclick = async () => { await run(() => rr.updateGitRepo(repo.name, name, { defaultBranch: b.dataset.def }), 'Výchozí větev změněna'); route(); }; });
    const on = (id, fn) => { const el = $(id, v); if (el) el.onclick = fn; };
    on('#saveS', async () => { await run(() => rr.updateGitRepo(repo.name, name, formData($('#fs', v))), 'Uloženo'); route(); });
    on('#delG', async () => { if (await confirmBox(`Smazat git repozitář ${name}?`)) { await run(() => rr.deleteGitRepo(repo.name, name), 'Smazáno'); location.hash = `#/git/${enc(repo.name)}`; } });
    on('#saveM', async () => {
      const d = formData($('#fm', v));
      if (!d.url) return toast('Zadejte URL zdroje', true);
      if (!d.token) delete d.token;
      await run(() => rr.updateGitRepo(repo.name, name, { mirror: d }), 'Zrcadlo uloženo');
      route();
    });
    on('#offM', async () => { if (await confirmBox('Zrušit zrcadlení? Repozitář zůstane jako běžný.')) { await run(() => rr.updateGitRepo(repo.name, name, { mirror: null }), 'Zrcadlo zrušeno'); route(); } });
    on('#pull', async () => { toast('Synchronizuji…'); const r = await run(() => rr.gitSync(repo.name, name, { direction: 'pull' })); toast(r.pull && r.pull.ok ? `Hotovo, změn: ${r.pull.changes.length}` : `Chyba: ${r.pull ? r.pull.error : ''}`, !(r.pull && r.pull.ok)); route(); });
    on('#push', async () => { toast('Odesílám…'); const r = await run(() => rr.gitSync(repo.name, name, { direction: 'push' })); toast(r.push.every((x) => x.ok) ? 'Odesláno' : r.push.map((x) => x.error).filter(Boolean).join('; '), !r.push.every((x) => x.ok)); route(); });
    on('#addPm', async () => {
      const d = formData($('#fp', v));
      if (!d.url) return toast('Zadejte cílovou URL', true);
      await run(() => rr.addGitPushMirror(repo.name, name, d), 'Push zrcadlo přidáno');
      route();
    });
    $$('[data-rmpm]', v).forEach((b) => { b.onclick = async () => { await run(() => rr.deleteGitPushMirror(repo.name, name, b.dataset.rmpm), 'Odebráno'); route(); }; });
  }

  // ---------------------------------------------------------------- git: pull requests & issues
  /** Body of the "Pull requesty" / "Issues" tab: list (state filter), detail with comments, create forms. */
  async function gitCollab(repo, name, info, kind, number, q) {
    const isPull = kind === 'pulls';
    const back = (params) => collabHash(repo, name, kind, null, params);
    const comments = (list) => `<div class="card"><h2>${icon('menu', 17)}Komentáře (${list.length})</h2>
      <ul class="feed">${list.map((c) => `<li>${tile('git', 'users')}<div class="tx"><b>${esc(c.user.login)}</b> <span class="when">${when(c.created_at)}</span><div style="white-space:pre-wrap">${esc(c.body)}</div></div></li>`).join('') || '<li class="muted">Zatím žádné komentáře.</li>'}</ul>
      ${canWrite() ? `<form class="form" id="cf" style="margin-top:10px"><label style="grid-column:1/-1">Nový komentář <textarea name="body" required></textarea></label></form>
      <div class="row" style="margin-top:8px"><button class="btn primary" id="addC">${icon('plus', 15)}Přidat komentář</button></div>` : ''}</div>`;
    const mountComments = (v) => {
      const b = $('#addC', v);
      if (!b) return;
      b.onclick = async () => {
        const d = formData($('#cf', v));
        if (!d.body.trim()) return toast('Napište text komentáře', true);
        await run(() => rr.createGitIssueComment(repo.name, name, number, { body: d.body }), 'Komentář přidán');
        route();
      };
    };
    const editModal = (it, onSave) => modal(`<h2>Upravit #${it.number}</h2><form class="form" id="f">
        <label style="grid-column:1/-1">Název <input name="title" required value="${esc(it.title)}"></label>
        ${isPull ? '' : `<label style="grid-column:1/-1">Štítky (čárkou) <input name="labels" value="${esc((it.labels || []).map((l) => l.name).join(','))}"></label>`}
        <label style="grid-column:1/-1">Popis <textarea name="body">${esc(it.body || '')}</textarea></label></form>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Uložit</button></div>`, (el, close) => {
      $('#ok', el).onclick = async () => {
        const d = formData($('#f', el));
        if (!isPull) d.labels = d.labels.split(',').map((x) => x.trim()).filter(Boolean);
        await run(() => onSave(d), 'Uloženo');
        close(); route();
      };
    });

    // ---- detail
    if (number) {
      const it = isPull ? await rr.getGitPull(repo.name, name, number) : await rr.getGitIssue(repo.name, name, number);
      const list = await rr.listGitIssueComments(repo.name, name, number);
      if (!isPull && it.pull_request) { location.hash = collabHash(repo, name, 'pulls', number); return { html: '', mount: () => {} }; }
      const ms = MERGE_STATE[it.mergeable_state] || MERGE_STATE.unknown;
      let merge = '';
      if (isPull && it.merged) {
        merge = `<p>${icon('check', 15)} Sloučeno ${when(it.merged_at)}${it.merged_by ? ` uživatelem <b>${esc(it.merged_by.login)}</b>` : ''} jako <a href="${gitHash(repo, name, { tab: 'files', ref: it.merge_commit_sha, path: '' })}"><code>${esc(String(it.merge_commit_sha).slice(0, 10))}</code></a></p>`;
      } else if (isPull) {
        merge = `<p><span class="badge ${ms[0]}">${esc(it.mergeable_state)}</span> ${esc(ms[1])}${it.conflicts && it.conflicts.length ? `: <code>${it.conflicts.map(esc).join(', ')}</code>` : ''}</p>
          ${it.state === 'open' && canWrite() ? `<form class="form" id="mf"><label>Způsob sloučení <select name="merge_method"><option value="merge">merge commit</option><option value="squash">squash (jeden commit)</option><option value="rebase">rebase (přehrát commity)</option></select></label>
            <label>Titulek commitu (nepovinné) <input name="commit_title" placeholder="${esc(it.title)}"></label></form>
            <div class="row" style="margin-top:8px"><button class="btn primary" id="merge"${it.mergeable === false ? ' disabled' : ''}>${icon('git', 15)}Sloučit do ${esc(it.base.ref)}</button></div>` : ''}`;
      }
      const html = `<div class="row"><a href="${back()}">← ${isPull ? 'pull requesty' : 'issues'}</a></div>
        <div class="card"><div class="row"><h2 style="margin:0">${esc(it.title)} <span class="muted">#${it.number}</span></h2>${STATE_BADGE(it)} ${labelBadges(it)}<span class="spacer"></span>
          ${canWrite() ? `<button class="btn small" id="edit">${icon('edit', 15)}Upravit</button>${it.merged ? '' : `<button class="btn small${it.state === 'open' ? ' danger' : ''}" id="toggle">${it.state === 'open' ? 'Zavřít' : 'Znovu otevřít'}</button>`}` : ''}</div>
          <p class="muted small"><b>${esc(it.user.login)}</b> otevřel(a) ${when(it.created_at)}${isPull ? ` · <code>${esc(it.head.ref)}</code> → <code>${esc(it.base.ref)}</code> · <code>${esc(it.head.sha.slice(0, 8))}</code>` : ''}${it.closed_at ? ` · zavřeno ${when(it.closed_at)}` : ''}</p>
          <pre style="white-space:pre-wrap">${esc(it.body || '(bez popisu)')}</pre>
          ${isPull ? `<div class="row"><a class="btn small" href="${gitHash(repo, name, { tab: 'commits', ref: it.head.sha })}">${icon('activity', 14)}Commity větve</a></div>` : ''}</div>
        ${isPull ? `<div class="card"><h2>${icon('git', 17)}Sloučení</h2>${merge}</div>` : ''}
        ${comments(list)}`;
      return {
        html,
        mount: (v) => {
          mountComments(v);
          const on = (id, fn) => { const el = $(id, v); if (el) el.onclick = fn; };
          on('#edit', () => editModal(it, (d) => (isPull ? rr.updateGitPull(repo.name, name, number, d) : rr.updateGitIssue(repo.name, name, number, d))));
          on('#toggle', async () => {
            const state = it.state === 'open' ? 'closed' : 'open';
            await run(() => (isPull ? rr.updateGitPull(repo.name, name, number, { state }) : rr.updateGitIssue(repo.name, name, number, { state })), state === 'closed' ? 'Zavřeno' : 'Znovu otevřeno');
            route();
          });
          on('#merge', async () => {
            const d = formData($('#mf', v));
            if (!d.commit_title) delete d.commit_title;
            if (!(await confirmBox(`Sloučit #${it.number} (${d.merge_method}) do ${it.base.ref}?`))) return;
            const r = await run(() => rr.mergeGitPull(repo.name, name, number, d));
            toast(`${r.message} (${r.sha.slice(0, 10)})`);
            route();
          });
        },
      };
    }

    // ---- list
    const state = ['open', 'closed', 'all'].includes(q.get('state')) ? q.get('state') : 'open';
    const labels = q.get('labels') || '';
    const rows = isPull ? await rr.listGitPulls(repo.name, name, { state }) : await rr.listGitIssues(repo.name, name, { state, labels });
    const stateSel = `<label class="dt-select">${icon('filter', 16)}<span class="sr">Stav</span><select id="cState">${[['open', 'otevřené'], ['closed', 'zavřené'], ['all', 'všechny']].map(([k, l]) => `<option value="${k}"${k === state ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
    const html = `<div class="card">
        <div class="row">${stateSel}${isPull ? '' : `<label class="dt-select">${icon('tag', 16)}<input id="cLabels" placeholder="štítky (a,b)" value="${esc(labels)}"></label>`}<span class="spacer"></span>
          ${canWrite() ? `<button class="btn small primary" id="cNew">${icon('plus', 15)}${isPull ? 'Nový pull request' : 'Nové issue'}</button>` : ''}</div>
        <div class="table-wrap"><table><tr><th>#</th><th>Název</th>${isPull ? '<th>Větve</th>' : '<th>Štítky</th>'}<th>Stav</th><th>Autor</th><th>Komentáře</th><th>Změněno</th></tr>
        ${rows.map((it) => `<tr class="click" data-n="${it.number}"><td class="mono">#${it.number}</td><td><b>${esc(it.title)}</b></td>
          <td>${isPull ? `<code>${esc(it.head.ref)}</code> → <code>${esc(it.base.ref)}</code>` : labelBadges(it)}</td><td>${STATE_BADGE(it)}</td><td>${esc(it.user.login)}</td><td>${it.comments}</td><td>${when(it.updated_at)}</td></tr>`).join('')
          || `<tr><td colspan="7" class="muted">${isPull ? 'Žádné pull requesty.' : 'Žádné issues.'}</td></tr>`}</table></div></div>`;
    return {
      html,
      mount: (v) => {
        $$('tr[data-n]', v).forEach((tr) => { tr.onclick = () => { location.hash = collabHash(repo, name, kind, tr.dataset.n); }; });
        $('#cState', v).onchange = (e) => { location.hash = back({ state: e.target.value, ...(labels ? { labels } : {}) }); };
        const lab = $('#cLabels', v);
        if (lab) lab.onchange = (e) => { location.hash = back({ state, ...(e.target.value.trim() ? { labels: e.target.value.trim() } : {}) }); };
        const nb = $('#cNew', v);
        if (!nb) return;
        const branches = info.branches.map((b) => b.name);
        const opts = (sel) => branches.map((b) => `<option${b === sel ? ' selected' : ''}>${esc(b)}</option>`).join('');
        nb.onclick = () => {
          if (isPull && branches.length < 2) return toast('Pull request potřebuje alespoň dvě větve – pošlete větev přes git push.', true);
          modal(isPull ? `<h2>Nový pull request</h2><form class="form" id="f">
              <label>Sloučit větev (head) <select name="head">${opts(branches.find((b) => b !== info.defaultBranch))}</select></label>
              <label>do větve (base) <select name="base">${opts(info.defaultBranch)}</select></label>
              <label style="grid-column:1/-1">Název <input name="title" required></label>
              <label style="grid-column:1/-1">Popis <textarea name="body"></textarea></label>
              <label class="check"><input type="checkbox" name="draft"> koncept (draft)</label></form>
            <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`
            : `<h2>Nové issue</h2><form class="form" id="f">
              <label style="grid-column:1/-1">Název <input name="title" required></label>
              <label style="grid-column:1/-1">Štítky (čárkou) <input name="labels" placeholder="bug,ui"></label>
              <label style="grid-column:1/-1">Popis <textarea name="body"></textarea></label></form>
            <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
            $('#ok', el).onclick = async () => {
              const d = formData($('#f', el));
              if (!d.title.trim()) return toast('Zadejte název', true);
              if (!isPull) d.labels = d.labels.split(',').map((x) => x.trim()).filter(Boolean);
              const it = await run(() => (isPull ? rr.createGitPull(repo.name, name, d) : rr.createGitIssue(repo.name, name, d)), 'Vytvořeno');
              close();
              location.hash = collabHash(repo, name, kind, it.number);
            };
          });
        };
      },
    };
  }

  // ---------------------------------------------------------------- webhooks & events
  views.webhooks = async () => {
    const [hooks, ev, dels] = await Promise.all([rr.listWebhooks(), rr.listEvents({ limit: 200 }), rr.listWebhookDeliveries({ limit: 200 })]);
    const v = setView('Webhooky a události', `
      <div class="card"><p class="muted" style="margin:0">Webhooky posílají události registru (publikace, push, upload, mazání, synchronizace zrcadel, selhání replikace…) na zadané URL.
        Tělo je podepsané hlavičkou <code>X-RR-Signature-256: sha256=HMAC(secret, body)</code>; formáty JSON, Slack/Mattermost a Discord.</p></div>
      <div id="th"></div>
      <div class="tabs" id="evTabs"><button type="button" data-t="del" class="active">Doručení (${dels.length})</button><button type="button" data-t="ev">Události (${ev.events.length})</button></div>
      <div id="tl"></div>`, 'bell');
    table('#th', {
      id: 'webhooks', rows: hooks, rowKey: (h) => h.id, placeholder: 'Hledat webhook…', sort: { key: 'name', dir: 1 },
      toolbar: `<button type="button" class="btn small primary" id="new">${icon('plus', 15)}Nový webhook</button>`,
      empty: 'Žádné webhooky.',
      columns: [
        { key: 'enabled', label: 'Zap.', value: (h) => (h.enabled ? 1 : 0), render: (h) => `<input type="checkbox" data-toggle="${esc(h.id)}" aria-label="Zapnuto"${h.enabled ? ' checked' : ''}>` },
        { key: 'name', label: 'Název', render: (h) => cellMain('docker', h.name, h.url, 'bell') },
        { key: 'events', label: 'Události', value: (h) => h.events.join(','), render: (h) => h.events.map((e) => `<span class="badge plain">${esc(e)}</span>`).join(' ') },
        { key: 'repos', label: 'Repozitáře', toggle: true, value: (h) => h.repos.join(', ') },
        { key: 'format', label: 'Formát', toggle: true },
        { key: 'last', label: 'Poslední doručení', value: (h) => (h.lastDelivery ? h.lastDelivery.time : ''), render: (h) => (h.lastDelivery ? `<span class="badge ${h.lastDelivery.ok ? 'ok' : 'off'}">${h.lastDelivery.status}</span> ${when(h.lastDelivery.time)}` : '–') },
        { key: 'act', label: '', sort: false, align: 'right', render: (h) => `${iconBtn(`data-test="${esc(h.id)}"`, 'play', 'Odeslat test')}${iconBtn(`data-edit="${esc(h.id)}"`, 'edit', 'Upravit')}${iconBtn(`data-del="${esc(h.id)}"`, 'trash', 'Smazat', 'danger')}` },
      ],
      onRender: (el) => {
        const n = $('#new', el);
        if (n) n.onclick = () => hookForm(null, ev.types);
        $$('[data-edit]', el).forEach((b) => { b.onclick = () => hookForm(hooks.find((h) => h.id === b.dataset.edit), ev.types); });
        $$('[data-del]', el).forEach((b) => { b.onclick = async () => { if (await confirmBox('Smazat webhook?')) { await run(() => rr.deleteWebhook(b.dataset.del), 'Smazáno'); route(); } }; });
        $$('[data-toggle]', el).forEach((c) => { c.onchange = () => run(() => rr.updateWebhook(c.dataset.toggle, { enabled: c.checked }), c.checked ? 'Zapnuto' : 'Vypnuto'); });
        $$('[data-test]', el).forEach((b) => { b.onclick = async () => { const r = await run(() => rr.testWebhook(b.dataset.test)); toast(r.ok ? `OK (HTTP ${r.status}, ${r.ms} ms)` : `Chyba: ${r.error || `HTTP ${r.status}`}`, !r.ok); }; });
      },
    });
    const showTab = (t) => {
      $$('#evTabs button', v).forEach((b) => b.classList.toggle('active', b.dataset.t === t));
      if (t === 'del') {
        table('#tl', {
          id: 'deliveries', rows: dels, rowKey: (d) => d.id, placeholder: 'Hledat v doručeních…', sort: { key: 'time', dir: -1 }, group: '',
          groups: [{ key: 'hook', label: 'webhook', value: (d) => d.hook }, { key: 'ok', label: 'výsledek', value: (d) => (d.ok ? 'úspěch' : 'chyba') }, { key: 'event', label: 'událost', value: (d) => d.event }],
          empty: 'Zatím nic nedoručeno.',
          columns: [
            { key: 'time', label: 'Čas', render: (d) => when(d.time) },
            { key: 'hook', label: 'Webhook' },
            { key: 'event', label: 'Událost', render: (d) => `<span class="badge blue">${esc(d.event)}</span>` },
            { key: 'status', label: 'Stav', render: (d) => `<span class="badge ${d.ok ? 'ok' : 'off'}">${d.status}</span>` },
            { key: 'attempt', label: 'Pokus', align: 'right' },
            { key: 'ms', label: 'ms', align: 'right', render: (d) => `<span class="mono">${d.ms}</span>` },
            { key: 'error', label: 'Chyba / odpověď', toggle: true, value: (d) => d.error || d.response || '', render: (d) => `<span class="small">${esc(d.error || d.response || '')}</span>` },
          ],
        });
      } else {
        table('#tl', {
          id: 'events', rows: ev.events, rowKey: (e) => e.id, placeholder: 'Hledat v událostech…', sort: { key: 'time', dir: -1 },
          groups: [{ key: 'type', label: 'typ', value: (e) => e.type }, { key: 'repo', label: 'repozitář', value: (e) => e.repo || '–' }, { key: 'user', label: 'uživatel', value: (e) => e.user }],
          search: (e) => `${e.type} ${e.repo} ${e.user} ${JSON.stringify(e.data)}`,
          empty: 'Zatím žádné události.',
          columns: [
            { key: 'time', label: 'Čas', render: (e) => when(e.time) },
            { key: 'type', label: 'Událost', render: (e) => `<span class="badge blue">${esc(e.type)}</span>` },
            { key: 'repo', label: 'Repozitář', value: (e) => e.repo || '' },
            { key: 'user', label: 'Uživatel' },
            { key: 'data', label: 'Detail', sort: false, render: (e) => `<code class="small">${esc(JSON.stringify(e.data).slice(0, 140))}</code>` },
          ],
        });
      }
    };
    $$('#evTabs button', v).forEach((b) => { b.onclick = () => showTab(b.dataset.t); });
    showTab('del');
    return v;
  };

  // ---------------------------------------------------------------- tasks & replication
  views.jobs = async () => {
    const [tasks, jobs] = await Promise.all([rr.listTasks(), rr.listReplications({ limit: 300 })]);
    const v = setView('Úlohy a replikace', '<div id="tt"></div><div class="card" style="padding:12px 18px"><h2 style="margin:0">' + icon('route', 17) + 'Replikace (směrovací pravidla „push“)</h2></div><div id="tr"></div>', 'clock');
    table('#tt', {
      id: 'tasks', rows: tasks, rowKey: (t) => t.id, placeholder: 'Hledat úlohu…', sort: { key: 'nextRun', dir: 1 },
      columns: [
        { key: 'name', label: 'Úloha', render: (t) => cellMain(t.lastError ? 'x' : 'git', t.name, t.description, t.lastError ? 'alert' : 'clock') },
        { key: 'intervalSec', label: 'Interval', align: 'right', render: (t) => `<span class="mono">${t.intervalSec >= 3600 ? `${t.intervalSec / 3600} h` : `${t.intervalSec} s`}</span>` },
        { key: 'lastRun', label: 'Poslední běh', render: (t) => when(t.lastRun) },
        { key: 'nextRun', label: 'Další běh', render: (t) => when(t.nextRun) },
        { key: 'result', label: 'Výsledek', sort: false, toggle: true, render: (t) => (t.running ? '<span class="badge blue">běží</span>' : t.lastError ? `<span class="error small">${esc(t.lastError)}</span>` : t.lastResult ? `<code class="small">${esc(JSON.stringify(t.lastResult).slice(0, 100))}</code>` : '–') },
        { key: 'act', label: '', sort: false, align: 'right', render: (t) => `<button type="button" class="btn small" data-run="${esc(t.id)}">${icon('play', 14)}Spustit</button>` },
      ],
      onRender: (el) => { $$('[data-run]', el).forEach((b) => { b.onclick = async () => { await run(() => rr.runTask(b.dataset.run), 'Úloha dokončena'); route(); }; }); },
    });
    table('#tr', {
      id: 'replications', rows: jobs, rowKey: (j) => j.id, placeholder: 'Hledat replikaci…', sort: { key: 'created', dir: -1 }, group: 'status',
      groups: [{ key: 'status', label: 'stav', value: (j) => j.status }, { key: 'rule', label: 'pravidlo', value: (j) => j.ruleName }, { key: 'repo', label: 'repozitář', value: (j) => j.repo }],
      empty: 'Zatím žádné replikace – vytvořte směrovací pravidlo s „push“.',
      columns: [
        { key: 'created', label: 'Vytvořeno', render: (j) => when(j.created) },
        { key: 'status', label: 'Stav', render: (j) => `<span class="badge ${j.status === 'ok' ? 'ok' : j.status === 'error' ? 'off' : j.status === 'skipped' ? 'plain' : 'blue'}">${esc(j.status)}</span>` },
        { key: 'ruleName', label: 'Pravidlo' },
        { key: 'event', label: 'Událost', toggle: true },
        { key: 'item', label: 'Položka', value: (j) => `${j.repo}/${j.item}`, render: (j) => `<code>${esc(j.repo)}/${esc(j.item)}</code>` },
        { key: 'target', label: 'Cíl', toggle: true, render: (j) => `<code class="small">${esc(j.target)}</code>` },
        { key: 'attempts', label: 'Pokusy', align: 'right' },
        { key: 'error', label: 'Chyba', toggle: true, value: (j) => j.error || '', render: (j) => `<span class="error small">${esc(j.error || '')}</span>` },
        { key: 'act', label: '', sort: false, align: 'right', render: (j) => (j.status === 'error' || j.status === 'ok' ? iconBtn(`data-retry="${esc(j.id)}"`, 'refresh', 'Spustit znovu') : '') },
      ],
      actions: [{ label: 'Spustit znovu', icon: 'refresh', run: async (sel) => { for (const j of sel) await run(() => rr.retryReplication(j.id)); toast(`Zařazeno: ${sel.length}`); setTimeout(route, 800); } }],
      onRender: (el) => { $$('[data-retry]', el).forEach((b) => { b.onclick = async () => { await run(() => rr.retryReplication(b.dataset.retry), 'Zařazeno'); setTimeout(route, 800); }; }); },
    });
    return v;
  };

  // ---------------------------------------------------------------- routing rules
  views.routes = async () => {
    const [rules, repos] = await Promise.all([rr.listRoutes(), rr.listRepos()]);
    const v = setView('Směrování', `
      <div class="card"><p class="muted" style="margin:0">Routing plugin přesměrovává požadavky na jiné registry dle masky URL / části URL / klíče
        (<code>/~klic/…</code>, hlavička <code>X-RR-Key</code> nebo <code>?rr_key=</code>), hlavičky nebo pokud položka lokálně neexistuje.
        Pravidla <b>push</b> replikují publikace na vzdálené servery, u gitu „vždy/nenalezeno“ automaticky klonuje.</p></div>
      <div id="t"></div>
      <div class="card"><h2>${icon('play', 17)}Test směrování</h2>
        <div class="form">
          <label>Cesta <input id="tPath" value="/@firma/utils" placeholder="/lodash nebo /@scope/name"></label>
          <label>Repozitář <select id="tRepo">${repos.map((r) => `<option${r.default ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
          <label>Klíč <input id="tKey"></label>
          <label>Metoda <select id="tMethod"><option>GET</option><option>HEAD</option><option>POST</option><option>PUT</option></select></label>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="test">${icon('play', 15)}Otestovat</button></div>
        <div id="tOut"></div>
      </div>`, 'route');
    table('#t', {
      id: 'routes', rows: rules, rowKey: (r) => r.id, placeholder: 'Hledat pravidlo, cíl, masku…', sort: { key: 'priority', dir: 1 },
      groups: [{ key: 'when', label: 'fáze', value: (r) => r.when }, { key: 'repo', label: 'repozitář', value: (r) => r.repo }, { key: 'host', label: 'cílový server', value: (r) => { try { return new URL(r.target).host; } catch { return r.target; } } }],
      toolbar: `<button type="button" class="btn small primary" id="newRule">${icon('plus', 15)}Nové pravidlo</button>`,
      empty: 'Žádná pravidla.',
      columns: [
        { key: 'enabled', label: 'Zap.', value: (r) => (r.enabled ? 1 : 0), render: (r) => `<input type="checkbox" data-toggle="${esc(r.id)}" aria-label="Zapnuto"${r.enabled ? ' checked' : ''}>` },
        { key: 'priority', label: 'Prio', align: 'right', render: (r) => `<span class="mono">${r.priority}</span>` },
        { key: 'name', label: 'Pravidlo', render: (r) => cellMain(r.when === 'push' ? 'git' : r.when === 'always' ? 'docker' : 'npm', r.name, r.description, r.when === 'push' ? 'upload' : 'route') },
        { key: 'when', label: 'Kdy', render: (r) => `<span class="badge ${r.when === 'always' ? 'blue' : r.when === 'push' ? 'ok' : 'plain'}">${r.when === 'always' ? 'vždy' : r.when === 'push' ? 'push' : 'nenalezeno'}</span>` },
        { key: 'pattern', label: 'Maska', value: (r) => `${r.matchOn}/${r.matchType}: ${r.pattern || '*'}`, render: (r) => `<code>${esc(r.matchType)}: ${esc(r.pattern || '*')}</code>${r.header ? `<div class="small muted">hlavička ${esc(r.header.name)}</div>` : ''}` },
        { key: 'repo', label: 'Repo', toggle: true, value: (r) => `${r.repo}${r.repoType !== '*' ? ` (${r.repoType})` : ''}` },
        { key: 'key', label: 'Klíč', toggle: true, value: (r) => r.key || '–' },
        { key: 'target', label: 'Cíl', render: (r) => `<code class="small">${esc(r.target)}</code>` },
        { key: 'cacheTtl', label: 'Cache', toggle: true, align: 'right', value: (r) => (r.cacheTtl == null ? -1 : r.cacheTtl), render: (r) => (r.cacheTtl == null ? '<span class="muted">výchozí</span>' : `<span class="mono">${r.cacheTtl} s</span>`) },
        { key: 'act', label: '', sort: false, align: 'right', render: (r) => `${iconBtn(`data-edit="${esc(r.id)}"`, 'edit', 'Upravit')}${iconBtn(`data-del="${esc(r.id)}"`, 'trash', 'Smazat', 'danger')}` },
      ],
      onRow: (r) => ruleForm(r, repos),
      onRender: (el) => {
        $('#newRule', el).onclick = () => ruleForm(null, repos);
        $$('[data-edit]', el).forEach((b) => { b.onclick = () => ruleForm(rules.find((r) => r.id === b.dataset.edit), repos); });
        $$('[data-del]', el).forEach((b) => { b.onclick = async () => { if (await confirmBox('Smazat pravidlo?')) { await run(() => rr.deleteRoute(b.dataset.del), 'Smazáno'); route(); } }; });
        $$('[data-toggle]', el).forEach((c) => { c.onchange = () => run(() => rr.updateRoute(c.dataset.toggle, { enabled: c.checked }), c.checked ? 'Zapnuto' : 'Vypnuto'); });
      },
    });
    $('#test', v).onclick = async () => {
      const r = await run(() => rr.testRoute({ path: $('#tPath', v).value, repo: $('#tRepo', v).value, key: $('#tKey', v).value, method: $('#tMethod', v).value }));
      $('#tOut', v).innerHTML = `<p>Balíček: <code>${esc(r.request.packagePath || '–')}</code> · vždy: <b>${esc(r.always ? r.always.name : '–')}</b> · při nenalezení: <b>${esc(r.notfound ? r.notfound.name : '–')}</b></p><div id="tOutT"></div>`;
      table('#tOutT', {
        id: 'routetest', rows: r.rules, rowKey: (x) => x.id, placeholder: 'Filtrovat…', sort: { key: 'priority', dir: 1 },
        columns: [
          { key: 'matched', label: 'Shoda', value: (x) => (x.matched ? 0 : 1), render: (x) => (x.matched ? `<span class="badge ok">ano</span>` : `<span class="badge off">ne</span>`) },
          { key: 'priority', label: 'Prio', align: 'right' },
          { key: 'name', label: 'Pravidlo' },
          { key: 'when', label: 'Kdy' },
          { key: 'target', label: 'Cílová URL', render: (x) => `<code class="small">${esc(x.target)}</code>` },
        ],
      });
    };
    return v;
  };

  // ---------------------------------------------------------------- cache
  views.cache = async () => {
    const [s, list] = await Promise.all([rr.cacheStats(), rr.listCache({ limit: 2000 })]);
    const rate = s.hits + s.misses ? s.hits / (s.hits + s.misses) : 0;
    const v = setView('Cache', `
      <div class="kpis">
        <article class="kpi"><div class="kpi-top"><span class="tile git">${icon('cache', 18)}</span>Položek</div><div class="kpi-v">${fmtNum(s.entries)}</div><div class="kpi-d">expirovaných ${fmtNum(s.expired)}</div></article>
        <article class="kpi"><div class="kpi-top"><span class="tile npm">${icon('repo', 18)}</span>Velikost</div><div class="kpi-v">${fmtBytes(s.bytes)}</div><div class="kpi-d">${esc(s.dir)}</div></article>
        <article class="kpi"><div class="kpi-top"><span class="tile docker">${icon('activity', 18)}</span>Hit / miss</div><div class="kpi-v">${Math.round(rate * 100)} %</div><div class="kpi-d">${fmtNum(s.hits)} / ${fmtNum(s.misses)} · stale ${s.stale} · chyby ${s.errors}</div></article>
      </div>
      <div id="t"></div>`, 'cache');
    const host = (e) => { try { return new URL(e.url).host; } catch { return '?'; } };
    table('#t', {
      id: 'cache', rows: list.entries, rowKey: (e) => e.key, placeholder: 'Hledat URL…', sort: { key: 'created', dir: -1 },
      groups: [{ key: 'host', label: 'server', value: host }, { key: 'expired', label: 'platnost', value: (e) => (e.expired ? 'expirované' : 'platné') }, { key: 'rule', label: 'pravidlo', value: (e) => e.ruleId || '–' }],
      toolbar: `<button type="button" class="btn small" id="pExp">${icon('broom', 15)}Smazat expirované</button><button type="button" class="btn small danger" id="pAll">${icon('trash', 15)}Smazat vše</button>`,
      empty: 'Cache je prázdná.',
      columns: [
        { key: 'url', label: 'URL', render: (e) => `<code class="small">${esc(e.url)}</code>` },
        { key: 'status', label: 'Status', align: 'right', render: (e) => `<span class="mono">${e.status}</span>` },
        { key: 'size', label: 'Velikost', align: 'right', render: (e) => `<span class="mono">${fmtBytes(e.size)}</span>` },
        { key: 'created', label: 'Uloženo', render: (e) => when(e.created) },
        { key: 'expires', label: 'Expirace', render: (e) => (e.expired ? '<span class="badge off">expirováno</span>' : when(e.expires)) },
        { key: 'act', label: '', sort: false, align: 'right', render: (e) => iconBtn(`data-del="${esc(e.key)}"`, 'x', 'Smazat položku', 'danger') },
      ],
      actions: [{ label: 'Smazat vybrané', icon: 'trash', danger: true, run: async (sel) => { for (const e of sel) await run(() => rr.deleteCacheEntry(e.key)); toast(`Smazáno: ${sel.length}`); route(); } }],
      onRender: (el) => {
        $$('[data-del]', el).forEach((b) => { b.onclick = async () => { await run(() => rr.deleteCacheEntry(b.dataset.del)); route(); }; });
        $('#pExp', el).onclick = async () => { const r = await run(() => rr.purgeCache({ expired: 1 })); toast(`Smazáno expirovaných: ${r.removed}`); route(); };
        $('#pAll', el).onclick = async () => { if (await confirmBox('Smazat celou cache?')) { const r = await run(() => rr.purgeCache({})); toast(`Smazáno: ${r.removed}`); route(); } };
      },
    });
    return v;
  };

  // ---------------------------------------------------------------- users & tokens
  views.users = async () => {
    const users = await rr.listUsers();
    const roles = ['publisher', 'reader', 'admin'];
    const v = setView('Uživatelé', `<div id="t"></div><p class="muted small">Role: <b>reader</b> – čtení, <b>publisher</b> – čtení a publikace, <b>admin</b> – vše. Uživatelé se mohou přihlásit i přes <code>npm login --auth-type=legacy</code>; přístup k jednotlivým repozitářům upravují ACL repozitáře.</p>`, 'users');
    table('#t', {
      id: 'users', rows: users, rowKey: (u) => u.name, placeholder: 'Hledat uživatele…', sort: { key: 'name', dir: 1 }, group: 'role',
      groups: [{ key: 'role', label: 'role', value: (u) => u.role }],
      toolbar: `<button type="button" class="btn small primary" id="new">${icon('plus', 15)}Nový uživatel</button>`,
      columns: [
        { key: 'name', label: 'Jméno', render: (u) => `<div class="cell-main"><span class="avatar">${esc(u.name.slice(0, 2))}</span><div class="t"><b>${esc(u.name)}</b><small>${esc(u.email || '')}</small></div>${u.builtin ? '<span class="badge blue">vestavěný</span>' : ''}</div>` },
        { key: 'role', label: 'Role', render: (u) => (u.builtin ? '<span class="pill">admin</span>' : `<select data-role="${esc(u.name)}" style="width:auto;min-height:32px;padding:4px 8px">${roles.map((r) => `<option${r === u.role ? ' selected' : ''}>${r}</option>`).join('')}</select>`) },
        { key: 'created', label: 'Vytvořen', render: (u) => when(u.created) },
        { key: 'act', label: '', sort: false, align: 'right', render: (u) => (u.builtin ? '' : `${iconBtn(`data-pw="${esc(u.name)}"`, 'key', 'Změnit heslo')}${iconBtn(`data-del="${esc(u.name)}"`, 'trash', 'Smazat', 'danger')}`) },
      ],
      onRender: (el) => {
        $('#new', el).onclick = () => modal(`<h2>Nový uživatel</h2><form class="form" id="f">
            <label>Jméno <input name="name" required></label><label>Heslo <input name="password" type="password" required></label>
            <label>E-mail <input name="email"></label><label>Role <select name="role">${roles.map((r) => `<option>${r}</option>`).join('')}</select></label></form>
            <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (m, close) => {
          $('#ok', m).onclick = async () => { await run(() => rr.createUser(formData($('#f', m))), 'Uživatel vytvořen'); close(); route(); };
        });
        $$('[data-role]', el).forEach((s) => { s.onchange = () => run(() => rr.updateUser(s.dataset.role, { role: s.value }), 'Role změněna'); });
        $$('[data-pw]', el).forEach((b) => {
          b.onclick = () => modal(`<h2>Heslo pro ${esc(b.dataset.pw)}</h2><label>Nové heslo <input type="password" id="pw"></label>
            <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Uložit</button></div>`, (m, close) => {
            $('#ok', m).onclick = async () => { await run(() => rr.updateUser(b.dataset.pw, { password: $('#pw', m).value }), 'Heslo změněno'); close(); };
          });
        });
        $$('[data-del]', el).forEach((b) => { b.onclick = async () => { if (await confirmBox(`Smazat uživatele ${b.dataset.del}?`)) { await run(() => rr.deleteUser(b.dataset.del), 'Smazáno'); route(); } }; });
      },
    });
    return v;
  };

  views.tokens = async () => {
    const [tokens, users] = await Promise.all([rr.listTokens(), isAdmin() ? rr.listUsers() : []]);
    const v = setView('Tokeny', '<div id="t"></div><p class="muted small">Hlavní API token (RR_API_TOKEN) se nastavuje v <code>make menuconfig</code> a zde se nezobrazuje.</p>', 'key');
    table('#t', {
      id: 'tokens', rows: tokens, rowKey: (t) => t.id, placeholder: 'Hledat token…', sort: { key: 'created', dir: -1 },
      groups: [{ key: 'user', label: 'uživatel', value: (t) => t.user }, { key: 'kind', label: 'druh', value: (t) => t.kind }],
      toolbar: `<button type="button" class="btn small primary" id="new">${icon('plus', 15)}Nový token</button>`,
      empty: 'Žádné tokeny.',
      columns: [
        { key: 'name', label: 'Token', render: (t) => cellMain('npm', t.name, t.preview, 'key') },
        { key: 'user', label: 'Uživatel' },
        { key: 'kind', label: 'Druh', toggle: true, render: (t) => `<span class="pill">${esc(t.kind)}</span>` },
        { key: 'readonly', label: 'Jen čtení', value: (t) => (t.readonly ? 1 : 0), render: (t) => yes(t.readonly) },
        { key: 'created', label: 'Vytvořen', render: (t) => when(t.created) },
        { key: 'lastUsed', label: 'Použit', render: (t) => when(t.lastUsed) },
        { key: 'expires', label: 'Expirace', toggle: true, render: (t) => (t.expires ? when(t.expires) : 'nikdy') },
        { key: 'act', label: '', sort: false, align: 'right', render: (t) => iconBtn(`data-del="${esc(t.id)}"`, 'trash', 'Zneplatnit', 'danger') },
      ],
      actions: [{ label: 'Zneplatnit vybrané', icon: 'trash', danger: true, run: async (sel) => { if (!(await confirmBox(`Zneplatnit ${sel.length} tokenů?`))) return; for (const t of sel) await run(() => rr.revokeToken(t.id)); toast(`Zneplatněno: ${sel.length}`); route(); } }],
      onRender: (el) => {
        $('#new', el).onclick = () => modal(`<h2>Nový token</h2><form class="form" id="f">
            <label>Název <input name="name" value="ci"></label>
            ${isAdmin() ? `<label>Pro uživatele <select name="user"><option value="">(já – ${esc(me.name)})</option>${users.filter((u) => !u.builtin).map((u) => `<option>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
            <label>Platnost v sekundách (0 = navždy) <input name="ttl" type="number" value="0"></label>
            <label class="check"><input type="checkbox" name="readonly"> jen pro čtení</label></form>
            <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (m, close) => {
          $('#ok', m).onclick = async () => {
            const t = await run(() => rr.createToken(formData($('#f', m))));
            close();
            modal(`<h2>Token vytvořen</h2><p style="margin:0">Uložte si ho – znovu se nezobrazí.</p><pre>${esc(t.token)}</pre>
              <pre># .npmrc\n${esc(registryUrl('', true).replace(/^https?:/, ''))}:_authToken=${esc(t.token)}</pre>
              <div class="row"><button class="btn" id="cp">${icon('copy', 15)}Kopírovat</button><span class="spacer"></span><button class="btn primary" data-close>Hotovo</button></div>`, (m2) => {
              $('#cp', m2).onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText(t.token); toast('Zkopírováno'); };
            });
            route();
          };
        });
        $$('[data-del]', el).forEach((b) => { b.onclick = async () => { if (await confirmBox('Zneplatnit token?')) { await run(() => rr.revokeToken(b.dataset.del), 'Token zneplatněn'); route(); } }; });
      },
    });
    return v;
  };

  // ---------------------------------------------------------------- logs
  views.logs = async () => {
    const tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'requests';
    const l = await rr.getLogs({ limit: 1000 });
    const v = setView('Logy', `
      <div class="tabs"><button data-tab="requests" class="${tab === 'requests' ? 'active' : ''}">Požadavky</button><button data-tab="audit" class="${tab === 'audit' ? 'active' : ''}">Audit</button>
        <span class="spacer"></span><label class="check"><input type="checkbox" id="auto" ${refreshTimer ? 'checked' : ''}> obnovovat každé 3 s</label>
        <button type="button" class="btn small" id="logWin">${icon('terminal', 15)}Živý log v okně</button></div>
      <div id="t"></div>`, 'terminal');
    let t;
    if (tab === 'audit') {
      t = table('#t', {
        id: 'audit', rows: l.audit, rowKey: (a, i) => `${a.time}-${i}`, placeholder: 'Hledat v auditu…', sort: { key: 'time', dir: -1 },
        groups: [{ key: 'user', label: 'uživatel', value: (a) => a.user }, { key: 'action', label: 'akce', value: (a) => a.action }],
        columns: [
          { key: 'time', label: 'Čas', render: (a) => when(a.time) },
          { key: 'user', label: 'Uživatel' },
          { key: 'action', label: 'Akce', render: (a) => { const [ic, ty] = ACT_ICON(a.action); return `<span class="cell-main">${tile(ty || 'x', ic)}${esc(a.action)}</span>`; } },
          { key: 'target', label: 'Cíl', render: (a) => `<code class="small">${esc(a.target)}</code>` },
        ],
      });
    } else {
      t = table('#t', {
        id: 'requests', rows: l.requests, rowKey: (r, i) => `${r.time}-${i}`, placeholder: 'Hledat URL, uživatele, status…', sort: { key: 'time', dir: -1 },
        groups: [{ key: 'class', label: 'třída statusu', value: (r) => `${String(r.status)[0]}xx` }, { key: 'user', label: 'uživatel', value: (r) => r.user }, { key: 'method', label: 'metoda', value: (r) => r.method }, { key: 'cache', label: 'cache', value: (r) => r.cache || 'lokálně' }],
        columns: [
          { key: 'time', label: 'Čas', render: (r) => `<span class="mono small" title="${esc(fmtDate(r.time))}">${esc(new Date(r.time).toLocaleTimeString())}</span>` },
          { key: 'status', label: 'Status', render: (r) => `<span class="badge ${r.status < 300 ? 'ok' : r.status < 400 ? 'blue' : r.status < 500 ? 'warn' : 'off'}">${r.status}</span>` },
          { key: 'method', label: 'Metoda', render: (r) => `<span class="mono">${esc(r.method)}</span>` },
          { key: 'url', label: 'URL', render: (r) => `<code class="small">${esc(r.url)}</code>` },
          { key: 'ms', label: 'ms', align: 'right', render: (r) => `<span class="mono">${r.ms}</span>` },
          { key: 'user', label: 'Uživatel' },
          { key: 'cache', label: 'Cache', toggle: true },
          { key: 'ip', label: 'IP', toggle: true, hidden: true },
        ],
      });
    }
    $$('[data-tab]', v).forEach((b) => { b.onclick = () => { location.hash = `#/logs?tab=${b.dataset.tab}`; }; });
    $('#logWin', v).onclick = liveLogWindow;
    const tick = async () => {
      if (!location.hash.startsWith('#/logs')) { clearInterval(refreshTimer); refreshTimer = null; return; }
      const n = await rr.getLogs({ limit: 1000 }).catch(() => null);
      if (n) t.setRows(tab === 'audit' ? n.audit : n.requests);
    };
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = setInterval(tick, 3000); }
    $('#auto', v).onchange = (e) => {
      clearInterval(refreshTimer); refreshTimer = null;
      if (e.target.checked) refreshTimer = setInterval(tick, 3000);
    };
    return v;
  };

  function hookForm(h, types) {
    h = h || { enabled: true, events: ['*'], repos: ['*'], format: 'json', headers: {}, retries: 3 };
    const all = ['*', ...['npm', 'file', 'docker', 'git', 'repo'].map((x) => `${x}.*`), ...types];
    modal(`<h2>${h.id ? `Upravit webhook ${esc(h.name)}` : 'Nový webhook'}</h2><form class="form" id="f">
        <label>Název <input name="name" value="${esc(h.name || '')}" required></label>
        <label>Formát <select name="format">${['json', 'slack', 'discord'].map((f) => `<option${f === h.format ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
        <label style="grid-column:1/-1">URL <input name="url" value="${esc(h.url || '')}" placeholder="https://example.com/hooks/rr"></label>
        <label>Repozitáře (čárkou, * = vše) <input name="repos" value="${esc(h.repos.join(','))}"></label>
        <label>Tajný klíč (HMAC) <input name="secret" type="password" value="${esc(h.secret || '')}"></label>
        <label>Počet pokusů <input name="retries" type="number" value="${h.retries ?? 3}" min="1" max="10"></label>
        <label class="check"><input type="checkbox" name="enabled" ${h.enabled ? 'checked' : ''}> zapnuto</label>
        <label style="grid-column:1/-1">Hlavičky (JSON) <textarea name="headers">${esc(JSON.stringify(h.headers || {}, null, 2))}</textarea></label></form>
      <h2>Události</h2><div class="row" id="evs">${all.map((e) => `<label class="check"><input type="checkbox" value="${esc(e)}" ${h.events.includes(e) ? 'checked' : ''}> ${esc(e)}</label>`).join('')}</div>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="save">Uložit</button></div>`, (el, close) => {
      $('#save', el).onclick = async () => {
        const d = formData($('#f', el));
        try { d.headers = JSON.parse(d.headers || '{}'); } catch { return toast('Hlavičky nejsou platný JSON', true); }
        d.events = $$('#evs input', el).filter((x) => x.checked).map((x) => x.value);
        if (!d.events.length) d.events = ['*'];
        if (h.id) await run(() => rr.updateWebhook(h.id, d), 'Uloženo');
        else await run(() => rr.createWebhook(d), 'Webhook vytvořen');
        close(); route();
      };
    });
  }

  function ruleForm(r, repos) {
    r = r || { enabled: true, priority: 100, when: 'notfound', matchOn: 'package', matchType: 'prefix', pattern: '', repo: '*', repoType: '*', key: '', methods: ['GET', 'HEAD'], target: 'https://registry.npmjs.org', stripPrefix: '', addPrefix: '', headers: {}, cacheTtl: null, header: null };
    const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
    modal(`<h2>${r.id ? `Upravit pravidlo ${esc(r.name)}` : 'Nové směrovací pravidlo'}</h2>
      <form class="form" id="f">
        <label>Název <input name="name" value="${esc(r.name || '')}" required></label>
        <label>Priorita (nižší dříve) <input name="priority" type="number" value="${r.priority}"></label>
        <label>Kdy <select name="when">${opt([['notfound', 'když není lokálně'], ['always', 'vždy (před lokálním)'], ['push', 'push – replikovat zápisy na cíl']], r.when)}</select></label>
        <label>Porovnávat <select name="matchOn">${opt([['package', 'cesta balíčku /@scope/name'], ['path', 'cesta v repozitáři'], ['url', 'celá URL']], r.matchOn)}</select></label>
        <label>Typ masky <select name="matchType">${opt([['prefix', 'začíná na'], ['glob', 'glob * ** ?'], ['regex', 'regulární výraz'], ['contains', 'obsahuje'], ['exact', 'přesná shoda']], r.matchType)}</select></label>
        <label>Maska (prázdná = vše) <input name="pattern" value="${esc(r.pattern)}" placeholder="/@firma/"></label>
        <label>Repozitář <select name="repo">${opt([['*', '* (všechny)'], ...repos.map((x) => [x.name, x.name])], r.repo)}</select></label>
        <label>Typ repozitáře <select name="repoType">${opt([['*', '*'], ['npm', 'npm'], ['generic', 'generic'], ['git', 'git'], ['group', 'group']], r.repoType)}</select></label>
        <label>Klíč (volitelný) <input name="key" value="${esc(r.key)}" placeholder="např. corp"></label>
        <label>Metody <input name="methods" value="${esc((r.methods || []).join(','))}"></label>
        <label style="grid-column:1/-1">Cílový registr (URL) <input name="target" value="${esc(r.target)}" required></label>
        <label>Odebrat prefix cesty <input name="stripPrefix" value="${esc(r.stripPrefix)}"></label>
        <label>Přidat prefix cesty <input name="addPrefix" value="${esc(r.addPrefix)}"></label>
        <label>Cache TTL (s, prázdné = výchozí) <input name="cacheTtl" type="number" value="${r.cacheTtl ?? ''}"></label>
        <label>Podmínka – hlavička <input name="headerName" value="${esc(r.header ? r.header.name : '')}" placeholder="např. user-agent"></label>
        <label>Podmínka – regex hodnoty <input name="headerPattern" value="${esc(r.header ? r.header.pattern : '')}" placeholder="např. ^yarn"></label>
        <label style="grid-column:1/-1">Hlavičky pro upstream (JSON) <textarea name="headers">${esc(JSON.stringify(r.headers || {}, null, 2))}</textarea></label>
        <label>Token pro cíl <input name="token" type="password" value="${esc(r.token || '')}" placeholder="git: x-access-token, npm/generic: Bearer"></label>
        <label>Uživatel pro token (git) <input name="username" value="${esc(r.username || '')}" placeholder="x-access-token"></label>
        <label>Git režim push <select name="gitMode">${opt([['mirror', 'mirror (všechny refy, i mazání)'], ['branches', 'větve a tagy']], r.gitMode || 'mirror')}</select></label>
        <label class="check"><input type="checkbox" name="createMissing" ${r.createMissing ? 'checked' : ''}> GitHub: vytvořit chybějící repozitář</label>
        <label class="check"><input type="checkbox" name="private" ${r.private !== false ? 'checked' : ''}> vytvářet jako privátní</label>
        <label class="check"><input type="checkbox" name="replicateDeletes" ${r.replicateDeletes ? 'checked' : ''}> generic: replikovat i mazání</label>
        <label style="grid-column:1/-1">Popis <input name="description" value="${esc(r.description || '')}"></label>
        <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}> zapnuto</label>
      </form>
      <p class="muted small">Git repozitáře: „vždy“/„nenalezeno“ vytvoří lokální zrcadlo z <code>cíl/&lt;název&gt;.git</code> (obnoví se po uplynutí Cache TTL), „push“ po každém push odešle repozitář na <code>cíl/&lt;název&gt;.git</code>. npm: push replikuje publikované verze, generic: nahrané soubory.</p>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="save">Uložit</button></div>`, (el, close) => {
      $('#save', el).onclick = async () => {
        const d = formData($('#f', el));
        try { d.headers = JSON.parse(d.headers || '{}'); } catch { return toast('Hlavičky nejsou platný JSON', true); }
        d.header = d.headerName ? { name: d.headerName, pattern: d.headerPattern } : null;
        delete d.headerName; delete d.headerPattern;
        if (d.cacheTtl === null) d.cacheTtl = '';
        if (r.id) await run(() => rr.updateRoute(r.id, d), 'Uloženo');
        else await run(() => rr.createRoute(d), 'Pravidlo vytvořeno');
        close(); route();
      };
    });
  }

  // ---------------------------------------------------------------- settings (general, export, import)
  const settingsTabs = (tab) => `<div class="tabs">${[['general', 'Obecné', 'gear'], ['export', 'Export', 'download'], ['import', 'Import', 'upload']].map(([k, l, ic]) => `<a href="#/settings?tab=${k}" class="tab-link${tab === k ? ' active' : ''}">${icon(ic, 15)}${l}</a>`).join('')}</div>`;

  views.settings = async () => {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const tab = q.get('tab') || 'general';
    if (tab === 'export') return settingsExport();
    if (tab === 'import') return q.get('id') ? importPlan(q.get('id')) : settingsImport();
    const [s, repos, plugins] = await Promise.all([rr.getSettings(), rr.listRepos(), rr.listPlugins()]);
    const v = setView('Nastavení', `${settingsTabs(tab)}
      <div class="card"><form class="form" id="f">
        <label>Název registru <input name="title" value="${esc(s.title)}"></label>
        <label>Výchozí repozitář (kořen /) <select name="defaultRepo">${repos.map((r) => `<option${r.name === s.defaultRepo ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label>Repozitář pro klientské balíčky <select name="clientsRepo">${repos.filter((r) => r.type === 'npm').map((r) => `<option${r.name === s.clientsRepo ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>
        <label>Výchozí TTL cache metadat (s) <input type="number" name="cacheTtl" value="${s.cacheTtl}"></label>
        <label>TTL cache tarballů (s) <input type="number" name="tarballTtl" value="${s.tarballTtl}"></label>
        <label>CORS Allow-Origin (prázdné = vypnuto) <input name="cors" value="${esc(s.cors)}"></label>
        <label style="grid-column:1/-1">Zpráva na úvodní stránce <input name="motd" value="${esc(s.motd || '')}"></label>
        <label class="check"><input type="checkbox" name="anonymousRead" ${s.anonymousRead ? 'checked' : ''}> anonymní čtení veřejných repozitářů</label>
        <label class="check"><input type="checkbox" name="allowRegistration" ${s.allowRegistration ? 'checked' : ''}> registrace přes npm adduser</label>
      </form></div>
      <div class="card"><h2>Pluginy</h2>${plugins.map((p) => `<label class="check"><input type="checkbox" data-plugin="${esc(p.name)}" ${p.enabled ? 'checked' : ''}> <b>${esc(p.name)}</b> – ${esc(p.description)}</label>`).join('')}
        <p class="muted small">Vlastní pluginy lze přidat do <code>data/plugins/*.js</code>.</p></div>
      <div class="row"><button class="btn primary" id="save">Uložit nastavení</button></div>
      <div class="card"><h2>Konfigurace serveru (.env / make menuconfig)</h2><p class="muted">Port, heslo administrátora a API token se nastavují příkazem <code>make menuconfig</code> a projeví se po restartu kontejneru (<code>make restart</code>). Údaje převzaté importem (záložka Import) mají přednost a ukládají se do <code>data/config/server.json</code>.</p></div>`, 'gear');
    $('#save', v).onclick = async () => {
      const d = formData($('#f', v));
      d.plugins = $$('[data-plugin]', v).filter((c) => c.checked).map((c) => c.dataset.plugin);
      await run(() => rr.updateSettings(d), 'Nastavení uloženo');
    };
  };

  async function settingsExport() {
    const [desc, exports] = await Promise.all([rr.transferSections(), rr.listExports()]);
    const v = setView('Nastavení', `${settingsTabs('export')}
      <div class="card"><h2>${icon('lock', 17)}Šifrovaný export</h2>
        <p class="muted" style="margin:0 0 12px">Export obsahuje vybrané části registru v pevném pořadí (nejdřív to, na čem ostatní závisí) a je zašifrovaný heslem
          (AES-256-GCM, klíč z hesla přes scrypt). Bez hesla ho nelze přečíst ani upravit. Přihlašovací údaje, hesla, tokeny a klíče se exportují jen v sekcích označených <span class="badge warn">tajné</span>.</p>
        <div class="xsections">${desc.sections.map((sec, i) => `
          <details class="xsec"><summary><label class="check" onclick="event.stopPropagation()"><input type="checkbox" data-sec="${sec.id}"${sec.optional || !sec.items.length ? '' : ' checked'}${sec.items.length ? '' : ' disabled'}> <span class="pill">${i + 1}</span> <b>${esc(sec.title)}</b></label>
            <span class="muted small">${esc(sec.description)}</span>${sec.secret ? ' <span class="badge warn">tajné</span>' : ''}<span class="spacer"></span>
            <span class="mono small muted">${sec.items.length} ${sec.bytes ? `· ${fmtBytes(sec.bytes)}` : ''}</span></summary>
            <div class="xitems">${sec.items.map((it) => `<label class="check"><input type="checkbox" data-item="${sec.id}" value="${esc(it.id)}"${sec.optional ? '' : ' checked'}> ${esc(it.title)} ${it.bytes ? `<span class="mono small muted">${fmtBytes(it.bytes)} · ${it.files} souborů</span>` : ''}</label>`).join('') || '<span class="muted small">nic k exportu</span>'}</div></details>`).join('')}</div>
        <form class="form" id="xf" style="margin-top:14px" autocomplete="off">
          <label>Heslo exportu (min. 8 znaků) <input type="password" name="passphrase" autocomplete="new-password" required minlength="8"></label>
          <label>Heslo znovu <input type="password" name="passphrase2" autocomplete="new-password" required></label>
          <label style="grid-column:1/-1">Poznámka <input name="note" placeholder="např. záloha před aktualizací"></label>
        </form>
        <div class="row" style="margin-top:12px"><button type="button" class="btn primary" id="doExport">${icon('download', 15)}Vytvořit šifrovaný export</button><span class="muted small" id="xstatus"></span></div>
      </div>
      <div id="xt"></div>`, 'gear');
    $$('[data-sec]', v).forEach((cb) => { cb.onchange = () => $$(`[data-item="${cb.dataset.sec}"]`, v).forEach((i) => { i.checked = cb.checked; }); });
    $('#doExport', v).onclick = async () => {
      const f = formData($('#xf', v));
      if (f.passphrase.length < 8) return toast('Heslo musí mít aspoň 8 znaků.', true);
      if (f.passphrase !== f.passphrase2) return toast('Hesla se neshodují.', true);
      const sections = [];
      const items = {};
      for (const sec of desc.sections) {
        const all = $$(`[data-item="${sec.id}"]`, v);
        const on = all.filter((x) => x.checked).map((x) => x.value);
        if (!on.length) continue;
        sections.push(sec.id);
        if (on.length < all.length) items[sec.id] = on;
      }
      if (!sections.length) return toast('Vyberte, co exportovat.', true);
      const btn = $('#doExport', v);
      btn.disabled = true;
      $('#xstatus', v).textContent = 'Exportuji a šifruji…';
      try {
        const r = await run(() => rr.createExport({ passphrase: f.passphrase, sections, items, note: f.note }), 'Export vytvořen');
        $('#xstatus', v).textContent = `${r.file} · ${fmtBytes(r.size)} · ${(r.ms / 1000).toFixed(1)} s`;
        route();
      } catch { btn.disabled = false; $('#xstatus', v).textContent = ''; }
    };
    table('#xt', {
      id: 'exports', rows: exports, rowKey: (e) => e.id, placeholder: 'Hledat export…', sort: { key: 'created', dir: -1 }, empty: 'Zatím žádné exporty.',
      columns: [
        { key: 'file', label: 'Soubor', render: (e) => cellMain('npm', e.file, e.note || `sha256 ${e.sha256.slice(0, 16)}…`, 'lock') },
        { key: 'created', label: 'Vytvořen', render: (e) => when(e.created) },
        { key: 'size', label: 'Velikost', align: 'right', render: (e) => `<span class="mono">${fmtBytes(e.size)}</span>` },
        { key: 'sections', label: 'Obsah', sort: false, render: (e) => e.sections.map((s) => `<span class="badge plain">${esc(s.title)} ${s.items}</span>`).join(' ') },
        { key: 'createdBy', label: 'Autor', toggle: true },
        { key: 'act', label: '', sort: false, align: 'right', render: (e) => `${iconBtn(`data-dl="${esc(e.id)}" data-file="${esc(e.file)}"`, 'download', 'Stáhnout')}${iconBtn(`data-del="${esc(e.id)}"`, 'trash', 'Smazat', 'danger')}` },
      ],
      onRender: (el) => {
        $$('[data-dl]', el).forEach((b) => { b.onclick = async () => { toast('Stahuji…'); download(await run(() => rr.downloadExport(b.dataset.dl)), b.dataset.file); }; });
        $$('[data-del]', el).forEach((b) => { b.onclick = async () => { if (await confirmBox('Smazat export ze serveru?')) { await run(() => rr.deleteExport(b.dataset.del), 'Smazáno'); route(); } }; });
      },
    });
  }

  const IMPORT_STATUS = { received: ['plain', 'přijato'], locked: ['warn', 'zamčeno heslem'], ready: ['blue', 'připraveno'], running: ['blue', 'probíhá'], done: ['ok', 'dokončeno'], failed: ['off', 'dokončeno s chybami'] };
  const statusBadge = (s) => `<span class="badge ${(IMPORT_STATUS[s] || ['plain'])[0]}">${esc((IMPORT_STATUS[s] || [0, s])[1])}</span>`;
  const sourceLabel = (src) => (src.kind === 'remote' ? `${src.mode === 'server' ? 'server' : 'URL'} ${src.url}` : `soubor ${src.name || ''}`);

  async function settingsImport() {
    const imports = await rr.listImports();
    const v = setView('Nastavení', `${settingsTabs('import')}
      <div class="widgets">
        <article class="card widget w6"><h2>${icon('upload', 17)}Import ze souboru</h2>
          <p class="muted small" style="margin:0">Soubor <code>.rrx</code> z exportu. Po nahrání ho odemknete heslem a vyberete, co se má importovat.</p>
          <label>Soubor exportu <input type="file" id="ifile" accept=".rrx,application/octet-stream"></label>
          <label>Heslo exportu <input type="password" id="ipass" autocomplete="off"></label>
          <div class="row"><button type="button" class="btn primary" id="iup">${icon('upload', 15)}Nahrát a odemknout</button></div>
        </article>
        <article class="card widget w6"><h2>${icon('link', 17)}Vzdálený import z URL</h2>
          <p class="muted small" style="margin:0">Každou operaci vzdáleného importu musíte před spuštěním jednotlivě schválit.</p>
          <form class="form" id="rf" autocomplete="off">
            <label>Zdroj <select name="mode"><option value="server">jiný RR Registry (vytvoří export)</option><option value="file">URL souboru .rrx</option></select></label>
            <label>URL <input name="url" placeholder="https://registry2.firma.cz"></label>
            <label>API token zdroje <input name="token" type="password" placeholder="admin token vzdáleného serveru"></label>
            <label>Heslo exportu <input name="passphrase" type="password"></label>
          </form>
          <div class="row"><button type="button" class="btn primary" id="rimp">${icon('download', 15)}Stáhnout a připravit plán</button></div>
        </article>
      </div>
      <div id="it"></div>`, 'gear');
    $('#iup', v).onclick = async () => {
      const f = $('#ifile', v).files[0];
      if (!f) return toast('Vyberte soubor exportu.', true);
      toast('Nahrávám…');
      const st = await run(async () => rr.uploadImport(await readFile(f)));
      const pass = $('#ipass', v).value;
      if (pass) await run(() => rr.unlockImport(st.id, { passphrase: pass }), 'Odemčeno').catch(() => {});
      location.hash = `#/settings?tab=import&id=${st.id}`;
    };
    $('#rimp', v).onclick = async () => {
      const d = formData($('#rf', v));
      if (!d.url) return toast('Zadejte URL.', true);
      toast(d.mode === 'server' ? 'Žádám vzdálený server o export…' : 'Stahuji…');
      const st = await run(() => rr.remoteImport(d));
      location.hash = `#/settings?tab=import&id=${st.id}`;
    };
    table('#it', {
      id: 'imports', rows: imports, rowKey: (i) => i.id, placeholder: 'Hledat import…', sort: { key: 'created', dir: -1 }, empty: 'Žádné importy.',
      columns: [
        { key: 'source', label: 'Zdroj', value: (i) => sourceLabel(i.source), render: (i) => cellMain(i.source.kind === 'remote' ? 'docker' : 'npm', sourceLabel(i.source), i.header ? `export z ${fmtDate(i.header.created)} · v${i.header.appVersion}` : '', i.source.kind === 'remote' ? 'link' : 'upload') },
        { key: 'created', label: 'Vytvořen', render: (i) => when(i.created) },
        { key: 'status', label: 'Stav', render: (i) => statusBadge(i.status) },
        { key: 'ops', label: 'Operací', align: 'right' },
        { key: 'size', label: 'Velikost', align: 'right', render: (i) => `<span class="mono">${fmtBytes(i.size)}</span>` },
        { key: 'act', label: '', sort: false, align: 'right', render: (i) => iconBtn(`data-del="${esc(i.id)}"`, 'trash', 'Zahodit', 'danger') },
      ],
      onRow: (i) => { location.hash = `#/settings?tab=import&id=${i.id}`; },
      onRender: (el) => { $$('[data-del]', el).forEach((b) => { b.onclick = async () => { await run(() => rr.deleteImport(b.dataset.del), 'Zahozeno'); route(); }; }); },
    });
  }

  const ACTION = { create: ['ok', 'vytvořit'], overwrite: ['warn', 'přepsat'], merge: ['warn', 'sloučit'], skip: ['plain', 'přeskočit'], extract: ['blue', 'rozbalit'] };

  async function importPlan(id) {
    let st = await rr.getImport(id);
    const v = setView('Nastavení', `${settingsTabs('import')}<div id="ip"></div>`, 'gear');
    const host = $('#ip', v);
    const update = async (body, msg) => { st = await run(() => rr.updateImport(id, body), msg); draw(); };
    function draw() {
      const p = st.plan;
      const remote = st.source.kind === 'remote';
      const head = `<div class="card"><div class="row between"><h2 style="margin:0">${icon(remote ? 'link' : 'upload', 17)}Import: ${esc(sourceLabel(st.source))}</h2>${statusBadge(st.status)}</div>
        <p class="muted small" style="margin:8px 0 0">${st.manifest ? `Export „${esc(st.manifest.source.title || '')}“ z ${esc(fmtDate(st.manifest.created))} · RR Registry ${esc(st.manifest.appVersion)} · autor ${esc(st.manifest.createdBy || '')}${st.manifest.note ? ` · ${esc(st.manifest.note)}` : ''}` : st.header ? `Export z ${esc(fmtDate(st.header.created))} · RR Registry ${esc(st.header.appVersion)}` : ''} · ${fmtBytes(st.size)}</p>
        <div class="row" style="margin-top:10px"><a class="btn small ghost" href="#/settings?tab=import">${icon('up', 15)}Všechny importy</a><span class="spacer"></span><button type="button" class="btn small danger" id="discard">${icon('trash', 15)}Zahodit import</button></div></div>`;
      if (st.status === 'locked') {
        host.innerHTML = `${head}<div class="card"><h2>${icon('lock', 17)}Odemknout heslem</h2><form class="row" id="uf"><input type="password" id="up" placeholder="heslo exportu" style="max-width:320px" autocomplete="off"><button class="btn primary">Odemknout</button></form></div>`;
        $('#uf', host).onsubmit = async (e) => { e.preventDefault(); st = await run(() => rr.unlockImport(id, { passphrase: $('#up', host).value }), 'Odemčeno'); draw(); };
        bindHead();
        return;
      }
      const done = st.status === 'done' || st.status === 'failed';
      const ws = st.options.target.mode === 'workspace';
      const results = Object.fromEntries((st.results || []).map((r) => [r.id, r]));
      const secTitle = Object.fromEntries(st.sections.map((s) => [s.id, s.title]));
      host.innerHTML = `${head}
        ${remote && !done ? `<div class="card" style="border-color:var(--warn-line)"><b>${icon('alert', 16)} Vzdálený import</b><p class="muted small" style="margin:6px 0 0">Data pocházejí z <code>${esc(st.source.url)}</code>. Než import spustíte, schvalte každou operaci (sloupec Schválení) – neschválené operace se neprovedou.</p></div>` : ''}
        ${done ? '' : `<div class="card"><h2>${icon('gear', 17)}Možnosti</h2><div class="form">
          <label>Když položka už existuje <select id="conflict"><option value="skip"${st.options.conflict === 'skip' ? ' selected' : ''}>ponechat stávající (přeskočit)</option><option value="overwrite"${st.options.conflict === 'overwrite' ? ' selected' : ''}>přepsat / sloučit</option></select></label>
          <label>Cíl <select id="tmode"><option value="live"${ws ? '' : ' selected'}>do běžícího registru</option><option value="workspace"${ws ? ' selected' : ''}>do workspace (jen rozbalit soubory)</option></select></label>
          <label${ws ? '' : ' class="hidden"'} id="wsl">Cesta workspace (v data/workspaces/) <input id="wsp" value="${esc(st.options.target.path || '')}" placeholder="${esc(st.id)}"></label></div>
          <div class="row" style="margin-top:12px"><button type="button" class="btn small" id="deps">${icon('layers', 15)}Doplnit chybějící závislosti</button>
            <button type="button" class="btn small" id="selAll">Vybrat vše</button><button type="button" class="btn small" id="selNone">Zrušit výběr</button>
            ${remote ? `<button type="button" class="btn small primary" id="apprAll">${icon('check', 15)}Schválit všechny vybrané</button>` : ''}</div></div>`}
        <div class="kpis">
          <article class="kpi"><div class="kpi-top"><span class="tile npm">${icon('layers', 18)}</span>Vybráno operací</div><div class="kpi-v">${p.selected}</div><div class="kpi-d">z ${st.ops.length} · ${fmtBytes(p.bytes)}</div></article>
          <article class="kpi"><div class="kpi-top"><span class="tile ${p.blocked.length ? 'x' : 'git'}">${icon(p.blocked.length ? 'alert' : 'check', 18)}</span>Závislosti</div><div class="kpi-v">${p.blocked.length ? p.blocked.length : 'OK'}</div><div class="kpi-d">${p.blocked.length ? 'blokovaných operací' : 'vše potřebné je vybráno nebo existuje'}${p.missingInBundle.length ? ` · v exportu chybí: ${esc(p.missingInBundle.join(', '))}` : ''}</div></article>
          <article class="kpi"><div class="kpi-top"><span class="tile docker">${icon('check', 18)}</span>Neschváleno</div><div class="kpi-v">${p.unapproved.length}</div><div class="kpi-d">${remote ? 'vzdálený import vyžaduje schválení' : 'místní soubor – schváleno výběrem'}</div></article>
        </div>
        <div id="ot"></div>
        ${done ? `<div class="card"><h2>${icon(st.status === 'done' ? 'check' : 'alert', 17)}Výsledek importu</h2><p class="muted" style="margin:0">${st.results.filter((r) => r.status === 'done').length} hotovo · ${st.results.filter((r) => r.status === 'skipped').length} přeskočeno · ${st.results.filter((r) => r.status === 'failed').length} chyb · dokončeno ${esc(fmtDate(st.finished))}</p></div>`
    : `<div class="card"><h2>${icon('folder', 17)}Cílové cesty</h2><p class="muted small" style="margin:0 0 8px">Importované soubory a konfigurace budou zapsány sem (datový adresář <code>${esc(st.dataDir)}</code>):</p>
          <pre>${esc(p.targets.join('\n') || '(nic)')}</pre>
          <label class="check" style="margin-top:10px"><input type="checkbox" id="confirm"> Potvrzuji cílové cesty a pořadí operací</label>
          <div class="row" style="margin-top:12px"><button type="button" class="btn primary" id="runImp" disabled>${icon('play', 15)}Spustit import (${p.selected})</button><span class="muted small" id="runWhy"></span></div></div>`}`;
      table($('#ot', host), {
        id: 'importops', rows: st.ops, rowKey: (o) => o.id, placeholder: 'Hledat operaci…', group: 'section', pageSize: 500,
        groups: [{ key: 'section', label: 'sekce', value: (o) => o.section, order: (a, b) => p.order.indexOf(a) - p.order.indexOf(b), render: (k) => `<b>${p.order.indexOf(k) + 1}. ${esc(secTitle[k] || k)}</b>` }, { key: 'action', label: 'akce', value: (o) => o.action }],
        columns: [
          { key: 'selected', label: '', sort: false, render: (o) => `<input type="checkbox" data-sel="${esc(o.id)}" aria-label="Vybrat ${esc(o.title)}"${o.selected ? ' checked' : ''}${done ? ' disabled' : ''}>` },
          { key: 'title', label: 'Položka', render: (o) => `${cellMain(o.section === 'content' ? 'git' : o.section === 'repos' ? 'npm' : 'x', o.title, o.warnings && o.warnings.length ? `⚠ ${o.warnings.join(' · ')}` : o.section, o.section === 'content' ? 'folder' : o.section === 'repos' ? 'repo' : o.section === 'users' ? 'users' : o.section === 'tokens' || o.section === 'server' || o.section === 'secret' ? 'key' : 'file')}${o.section === 'repos' && !done ? `<input class="rename" data-ren="${esc(o.key)}" value="${esc(o.rename || '')}" placeholder="nový název (volitelně)">` : ''}` },
          { key: 'action', label: 'Akce', render: (o) => (done || ws ? `<span class="badge ${ACTION[o.action][0]}">${ACTION[o.action][1]}</span>` : `<select data-ovr="${esc(o.id)}" class="inline-select"><option value="">${ACTION[o.action][1]}${o.override ? '' : ' (výchozí)'}</option>${o.exists ? '<option value="overwrite">přepsat</option><option value="skip">přeskočit</option>' : ''}</select>`) },
          { key: 'target', label: 'Cíl', toggle: true, hidden: true, render: (o) => `<code class="small">${esc(o.target)}</code>` },
          { key: 'size', label: 'Velikost', align: 'right', render: (o) => (o.size ? `<span class="mono">${fmtBytes(o.size)}</span>` : '') },
          { key: 'deps', label: 'Závislosti', sort: false, render: (o) => (o.deps || []).map((d) => `<span class="badge ${d.selected ? 'ok' : d.inBundle ? 'warn' : 'off'}" title="${d.selected ? 'vybráno' : d.inBundle ? 'v exportu, nevybráno' : 'chybí'}">${esc(d.title)}</span>`).join(' ') || '<span class="muted small">–</span>' },
          { key: 'approved', label: 'Schválení', value: (o) => (o.approved ? 1 : 0), render: (o) => (done ? '' : o.approved ? `<button type="button" class="btn small ghost" data-revoke="${esc(o.id)}" title="Zrušit schválení">${icon('check', 14)}schváleno</button>` : `<button type="button" class="btn small" data-approve="${esc(o.id)}">Schválit</button>`) },
          { key: 'status', label: 'Stav', value: (o) => (results[o.id] || {}).status || '', render: (o) => { const r = results[o.id]; if (r) return `<span class="badge ${r.status === 'done' ? 'ok' : r.status === 'failed' ? 'off' : 'plain'}" title="${esc(r.message)}">${esc(r.status === 'done' ? 'hotovo' : r.status === 'failed' ? 'chyba' : 'přeskočeno')}</span> <span class="small muted">${esc(r.message)}</span>`; return o.blocked ? '<span class="badge off">blokováno</span>' : o.selected ? '<span class="badge blue">připraveno</span>' : '<span class="muted small">nevybráno</span>'; } },
        ],
        rowClass: (o) => (o.selected ? '' : 'dim'),
        onRender: (el) => {
          $$('[data-sel]', el).forEach((c) => { c.onchange = () => update({ select: { [c.dataset.sel]: c.checked } }); });
          $$('[data-ovr]', el).forEach((sel) => { sel.onchange = () => update({ overrides: { [sel.dataset.ovr]: sel.value || null } }); });
          $$('[data-ren]', el).forEach((inp) => { inp.onchange = () => update({ renames: { [inp.dataset.ren]: inp.value.trim() } }, 'Název změněn'); });
          $$('[data-approve]', el).forEach((b) => { b.onclick = () => update({ approve: [b.dataset.approve] }); });
          $$('[data-revoke]', el).forEach((b) => { b.onclick = () => update({ revoke: [b.dataset.revoke] }); });
        },
      });
      bindHead();
      if (done) return;
      $('#conflict', host).onchange = (e) => update({ conflict: e.target.value });
      $('#tmode', host).onchange = (e) => update({ target: { mode: e.target.value, path: $('#wsp', host).value } });
      $('#wsp', host).onchange = (e) => update({ target: { mode: 'workspace', path: e.target.value } });
      $('#deps', host).onclick = () => update({ includeDependencies: true }, 'Závislosti doplněny');
      $('#selAll', host).onclick = () => update({ select: Object.fromEntries(st.sections.map((s) => [s.id, true])) });
      $('#selNone', host).onclick = () => update({ select: Object.fromEntries(st.sections.map((s) => [s.id, false])) });
      const appr = $('#apprAll', host);
      if (appr) appr.onclick = async () => { if (await confirmBox(`Schválit všech ${p.selected} vybraných operací ze vzdáleného zdroje ${st.source.url}?`)) update({ approve: 'selected' }, 'Schváleno'); };
      const runBtn = $('#runImp', host);
      const why = () => {
        const reasons = [];
        if (!$('#confirm', host).checked) reasons.push('potvrďte cílové cesty');
        if (p.blocked.length) reasons.push(`${p.blocked.length} operací má nesplněné závislosti`);
        if (p.unapproved.length) reasons.push(`${p.unapproved.length} operací není schváleno`);
        if (!p.selected) reasons.push('nic není vybráno');
        runBtn.disabled = reasons.length > 0;
        $('#runWhy', host).textContent = reasons.join(' · ');
      };
      $('#confirm', host).onchange = why;
      why();
      runBtn.onclick = async () => {
        if (!(await confirmBox(`Spustit import ${p.selected} operací${ws ? ' do workspace' : ' do běžícího registru'}?`))) return;
        runBtn.disabled = true;
        $('#runWhy', host).textContent = 'Importuji…';
        const r = await run(() => rr.runImport(id, { confirmPaths: true })).catch(() => null);
        if (r) toast(r.status === 'done' ? 'Import dokončen' : 'Import dokončen s chybami', r.status !== 'done');
        try {
          st = await rr.getImport(id);
          draw();
        } catch (e) {
          if (e.status !== 401) throw e;
          // imported server credentials replaced the ones this page signed in with
          toast('Importované přihlašovací údaje platí – přihlaste se znovu.', true);
          setTimeout(logout, 1500);
        }
      };
    }
    function bindHead() {
      $('#discard', host).onclick = async () => { if (await confirmBox('Zahodit import? Dočasná data budou smazána.')) { await run(() => rr.deleteImport(id), 'Zahozeno'); location.hash = '#/settings?tab=import'; } };
    }
    draw();
    return v;
  }

  views.clients = async () => {
    const list = await rr.listClients();
    const base = serverBase();
    const v = setView('Klientské balíčky', `
      <div class="card"><h2>Rychlá instalace</h2><pre>curl -fsSL ${esc(base)}/install.sh | bash                    # vše
curl -fsSL ${esc(base)}/install.sh | bash -s -- rr_bash-cli    # jen bash CLI</pre>
        ${me.role === 'admin' ? `<div class="row" style="margin-top:10px"><button class="btn" id="rebuild">${icon('refresh', 15)}Přegenerovat klientské knihovny ze specifikace API</button></div>` : ''}</div>
      ${list.map((p) => `<div class="card"><h2>${esc(p.name)} <span class="badge blue">v${esc(p.version)}</span></h2><p>${esc(p.description)}</p>
        <pre>${esc(p.npmInstall)}</pre><div class="row" style="margin-top:8px"><a class="btn" href="${esc(p.download)}">${icon('download', 15)}${esc(p.file)}</a>
        <span class="muted small">${fmtBytes(p.size)} · ${p.files} souborů · příkazy: ${esc(p.bin.join(', ') || '–')} · maintainer ${esc(p.maintainer)}</span></div></div>`).join('')}`, 'download');
    const b = $('#rebuild', v);
    if (b) b.onclick = async () => { const r = await run(() => rr.rebuildClients(), 'Klienti přegenerováni'); toast(`Publikováno: ${r.published.join(', ') || 'nic nového (verze již existují)'}`); };
  };

  // ------------------------------------------------------------------ routing & shell
  const VIEW_NAV = { repo: 'repos', pkg: 'packages' };
  async function route() {
    const [p] = location.hash.replace(/^#\/?/, '').split('?');
    const [name, ...args] = p.split('/').filter(Boolean);
    const view = views[name] ? name : 'dashboard';
    $$('#nav a').forEach((a) => { const on = a.dataset.view === (VIEW_NAV[view] || view); a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('#sidebar').classList.remove('open');
    try {
      await views[view](...args.map(decodeURIComponent));
    } catch (e) {
      if (e.status === 401) return logout();
      setView('Chyba', `<div class="card"><p class="error">${esc(e.message)}</p>${e.status === 403 ? '<p class="muted">Nemáte oprávnění pro tuto sekci.</p>' : ''}</div>`, 'alert');
    }
  }

  function makeClient(server, token) {
    rr = new RRClient({ baseUrl: server || CFG.baseUrl || '', token });
  }

  function showLogin(err) {
    // attached to the AI Tools Portal: one click signs in with the portal account (single sign-on)
    $('#portalLogin').classList.toggle('hidden', !CFG.portal);
    wm.closeAll();
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#lServer').value = LS.get('server');
    if (CFG.standalone) $('#lServer').closest('label').classList.add('hidden');
    $('#loginErr').textContent = err || '';
  }

  // theme: dark | light | auto
  const THEMES = ['dark', 'light', 'auto'];
  function applyTheme(t) {
    const eff = t === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t;
    document.documentElement.dataset.theme = eff;
    const b = $('#themeBtn');
    if (b) b.innerHTML = `${icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'eye', 15)}<span>${t === 'light' ? 'Světlý' : t === 'dark' ? 'Tmavý' : 'Podle systému'}</span>`;
  }
  function cycleTheme() {
    const cur = RRUI.LS.get('theme', 'dark');
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    RRUI.LS.set('theme', next);
    applyTheme(next);
    toast(`Motiv: ${next === 'light' ? 'světlý' : next === 'dark' ? 'tmavý' : 'podle systému'}`);
  }

  function openPalette() {
    if (!me) return;
    const nav = $$('#nav a').filter((a) => !a.classList.contains('hidden')).map((a) => ({ title: a.textContent.trim(), icon: (a.querySelector('path') && Object.keys(RRUI.ICONS).find((k) => RRUI.ICONS[k] === a.querySelector('path').getAttribute('d'))) || 'chevron', group: 'sekce', run: () => { location.hash = a.getAttribute('href'); } }));
    const actions = [
      ...(isAdmin() ? [{ title: 'Nový repozitář', icon: 'plus', group: 'akce', run: () => repoForm() }, { title: 'Živý log požadavků v okně', icon: 'terminal', group: 'akce', run: liveLogWindow }] : []),
      { title: 'Přepnout motiv (tmavý / světlý / systém)', icon: 'moon', group: 'akce', keywords: 'theme dark light', run: cycleTheme },
      { title: 'Uspořádat okna do dlaždic', icon: 'grid', group: 'okna', run: () => wm.tile() },
      { title: 'Zavřít všechna okna', icon: 'x', group: 'okna', run: () => wm.closeAll() },
      { title: 'Odhlásit', icon: 'logout', group: 'akce', run: logout },
    ];
    const repos = repoCache.map((r) => ({ title: r.name, hint: r.type, icon: TYPE_ICON[r.type] || 'repo', group: 'repozitář', run: () => { location.hash = `#/repo/${enc(r.name)}`; } }));
    RRUI.palette({
      items: [...nav, ...actions, ...repos],
      search: async (q) => {
        const res = await rr.search({ q, size: 12 });
        return res.objects.map((o) => ({ title: o.package.name, hint: o.package.version, icon: 'package', group: o.repository, run: () => { location.hash = `#/pkg/${enc(o.repository)}/${enc(o.package.name)}`; } }))
          .concat([{ title: `Hledat „${q}“ ve všech balíčcích`, icon: 'search', group: 'hledání', run: () => { location.hash = `#/search?q=${enc(q)}`; } }]);
      },
    });
  }

  async function start() {
    makeClient(LS.get('server'), LS.get('token'));
    if (!rr.token) {
      // AI Tools Portal single sign-on: behind the portal gateway the logged-in portal user is
      // identified by the gateway (signed header) — no token and no login form needed.
      me = await rr.whoami().catch(() => null);
      if (!me || me.via !== 'portal') return showLogin();
    } else {
      try {
        me = await rr.whoami();
      } catch (e) {
        LS.set('token', '');
        return showLogin(e.status === 401 ? '' : e.message);
      }
    }
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#who').textContent = me.name;
    $('#whoRole').textContent = `${me.role}${me.readonly ? ' · jen čtení' : ''}${me.via === 'portal' ? ' · portál' : ''}`;
    $('#avatar').textContent = me.name.slice(0, 2);
    const st = await rr.status().catch(() => null);
    if (st) { $('#serverInfo').textContent = `${st.title} ${st.version} · ${st.registry}`; document.title = `${st.title} – administrace`; }
    repoCache = await rr.listRepos().catch(() => []);
    const adminOnly = ['routes', 'cache', 'users', 'settings', 'logs', 'webhooks', 'jobs'];
    adminOnly.forEach((v) => $(`#nav a[data-view="${v}"]`).classList.toggle('hidden', !isAdmin()));
    $('#newBtn').classList.toggle('hidden', !isAdmin());
    $('#liveLogBtn').classList.toggle('hidden', !isAdmin());
    route();
  }

  function logout() {
    // portal SSO: log out of the portal (ends the session in every attached app)
    if (me && me.via === 'portal') { location.href = '/_portal/auth/logout'; return; }
    if (rr && rr.token) rr.logout().catch(() => {});
    LS.set('token', '');
    me = null;
    showLogin();
  }

  RRUI.hydrate(document);
  wm.init($('#wm'), $('#dock'));
  applyTheme(RRUI.LS.get('theme', 'dark'));
  let loginMode = 'password';
  $$('#loginTabs button').forEach((b) => {
    b.onclick = () => {
      loginMode = b.dataset.mode;
      $$('#loginTabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('#loginForm > div[data-mode]').forEach((d) => d.classList.toggle('hidden', d.dataset.mode !== loginMode));
    };
  });
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const server = $('#lServer').value.trim().replace(/\/+$/, '');
    makeClient(server, '');
    try {
      if (loginMode === 'token') rr.setToken($('#lToken').value.trim());
      else await rr.signIn($('#lUser').value, $('#lPass').value);
      await rr.whoami();
      LS.set('server', server);
      LS.set('token', rr.token);
      $('#lPass').value = '';
      start();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  };
  $('#logout').onclick = logout;
  $('#themeBtn').onclick = cycleTheme;
  $('#cmdBtn').onclick = openPalette;
  $('#liveLogBtn').onclick = liveLogWindow;
  $('#newBtn').onclick = () => repoForm();
  $('#menuToggle').onclick = () => $('#sidebar').classList.toggle('open');
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    else if (e.key === '/' && !typing && me && !$('.palette-wrap')) { e.preventDefault(); openPalette(); }
  });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (RRUI.LS.get('theme', 'dark') === 'auto') applyTheme('auto'); });
  window.addEventListener('hashchange', () => { if (rr && rr.token && me) route(); });
  start();
})();

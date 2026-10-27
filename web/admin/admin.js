/* RR Registry - web administration. All server calls go through the generated RRClient library. */
(function () {
  'use strict';
  const CFG = window.RR_CONFIG || {};
  const LS = {
    get(k) { try { return localStorage.getItem(`rr.${k}`) || ''; } catch { return ''; } },
    set(k, v) { try { if (v) localStorage.setItem(`rr.${k}`, v); else localStorage.removeItem(`rr.${k}`); } catch { /* ignore */ } },
  };
  let rr = null;
  let me = null;
  let refreshTimer = null;

  // ------------------------------------------------------------------ helpers
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enc = encodeURIComponent;
  const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const fmtDate = (s) => (s ? new Date(s).toLocaleString() : '');
  const yes = (b) => (b ? '<span class="badge ok">ano</span>' : '<span class="badge off">ne</span>');
  const serverBase = () => (rr.baseUrl || location.origin);
  const registryUrl = (repo, def) => `${serverBase()}${def ? '' : `/r/${repo}`}/`;

  function toast(msg, err) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${err ? ' err' : ''}`;
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.add('hidden'), err ? 6000 : 2500);
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

  function modal(html, onMount) {
    const m = $('#modal');
    $('#modalBody').innerHTML = html;
    m.classList.remove('hidden');
    const close = () => m.classList.add('hidden');
    m.onclick = (e) => { if (e.target === m) close(); };
    $$('[data-close]', m).forEach((b) => { b.onclick = close; });
    if (onMount) onMount($('#modalBody'), close);
    const first = $('input,select,textarea', m);
    if (first) first.focus();
    return close;
  }

  function confirmBox(text) {
    return new Promise((resolve) => {
      modal(`<h2>Potvrzení</h2><p>${esc(text)}</p><div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn danger" id="cfOk">Potvrdit</button></div>`, (el, close) => {
        $('#cfOk', el).onclick = () => { close(); resolve(true); };
        $$('[data-close]', el).forEach((b) => { b.onclick = () => { close(); resolve(false); }; });
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

  function setView(title, html) {
    $('#title').textContent = title;
    $('#view').innerHTML = html;
    return $('#view');
  }

  function repoSelect(repos, current, onlyNpm) {
    return `<select id="repoSel">${repos.filter((r) => !onlyNpm || r.type === 'npm').map((r) => `<option value="${esc(r.name)}"${r.name === current ? ' selected' : ''}>${esc(r.name)} (${esc(r.type)})</option>`).join('')}</select>`;
  }

  // ------------------------------------------------------------------ views
  const views = {};

  views.dashboard = async () => {
    const [st, logs] = await Promise.all([rr.status(), me.role === 'admin' ? rr.getLogs({ limit: 12, type: 'audit' }) : { audit: [] }]);
    const v = setView('Přehled', `
      <div class="grid">
        <div class="card"><div class="muted">Verze</div><div class="stat">${esc(st.version)}</div><div class="muted small">Node ${esc(st.node)}</div></div>
        <div class="card"><div class="muted">Repozitáře</div><div class="stat">${st.repos}</div><div class="muted small">výchozí: ${esc(st.defaultRepo)}</div></div>
        <div class="card"><div class="muted">Balíčky</div><div class="stat">${st.packages}</div><div class="muted small">stažení: ${st.stats.downloads}</div></div>
        <div class="card"><div class="muted">Směrovací pravidla</div><div class="stat">${st.routes}</div><div class="muted small">proxy požadavků: ${st.stats.proxied}</div></div>
        <div class="card"><div class="muted">Cache</div><div class="stat">${st.cache.entries}</div><div class="muted small">${fmtBytes(st.cache.bytes)} · hit ${st.cache.hits} / miss ${st.cache.misses}</div></div>
        <div class="card"><div class="muted">Uptime</div><div class="stat">${Math.round(st.uptime / 60)} min</div><div class="muted small">požadavků: ${st.stats.requests}, chyb: ${st.stats.errors}</div></div>
      </div>
      <div class="card"><h2>Připojení npm / yarn / pnpm / bun</h2>
        <pre>npm config set registry ${esc(st.registry)}
npm login --registry ${esc(st.registry)} --auth-type=legacy
# nebo do .npmrc:
registry=${esc(st.registry)}
${esc(st.registry.replace(/^https?:/, ''))}:_authToken=&lt;token&gt;

yarn config set npmRegistryServer ${esc(st.registry)}     # yarn berry
pnpm config set registry ${esc(st.registry)}
bun install --registry ${esc(st.registry)}</pre></div>
      <div class="card"><h2>Docker image</h2>
        <pre>docker login ${esc(st.registry.replace(/^https?:\/\//, '').replace(/\/$/, ''))} -u &lt;uživatel&gt;      # heslo nebo token
docker tag moje-image ${esc(st.registry.replace(/^https?:\/\//, '').replace(/\/$/, ''))}/tym/moje-image:1.0
docker push ${esc(st.registry.replace(/^https?:\/\//, '').replace(/\/$/, ''))}/tym/moje-image:1.0
docker pull ${esc(st.registry.replace(/^https?:\/\//, '').replace(/\/$/, ''))}/tym/moje-image:1.0</pre>
        <p class="muted small">Jiný host než localhost vyžaduje HTTPS (reverse proxy) nebo položku "insecure-registries" v nastavení Docker démona.</p></div>
      <div class="card"><h2>Poslední změny</h2>
        <div class="table-wrap"><table><tr><th>Čas</th><th>Uživatel</th><th>Akce</th><th>Cíl</th></tr>
        ${logs.audit.map((a) => `<tr><td>${fmtDate(a.time)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">zatím nic</td></tr>'}
        </table></div></div>`);
    return v;
  };

  views.repos = async () => {
    const repos = await rr.listRepos();
    const v = setView('Repozitáře', `
      <div class="row"><button class="btn primary" id="newRepo">+ Nový repozitář</button></div>
      <div class="card table-wrap"><table>
        <tr><th>Název</th><th>Typ</th><th>Balíčky</th><th>Veřejný</th><th>Publikace</th><th>URL</th><th>Popis</th><th></th></tr>
        ${repos.map((r) => `<tr class="click" data-repo="${esc(r.name)}">
          <td><b>${esc(r.name)}</b> ${r.default ? '<span class="badge blue">výchozí</span>' : ''}</td><td>${esc(r.type)}</td><td>${r.packages ?? '–'}</td>
          <td>${yes(r.public)}</td><td>${yes(r.allowPublish)}</td><td><code>${esc(registryUrl(r.name, r.default))}</code></td><td>${esc(r.description)}</td>
          <td class="actions"><button class="btn small" data-edit="${esc(r.name)}">Upravit</button> <button class="btn small danger" data-del="${esc(r.name)}">Smazat</button></td></tr>`).join('')}
      </table></div>`);
    $('#newRepo', v).onclick = () => repoForm();
    $$('tr[data-repo]', v).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('button')) location.hash = `#/repo/${enc(tr.dataset.repo)}`; }; });
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => repoForm(repos.find((r) => r.name === b.dataset.edit)); });
    $$('[data-del]', v).forEach((b) => { b.onclick = () => deleteRepo(b.dataset.del); });
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
          ${r.type === 'npm' || r.type === 'group' ? `<a class="btn primary" href="#/packages/${enc(r.name)}">📦 Balíčky</a>` : ''}
          ${r.type === 'git' ? `<a class="btn primary" href="#/git/${enc(r.name)}">🌿 Git repozitáře</a>` : ''}
          ${r.type === 'docker' ? `<a class="btn primary" href="#/images/${enc(r.name)}">🐳 Image</a>` : ''}
          <a class="btn" href="#/files/${enc(r.name)}">📁 Soubory</a>
          <button class="btn" id="edit">Upravit</button><button class="btn danger" id="del">Smazat</button>
        </div></div>
      <div class="card"><h2>Čištění (retence)</h2>
        <p>${c.enabled ? '<span class="badge ok">automaticky</span>' : '<span class="badge">ručně</span>'} ponechat ${c.maxVersions || '∞'} · max. stáří ${c.maxAgeDays ? `${c.maxAgeDays} dní` : '∞'}${c.prereleaseOnly ? ' · jen pre-release' : ''}${c.pattern ? ` · ${esc(c.pattern)}` : ''} · poslední běh ${r.cleanupLastRun ? fmtDate(r.cleanupLastRun) : '–'}</p>
        <div class="row"><button class="btn" id="preview">Náhled čištění</button><button class="btn danger" id="clean" ${r.immutable ? 'disabled' : ''}>Spustit čištění</button></div>
        <div id="cleanOut"></div></div>
      ${stats && stats.top.length ? `<div class="card table-wrap"><h2>Nejstahovanější</h2><table><tr><th>Položka</th><th>Stažení</th></tr>${stats.top.map((t) => `<tr><td>${esc(t.item)}</td><td>${t.downloads}</td></tr>`).join('')}</table></div>` : ''}
      <div class="card"><h2>Použití</h2><pre>${esc(usage(r, reg))}</pre></div>`);
    $('#edit', v).onclick = () => repoForm(r);
    $('#del', v).onclick = () => deleteRepo(r.name);
    const showClean = (res) => {
      $('#cleanOut', v).innerHTML = `<p>${res.dryRun ? 'Náhled' : 'Hotovo'}: ${res.actions.length} akcí${res.dryRun ? '' : `, uvolněno ${fmtBytes(res.freedBytes)}`}</p>
        <div class="table-wrap"><table>${res.actions.slice(0, 200).map((a) => `<tr><td>${esc(a.action)}</td><td><code>${esc(a.target)}</code></td><td class="muted small">${esc(a.reason || '')}</td></tr>`).join('')}</table></div>`;
    };
    $('#preview', v).onclick = async () => showClean(await run(() => rr.runCleanup(r.name, { dryRun: true })));
    $('#clean', v).onclick = async () => { if (await confirmBox(`Spustit čištění repozitáře ${r.name}? Smazaná data nelze obnovit.`)) showClean(await run(() => rr.runCleanup(r.name, { dryRun: false }), 'Čištění dokončeno')); };
  };

  views.packages = async (repoName) => {
    const repos = (await rr.listRepos()).filter((r) => r.type === 'npm' || r.type === 'group');
    if (!repos.length) return setView('Balíčky', '<div class="card">Žádný npm repozitář.</div>');
    const repo = repoName || (repos.find((r) => r.default) || repos[0]).name;
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const list = await rr.listPackages(repo, { q });
    const v = setView('Balíčky', `
      <div class="card row">
        <label>Repozitář ${repoSelect(repos, repo, true)}</label>
        <label style="flex:1">Filtr <input id="q" value="${esc(q)}" placeholder="název nebo popis"></label>
        <label>Publikovat .tgz <input type="file" id="upload" accept=".tgz,.tar.gz" multiple></label>
        <label>dist-tag <input id="tag" value="latest" style="width:100px"></label>
      </div>
      <div class="card table-wrap"><table>
        <tr><th>Balíček</th><th>Poslední</th><th>Verze</th><th>Tagy</th><th>Popis</th><th>Změněno</th></tr>
        ${list.map((p) => `<tr class="click" data-pkg="${esc(p.name)}" data-member="${esc(p.member || repo)}"><td><b>${esc(p.name)}</b></td><td>${esc(p.version)}</td><td>${p.versions}</td>
          <td>${Object.entries(p.distTags || {}).map(([t, ver]) => `<span class="badge">${esc(t)}: ${esc(ver)}</span>`).join(' ')}</td>
          <td>${esc(p.description)}</td><td>${fmtDate(p.modified)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">žádné balíčky</td></tr>'}
      </table></div>`);
    $('#repoSel', v).onchange = (e) => { location.hash = `#/packages/${enc(e.target.value)}`; };
    $('#q', v).onkeydown = (e) => { if (e.key === 'Enter') location.hash = `#/packages/${enc(repo)}?q=${enc(e.target.value)}`; };
    $('#upload', v).onchange = async (e) => {
      for (const f of e.target.files) await run(async () => rr.uploadPackage(repo, await readFile(f), { tag: $('#tag', v).value }), `Publikováno: ${f.name}`);
      route();
    };
    $$('tr[data-pkg]', v).forEach((tr) => { tr.onclick = () => { location.hash = `#/pkg/${enc(tr.dataset.member)}/${enc(tr.dataset.pkg)}`; }; });
  };

  views.pkg = async (repo, name) => {
    const d = await rr.getPackage(repo, name);
    const versions = Object.keys(d.versions).reverse();
    const reg = registryUrl(repo, (await rr.getRepo(repo)).default);
    const v = setView(name, `
      <div class="row"><a href="#/packages/${enc(repo)}">← balíčky v ${esc(repo)}</a></div>
      <div class="card"><h2>${esc(d.name)} <span class="badge blue">${esc(d['dist-tags'].latest)}</span></h2>
        <p>${esc(d.description)}</p>
        <p class="muted small">Správci: ${(d.maintainers || []).map((m) => esc(m.name)).join(', ')} · vytvořeno ${fmtDate(d.time.created)} · změněno ${fmtDate(d.time.modified)}</p>
        <pre>npm install ${esc(d.name)} --registry ${esc(reg)}</pre>
        <div class="row" style="margin-top:10px"><button class="btn danger" id="delPkg">Smazat celý balíček</button></div>
      </div>
      <div class="card"><h2>Dist-tagy</h2>
        <div class="row">${Object.entries(d['dist-tags']).map(([t, ver]) => `<span class="badge">${esc(t)} → ${esc(ver)} ${t !== 'latest' ? `<a href="#" data-untag="${esc(t)}">✕</a>` : ''}</span>`).join(' ')}</div>
        <div class="row" style="margin-top:10px"><input id="tagName" placeholder="tag (např. beta)" style="width:160px">
          <select id="tagVer" style="width:160px">${versions.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
          <button class="btn" id="setTag">Nastavit tag</button></div>
      </div>
      <div class="card table-wrap"><h2>Verze (${versions.length})</h2><table>
        <tr><th>Verze</th><th>Publikováno</th><th>Velikost</th><th>Publikoval</th><th>Stav</th><th></th></tr>
        ${versions.map((ver) => { const m = d.versions[ver]; return `<tr><td><b>${esc(ver)}</b></td><td>${fmtDate(d.time[ver])}</td><td>${fmtBytes(m.dist.size)}</td>
          <td>${esc((m._npmUser || {}).name || '')}</td><td>${m.deprecated ? `<span class="badge off">deprecated: ${esc(m.deprecated)}</span>` : ''}</td>
          <td class="actions"><button class="btn small" data-dl="${esc(ver)}">⬇ tgz</button> <button class="btn small" data-dep="${esc(ver)}">Deprecate</button> <button class="btn small danger" data-delv="${esc(ver)}">Smazat</button></td></tr>`; }).join('')}
      </table></div>
      <div class="card"><h2>README</h2><pre>${esc(d.readme || '(bez README)')}</pre></div>
      <div class="card"><h2>package.json (${esc(d['dist-tags'].latest)})</h2><pre>${esc(JSON.stringify(d.versions[d['dist-tags'].latest], null, 2))}</pre></div>`);
    $('#delPkg', v).onclick = async () => { if (await confirmBox(`Smazat ${name} se všemi verzemi?`)) { await run(() => rr.deletePackage(repo, name), 'Smazáno'); location.hash = `#/packages/${enc(repo)}`; } };
    $('#setTag', v).onclick = async () => { await run(() => rr.setDistTag(repo, name, $('#tagName', v).value, { version: $('#tagVer', v).value }), 'Tag nastaven'); route(); };
    $$('[data-untag]', v).forEach((a) => { a.onclick = async (e) => { e.preventDefault(); await run(() => rr.deleteDistTag(repo, name, a.dataset.untag), 'Tag smazán'); route(); }; });
    $$('[data-dl]', v).forEach((b) => { b.onclick = async () => download(await run(() => rr.downloadTarball(repo, name, b.dataset.dl)), `${name.split('/').pop()}-${b.dataset.dl}.tgz`); });
    $$('[data-dep]', v).forEach((b) => {
      b.onclick = () => modal(`<h2>Deprecate ${esc(name)}@${esc(b.dataset.dep)}</h2><label>Zpráva (prázdná = zrušit) <input id="msg"></label>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Uložit</button></div>`, (el, close) => {
        $('#ok', el).onclick = async () => { await run(() => rr.deprecateVersion(repo, name, b.dataset.dep, { message: $('#msg', el).value }), 'Uloženo'); close(); route(); };
      });
    });
    $$('[data-delv]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox(`Smazat ${name}@${b.dataset.delv}?`)) { await run(() => rr.deleteVersion(repo, name, b.dataset.delv), 'Verze smazána'); route(); } }; });
  };

  views.files = async (repoName, ...rest) => {
    const repos = await rr.listRepos();
    const repo = repoName || (repos.find((r) => r.default) || repos[0]).name;
    const path = `/${rest.map(decodeURIComponent).join('/')}`.replace(/\/+$/, '') || '/';
    const t = await rr.tree(repo, { path, depth: 1 });
    const parts = path.split('/').filter(Boolean);
    const link = (i) => `#/files/${enc(repo)}/${parts.slice(0, i).map(enc).join('/')}`;
    const v = setView('Soubory', `
      <div class="card row">
        <label>Repozitář ${repoSelect(repos, repo)}</label>
        <span class="spacer"></span>
        <label>Nahrát soubory <input type="file" id="up" multiple></label>
        <button class="btn" id="mk">+ Adresář</button>
      </div>
      <div class="card">
        <div class="crumbs"><a href="${link(0)}">📁 ${esc(repo)}</a>${parts.map((p, i) => ` / <a href="${link(i + 1)}">${esc(p)}</a>`).join('')}</div>
        <div class="table-wrap"><table>
          <tr><th>Název</th><th>Velikost</th><th>Změněno</th><th></th></tr>
          ${path !== '/' ? `<tr class="click" data-dir=".."><td>⬆ ..</td><td></td><td></td><td></td></tr>` : ''}
          ${(t.children || []).map((c) => `<tr class="click" data-${c.type === 'dir' ? 'dir' : 'file'}="${esc(c.name)}">
            <td>${c.type === 'dir' ? '📁' : '📄'} ${esc(c.name)}</td><td>${c.type === 'dir' ? '' : fmtBytes(c.size)}</td><td>${fmtDate(c.modified)}</td>
            <td class="actions">${c.type === 'file' ? `<button class="btn small" data-get="${esc(c.name)}">⬇</button> ` : ''}<button class="btn small danger" data-rm="${esc(c.name)}">Smazat</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">prázdný adresář</td></tr>'}
        </table></div>
      </div>`);
    const full = (n) => `${path === '/' ? '' : path}/${n}`;
    $('#repoSel', v).onchange = (e) => { location.hash = `#/files/${enc(e.target.value)}`; };
    $$('tr[data-dir]', v).forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('button')) return;
        location.hash = tr.dataset.dir === '..' ? link(parts.length - 1) : `${link(parts.length)}${parts.length ? '/' : ''}${enc(tr.dataset.dir)}`;
      };
    });
    $$('tr[data-file]', v).forEach((tr) => { tr.onclick = (e) => { if (!e.target.closest('button')) viewFile(repo, full(tr.dataset.file)); }; });
    $$('[data-get]', v).forEach((b) => { b.onclick = async () => download(await run(() => rr.readFile(repo, { path: full(b.dataset.get) })), b.dataset.get); });
    $$('[data-rm]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox(`Smazat ${full(b.dataset.rm)}?`)) { await run(() => rr.deleteFile(repo, { path: full(b.dataset.rm) }), 'Smazáno'); route(); } }; });
    $('#up', v).onchange = async (e) => {
      for (const f of e.target.files) await run(async () => rr.writeFile(repo, await readFile(f), { path: full(f.name) }), `Nahráno: ${f.name}`);
      route();
    };
    $('#mk', v).onclick = () => modal(`<h2>Nový adresář v ${esc(path)}</h2><label>Název <input id="dn"></label>
      <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
      $('#ok', el).onclick = async () => { await run(() => rr.mkdir(repo, { path: full($('#dn', el).value) })); close(); route(); };
    });
  };

  async function viewFile(repo, path) {
    const st = await run(() => rr.stat(repo, { path }));
    let content = '';
    const textLike = /\.(json|md|txt|js|ts|css|html|xml|ya?ml|sh|ini|cfg|conf|log|csv|toml)$/i.test(path);
    if (textLike && st.size < 512 * 1024) {
      const bytes = await run(() => rr.readFile(repo, { path }));
      content = new TextDecoder().decode(bytes);
      if (/\.json$/.test(path)) { try { content = JSON.stringify(JSON.parse(content), null, 2); } catch { /* keep raw */ } }
    } else content = '(binární nebo velký soubor – použijte stažení)';
    modal(`<h2>📄 ${esc(path)}</h2><p class="muted small">${fmtBytes(st.size)} · ${fmtDate(st.modified)}</p><pre>${esc(content)}</pre>
      <div class="row"><span class="spacer"></span><button class="btn" id="dl">⬇ Stáhnout</button><button class="btn" data-close>Zavřít</button></div>`, (el) => {
      $('#dl', el).onclick = async () => download(await run(() => rr.readFile(repo, { path })), path.split('/').pop());
    });
  }

  views.images = async (repoName, ...rest) => {
    const repos = (await rr.listRepos()).filter((r) => r.type === 'docker');
    if (!repos.length) return setView('Docker image', '<div class="card"><p class="muted">Žádný docker repozitář — vytvořte ho v sekci Repozitáře (typ docker).</p></div>');
    const repo = repos.find((r) => r.name === repoName) || repos.find((r) => r.dockerDefault) || repos[0];
    const image = rest.length ? rest.join('/') : '';
    const host = location.host;
    if (image) {
      const tags = await rr.listImageTags(repo.name, image);
      const v = setView(`🐳 ${image}`, `
        <div class="row"><a class="btn" href="#/images/${enc(repo.name)}">← Image</a><span class="spacer"></span></div>
        <div class="card"><pre>docker pull ${esc(host)}/${esc(image)}:${esc(tags[0] ? tags[0].tag : 'latest')}</pre></div>
        <div class="card table-wrap"><table><tr><th>Tag</th><th>Digest</th><th>Typ</th><th>Velikost</th><th>Vytvořen</th><th></th></tr>
        ${tags.map((t) => `<tr><td><b>${esc(t.tag)}</b></td><td><code title="${esc(t.digest)}">${esc((t.digest || '').slice(0, 19))}…</code></td><td class="small muted">${esc((t.mediaType || '').replace('application/vnd.', ''))}</td><td>${fmtBytes(t.size)}</td><td>${fmtDate(t.created)}</td>
          <td class="actions"><button class="btn small danger" data-del="${esc(t.tag)}">Smazat</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">žádné tagy</td></tr>'}
        </table></div>`);
      $$('[data-del]', v).forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox(`Smazat tag ${image}:${b.dataset.del}? Data uvolní garbage collection.`))) return;
          await run(() => rr.deleteImageTag(repo.name, image, b.dataset.del), 'Tag smazán');
          route();
        };
      });
      return v;
    }
    const images = await rr.listImages(repo.name);
    const v = setView('🐳 Docker image', `
      <div class="row">${repos.length > 1 ? `<select id="dockerRepo">${repos.map((r) => `<option value="${esc(r.name)}"${r.name === repo.name ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : `<span class="muted">repozitář <b>${esc(repo.name)}</b> · API <code>${esc(host)}/v2/</code></span>`}
        <span class="spacer"></span>${me.role === 'admin' ? '<button class="btn" id="gc">🧹 Garbage collection</button>' : ''}</div>
      <div class="card table-wrap"><table><tr><th>Image</th><th>Tagy</th><th>Velikost (latest)</th><th>Aktualizace</th></tr>
      ${images.map((i) => `<tr class="click" data-img="${esc(i.name)}"><td><b>${esc(i.name)}</b></td><td>${i.tags}</td><td>${fmtBytes(i.size)}</td><td>${fmtDate(i.updated)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">zatím žádné image — viz Přehled → Docker image</td></tr>'}
      </table></div>`);
    const sel = $('#dockerRepo', v);
    if (sel) sel.onchange = () => { location.hash = `#/images/${enc(sel.value)}`; };
    $$('tr[data-img]', v).forEach((tr) => { tr.onclick = () => { location.hash = `#/images/${enc(repo.name)}/${tr.dataset.img.split('/').map(enc).join('/')}`; }; });
    const gc = $('#gc', v);
    if (gc) gc.onclick = async () => {
      const untagged = await confirmBox('Smazat i manifesty bez tagu? (Ne = jen nepoužívaná data)');
      const r = await run(() => rr.dockerGc(repo.name, { untagged }));
      if (r) toast(`Uvolněno ${fmtBytes(r.bytes)} — ${r.blobs} blobů, ${r.manifests} manifestů, ${r.uploads} nedokončených uploadů`);
      route();
    };
    return v;
  };

  // ---------------------------------------------------------------- git
  const gitBase = (repo) => `${serverBase()}${repo.gitDefault ? '/git' : `/r/${repo.name}`}`;
  const gitHash = (repo, name, params) => `#/git/${enc(repo.name)}/${name.split('/').map(enc).join('/')}${params ? `?${new URLSearchParams(params)}` : ''}`;

  views.git = async (repoName, ...rest) => {
    const repos = (await rr.listRepos()).filter((r) => r.type === 'git');
    if (!repos.length) return setView('Git', '<div class="card"><p class="muted">Žádný repozitář typu git – vytvořte ho v sekci Repozitáře (typ git).</p></div>');
    const repo = repos.find((r) => r.name === repoName) || repos.find((r) => r.gitDefault) || repos[0];
    const name = rest.join('/');
    if (name) return gitDetail(repo, name);
    const list = await rr.listGitRepos(repo.name);
    const v = setView('🌿 Git repozitáře', `
      <div class="card row">
        ${repos.length > 1 ? `<select id="gitRepo">${repos.map((r) => `<option value="${esc(r.name)}"${r.name === repo.name ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select>` : `<span class="muted">repozitář <b>${esc(repo.name)}</b></span>`}
        <span class="spacer"></span>
        <button class="btn primary" id="new">+ Nový</button><button class="btn" id="imp">⇣ Import / zrcadlo z URL</button><button class="btn" id="gh">GitHub import</button></div>
      <div class="card"><pre>git clone ${esc(gitBase(repo))}/&lt;název&gt;.git
git remote add rr ${esc(gitBase(repo))}/tym/projekt.git
git push rr main      # ${repo.autoCreate === false ? 'automatické vytvoření je vypnuto' : 'repozitář se při prvním push vytvoří automaticky'}</pre></div>
      <div class="card table-wrap"><table><tr><th>Název</th><th>Pull zrcadlo</th><th>Push zrcadla</th><th>Popis</th><th>Vytvořeno</th></tr>
        ${list.map((g) => `<tr class="click" data-g="${esc(g.name)}"><td><b>${esc(g.name)}</b></td>
          <td>${g.mirror ? `<span class="badge ${g.mirror.status === 'ok' ? 'ok' : g.mirror.status === 'error' ? 'off' : ''}">${esc(g.mirror.status || '')}</span> <span class="small muted">${esc(g.mirror.url)}</span>` : '–'}</td>
          <td>${g.pushMirrors || '–'}</td><td>${esc(g.description)}</td><td>${fmtDate(g.created)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">zatím žádné git repozitáře</td></tr>'}
      </table></div>`);
    const sel = $('#gitRepo', v);
    if (sel) sel.onchange = () => { location.hash = `#/git/${enc(sel.value)}`; };
    $$('tr[data-g]', v).forEach((tr) => { tr.onclick = () => { location.hash = gitHash(repo, tr.dataset.g); }; });
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
  };

  async function gitDetail(repo, name) {
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    const tab = q.get('tab') || 'files';
    const info = await rr.getGitRepo(repo.name, name);
    const ref = q.get('ref') || info.defaultBranch || 'HEAD';
    const path = q.get('path') || '';
    const link = (params) => gitHash(repo, name, { tab, ref, path, ...params });
    const tabs = [['files', 'Soubory'], ['commits', 'Commity'], ['branches', `Větve a tagy (${info.branches.length}/${info.tags.length})`], ['settings', 'Zrcadla a nastavení']];
    let body = '';
    if (info.empty && tab !== 'settings') {
      body = `<div class="card"><p class="muted">Prázdný repozitář. Pošlete první commit:</p><pre>git remote add rr ${esc(info.cloneUrl)}\ngit push rr main</pre></div>`;
    } else if (tab === 'files' || tab === 'file') {
      const parts = path.split('/').filter(Boolean);
      const crumbs = `<div class="crumbs"><a href="${link({ tab: 'files', path: '' })}">📁 ${esc(name.split('/').pop())}</a>${parts.map((p, i) => ` / <a href="${link({ tab: 'files', path: parts.slice(0, i + 1).join('/') })}">${esc(p)}</a>`).join('')}</div>`;
      if (tab === 'file') {
        const bytes = await rr.gitBlob(repo.name, name, { ref, path });
        const text = bytes.length < 512 * 1024 && !bytes.slice(0, 8000).includes(0) ? new TextDecoder().decode(bytes) : null;
        body = `<div class="card">${crumbs}<div class="row" style="margin:8px 0"><span class="muted small">${fmtBytes(bytes.length)}</span><span class="spacer"></span><button class="btn small" id="dlf">⬇ Stáhnout</button></div>
          <pre>${text === null ? '(binární soubor)' : esc(text)}</pre></div>`;
      } else {
        const t = await rr.gitTree(repo.name, name, { ref, path });
        const readme = t.entries.find((e) => e.type === 'file' && /^readme(\.md|\.txt)?$/i.test(e.name));
        let readmeText = '';
        if (readme) readmeText = new TextDecoder().decode(await rr.gitBlob(repo.name, name, { ref, path: readme.path }));
        body = `<div class="card">${crumbs}<div class="table-wrap"><table>
          ${path ? `<tr class="click" data-up="1"><td>⬆ ..</td><td></td></tr>` : ''}
          ${t.entries.map((e) => `<tr class="click" data-e="${esc(e.path)}" data-t="${e.type}"><td>${e.type === 'dir' ? '📁' : e.type === 'submodule' ? '🔗' : '📄'} ${esc(e.name)}</td><td>${e.type === 'file' ? fmtBytes(e.size) : ''}</td></tr>`).join('')}
          </table></div></div>${readmeText ? `<div class="card"><h2>${esc(readme.name)}</h2><pre>${esc(readmeText)}</pre></div>` : ''}`;
      }
    } else if (tab === 'commits') {
      const commits = await rr.gitCommits(repo.name, name, { ref, limit: 100 });
      body = `<div class="card table-wrap"><table><tr><th>Commit</th><th>Zpráva</th><th>Autor</th><th>Datum</th></tr>
        ${commits.map((c) => `<tr><td><a href="${link({ ref: c.commit, tab: 'files', path: '' })}"><code>${esc(c.short)}</code></a></td><td>${esc(c.subject)}</td><td>${esc(c.author)}</td><td>${fmtDate(c.date)}</td></tr>`).join('')}</table></div>`;
    } else if (tab === 'branches') {
      const row = (b, kind) => `<tr><td><a href="${link({ ref: b.name, tab: 'files', path: '' })}"><b>${esc(b.name)}</b></a> ${b.name === info.defaultBranch ? '<span class="badge blue">výchozí</span>' : ''}${info.protectedBranches.includes(b.name) ? ' <span class="badge">🔒 chráněná</span>' : ''}</td>
        <td><code>${esc(b.commit.slice(0, 8))}</code></td><td>${esc(b.subject)}</td><td>${fmtDate(b.date)}</td>
        <td class="actions"><button class="btn small" data-arch="${esc(b.name)}">⬇ tar.gz</button> <button class="btn small" data-zip="${esc(b.name)}">⬇ zip</button>${kind === 'branch' && b.name !== info.defaultBranch ? ` <button class="btn small" data-def="${esc(b.name)}">Výchozí</button>` : ''}</td></tr>`;
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
    const v = setView(`🌿 ${name}`, `
      <div class="row"><a href="#/git/${enc(repo.name)}">← git repozitáře</a></div>
      <div class="card"><div class="row"><h2 style="margin:0">${esc(name)}</h2>${info.mirror ? '<span class="badge blue">zrcadlo</span>' : ''}<span class="spacer"></span>
        <select id="ref">${[...info.branches.map((b) => b.name), ...info.tags.map((t) => t.name)].map((x) => `<option${x === ref ? ' selected' : ''}>${esc(x)}</option>`).join('')}${[...info.branches, ...info.tags].some((x) => x.name === ref) ? '' : `<option selected>${esc(ref)}</option>`}</select></div>
        <p class="muted">${esc(info.description)}</p>
        <div class="row"><code style="flex:1;min-width:0;overflow:auto">git clone ${esc(info.cloneUrl)}</code><button class="btn small" id="copy">Kopírovat</button>
          <button class="btn small" id="tgz">⬇ tar.gz</button><button class="btn small" id="zip">⬇ zip</button><span class="muted small">${fmtBytes(info.size)}</span></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${(tab === k || (tab === 'file' && k === 'files')) ? 'active' : ''}">${l}</button>`).join('')}</div>
      ${body}`);
    const archive = async (r, format) => download(await run(() => rr.gitArchive(repo.name, name, { ref: r, format })), `${name.split('/').pop()}-${r}.${format}`);
    $$('[data-tab]', v).forEach((b) => { b.onclick = () => { location.hash = link({ tab: b.dataset.tab }); }; });
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

  // ---------------------------------------------------------------- webhooks & events
  views.webhooks = async () => {
    const [hooks, ev, dels] = await Promise.all([rr.listWebhooks(), rr.listEvents({ limit: 30 }), rr.listWebhookDeliveries({ limit: 30 })]);
    const v = setView('🔔 Webhooky a události', `
      <div class="card"><p class="muted" style="margin-top:0">Webhooky posílají události registru (publikace, push, upload, mazání, synchronizace zrcadel, selhání replikace…) na zadané URL.
        Tělo je podepsané hlavičkou <code>X-RR-Signature-256: sha256=HMAC(secret, body)</code>; formáty JSON, Slack/Mattermost a Discord.</p>
        <button class="btn primary" id="new">+ Nový webhook</button></div>
      <div class="card table-wrap"><table><tr><th>Zap.</th><th>Název</th><th>Události</th><th>Repozitáře</th><th>URL</th><th>Formát</th><th>Poslední doručení</th><th></th></tr>
        ${hooks.map((h) => `<tr><td><input type="checkbox" data-toggle="${esc(h.id)}" ${h.enabled ? 'checked' : ''}></td><td><b>${esc(h.name)}</b></td><td>${h.events.map((e) => `<span class="badge">${esc(e)}</span>`).join(' ')}</td>
          <td>${esc(h.repos.join(', '))}</td><td><code>${esc(h.url)}</code></td><td>${esc(h.format)}</td>
          <td>${h.lastDelivery ? `<span class="badge ${h.lastDelivery.ok ? 'ok' : 'off'}">${h.lastDelivery.status}</span> ${fmtDate(h.lastDelivery.time)}` : '–'}</td>
          <td class="actions"><button class="btn small" data-test="${esc(h.id)}">Test</button> <button class="btn small" data-edit="${esc(h.id)}">Upravit</button> <button class="btn small danger" data-del="${esc(h.id)}">Smazat</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">žádné webhooky</td></tr>'}
      </table></div>
      <div class="card table-wrap"><h2>Doručení</h2><table><tr><th>Čas</th><th>Webhook</th><th>Událost</th><th>Stav</th><th>Pokus</th><th>ms</th><th>Chyba / odpověď</th></tr>
        ${dels.map((d) => `<tr><td>${fmtDate(d.time)}</td><td>${esc(d.hook)}</td><td>${esc(d.event)}</td><td><span class="badge ${d.ok ? 'ok' : 'off'}">${d.status}</span></td><td>${d.attempt}</td><td>${d.ms}</td><td class="small">${esc(d.error || d.response || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">zatím nic</td></tr>'}</table></div>
      <div class="card table-wrap"><h2>Poslední události</h2><table><tr><th>Čas</th><th>Událost</th><th>Repozitář</th><th>Uživatel</th><th>Detail</th></tr>
        ${ev.events.map((e) => `<tr><td>${fmtDate(e.time)}</td><td><span class="badge blue">${esc(e.type)}</span></td><td>${esc(e.repo || '')}</td><td>${esc(e.user)}</td><td class="small"><code>${esc(JSON.stringify(e.data).slice(0, 160))}</code></td></tr>`).join('') || '<tr><td colspan="5" class="muted">zatím nic</td></tr>'}</table></div>`);
    $('#new', v).onclick = () => hookForm(null, ev.types);
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => hookForm(hooks.find((h) => h.id === b.dataset.edit), ev.types); });
    $$('[data-del]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox('Smazat webhook?')) { await run(() => rr.deleteWebhook(b.dataset.del), 'Smazáno'); route(); } }; });
    $$('[data-toggle]', v).forEach((c) => { c.onchange = () => run(() => rr.updateWebhook(c.dataset.toggle, { enabled: c.checked }), c.checked ? 'Zapnuto' : 'Vypnuto'); });
    $$('[data-test]', v).forEach((b) => { b.onclick = async () => { const r = await run(() => rr.testWebhook(b.dataset.test)); toast(r.ok ? `OK (HTTP ${r.status}, ${r.ms} ms)` : `Chyba: ${r.error || `HTTP ${r.status}`}`, !r.ok); route(); }; });
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

  // ---------------------------------------------------------------- tasks & replication
  views.jobs = async () => {
    const [tasks, jobs] = await Promise.all([rr.listTasks(), rr.listReplications({ limit: 200 })]);
    const v = setView('⏱ Úlohy a replikace', `
      <div class="card table-wrap"><h2>Naplánované úlohy</h2><table><tr><th>Úloha</th><th>Interval</th><th>Poslední běh</th><th>Další běh</th><th>Výsledek</th><th></th></tr>
        ${tasks.map((t) => `<tr><td><b>${esc(t.name)}</b><div class="muted small">${esc(t.description)}</div></td><td>${t.intervalSec >= 3600 ? `${t.intervalSec / 3600} h` : `${t.intervalSec} s`}</td>
          <td>${fmtDate(t.lastRun) || '–'}</td><td>${fmtDate(t.nextRun) || '–'}</td>
          <td class="small">${t.running ? '<span class="badge blue">běží</span>' : t.lastError ? `<span class="error">${esc(t.lastError)}</span>` : (t.lastResult ? `<code>${esc(JSON.stringify(t.lastResult).slice(0, 120))}</code>` : '–')}</td>
          <td class="actions"><button class="btn small" data-run="${esc(t.id)}">▶ Spustit</button></td></tr>`).join('')}</table></div>
      <div class="card table-wrap"><h2>Replikace (pravidla „push“)</h2><table><tr><th>Vytvořeno</th><th>Stav</th><th>Pravidlo</th><th>Událost</th><th>Položka</th><th>Cíl</th><th>Pokusy</th><th>Chyba</th><th></th></tr>
        ${jobs.map((j) => `<tr><td>${fmtDate(j.created)}</td><td><span class="badge ${j.status === 'ok' ? 'ok' : j.status === 'error' ? 'off' : 'blue'}">${esc(j.status)}</span></td><td>${esc(j.ruleName)}</td><td>${esc(j.event)}</td>
          <td>${esc(j.repo)}/${esc(j.item)}</td><td class="small"><code>${esc(j.target)}</code></td><td>${j.attempts}</td><td class="small error">${esc(j.error || '')}</td>
          <td class="actions">${j.status === 'error' || j.status === 'ok' ? `<button class="btn small" data-retry="${esc(j.id)}">↻</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">zatím žádné replikace – vytvořte směrovací pravidlo s „push“</td></tr>'}</table></div>`);
    $$('[data-run]', v).forEach((b) => { b.onclick = async () => { await run(() => rr.runTask(b.dataset.run), 'Úloha dokončena'); route(); }; });
    $$('[data-retry]', v).forEach((b) => { b.onclick = async () => { await run(() => rr.retryReplication(b.dataset.retry), 'Zařazeno'); setTimeout(route, 800); }; });
  };

  views.search = async () => {
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const res = q ? await rr.search({ q, size: 100 }) : { objects: [], total: 0 };
    const v = setView('Hledání', `
      <div class="card row"><input id="q" value="${esc(q)}" placeholder="název, popis, keywords:xyz, scope:firma, maintainer:m5ike" style="flex:1"><button class="btn primary" id="go">Hledat</button></div>
      <div class="card table-wrap"><table><tr><th>Balíček</th><th>Verze</th><th>Repozitář</th><th>Popis</th></tr>
      ${res.objects.map((o) => `<tr class="click" data-r="${esc(o.repository)}" data-p="${esc(o.package.name)}"><td><b>${esc(o.package.name)}</b></td><td>${esc(o.package.version)}</td><td>${esc(o.repository)}</td><td>${esc(o.package.description)}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">${q ? 'nic nenalezeno' : 'zadejte dotaz'}</td></tr>`}
      </table></div>`);
    const go = () => { location.hash = `#/search?q=${enc($('#q', v).value)}`; };
    $('#go', v).onclick = go;
    $('#q', v).onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $$('tr[data-p]', v).forEach((tr) => { tr.onclick = () => { location.hash = `#/pkg/${enc(tr.dataset.r)}/${enc(tr.dataset.p)}`; }; });
  };

  views.routes = async () => {
    const [rules, repos] = await Promise.all([rr.listRoutes(), rr.listRepos()]);
    const v = setView('Směrování', `
      <div class="card"><p class="muted" style="margin-top:0">Routing plugin přesměrovává požadavky na jiné registry dle masky URL / části URL / klíče
        (<code>/~klic/…</code>, hlavička <code>X-RR-Key</code> nebo <code>?rr_key=</code>), hlavičky nebo pokud položka lokálně neexistuje.
        Vzdálený obsah se ukládá do cache a do vypršení platnosti se servíruje z ní.</p>
        <button class="btn primary" id="newRule">+ Nové pravidlo</button></div>
      <div class="card table-wrap"><table>
        <tr><th>Zap.</th><th>Prio</th><th>Název</th><th>Kdy</th><th>Maska</th><th>Repo</th><th>Klíč</th><th>Cíl</th><th>Cache</th><th></th></tr>
        ${rules.map((r) => `<tr><td><input type="checkbox" data-toggle="${esc(r.id)}" ${r.enabled ? 'checked' : ''}></td><td>${r.priority}</td><td style="min-width:160px"><b>${esc(r.name)}</b><div class="muted small">${esc(r.description || '')}</div></td>
          <td><span class="badge ${r.when === 'always' ? 'blue' : ''}">${r.when === 'always' ? 'vždy' : 'nenalezeno'}</span></td>
          <td><code>${esc(r.matchOn)}/${esc(r.matchType)}: ${esc(r.pattern || '*')}</code>${r.header ? `<div class="small">hlavička ${esc(r.header.name)} ~ ${esc(r.header.pattern || '*')}</div>` : ''}</td>
          <td>${esc(r.repo)}${r.repoType !== '*' ? ` (${esc(r.repoType)})` : ''}</td><td>${esc(r.key || '–')}</td><td><code>${esc(r.target)}</code></td><td>${r.cacheTtl == null ? 'výchozí' : `${r.cacheTtl} s`}</td>
          <td class="actions"><button class="btn small" data-edit="${esc(r.id)}">Upravit</button> <button class="btn small danger" data-del="${esc(r.id)}">Smazat</button></td></tr>`).join('') || '<tr><td colspan="10" class="muted">žádná pravidla</td></tr>'}
      </table></div>
      <div class="card"><h2>Test směrování</h2>
        <div class="form">
          <label>Cesta <input id="tPath" value="/@firma/utils" placeholder="/lodash nebo /@scope/name"></label>
          <label>Repozitář ${repoSelect(repos, repos.find((r) => r.default)?.name).replace('id="repoSel"', 'id="tRepo"')}</label>
          <label>Klíč <input id="tKey"></label>
          <label>Metoda <select id="tMethod"><option>GET</option><option>HEAD</option><option>POST</option><option>PUT</option></select></label>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn" id="test">Otestovat</button></div>
        <div id="tOut"></div>
      </div>`);
    $('#newRule', v).onclick = () => ruleForm(null, repos);
    $$('[data-edit]', v).forEach((b) => { b.onclick = () => ruleForm(rules.find((r) => r.id === b.dataset.edit), repos); });
    $$('[data-del]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox('Smazat pravidlo?')) { await run(() => rr.deleteRoute(b.dataset.del), 'Smazáno'); route(); } }; });
    $$('[data-toggle]', v).forEach((c) => { c.onchange = async () => { await run(() => rr.updateRoute(c.dataset.toggle, { enabled: c.checked }), c.checked ? 'Zapnuto' : 'Vypnuto'); }; });
    $('#test', v).onclick = async () => {
      const r = await run(() => rr.testRoute({ path: $('#tPath', v).value, repo: $('#tRepo', v).value, key: $('#tKey', v).value, method: $('#tMethod', v).value }));
      $('#tOut', v).innerHTML = `<p>Balíček: <code>${esc(r.request.packagePath || '–')}</code> · vždy: <b>${esc(r.always ? r.always.name : '–')}</b> · při nenalezení: <b>${esc(r.notfound ? r.notfound.name : '–')}</b></p>
        <table><tr><th></th><th>Pravidlo</th><th>Kdy</th><th>Cílová URL</th></tr>${r.rules.map((x) => `<tr><td>${x.matched ? '✅' : '❌'}</td><td>${esc(x.name)}</td><td>${esc(x.when)}</td><td><code>${esc(x.target)}</code></td></tr>`).join('')}</table>`;
    };
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

  views.cache = async () => {
    const q = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || '';
    const [s, list] = await Promise.all([rr.cacheStats(), rr.listCache({ q, limit: 300 })]);
    const v = setView('Cache', `
      <div class="grid">
        <div class="card"><div class="muted">Položek</div><div class="stat">${s.entries}</div><div class="muted small">expirovaných ${s.expired}</div></div>
        <div class="card"><div class="muted">Velikost</div><div class="stat">${fmtBytes(s.bytes)}</div></div>
        <div class="card"><div class="muted">Hit / Miss</div><div class="stat">${s.hits} / ${s.misses}</div><div class="muted small">stale ${s.stale} · chyby ${s.errors}</div></div>
      </div>
      <div class="card row"><input id="q" value="${esc(q)}" placeholder="filtr URL" style="flex:1"><button class="btn" id="filter">Filtrovat</button>
        <button class="btn" id="pExp">Smazat expirované</button><button class="btn" id="pQ">Smazat dle filtru</button><button class="btn danger" id="pAll">Smazat vše</button></div>
      <div class="card table-wrap"><table><tr><th>URL</th><th>Status</th><th>Velikost</th><th>Uloženo</th><th>Expirace</th><th></th></tr>
        ${list.entries.map((e) => `<tr><td><code>${esc(e.url)}</code></td><td>${e.status}</td><td>${fmtBytes(e.size)}</td><td>${fmtDate(e.created)}</td>
          <td>${e.expired ? '<span class="badge off">expirováno</span>' : fmtDate(e.expires)}</td><td class="actions"><button class="btn small danger" data-del="${esc(e.key)}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">cache je prázdná</td></tr>'}
      </table><p class="muted small">Zobrazeno ${list.entries.length} z ${list.total}</p></div>`);
    const purge = async (query, msg) => { const r = await run(() => rr.purgeCache(query)); toast(`${msg}: ${r.removed}`); route(); };
    $('#filter', v).onclick = () => { location.hash = `#/cache?q=${enc($('#q', v).value)}`; };
    $('#pExp', v).onclick = () => purge({ expired: 1 }, 'Smazáno expirovaných');
    $('#pQ', v).onclick = () => purge({ q: $('#q', v).value }, 'Smazáno');
    $('#pAll', v).onclick = async () => { if (await confirmBox('Smazat celou cache?')) purge({}, 'Smazáno'); };
    $$('[data-del]', v).forEach((b) => { b.onclick = async () => { await run(() => rr.deleteCacheEntry(b.dataset.del)); route(); }; });
  };

  views.users = async () => {
    const users = await rr.listUsers();
    const roles = ['publisher', 'reader', 'admin'];
    const v = setView('Uživatelé', `
      <div class="row"><button class="btn primary" id="new">+ Nový uživatel</button></div>
      <div class="card table-wrap"><table><tr><th>Jméno</th><th>Role</th><th>E-mail</th><th>Vytvořen</th><th></th></tr>
        ${users.map((u) => `<tr><td><b>${esc(u.name)}</b> ${u.builtin ? '<span class="badge blue">vestavěný (.env)</span>' : ''}</td>
          <td>${u.builtin ? 'admin' : `<select data-role="${esc(u.name)}">${roles.map((r) => `<option${r === u.role ? ' selected' : ''}>${r}</option>`).join('')}</select>`}</td>
          <td>${esc(u.email)}</td><td>${fmtDate(u.created)}</td>
          <td class="actions">${u.builtin ? '' : `<button class="btn small" data-pw="${esc(u.name)}">Heslo</button> <button class="btn small danger" data-del="${esc(u.name)}">Smazat</button>`}</td></tr>`).join('')}
      </table><p class="muted small">Role: <b>reader</b> – čtení, <b>publisher</b> – čtení a publikace, <b>admin</b> – vše. Uživatelé se mohou přihlásit i přes <code>npm login --auth-type=legacy</code>.</p></div>`);
    $('#new', v).onclick = () => modal(`<h2>Nový uživatel</h2><form class="form" id="f">
        <label>Jméno <input name="name" required></label><label>Heslo <input name="password" type="password" required></label>
        <label>E-mail <input name="email"></label><label>Role <select name="role">${roles.map((r) => `<option>${r}</option>`).join('')}</select></label></form>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
      $('#ok', el).onclick = async () => { await run(() => rr.createUser(formData($('#f', el))), 'Uživatel vytvořen'); close(); route(); };
    });
    $$('[data-role]', v).forEach((s) => { s.onchange = () => run(() => rr.updateUser(s.dataset.role, { role: s.value }), 'Role změněna'); });
    $$('[data-pw]', v).forEach((b) => {
      b.onclick = () => modal(`<h2>Heslo pro ${esc(b.dataset.pw)}</h2><label>Nové heslo <input type="password" id="pw"></label>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Uložit</button></div>`, (el, close) => {
        $('#ok', el).onclick = async () => { await run(() => rr.updateUser(b.dataset.pw, { password: $('#pw', el).value }), 'Heslo změněno'); close(); };
      });
    });
    $$('[data-del]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox(`Smazat uživatele ${b.dataset.del}?`)) { await run(() => rr.deleteUser(b.dataset.del), 'Smazáno'); route(); } }; });
  };

  views.tokens = async () => {
    const [tokens, users] = await Promise.all([rr.listTokens(), me.role === 'admin' ? rr.listUsers() : []]);
    const v = setView('Tokeny', `
      <div class="row"><button class="btn primary" id="new">+ Nový token</button></div>
      <div class="card table-wrap"><table><tr><th>ID</th><th>Název</th><th>Uživatel</th><th>Druh</th><th>Token</th><th>Jen čtení</th><th>Vytvořen</th><th>Použit</th><th>Expirace</th><th></th></tr>
        ${tokens.map((t) => `<tr><td><code>${esc(t.id)}</code></td><td>${esc(t.name)}</td><td>${esc(t.user)}</td><td>${esc(t.kind)}</td><td><code>${esc(t.preview)}</code></td><td>${yes(t.readonly)}</td>
          <td>${fmtDate(t.created)}</td><td>${fmtDate(t.lastUsed)}</td><td>${t.expires ? fmtDate(t.expires) : 'nikdy'}</td>
          <td class="actions"><button class="btn small danger" data-del="${esc(t.id)}">Zneplatnit</button></td></tr>`).join('') || '<tr><td colspan="10" class="muted">žádné tokeny</td></tr>'}
      </table><p class="muted small">Hlavní API token (RR_API_TOKEN) se nastavuje v <code>make menuconfig</code> a zde se nezobrazuje.</p></div>`);
    $('#new', v).onclick = () => modal(`<h2>Nový token</h2><form class="form" id="f">
        <label>Název <input name="name" value="ci"></label>
        ${me.role === 'admin' ? `<label>Pro uživatele <select name="user"><option value="">(já – ${esc(me.name)})</option>${users.filter((u) => !u.builtin).map((u) => `<option>${esc(u.name)}</option>`).join('')}</select></label>` : ''}
        <label>Platnost v sekundách (0 = navždy) <input name="ttl" type="number" value="0"></label>
        <label class="check"><input type="checkbox" name="readonly"> jen pro čtení</label></form>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
      $('#ok', el).onclick = async () => {
        const t = await run(() => rr.createToken(formData($('#f', el))));
        close();
        modal(`<h2>Token vytvořen</h2><p>Uložte si ho – znovu se nezobrazí.</p><pre>${esc(t.token)}</pre>
          <pre># .npmrc\n${esc(registryUrl('', true).replace(/^https?:/, ''))}:_authToken=${esc(t.token)}</pre>
          <div class="row"><span class="spacer"></span><button class="btn primary" data-close>Hotovo</button></div>`);
        route();
      };
    });
    $$('[data-del]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox('Zneplatnit token?')) { await run(() => rr.revokeToken(b.dataset.del), 'Token zneplatněn'); route(); } }; });
  };

  views.settings = async () => {
    const [s, repos, plugins] = await Promise.all([rr.getSettings(), rr.listRepos(), rr.listPlugins()]);
    const v = setView('Nastavení', `
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
      <div class="card"><h2>Konfigurace serveru (.env / make menuconfig)</h2><p class="muted">Port, heslo administrátora a API token se nastavují příkazem <code>make menuconfig</code> a projeví se po restartu kontejneru (<code>make restart</code>).</p></div>`);
    $('#save', v).onclick = async () => {
      const d = formData($('#f', v));
      d.plugins = $$('[data-plugin]', v).filter((c) => c.checked).map((c) => c.dataset.plugin);
      await run(() => rr.updateSettings(d), 'Nastavení uloženo');
    };
  };

  views.logs = async () => {
    const tab = new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'requests';
    const l = await rr.getLogs({ limit: 300 });
    const v = setView('Logy', `
      <div class="tabs"><button data-tab="requests" class="${tab === 'requests' ? 'active' : ''}">Požadavky</button><button data-tab="audit" class="${tab === 'audit' ? 'active' : ''}">Audit</button>
        <span class="spacer"></span><label class="check"><input type="checkbox" id="auto" ${refreshTimer ? 'checked' : ''}> auto-refresh</label></div>
      <div class="card table-wrap">${tab === 'audit'
    ? `<table><tr><th>Čas</th><th>Uživatel</th><th>Akce</th><th>Cíl</th></tr>${l.audit.map((a) => `<tr><td>${fmtDate(a.time)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td></tr>`).join('')}</table>`
    : `<table><tr><th>Čas</th><th>Status</th><th>Metoda</th><th>URL</th><th>ms</th><th>Uživatel</th><th>Cache</th></tr>${l.requests.map((r) => `<tr><td>${fmtDate(r.time)}</td><td><span class="badge ${r.status < 400 ? 'ok' : 'off'}">${r.status}</span></td><td>${esc(r.method)}</td><td><code>${esc(r.url)}</code></td><td>${r.ms}</td><td>${esc(r.user)}</td><td>${esc(r.cache)}</td></tr>`).join('')}</table>`}</div>`);
    $$('[data-tab]', v).forEach((b) => { b.onclick = () => { location.hash = `#/logs?tab=${b.dataset.tab}`; }; });
    $('#auto', v).onchange = (e) => {
      clearInterval(refreshTimer); refreshTimer = null;
      if (e.target.checked) refreshTimer = setInterval(() => { if (location.hash.startsWith('#/logs')) route(); else { clearInterval(refreshTimer); refreshTimer = null; } }, 3000);
    };
  };

  views.clients = async () => {
    const list = await rr.listClients();
    const base = serverBase();
    const v = setView('Klientské balíčky', `
      <div class="card"><h2>Rychlá instalace</h2><pre>curl -fsSL ${esc(base)}/install.sh | bash                    # vše
curl -fsSL ${esc(base)}/install.sh | bash -s -- rr_bash-cli    # jen bash CLI</pre>
        ${me.role === 'admin' ? '<div class="row" style="margin-top:10px"><button class="btn" id="rebuild">🔄 Přegenerovat klientské knihovny ze specifikace API</button></div>' : ''}</div>
      ${list.map((p) => `<div class="card"><h2>${esc(p.name)} <span class="badge blue">v${esc(p.version)}</span></h2><p>${esc(p.description)}</p>
        <pre>${esc(p.npmInstall)}</pre><div class="row" style="margin-top:8px"><a class="btn" href="${esc(p.download)}">⬇ ${esc(p.file)}</a>
        <span class="muted small">${fmtBytes(p.size)} · ${p.files} souborů · příkazy: ${esc(p.bin.join(', ') || '–')} · maintainer ${esc(p.maintainer)}</span></div></div>`).join('')}`);
    const b = $('#rebuild', v);
    if (b) b.onclick = async () => { const r = await run(() => rr.rebuildClients(), 'Klienti přegenerováni'); toast(`Publikováno: ${r.published.join(', ') || 'nic nového (verze již existují)'}`); };
  };

  // ------------------------------------------------------------------ routing & auth
  async function route() {
    const [p] = location.hash.replace(/^#\/?/, '').split('?');
    const [name, ...args] = p.split('/').filter(Boolean);
    const view = views[name] ? name : 'dashboard';
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === (view === 'repo' ? 'repos' : view === 'pkg' ? 'packages' : view)));
    $('.sidebar').classList.remove('open');
    try {
      await views[view](...args.map(decodeURIComponent));
    } catch (e) {
      if (e.status === 401) return logout();
      setView('Chyba', `<div class="card"><p class="error">${esc(e.message)}</p>${e.status === 403 ? '<p class="muted">Nemáte oprávnění pro tuto sekci.</p>' : ''}</div>`);
    }
  }

  function makeClient(server, token) {
    rr = new RRClient({ baseUrl: server || CFG.baseUrl || '', token });
  }

  function showLogin(err) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#lServer').value = LS.get('server');
    if (CFG.standalone) $('#lServer').closest('label').classList.add('hidden');
    $('#loginErr').textContent = err || '';
  }

  async function start() {
    makeClient(LS.get('server'), LS.get('token'));
    if (!rr.token) return showLogin();
    try {
      me = await rr.whoami();
    } catch (e) {
      LS.set('token', '');
      return showLogin(e.status === 401 ? '' : e.message);
    }
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#who').textContent = `${me.name} (${me.role}${me.readonly ? ', jen čtení' : ''})`;
    const st = await rr.status().catch(() => null);
    if (st) { $('#serverInfo').textContent = `${st.title} ${st.version} · ${st.registry}`; document.title = `${st.title} – administrace`; }
    if (me.role !== 'admin') ['routes', 'cache', 'users', 'settings', 'logs', 'webhooks', 'jobs'].forEach((v) => $(`#nav a[data-view="${v}"]`).classList.add('hidden'));
    route();
  }

  function logout() {
    if (rr && rr.token) rr.logout().catch(() => {});
    LS.set('token', '');
    showLogin();
  }

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
  $('#menuToggle').onclick = () => $('.sidebar').classList.toggle('open');
  window.addEventListener('hashchange', () => { if (rr && rr.token && me) route(); });
  start();
})();

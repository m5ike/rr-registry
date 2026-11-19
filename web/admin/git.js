/* RR Registry - git repositories in the web UI (GitHub-like). Loaded before admin.js, which calls
   RRGit(ctx) with its helpers and mounts the returned views.

   Routes (inside admin.js: #/git/<repository>/...; on the git type host the same path without "#/git/<repository>"):
     <repo>                                  list of git repositories           new  create (github.com/new)
     <repo>/<owner>/<name>                   code: files of the default branch + README
     .../tree/<ref>/<path>   .../blob/<ref>/<path>   .../commits/<ref>   .../commit/<sha>
     .../branches   .../tags   .../releases[/new | /tag/<tag> | /edit/<id>]   .../pulls[/<n>]   .../issues[/<n>]
     .../new/<ref>/<dir>   .../edit/<ref>/<path>   .../upload/<ref>/<dir>   .../settings?tab=...
   plus the view "profile" (SSH keys). */
(function () {
  'use strict';

  window.RRGit = function RRGit(ctx) {
    const { $, $$, esc, enc, icon, tile, cellMain, fmtBytes, fmtDate, when, toast, run, modal, confirmBox, formData, download, setView, table } = ctx;
    const rr = () => ctx.rr();
    const me = () => ctx.me();
    const go = (h) => { location.hash = h; };
    const isAdmin = () => me() && me().role === 'admin';
    const guest = () => !me() || me().guest;

    // ------------------------------------------------------------------ urls
    const segs = (s) => String(s).split('/').map(enc).join('/');
    /** #/git/<repo>/<name>/<parts...>?query  (parts may contain "/" - every segment is encoded) */
    function U(c, name, ...parts) {
      let q = '';
      if (parts.length && parts[parts.length - 1] && typeof parts[parts.length - 1] === 'object') {
        const o = Object.fromEntries(Object.entries(parts.pop()).filter(([, v]) => v !== undefined && v !== null && v !== ''));
        const s = new URLSearchParams(o).toString();
        if (s) q = `?${s}`;
      }
      const tail = parts.filter((p) => p !== '' && p !== undefined && p !== null).map(segs).join('/');
      return `#/git/${enc(c)}${name ? `/${segs(name)}` : ''}${tail ? `/${tail}` : ''}${q}`;
    }
    const listUrl = (c) => `#/git/${enc(c)}`;

    // ------------------------------------------------------------------ small helpers
    const TEXT_EXT = /\.(md|markdown|mdx|txt|json|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|bat|cmd|sql|graphql|proto|lua|pl|r|swift|dart|scala|clj|ex|exs|erl|hs|ml|nim|zig|tf|hcl|gradle|properties|csv|tsv|log|lock|gitignore|gitattributes|editorconfig|dockerignore|npmignore|prettierrc|eslintrc|babelrc|nvmrc)$/i;
    const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i;
    const MD_EXT = /\.(md|markdown|mdx)$/i;
    const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif' };
    const isBinary = (bytes) => bytes.slice(0, 8000).includes(0);
    const decode = (bytes) => new TextDecoder().decode(bytes);
    const short = (sha) => String(sha || '').slice(0, 7);
    const copy = (text) => { if (navigator.clipboard) navigator.clipboard.writeText(text); toast('Zkopírováno'); };
    const b64 = (bytes) => { let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); return btoa(s); };
    const joinPath = (...p) => p.filter(Boolean).join('/').replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
    function resolveRel(dir, href) {
      const out = [];
      for (const part of (href.startsWith('/') ? href.slice(1) : `${dir ? `${dir}/` : ''}${href}`).split('/')) {
        if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
      }
      return out.join('/');
    }

    const STATE_BADGE = (it) => (it.merged ? '<span class="badge blue">sloučeno</span>' : it.state === 'open' ? `<span class="badge ok">otevřeno</span>${it.draft ? ' <span class="badge plain">koncept</span>' : ''}` : '<span class="badge off">zavřeno</span>');
    const labelBadges = (it) => (it.labels || []).map((l) => `<span class="badge plain">${esc(l.name)}</span>`).join(' ');
    const MERGE_STATE = { clean: ['ok', 'Lze sloučit bez konfliktů'], dirty: ['off', 'Konflikty – nelze sloučit automaticky'], unknown: ['', 'Slučitelnost nelze určit'] };
    const visBadge = (g) => (g.private ? `<span class="badge warn">${icon('lock', 12)}soukromý</span>` : '<span class="badge plain">veřejný</span>');

    // repository names per git repository (to split a path into name and section)
    const nameCache = new Map();
    async function names(c, fresh) {
      const hit = nameCache.get(c);
      if (hit && !fresh && Date.now() - hit.t < 20000) return hit.list;
      const list = await rr().listGitRepos(c);
      nameCache.set(c, { t: Date.now(), list });
      return list;
    }
    const forget = (c) => nameCache.delete(c);

    /** Render markdown of a file at `path` (links resolved relative to its directory) and wire it up. */
    function markdown(text, { c, name, ref, path }) {
      const dir = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
      const html = window.RRMarkdown.render(text, {
        slugPrefix: 'md-',
        resolveLink: (href) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { href, internal: false };
          if (href.startsWith('#')) return { href: `#md-${href.slice(1).toLowerCase()}`, internal: true };
          const [p, frag] = href.split('#');
          let target;
          try { target = resolveRel(dir, decodeURIComponent(p)); } catch { target = resolveRel(dir, p); }
          // the anchor travels as ?anchor= (a second "#" would break the route) and is scrolled to after rendering
          const anchor = frag ? { anchor: `md-${frag.toLowerCase()}` } : undefined;
          return { href: target ? U(c, name, 'blob', ref, target, anchor) : U(c, name, 'tree', ref, anchor), internal: true };
        },
        resolveImage: (src) => (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') ? src : `rr-blob:${resolveRel(dir, decodeURIComponent(src.split('#')[0].split('?')[0]))}`),
      });
      return html;
    }

    /** After inserting rendered markdown: images from the repository, in-page anchors, internal links. */
    function mountMarkdown(el, { c, name, ref }) {
      const anchor = ctx.query().get('anchor');
      if (anchor) setTimeout(() => { const t = document.getElementById(anchor); if (t && el.contains(t)) t.scrollIntoView({ block: 'start' }); }, 50);
      $$('img', el).forEach(async (img) => {
        const src = img.getAttribute('src') || '';
        if (!src.startsWith('rr-blob:')) return;
        img.removeAttribute('src');
        const p = src.slice(8);
        try {
          const bytes = await rr().gitBlob(c, name, { ref, path: p });
          const ext = (p.split('.').pop() || '').toLowerCase();
          img.src = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
        } catch { img.alt = `${img.alt} (nenalezeno: ${p})`; }
      });
      $$('a[href]', el).forEach((a) => {
        const href = a.getAttribute('href');
        // "#md-section" anchors scroll inside the page instead of changing the route
        if (/^#md-/.test(href)) {
          a.onclick = (e) => {
            e.preventDefault();
            const t = document.getElementById(href.slice(1));
            if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
          };
        }
      });
    }

    // ------------------------------------------------------------------ the view
    async function view(cName, ...rest) {
      const containers = (await rr().listRepos()).filter((r) => r.type === 'git');
      if (!containers.length) return setView('Git', '<div class="card"><p class="muted">Žádný repozitář typu git – vytvořte ho v sekci Repozitáře (typ git).</p></div>', 'git');
      const TH = ctx.typeHost();
      const c = containers.find((r) => r.name === cName) || containers.find((r) => r.gitDefault) || (TH && containers.find((r) => r.name === TH.repo)) || containers[0];
      if (!rest.length) return repoList(c, containers);
      if (rest.length === 1 && rest[0] === 'new') return createPage(c, containers);
      const list = await names(c.name);
      // longest prefix of the path that is a repository name (names may contain "/", like owner/project)
      let k = 0;
      let name = null;
      for (let i = Math.min(rest.length, 4); i >= 1; i--) {
        const cand = rest.slice(0, i).join('/').replace(/\.git$/, '');
        if (list.some((g) => g.name === cand)) { k = i; name = cand; break; }
      }
      if (!name) {
        const fresh = await names(c.name, true);
        for (let i = Math.min(rest.length, 4); i >= 1; i--) {
          const cand = rest.slice(0, i).join('/').replace(/\.git$/, '');
          if (fresh.some((g) => g.name === cand)) { k = i; name = cand; break; }
        }
      }
      if (!name) {
        return setView('Nenalezeno', `<div class="card"><h2>${icon('alert', 18)}Repozitář nenalezen</h2><p class="muted"><code>${esc(rest.join('/'))}</code> neexistuje nebo k němu nemáte přístup.</p>
          <div class="row"><a class="btn" href="${listUrl(c.name)}">← git repozitáře</a>${guest() ? '<button class="btn primary" data-login>Přihlásit</button>' : ''}</div></div>`, 'git');
      }
      const section = rest[k] || 'code';
      const sub = rest.slice(k + 1);
      return repoPage(c, containers, name, section, sub);
    }

    // ------------------------------------------------------------------ list
    async function repoList(c, containers) {
      const list = await names(c.name, true);
      const TH = ctx.typeHost();
      const canCreate = !guest() && c.allowPublish !== false;
      const v = setView(TH ? 'Git repozitáře' : `Git · ${c.name}`, `<div id="t"></div>`, 'git');
      table('#t', {
        id: 'gitrepos', rows: list, rowKey: (g) => g.name, placeholder: 'Najít repozitář…', sort: { key: 'name', dir: 1 },
        groups: [
          { key: 'owner', label: 'vlastník', value: (g) => g.owner || (g.name.includes('/') ? g.name.split('/')[0] : '(bez vlastníka)') },
          { key: 'vis', label: 'viditelnost', value: (g) => (g.private ? 'soukromé' : 'veřejné') },
          { key: 'kind', label: 'druh', value: (g) => (g.mirror ? 'zrcadla' : 'vlastní') },
        ],
        toolbar: `${containers.length > 1 && !TH ? `<label class="dt-select">${icon('repo', 16)}<select id="gitRepo">${containers.map((r) => `<option value="${esc(r.name)}"${r.name === c.name ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>` : ''}
          ${canCreate ? `<a class="btn small primary" href="${U(c.name, null, 'new')}">${icon('plus', 15)}Nový repozitář</a>` : ''}
          ${isAdmin() ? `<button type="button" class="btn small" id="imp">${icon('download', 15)}Import / zrcadlo</button><button type="button" class="btn small" id="gh">${icon('git', 15)}GitHub import</button>` : ''}`,
        empty: canCreate ? 'Zatím žádné git repozitáře – vytvořte první nebo pošlete git push.' : 'Žádné repozitáře k zobrazení.',
        columns: [
          { key: 'name', label: 'Název', render: (g) => `${cellMain('git', g.name, g.description, g.private ? 'lock' : 'git')}` },
          { key: 'vis', label: 'Viditelnost', value: (g) => (g.private ? 1 : 0), render: (g) => `${visBadge(g)}${g.mirror ? ' <span class="badge blue">zrcadlo</span>' : ''}` },
          { key: 'permission', label: 'Oprávnění', toggle: true, render: (g) => `<span class="pill">${esc({ admin: 'správce', write: 'zápis', read: 'čtení' }[g.permission] || g.permission || '')}</span>` },
          { key: 'mirror', label: 'Zrcadlo', toggle: true, hidden: true, value: (g) => (g.mirror ? g.mirror.status : ''), render: (g) => (g.mirror ? `<span class="badge ${g.mirror.status === 'ok' ? 'ok' : g.mirror.status === 'error' ? 'off' : 'blue'}">${esc(g.mirror.status || '')}</span> ${when(g.mirror.lastSync)}` : '–') },
          { key: 'created', label: 'Vytvořeno', toggle: true, render: (g) => when(g.created) },
        ],
        onRow: (g) => go(U(c.name, g.name)),
      });
      const sel = $('#gitRepo', v);
      if (sel) sel.onchange = () => go(listUrl(sel.value));
      const imp = $('#imp', v);
      if (imp) imp.onclick = () => importModal(c);
      const gh = $('#gh', v);
      if (gh) gh.onclick = () => githubModal(c);
      return v;
    }

    function importModal(c) {
      modal(`<h2>Import / zrcadlo git repozitáře</h2><form class="form" id="f">
        <label style="grid-column:1/-1">URL zdroje <input name="importUrl" id="iu" required placeholder="https://github.com/owner/repo.git"></label>
        <label>Název v registru <input name="name" id="in" required></label>
        <label>Token (privátní repozitáře) <input name="token" type="password"></label>
        <label>Uživatel (výchozí x-access-token) <input name="username"></label>
        <label>Interval synchronizace (s) <input name="interval" type="number" value="3600"></label>
        <label class="check"><input type="checkbox" name="mirror" checked> udržovat jako zrcadlo (jen pro čtení)</label>
        <label class="check"><input type="checkbox" name="private"> soukromý</label></form>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Importovat</button></div>`, (el, close) => {
        $('#iu', el).oninput = (e) => { $('#in', el).value = e.target.value.replace(/^[a-z]+:\/\/[^/]+\//, '').replace(/\.git$/, ''); };
        $('#ok', el).onclick = async () => {
          const d = formData($('#f', el));
          toast('Klonuji…');
          const g = await run(() => rr().createGitRepo(c.name, d), 'Importováno');
          close();
          forget(c.name);
          go(U(c.name, g.name));
        };
      });
    }

    function githubModal(c) {
      modal(`<h2>Import z GitHubu</h2><form class="form" id="f">
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
          const r = await run(() => rr().githubImport(c.name, d));
          close();
          forget(c.name);
          modal(`<h2>Import dokončen</h2><p>Nalezeno ${r.found}, vybráno ${r.selected}.</p><div class="table-wrap"><table>${r.results.map((x) => `<tr><td><span class="badge ${x.status === 'created' ? 'ok' : x.status === 'error' ? 'off' : ''}">${esc(x.status)}</span></td><td>${esc(x.name)}</td><td class="small muted">${esc(x.error || '')}</td></tr>`).join('') || '<tr><td class="muted">nic</td></tr>'}</table></div>
            <div class="row"><span class="spacer"></span><button class="btn primary" data-close>Hotovo</button></div>`);
          ctx.route();
        };
      });
    }

    // ------------------------------------------------------------------ create (github.com/new)
    async function createPage(c, containers) {
      if (guest()) return setView('Nový repozitář', '<div class="card"><p class="muted">Pro vytvoření repozitáře se přihlaste.</p><button class="btn primary" data-login>Přihlásit</button></div>', 'git');
      const [list, tpl] = await Promise.all([names(c.name, true), rr().gitTemplates().catch(() => ({ gitignore: [], licenses: [] }))]);
      const owners = [...new Set([me().name, ...(isAdmin() ? list.map((g) => g.owner).filter(Boolean) : [])])];
      const TH = ctx.typeHost();
      const v = setView('Nový repozitář', `
        <div class="card git-new" style="max-width:760px">
          <h2 style="margin-top:0">${icon('git', 18)}Vytvořit nový repozitář</h2>
          <p class="muted">Repozitář obsahuje všechny soubory projektu včetně historie revizí. Už máte repozitář jinde? ${isAdmin() ? '<a href="#" id="impLink">Importujte ho.</a>' : 'Pošlete ho příkazem git push.'}</p>
          <form id="f" class="form" style="grid-template-columns:minmax(0,1fr) auto minmax(0,2fr)">
            ${containers.length > 1 && !TH ? `<label style="grid-column:1/-1">Úložiště <select name="container">${containers.map((r) => `<option value="${esc(r.name)}"${r.name === c.name ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></label>` : ''}
            <label>Vlastník * <select name="owner">${owners.map((o) => `<option${o === me().name ? ' selected' : ''}>${esc(o)}</option>`).join('')}<option value="">(bez vlastníka)</option></select></label>
            <span style="align-self:end;padding-bottom:10px;font-size:20px">/</span>
            <label>Název repozitáře * <input name="name" required autocomplete="off" placeholder="muj-projekt" pattern="[A-Za-z0-9_][A-Za-z0-9_.\\-]*"></label>
            <p class="small muted" style="grid-column:1/-1;margin:0" id="nameHint">Krátké a zapamatovatelné názvy jsou nejlepší.</p>
            <label style="grid-column:1/-1">Popis <span class="muted small">(nepovinné)</span> <input name="description"></label>
            <fieldset class="vis" style="grid-column:1/-1">
              <label class="radio"><input type="radio" name="visibility" value="public" checked> ${icon('git', 18)}<span><b>Veřejný</b><small>Kdokoli s přístupem k registru může repozitář vidět. Vy rozhodujete, kdo do něj může zapisovat.</small></span></label>
              <label class="radio"><input type="radio" name="visibility" value="private"> ${icon('lock', 18)}<span><b>Soukromý</b><small>Vidíte ho vy, spolupracovníci, kterým ho zpřístupníte, a správci.</small></span></label>
            </fieldset>
            <h3 style="grid-column:1/-1;margin:6px 0 0">Inicializovat repozitář s:</h3>
            <label class="check" style="grid-column:1/-1"><input type="checkbox" name="readme"> <span><b>Přidat soubor README</b> <small class="muted">– sem můžete napsat podrobný popis projektu.</small></span></label>
            <label>Přidat .gitignore <select name="gitignore"><option value="">.gitignore šablona: žádná</option>${(tpl.gitignore || []).map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
            <span></span>
            <label>Licence <select name="license"><option value="">Licence: žádná</option>${(tpl.licenses || []).map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
            <label>Výchozí větev <input name="defaultBranch" value="main"></label>
          </form>
          <p class="small muted" id="initNote">Repozitář bude vytvořen prázdný – po vytvoření uvidíte návod, jak do něj poslat kód.</p>
          <div class="row"><span class="spacer"></span><button class="btn primary" id="ok">${icon('plus', 16)}Vytvořit repozitář</button></div>
        </div>`, 'git');
      const f = $('#f', v);
      const full = () => { const d = formData(f); return d.owner ? `${d.owner}/${d.name.trim()}` : d.name.trim(); };
      const upd = () => {
        const d = formData(f);
        const exists = list.some((g) => g.name === full());
        $('#nameHint', v).innerHTML = d.name ? (exists ? `<span class="error">${icon('alert', 13)} ${esc(full())} už existuje.</span>` : `<span class="ok-text">${icon('check', 13)} ${esc(full())} je volné.</span>`) : 'Krátké a zapamatovatelné názvy jsou nejlepší.';
        $('#initNote', v).textContent = d.readme || d.gitignore || d.license ? `Výchozí větev ${d.defaultBranch || 'main'} se vytvoří s vybranými soubory.` : 'Repozitář bude vytvořen prázdný – po vytvoření uvidíte návod, jak do něj poslat kód.';
      };
      f.oninput = upd;
      f.onchange = upd;
      const il = $('#impLink', v);
      if (il) il.onclick = (e) => { e.preventDefault(); importModal(c); };
      $('#ok', v).onclick = async () => {
        const d = formData(f);
        if (!d.name.trim()) return toast('Zadejte název repozitáře', true);
        const target = d.container || c.name;
        const body = { name: full(), description: d.description, visibility: d.visibility, readme: d.readme, gitignore: d.gitignore, license: d.license, defaultBranch: d.defaultBranch || 'main' };
        const g = await run(() => rr().createGitRepo(target, body), 'Repozitář vytvořen');
        forget(target);
        go(U(target, g.name));
      };
      return v;
    }

    // ------------------------------------------------------------------ repository page
    async function repoPage(c, containers, name, section, sub) {
      const q = ctx.query();
      const info = await rr().getGitRepo(c.name, name);
      const perm = info.permissions || {};
      const writable = perm.write && !info.mirror;
      const refs = [...info.branches.map((b) => b.name), ...info.tags.map((t) => t.name)];
      /** "feature/x/docs/a.md" -> ref "feature/x", path "docs/a.md" (longest known ref, else first segment = sha) */
      const splitRef = (parts) => {
        for (let i = parts.length; i >= 1; i--) {
          const cand = parts.slice(0, i).join('/');
          if (refs.includes(cand)) return { ref: cand, path: parts.slice(i).join('/') };
        }
        return parts.length ? { ref: parts[0], path: parts.slice(1).join('/') } : { ref: info.defaultBranch || 'HEAD', path: '' };
      };
      const ctxR = { c: c.name, name, info, writable, perm, splitRef, q };
      const counts = info.counts || {};
      const TABS = [
        ['code', 'Kód', 'file', U(c.name, name)],
        ['issues', 'Issues', 'alert', U(c.name, name, 'issues'), counts.openIssues],
        ['pulls', 'Pull requesty', 'git', U(c.name, name, 'pulls'), counts.openPulls],
        ['releases', 'Releases', 'tag', U(c.name, name, 'releases'), counts.releases],
        ['commits', 'Commity', 'activity', U(c.name, name, 'commits', info.defaultBranch || ''), counts.commits],
        ['branches', 'Větve', 'git', U(c.name, name, 'branches'), counts.branches],
        ['tags', 'Tagy', 'tag', U(c.name, name, 'tags'), counts.tags],
        ...(perm.admin ? [['settings', 'Nastavení', 'gear', U(c.name, name, 'settings')]] : []),
      ];
      const activeTab = { tree: 'code', blob: 'code', new: 'code', edit: 'code', upload: 'code', commit: 'commits' }[section] || section;
      const owner = name.includes('/') ? name.split('/').slice(0, -1).join('/') : '';
      const header = `
        <div class="git-head">
          <div class="git-title">${icon(info.private ? 'lock' : 'git', 20)}
            ${owner ? `<span class="muted">${esc(owner)}</span><span class="muted">/</span>` : ''}<a href="${U(c.name, name)}"><b>${esc(name.split('/').pop())}</b></a>
            ${visBadge(info)}${info.mirror ? ' <span class="badge blue">zrcadlo</span>' : ''}${info.latestRelease ? ` <a class="badge ok" href="${U(c.name, name, 'releases', 'tag', info.latestRelease.tag_name)}">${icon('tag', 12)}${esc(info.latestRelease.tag_name)}</a>` : ''}
            <span class="spacer"></span>${cloneButton(info)}
          </div>
          ${info.description ? `<p class="muted" style="margin:4px 0 0">${esc(info.description)}</p>` : ''}
          <nav class="tabs git-tabs" aria-label="Sekce repozitáře">${TABS.map(([k, l, ic, href, n]) => `<a href="${href}" class="tab-link${k === activeTab ? ' active' : ''}"${k === activeTab ? ' aria-current="page"' : ''}>${icon(ic, 15)}${l}${n ? ` <span class="pill">${n}</span>` : ''}</a>`).join('')}</nav>
        </div>`;
      let body;
      try {
        body = await SECTIONS[section] ? await SECTIONS[section](ctxR, sub) : { html: `<div class="card"><p class="error">Neznámá sekce ${esc(section)}</p></div>` };
      } catch (e) {
        if (e.status === 401 || e.status === 403) throw e;
        // a link to a directory through "blob" (README links) - show it as a tree
        if (section === 'blob' && e.status === 404) { go(U(c.name, name, 'tree', ...sub)); return null; }
        body = { html: `<div class="card"><p class="error">${esc(e.message)}</p><a href="${U(c.name, name)}">← kód repozitáře</a></div>` };
      }
      const v = setView(name, `${header}${body.html}`, 'git');
      mountClone(v, info);
      if (body.mount) body.mount(v);
      return v;
    }

    // clone dropdown: HTTPS | SSH, copy, zip / tar.gz
    function cloneButton(info) {
      return `<div class="clone-box"><button type="button" class="btn small primary" data-clone>${icon('download', 15)}Kód ▾</button>
        <div class="clone-pop hidden" data-clonepop>${cloneUrls(info, 'pop')}
          <div class="row" style="margin-top:8px"><button type="button" class="btn small" data-arch="zip">${icon('download', 14)}ZIP</button><button type="button" class="btn small" data-arch="tar.gz">${icon('download', 14)}tar.gz</button></div></div></div>`;
    }
    function cloneUrls(info, id) {
      const urls = info.cloneUrls || { https: info.cloneUrl };
      const pref = (ctx.LS && ctx.LS.get('cloneProto')) || 'https';
      const cur = pref === 'ssh' && urls.ssh ? 'ssh' : 'https';
      return `<div class="clone-urls" data-cu="${id}"><div class="tabs small-tabs">${['https', 'ssh'].filter((p) => urls[p]).map((p) => `<button type="button" data-proto="${p}" class="${p === cur ? 'active' : ''}">${p.toUpperCase()}</button>`).join('')}</div>
        <div class="row" style="flex-wrap:nowrap"><input class="mono" readonly value="${esc(urls[cur])}" data-url style="flex:1;min-width:0"><button type="button" class="btn small" data-copyurl title="Kopírovat" aria-label="Kopírovat">${icon('copy', 15)}</button></div>
        ${cur === 'ssh' ? '<p class="small muted" style="margin:4px 0 0">Přihlášení klíčem – klíče spravujete v <a href="#/profile">Můj účet → SSH klíče</a>.</p>' : '<p class="small muted" style="margin:4px 0 0">Přihlášení jménem a heslem nebo tokenem.</p>'}</div>`;
    }
    function mountCloneUrls(root, info, onChange) {
      $$('[data-cu]', root).forEach((box) => {
        const urls = info.cloneUrls || { https: info.cloneUrl };
        $$('[data-proto]', box).forEach((b) => { b.onclick = () => { if (ctx.LS) ctx.LS.set('cloneProto', b.dataset.proto); box.outerHTML = cloneUrls(info, box.dataset.cu); mountCloneUrls(root, info, onChange); if (onChange) onChange(b.dataset.proto); }; });
        const btn = $('[data-copyurl]', box);
        if (btn) btn.onclick = () => copy($('[data-url]', box).value);
        const inp = $('[data-url]', box);
        if (inp) inp.onfocus = () => inp.select();
        void urls;
      });
    }
    function mountClone(v, info) {
      const btn = $('[data-clone]', v);
      if (!btn) return;
      const pop = $('[data-clonepop]', v);
      btn.onclick = (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); };
      document.addEventListener('click', (e) => { if (!pop.contains(e.target) && e.target !== btn) pop.classList.add('hidden'); }, { once: false });
      mountCloneUrls(pop, info);
      $$('[data-arch]', pop).forEach((b) => {
        b.onclick = async () => {
          const ref = ctx.query().get('ref') || info.defaultBranch;
          download(await run(() => rr().gitArchive(info.repo, info.name, { ref, format: b.dataset.arch })), `${info.name.split('/').pop()}-${ref}.${b.dataset.arch}`);
        };
      });
    }

    // ------------------------------------------------------------------ sections
    const SECTIONS = {};

    SECTIONS.code = (r) => (r.info.empty ? quickSetup(r) : treeSection(r, { ref: r.info.defaultBranch, path: '' }, true));
    SECTIONS.tree = (r, sub) => treeSection(r, r.splitRef(sub));

    /** Empty repository: GitHub's "Quick setup". */
    function quickSetup(r) {
      const { info, c, name } = r;
      const br = info.defaultBranch || 'main';
      const base = name.split('/').pop();
      const html = (proto) => {
        const urls = info.cloneUrls || { https: info.cloneUrl };
        const url = urls[proto] || urls.https;
        return `<div class="card quick">
          <h2 style="margin-top:0">Rychlé nastavení — pokud už to znáte</h2>
          ${cloneUrls(info, 'quick')}
          <p>${r.writable ? `Začněte <a href="${U(c, name, 'new', br, { filename: '' })}">vytvořením nového souboru</a> nebo <a href="${U(c, name, 'upload', br)}">nahráním existujícího souboru</a>. Doporučujeme, aby každý repozitář obsahoval <a href="${U(c, name, 'new', br, { filename: 'README.md', readme: 1 })}">README</a>, <a href="${U(c, name, 'new', br, { filename: 'LICENSE' })}">LICENSE</a> a <a href="${U(c, name, 'new', br, { filename: '.gitignore' })}">.gitignore</a>.` : 'Repozitář je zatím prázdný.'}</p>
          <h3>…nebo vytvořte nový repozitář na příkazové řádce</h3>
          <div class="pre-copy"><pre>echo "# ${esc(base)}" &gt;&gt; README.md
git init
git add README.md
git commit -m "first commit"
git branch -M ${esc(br)}
git remote add origin ${esc(url)}
git push -u origin ${esc(br)}</pre><button type="button" class="btn small ghost" data-copypre title="Kopírovat">${icon('copy', 15)}</button></div>
          <h3>…nebo pošlete existující repozitář z příkazové řádky</h3>
          <div class="pre-copy"><pre>git remote add origin ${esc(url)}
git branch -M ${esc(br)}
git push -u origin ${esc(br)}</pre><button type="button" class="btn small ghost" data-copypre title="Kopírovat">${icon('copy', 15)}</button></div>
          ${info.cloneUrls && info.cloneUrls.ssh ? '' : '<p class="small muted">SSH na tomto serveru není zapnuté (RR_SSH_PORT).</p>'}
        </div>`;
      };
      const pref = (ctx.LS && ctx.LS.get('cloneProto')) || 'https';
      return {
        html: `<div id="qs">${html(pref)}</div>`,
        mount: (v) => {
          const host = $('#qs', v);
          const wire = () => {
            mountCloneUrls(host, info, (p) => { host.innerHTML = html(p); wire(); });
            $$('[data-copypre]', host).forEach((b) => { b.onclick = () => copy(b.previousElementSibling.textContent); });
          };
          wire();
        },
      };
    }

    async function treeSection(r, { ref, path }, home) {
      const { c, name, info } = r;
      const t = await rr().gitTree(c, name, { ref, path });
      const commits = await rr().gitCommits(c, name, { ref, limit: 1, path: path || undefined }).catch(() => []);
      const last = commits[0];
      const readme = t.entries.find((e) => e.type === 'file' && /^readme(\.(md|markdown|txt|rst))?$/i.test(e.name));
      let readmeHtml = '';
      if (readme) {
        const text = decode(await rr().gitBlob(c, name, { ref, path: readme.path }));
        readmeHtml = /\.(md|markdown)$/i.test(readme.name)
          ? `<article class="card markdown-body" data-md><header class="md-head">${icon('file', 16)}<b>${esc(readme.name)}</b><span class="spacer"></span>${r.writable && refIsBranch(r, ref) ? `<a class="btn small ghost" href="${U(c, name, 'edit', ref, readme.path)}" title="Upravit">${icon('edit', 15)}</a>` : ''}</header>${markdown(text, { c, name, ref, path: readme.path })}</article>`
          : `<article class="card"><header class="md-head">${icon('file', 16)}<b>${esc(readme.name)}</b></header><pre style="white-space:pre-wrap">${esc(text)}</pre></article>`;
      }
      const parts = path.split('/').filter(Boolean);
      const crumbs = `<div class="crumbs"><a href="${U(c, name, 'tree', ref)}">${esc(name.split('/').pop())}</a>${parts.map((p, i) => ` / <a href="${U(c, name, 'tree', ref, parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`).join('')}</div>`;
      const isBranch = refIsBranch(r, ref);
      const html = `
        <div class="row git-bar">${refPicker(r, ref, home ? 'tree' : 'tree', path)}${home ? `<a class="small muted" href="${U(c, name, 'branches')}">${icon('git', 14)}${info.counts.branches} větví</a><a class="small muted" href="${U(c, name, 'tags')}">${icon('tag', 14)}${info.counts.tags} tagů</a>` : crumbs}
          <span class="spacer"></span>
          ${r.writable && isBranch ? `<div class="menu-wrap"><button type="button" class="btn small" data-addmenu>${icon('plus', 15)}Přidat soubor ▾</button><div class="menu hidden" data-addpop><a href="${U(c, name, 'new', ref, path, { filename: '' })}">${icon('edit', 15)}Vytvořit nový soubor</a><a href="${U(c, name, 'upload', ref, path)}">${icon('upload', 15)}Nahrát soubory</a></div></div>` : ''}
          <a class="btn small" href="${U(c, name, 'commits', ref, { path: path || undefined })}">${icon('activity', 15)}${home ? `${info.counts.commits} commitů` : 'Historie'}</a></div>
        <div class="card git-files">
          ${last ? `<div class="last-commit"><b>${esc(last.author)}</b> <a href="${U(c, name, 'commit', last.commit)}">${esc(last.subject)}</a><span class="spacer"></span><a class="mono small" href="${U(c, name, 'commit', last.commit)}">${short(last.commit)}</a> <span class="small muted">${when(last.date)}</span></div>` : ''}
          <div class="table-wrap"><table class="files">
          ${path ? `<tr class="click" data-href="${U(c, name, 'tree', ref, parts.slice(0, -1).join('/'))}"><td colspan="2">${icon('up', 14)} ..</td></tr>` : ''}
          ${t.entries.map((e) => `<tr class="click" data-href="${e.type === 'dir' ? U(c, name, 'tree', ref, e.path) : e.type === 'submodule' ? '' : U(c, name, 'blob', ref, e.path)}"><td><span class="file-name">${icon(e.type === 'dir' ? 'folder' : e.type === 'submodule' ? 'link' : 'file', 16)}<a href="${e.type === 'dir' ? U(c, name, 'tree', ref, e.path) : U(c, name, 'blob', ref, e.path)}">${esc(e.name)}</a></span></td><td class="small muted" style="text-align:right">${e.type === 'file' ? fmtBytes(e.size) : e.type === 'submodule' ? 'submodul' : ''}</td></tr>`).join('') || '<tr><td class="muted">prázdný adresář</td></tr>'}
          </table></div></div>
        ${readmeHtml}`;
      return {
        html,
        mount: (v) => {
          mountRefPicker(v, r, (nr) => U(c, name, 'tree', nr, path));
          $$('tr[data-href]', v).forEach((tr) => { tr.onclick = (e) => { if (e.target.closest('a')) return; if (tr.dataset.href) go(tr.dataset.href); }; });
          const md = $('[data-md]', v);
          if (md) mountMarkdown(md, { c, name, ref });
          const am = $('[data-addmenu]', v);
          if (am) { const pop = $('[data-addpop]', v); am.onclick = (e) => { e.stopPropagation(); pop.classList.toggle('hidden'); }; document.addEventListener('click', () => pop.classList.add('hidden'), { once: true }); }
        },
      };
    }

    const refIsBranch = (r, ref) => r.info.branches.some((b) => b.name === ref) || (r.info.empty && ref === r.info.defaultBranch);

    function refPicker(r, ref, kind, path) {
      const { info } = r;
      const known = [...info.branches, ...info.tags].some((x) => x.name === ref);
      return `<label class="dt-select ref-pick">${icon(info.tags.some((t) => t.name === ref) ? 'tag' : 'git', 15)}<span class="sr">Větev nebo tag</span><select data-refpick>
        <optgroup label="Větve">${info.branches.map((b) => `<option value="${esc(b.name)}"${b.name === ref ? ' selected' : ''}>${esc(b.name)}${b.name === info.defaultBranch ? ' (výchozí)' : ''}</option>`).join('')}</optgroup>
        ${info.tags.length ? `<optgroup label="Tagy">${info.tags.map((t) => `<option value="${esc(t.name)}"${t.name === ref ? ' selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>` : ''}
        ${known ? '' : `<option selected value="${esc(ref)}">${esc(short(ref) || ref)}</option>`}</select></label>`;
    }
    function mountRefPicker(v, r, urlFor) {
      const s = $('[data-refpick]', v);
      if (s) s.onchange = () => go(urlFor(s.value));
    }

    // ---- file
    SECTIONS.blob = async (r, sub) => {
      const { c, name } = r;
      const { ref, path } = r.splitRef(sub);
      if (!path) return treeSection(r, { ref, path });
      const bytes = await rr().gitBlob(c, name, { ref, path });
      const fileName = path.split('/').pop();
      const ext = (fileName.split('.').pop() || '').toLowerCase();
      const isImg = IMG_EXT.test(fileName);
      const binary = !isImg && isBinary(bytes);
      const text = !isImg && !binary && bytes.length < 2 * 1024 * 1024 ? decode(bytes) : null;
      const isMd = MD_EXT.test(fileName) && text !== null;
      const mode = r.q.get('plain') === '1' ? 'code' : isMd ? 'preview' : 'code';
      const parts = path.split('/');
      const crumbs = `<div class="crumbs"><a href="${U(c, name, 'tree', ref)}">${esc(name.split('/').pop())}</a>${parts.map((p, i) => (i === parts.length - 1 ? ` / <b>${esc(p)}</b>` : ` / <a href="${U(c, name, 'tree', ref, parts.slice(0, i + 1).join('/'))}">${esc(p)}</a>`)).join('')}</div>`;
      const lines = text !== null ? text.split('\n') : [];
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      let content;
      if (isImg) content = `<div class="blob-img"><img data-img alt="${esc(fileName)}"></div>`;
      else if (text === null) content = `<div class="blob-empty"><p class="muted">${binary ? 'Binární soubor' : 'Soubor je příliš velký pro zobrazení'} (${fmtBytes(bytes.length)}).</p><button type="button" class="btn" data-dl>${icon('download', 15)}Stáhnout</button></div>`;
      else if (mode === 'preview') content = `<div class="markdown-body" data-md>${markdown(text, { c, name, ref, path })}</div>`;
      else if (lines.length > 20000) content = `<pre class="code">${esc(text)}</pre>`;
      else content = `<div class="code-wrap"><table class="code-lines"><tbody>${lines.map((l, i) => `<tr id="L${i + 1}"><td class="ln"><a href="#L${i + 1}" data-ln="${i + 1}">${i + 1}</a></td><td class="lc">${esc(l) || ' '}</td></tr>`).join('')}</tbody></table></div>`;
      const branch = refIsBranch(r, ref);
      const html = `
        <div class="row git-bar">${refPicker(r, ref, 'blob', path)}${crumbs}<span class="spacer"></span><a class="btn small" href="${U(c, name, 'commits', ref, { path })}">${icon('activity', 15)}Historie</a></div>
        <div class="card blob">
          <header class="blob-head"><span class="small muted">${text !== null ? `${lines.length} řádků · ` : ''}${fmtBytes(bytes.length)}${ext ? ` · ${esc(ext)}` : ''}</span>
            ${isMd ? `<div class="seg"><a class="${mode === 'preview' ? 'active' : ''}" href="${U(c, name, 'blob', ref, path)}">Náhled</a><a class="${mode === 'code' ? 'active' : ''}" href="${U(c, name, 'blob', ref, path, { plain: 1 })}">Kód</a></div>` : ''}
            <span class="spacer"></span>
            ${text !== null ? `<button type="button" class="btn small ghost" data-copyfile title="Kopírovat obsah">${icon('copy', 15)}</button>` : ''}
            <button type="button" class="btn small ghost" data-dl title="Stáhnout">${icon('download', 15)}</button>
            ${r.writable && branch && text !== null ? `<a class="btn small ghost" href="${U(c, name, 'edit', ref, path)}" title="Upravit">${icon('edit', 15)}</a>` : ''}
            ${r.writable && branch ? `<button type="button" class="btn small ghost danger" data-delfile title="Smazat">${icon('trash', 15)}</button>` : ''}
          </header>${content}</div>`;
      return {
        html,
        mount: (v) => {
          mountRefPicker(v, r, (nr) => U(c, name, 'blob', nr, path));
          $$('[data-dl]', v).forEach((b) => { b.onclick = () => download(bytes, fileName); });
          const cp = $('[data-copyfile]', v);
          if (cp) cp.onclick = () => copy(text);
          const img = $('[data-img]', v);
          if (img) img.src = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }));
          const md = $('[data-md]', v);
          if (md) mountMarkdown(md, { c, name, ref });
          $$('[data-ln]', v).forEach((a) => { a.onclick = (e) => { e.preventDefault(); $$('tr.hl', v).forEach((x) => x.classList.remove('hl')); a.closest('tr').classList.add('hl'); }; });
          const del = $('[data-delfile]', v);
          if (del) del.onclick = () => commitModal(r, { title: `Smazat ${fileName}`, message: `Delete ${path}`, branch: ref, danger: true }, async (d) => {
            await run(() => rr().deleteGitFile(c, name, { path, branch: d.branch, message: d.message }), 'Soubor smazán');
            go(U(c, name, 'tree', d.branch, parts.slice(0, -1).join('/')));
          });
        },
      };
    };

    /** Commit dialog: message + commit to the current branch or to a new branch. */
    function commitModal(r, { title, message, branch, danger }, onCommit) {
      modal(`<h2>${esc(title)}</h2><form class="form" id="f" style="grid-template-columns:1fr">
          <label>Zpráva commitu <input name="message" value="${esc(message)}" required></label>
          <label>Rozšířený popis <span class="muted small">(nepovinné)</span><textarea name="description" rows="3"></textarea></label>
          <label class="radio"><input type="radio" name="target" value="current" checked> Commit přímo do větve <code>${esc(branch)}</code></label>
          <label class="radio"><input type="radio" name="target" value="new"> Vytvořit novou větev pro tento commit <input name="newBranch" placeholder="${esc(`${(me() && me().name) || 'patch'}-patch-1`)}"></label>
        </form><div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn ${danger ? 'danger' : 'primary'}" id="ok">Potvrdit commit</button></div>`, (el, close) => {
        $('#ok', el).onclick = async () => {
          const d = formData($('#f', el));
          const msg = d.description ? `${d.message}\n\n${d.description}` : d.message;
          const nb = d.target === 'new' ? (d.newBranch || $('[name=newBranch]', el).placeholder).trim() : '';
          await onCommit({ message: msg, branch: nb || branch, from: nb ? branch : undefined, newBranch: !!nb });
          close();
        };
      });
    }

    // ---- editor: new file / edit file
    SECTIONS.new = (r, sub) => editor(r, sub, true);
    SECTIONS.edit = (r, sub) => editor(r, sub, false);
    async function editor(r, sub, isNew) {
      const { c, name, info } = r;
      if (!r.writable) throw Object.assign(new Error('Do tohoto repozitáře nemůžete zapisovat.'), { status: 0 });
      const { ref, path } = info.empty ? { ref: sub[0] || info.defaultBranch || 'main', path: sub.slice(1).join('/') } : r.splitRef(sub);
      let content = '';
      let sha = null;
      if (!isNew) {
        content = decode(await rr().gitBlob(c, name, { ref, path }));
        sha = true;
      }
      const dir = isNew ? path : path.split('/').slice(0, -1).join('/');
      const fname = isNew ? (r.q.get('filename') || '') : path.split('/').pop();
      const tpl = isNew && /^(LICENSE(\.md)?|\.gitignore)$/i.test(fname) ? await rr().gitTemplates().catch(() => null) : null;
      if (isNew && r.q.get('readme')) content = `# ${name.split('/').pop()}\n\n${info.description || ''}\n`;
      const html = `
        <div class="card editor">
          <div class="row" style="flex-wrap:wrap;gap:6px"><span class="crumbs"><a href="${U(c, name, 'tree', ref)}">${esc(name.split('/').pop())}</a> /</span>
            <input id="fname" class="mono" style="min-width:260px;flex:1" placeholder="Název souboru (lze i adresář/soubor.md)" value="${esc(joinPath(dir, fname))}">
            <span class="small muted">ve větvi <code>${esc(ref)}</code></span>
            ${tpl && /gitignore/i.test(fname) ? `<label class="dt-select">Šablona <select id="tplSel"><option value="">–</option>${tpl.gitignore.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>` : ''}
            ${tpl && /license/i.test(fname) ? `<label class="dt-select">Licence <select id="tplSel"><option value="">–</option>${tpl.licenses.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>` : ''}
          </div>
          <div class="tabs small-tabs" style="margin-top:10px"><button type="button" class="active" data-et="edit">Upravit</button><button type="button" data-et="preview">Náhled</button></div>
          <textarea id="content" class="code-edit" spellcheck="false" rows="24">${esc(content)}</textarea>
          <div id="preview" class="markdown-body hidden" style="min-height:200px"></div>
          <div class="row" style="margin-top:10px"><a class="btn" href="${isNew ? U(c, name, 'tree', ref, dir) : U(c, name, 'blob', ref, path)}">Zrušit</a><span class="spacer"></span><button class="btn primary" id="commit">${icon('check', 15)}Commit změn…</button></div>
        </div>`;
      return {
        html,
        mount: (v) => {
          const ta = $('#content', v);
          ta.onkeydown = (e) => { if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); } };
          const ts = $('#tplSel', v);
          if (ts) ts.onchange = async () => {
            if (!ts.value) return;
            const q = /gitignore/i.test(fname) ? { gitignore: ts.value } : { license: ts.value, holder: (info.owner || (me() && me().name) || '') };
            const t = await run(() => rr().gitTemplates(q));
            ta.value = t.content || '';
          };
          $$('[data-et]', v).forEach((b) => {
            b.onclick = () => {
              $$('[data-et]', v).forEach((x) => x.classList.toggle('active', x === b));
              const pv = b.dataset.et === 'preview';
              ta.classList.toggle('hidden', pv);
              const p = $('#preview', v);
              p.classList.toggle('hidden', !pv);
              if (pv) {
                const fpath = $('#fname', v).value.trim();
                p.innerHTML = MD_EXT.test(fpath) || !fpath.includes('.') ? markdown(ta.value, { c, name, ref, path: fpath || 'x.md' }) : `<pre>${esc(ta.value)}</pre>`;
                mountMarkdown(p, { c, name, ref });
              }
            };
          });
          $('#commit', v).onclick = () => {
            const fpath = $('#fname', v).value.trim().replace(/^\/+/, '');
            if (!fpath || fpath.endsWith('/')) return toast('Zadejte název souboru', true);
            const renamed = !isNew && fpath !== path;
            commitModal(r, { title: isNew ? `Vytvořit ${fpath}` : `Upravit ${fpath}`, message: isNew ? `Create ${fpath}` : renamed ? `Rename ${path} to ${fpath}` : `Update ${fpath}`, branch: ref }, async (d) => {
              const files = [{ path: fpath, content: ta.value, encoding: 'utf8', create: isNew }];
              const body = { branch: d.branch, from: d.from, message: d.message, files, deletes: renamed ? [path] : [] };
              await run(() => rr().commitGitFiles(c, name, body), 'Změny uloženy');
              if (d.newBranch && info.branches.length) go(U(c, name, 'pulls', { compare: d.branch }));
              else go(U(c, name, 'blob', d.branch, fpath));
            });
            void sha;
          };
        },
      };
    }

    // ---- upload
    SECTIONS.upload = async (r, sub) => {
      const { c, name, info } = r;
      if (!r.writable) throw new Error('Do tohoto repozitáře nemůžete zapisovat.');
      const { ref, path } = info.empty ? { ref: sub[0] || info.defaultBranch || 'main', path: sub.slice(1).join('/') } : r.splitRef(sub);
      const files = [];
      const html = `
        <div class="card">
          <h2 style="margin-top:0">${icon('upload', 18)}Nahrát soubory do <code>${esc(joinPath(name.split('/').pop(), path))}</code> (${esc(ref)})</h2>
          <div class="drop" id="drop" tabindex="0">${icon('upload', 32)}<p><b>Přetáhněte sem soubory nebo složky</b><br><span class="muted">nebo</span> <label class="link"><input type="file" id="fi" multiple hidden>vyberte soubory</label> · <label class="link"><input type="file" id="fd" webkitdirectory multiple hidden>vyberte složku</label></p></div>
          <div id="flist"></div>
          <div class="row" style="margin-top:10px"><a class="btn" href="${U(c, name, 'tree', ref, path)}">Zrušit</a><span class="spacer"></span><button class="btn primary" id="commit" disabled>${icon('check', 15)}Commit změn…</button></div>
        </div>`;
      return {
        html,
        mount: (v) => {
          const drawList = () => {
            $('#flist', v).innerHTML = files.length ? `<div class="table-wrap"><table>${files.map((f, i) => `<tr><td>${icon('file', 14)} <code>${esc(joinPath(path, f.rel))}</code></td><td class="small muted">${fmtBytes(f.file.size)}</td><td class="actions"><button type="button" class="btn small ghost" data-rm="${i}" aria-label="Odebrat">${icon('x', 14)}</button></td></tr>`).join('')}</table></div>` : '';
            $$('[data-rm]', v).forEach((b) => { b.onclick = () => { files.splice(Number(b.dataset.rm), 1); drawList(); }; });
            $('#commit', v).disabled = !files.length;
          };
          const add = (list) => { for (const f of list) files.push({ file: f, rel: f.webkitRelativePath || f.relPath || f.name }); drawList(); };
          $('#fi', v).onchange = (e) => add(e.target.files);
          $('#fd', v).onchange = (e) => add(e.target.files);
          const drop = $('#drop', v);
          drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
          drop.ondragleave = () => drop.classList.remove('over');
          drop.ondrop = async (e) => {
            e.preventDefault();
            drop.classList.remove('over');
            const items = [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
            if (!items.length) return add(e.dataTransfer.files);
            const out = [];
            const walk = (entry, prefix) => new Promise((resolve) => {
              if (entry.isFile) entry.file((f) => { f.relPath = prefix + f.name; out.push(f); resolve(); }, () => resolve());
              else if (entry.isDirectory) {
                const reader = entry.createReader();
                const all = [];
                const read = () => reader.readEntries(async (ents) => { if (!ents.length) { for (const x of all) await walk(x, `${prefix}${entry.name}/`); resolve(); } else { all.push(...ents); read(); } }, () => resolve());
                read();
              } else resolve();
            });
            for (const it of items) await walk(it, '');
            add(out);
          };
          $('#commit', v).onclick = () => commitModal(r, { title: `Nahrát ${files.length} souborů`, message: files.length === 1 ? `Add ${files[0].rel}` : `Add ${files.length} files`, branch: ref }, async (d) => {
            const total = files.reduce((n, f) => n + f.file.size, 0);
            if (total > 150 * 1024 * 1024) throw new Error('Najednou lze nahrát nejvýše 150 MB – použijte git push.');
            toast('Nahrávám…');
            const payload = [];
            for (const f of files) payload.push({ path: joinPath(path, f.rel), content: b64(new Uint8Array(await f.file.arrayBuffer())), encoding: 'base64' });
            await run(() => rr().commitGitFiles(c, name, { branch: d.branch, from: d.from, message: d.message, files: payload }), 'Soubory nahrány');
            go(U(c, name, 'tree', d.branch, path));
          });
        },
      };
    };

    // ---- commits
    SECTIONS.commits = async (r, sub) => {
      const { c, name } = r;
      const { ref } = sub.length ? r.splitRef(sub) : { ref: r.info.defaultBranch };
      const path = r.q.get('path') || '';
      const limit = Number(r.q.get('limit')) || 100;
      const list = r.info.empty ? [] : await rr().gitCommits(c, name, { ref, limit, path: path || undefined });
      const groups = new Map();
      for (const cm of list) {
        const d = new Date(cm.date).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(cm);
      }
      const html = `<div class="row git-bar">${r.info.empty ? '' : refPicker(r, ref, 'commits', '')}${path ? `<span class="small">soubor <code>${esc(path)}</code> · <a href="${U(c, name, 'commits', ref)}">všechny</a></span>` : ''}</div>
        ${[...groups].map(([d, cms]) => `<h3 class="commit-day">${icon('activity', 15)}Commity z ${esc(d)}</h3><div class="card commit-list">${cms.map((cm) => `
          <div class="commit-row"><div class="tx"><a href="${U(c, name, 'commit', cm.commit)}"><b>${esc(cm.subject)}</b></a><div class="small muted"><b>${esc(cm.author)}</b> ${when(cm.date)}${cm.parents.length > 1 ? ' · merge' : ''}</div></div>
            <div class="row" style="flex-wrap:nowrap"><a class="mono btn small" href="${U(c, name, 'commit', cm.commit)}">${short(cm.commit)}</a><button type="button" class="btn small ghost" data-copy="${esc(cm.commit)}" title="Kopírovat SHA">${icon('copy', 14)}</button><a class="btn small ghost" href="${U(c, name, 'tree', cm.commit)}" title="Procházet soubory v tomto commitu">${icon('file', 14)}</a></div></div>`).join('')}</div>`).join('') || '<div class="card"><p class="muted">Žádné commity.</p></div>'}
        ${list.length >= limit ? `<div class="row"><a class="btn" href="${U(c, name, 'commits', ref, { path: path || undefined, limit: limit + 100 })}">Starší…</a></div>` : ''}`;
      return { html, mount: (v) => { mountRefPicker(v, r, (nr) => U(c, name, 'commits', nr, { path: path || undefined })); $$('[data-copy]', v).forEach((b) => { b.onclick = () => copy(b.dataset.copy); }); } };
    };

    SECTIONS.commit = async (r, sub) => {
      const { c, name } = r;
      const d = await rr().gitCommit(c, name, sub.join('/'));
      const body = d.message.split('\n').slice(1).join('\n').trim();
      const html = `<div class="card">
          <h2 style="margin:0 0 6px">${esc(d.subject)}</h2>${body ? `<pre class="commit-msg">${esc(body)}</pre>` : ''}
          <div class="row small"><b>${esc(d.author)}</b> <span class="muted">&lt;${esc(d.email)}&gt;</span> ${when(d.date)}${d.committer && d.committer !== d.author ? ` · commit ${esc(d.committer)}` : ''}<span class="spacer"></span>
            ${d.parents.map((p) => `rodič <a class="mono" href="${U(c, name, 'commit', p)}">${short(p)}</a>`).join(' + ')} · <span class="mono">${esc(d.commit)}</span>
            <a class="btn small" href="${U(c, name, 'tree', d.commit)}">${icon('file', 14)}Procházet soubory</a></div></div>
        <p class="small">${d.stats.files} změněných souborů · <span class="ok-text">+${d.stats.additions}</span> <span class="error">−${d.stats.deletions}</span>${d.truncated ? ' · <span class="muted">diff je příliš velký pro zobrazení</span>' : ''}</p>
        ${d.files.map((f) => `<div class="card diff"><header class="diff-head"><span class="badge ${f.status === 'added' ? 'ok' : f.status === 'removed' ? 'off' : f.status === 'renamed' ? 'blue' : 'plain'}">${esc({ added: 'přidán', removed: 'smazán', modified: 'změněn', renamed: 'přejmenován', copied: 'zkopírován' }[f.status] || f.status)}</span>
          <a class="mono" href="${f.status === 'removed' ? U(c, name, 'blob', d.parents[0] || d.commit, f.path) : U(c, name, 'blob', d.commit, f.path)}">${f.previous ? `${esc(f.previous)} → ` : ''}${esc(f.path)}</a><span class="spacer"></span><span class="small"><span class="ok-text">+${f.additions || 0}</span> <span class="error">−${f.deletions || 0}</span></span></header>
          ${f.binary ? '<p class="muted small" style="padding:8px">binární soubor</p>' : f.patch ? diffTable(f.patch) : ''}</div>`).join('')}`;
      return { html };
    };

    function diffTable(patch) {
      const rows = [];
      let oldN = 0;
      let newN = 0;
      for (const l of patch.split('\n')) {
        if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(l)) continue;
        const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(l);
        if (h) { oldN = Number(h[1]); newN = Number(h[2]); rows.push(`<tr class="hunk"><td></td><td></td><td>${esc(l)}</td></tr>`); continue; }
        if (l.startsWith('+')) rows.push(`<tr class="add"><td></td><td>${newN++}</td><td>${esc(l)}</td></tr>`);
        else if (l.startsWith('-')) rows.push(`<tr class="del"><td>${oldN++}</td><td></td><td>${esc(l)}</td></tr>`);
        else if (l.startsWith('\\')) rows.push(`<tr class="meta"><td></td><td></td><td>${esc(l)}</td></tr>`);
        else if (l !== '' || rows.length) rows.push(`<tr><td>${oldN++}</td><td>${newN++}</td><td>${esc(l)}</td></tr>`);
      }
      if (rows.length && /<td>\d+<\/td><td>\d+<\/td><td><\/td><\/tr>$/.test(rows[rows.length - 1])) rows.pop();
      return `<div class="code-wrap"><table class="diff-lines">${rows.join('')}</table></div>`;
    }

    // ---- branches
    SECTIONS.branches = async (r) => {
      const { c, name, info } = r;
      const list = await rr().listGitBranches(c, name, { detailed: 1 });
      const max = Math.max(1, ...list.map((b) => Math.max(b.ahead, b.behind)));
      const html = `<div class="card">
        <div class="row"><h2 style="margin:0">${icon('git', 17)}Větve</h2><span class="spacer"></span>${r.writable ? `<button class="btn small primary" id="newB">${icon('plus', 15)}Nová větev</button>` : ''}</div>
        <div class="table-wrap"><table class="branches"><tr><th>Větev</th><th>Poslední commit</th><th title="za výchozí větví / před výchozí větví">Za | Před</th><th></th></tr>
        ${list.map((b) => `<tr><td><a href="${U(c, name, 'tree', b.name)}"><b class="mono">${esc(b.name)}</b></a> ${b.default ? '<span class="badge blue">výchozí</span>' : ''}${b.protected ? ` <span class="badge warn">${icon('lock', 11)}chráněná</span>` : ''}</td>
          <td class="small"><a href="${U(c, name, 'commit', b.commit)}">${esc(b.subject)}</a><div class="muted">${esc(b.author)} · ${when(b.date)}</div></td>
          <td>${b.default ? '' : `<div class="ab" title="${b.behind} za ${esc(info.defaultBranch)}, ${b.ahead} před"><span class="behind"><i style="width:${(b.behind / max) * 100}%"></i><em>${b.behind}</em></span><span class="ahead"><i style="width:${(b.ahead / max) * 100}%"></i><em>${b.ahead}</em></span></div>`}</td>
          <td class="actions">${!b.default && b.ahead && r.writable ? `<a class="btn small" href="${U(c, name, 'pulls', { compare: b.name })}">${icon('git', 14)}Pull request</a>` : ''}
            ${r.perm.admin && !b.default ? `<button class="btn small" data-def="${esc(b.name)}" title="Nastavit jako výchozí">Výchozí</button>` : ''}
            ${r.perm.admin ? `<button class="btn small ghost" data-prot="${esc(b.name)}" data-on="${b.protected ? '0' : '1'}" title="${b.protected ? 'Zrušit ochranu' : 'Chránit (zákaz force-push a smazání)'}">${icon('lock', 14)}</button>` : ''}
            ${r.writable && !b.protected ? `<button class="btn small ghost" data-ren="${esc(b.name)}" title="Přejmenovat">${icon('edit', 14)}</button>` : ''}
            ${r.writable && !b.default && !b.protected ? `<button class="btn small ghost danger" data-delb="${esc(b.name)}" title="Smazat">${icon('trash', 14)}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Žádné větve.</td></tr>'}</table></div></div>`;
      return {
        html,
        mount: (v) => {
          const on = (sel, fn) => $$(sel, v).forEach((b) => { b.onclick = () => fn(b); });
          const nb = $('#newB', v);
          if (nb) nb.onclick = () => modal(`<h2>Nová větev</h2><form class="form" id="f"><label>Název <input name="name" required placeholder="feature/novinka"></label>
              <label>Ze zdroje <select name="from">${[...info.branches.map((b) => b.name), ...info.tags.map((t) => t.name)].map((x) => `<option${x === info.defaultBranch ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label></form>
              <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
            $('#ok', el).onclick = async () => { const d = formData($('#f', el)); await run(() => rr().createGitBranch(c, name, d), 'Větev vytvořena'); close(); ctx.route(); };
          });
          on('[data-def]', async (b) => { if (await confirmBox(`Nastavit ${b.dataset.def} jako výchozí větev? Klony a pull requesty budou nově vycházet z ní.`)) { await run(() => rr().updateGitBranch(c, name, b.dataset.def, { default: true }), 'Výchozí větev změněna'); ctx.route(); } });
          on('[data-prot]', async (b) => { await run(() => rr().updateGitBranch(c, name, b.dataset.prot, { protected: b.dataset.on === '1' }), b.dataset.on === '1' ? 'Větev je chráněná' : 'Ochrana zrušena'); ctx.route(); });
          on('[data-ren]', (b) => modal(`<h2>Přejmenovat větev</h2><form class="form" id="f" style="grid-template-columns:1fr"><label>Nový název <input name="name" required value="${esc(b.dataset.ren)}"></label>
              <p class="small muted">Otevřené pull requesty se přesměrují na nový název. Lokální klony je potřeba přejmenovat ručně:<br><code>git branch -m ${esc(b.dataset.ren)} &lt;nový&gt; && git fetch origin && git branch -u origin/&lt;nový&gt;</code></p></form>
              <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Přejmenovat</button></div>`, (el, close) => {
            $('#ok', el).onclick = async () => { const d = formData($('#f', el)); await run(() => rr().updateGitBranch(c, name, b.dataset.ren, { name: d.name }), 'Větev přejmenována'); close(); ctx.route(); };
          }));
          on('[data-delb]', async (b) => { if (await confirmBox(`Smazat větev ${b.dataset.delb}?`)) { await run(() => rr().deleteGitBranch(c, name, b.dataset.delb), 'Větev smazána'); ctx.route(); } });
        },
      };
    };

    // ---- tags
    SECTIONS.tags = async (r) => {
      const { c, name, info } = r;
      const [list, rels] = await Promise.all([rr().listGitTags(c, name), rr().listGitReleases(c, name).catch(() => [])]);
      const relByTag = new Map(rels.map((x) => [x.tag_name, x]));
      const html = `<div class="card">
        <div class="row"><h2 style="margin:0">${icon('tag', 17)}Tagy</h2><span class="spacer"></span>${r.writable && !info.empty ? `<button class="btn small primary" id="newT">${icon('plus', 15)}Nový tag</button>` : ''}</div>
        <div class="table-wrap"><table><tr><th>Tag</th><th>Commit</th><th>Datum</th><th></th></tr>
        ${list.map((t) => `<tr><td><a href="${U(c, name, 'tree', t.name)}"><b class="mono">${esc(t.name)}</b></a> ${t.annotated ? '<span class="badge plain">anotovaný</span>' : ''}${relByTag.has(t.name) ? ` <a class="badge ok" href="${U(c, name, 'releases', 'tag', t.name)}">release</a>` : ''}${t.message ? `<div class="small muted">${esc(t.message)}${t.tagger ? ` – ${esc(t.tagger)}` : ''}</div>` : ''}</td>
          <td><a class="mono" href="${U(c, name, 'commit', t.commit)}">${short(t.commit)}</a></td><td class="small">${when(t.date)}</td>
          <td class="actions"><button class="btn small ghost" data-arch="${esc(t.name)}" data-f="zip" title="ZIP">${icon('download', 14)}zip</button><button class="btn small ghost" data-arch="${esc(t.name)}" data-f="tar.gz" title="tar.gz">${icon('download', 14)}tar.gz</button>
            ${r.writable && !relByTag.has(t.name) ? `<a class="btn small" href="${U(c, name, 'releases', 'new', { tag: t.name })}">Vytvořit release</a>` : ''}
            ${r.writable ? `<button class="btn small ghost danger" data-delt="${esc(t.name)}" title="Smazat tag">${icon('trash', 14)}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Žádné tagy.</td></tr>'}</table></div></div>`;
      return {
        html,
        mount: (v) => {
          $$('[data-arch]', v).forEach((b) => { b.onclick = async () => download(await run(() => rr().gitArchive(c, name, { ref: b.dataset.arch, format: b.dataset.f })), `${name.split('/').pop()}-${b.dataset.arch}.${b.dataset.f}`); });
          $$('[data-delt]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox(`Smazat tag ${b.dataset.delt}?${relByTag.has(b.dataset.delt) ? ' Release k tagu zůstane, ale bez tagu.' : ''}`)) { await run(() => rr().deleteGitTag(c, name, b.dataset.delt), 'Tag smazán'); ctx.route(); } }; });
          const nt = $('#newT', v);
          if (nt) nt.onclick = () => modal(`<h2>Nový tag</h2><form class="form" id="f"><label>Název <input name="tag" required placeholder="v1.0.0"></label>
              <label>Commit / větev <select name="ref">${info.branches.map((b) => `<option${b.name === info.defaultBranch ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
              <label style="grid-column:1/-1">Zpráva <span class="muted small">(vyplněná = anotovaný tag)</span><textarea name="message" rows="3"></textarea></label></form>
              <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
            $('#ok', el).onclick = async () => { const d = formData($('#f', el)); await run(() => rr().createGitTag(c, name, d), 'Tag vytvořen'); close(); ctx.route(); };
          });
        },
      };
    };

    // ---- releases
    SECTIONS.releases = async (r, sub) => {
      const { c, name } = r;
      if (sub[0] === 'new') return releaseForm(r, null);
      if (sub[0] === 'edit' && sub[1]) return releaseForm(r, await rr().getGitRelease(c, name, sub[1]));
      if (sub[0] === 'tag' && sub[1]) {
        const rel = await rr().getGitReleaseByTag(c, name, sub.slice(1).join('/'));
        return { html: `<div class="row"><a href="${U(c, name, 'releases')}">← všechny releases</a></div>${releaseCard(r, rel, true)}`, mount: (v) => mountRelease(v, r) };
      }
      const list = await rr().listGitReleases(c, name);
      const latest = list.find((x) => !x.draft && !x.prerelease);
      return {
        html: `<div class="row"><h2 style="margin:0">${icon('tag', 18)}Releases</h2><span class="spacer"></span><a class="btn small" href="${U(c, name, 'tags')}">${icon('tag', 15)}Tagy</a>${r.writable && !r.info.empty ? `<a class="btn small primary" href="${U(c, name, 'releases', 'new')}">${icon('plus', 15)}Nový release</a>` : ''}</div>
          ${list.map((rel) => releaseCard(r, rel, false, latest && rel.id === latest.id)).join('') || `<div class="card"><p class="muted">Zatím žádné releases. Release zabalí verzi projektu (tag) s poznámkami a soubory ke stažení.</p></div>`}`,
        mount: (v) => mountRelease(v, r),
      };
    };

    function releaseCard(r, rel, full, latest) {
      const { c, name } = r;
      return `<article class="card release" data-rel="${rel.id}">
        <header class="row"><h2 style="margin:0"><a href="${U(c, name, 'releases', 'tag', rel.tag_name)}">${esc(rel.name || rel.tag_name)}</a></h2>
          ${latest ? '<span class="badge ok">nejnovější</span>' : ''}${rel.prerelease ? '<span class="badge warn">předběžná verze</span>' : ''}${rel.draft ? '<span class="badge plain">koncept</span>' : ''}<span class="spacer"></span>
          ${r.writable ? `<a class="btn small ghost" href="${U(c, name, 'releases', 'edit', rel.id)}" title="Upravit">${icon('edit', 15)}</a><button class="btn small ghost danger" data-delrel="${rel.id}" title="Smazat">${icon('trash', 15)}</button>` : ''}</header>
        <p class="small muted">${icon('tag', 12)}<a class="mono" href="${U(c, name, 'tree', rel.tag_name)}">${esc(rel.tag_name)}</a> · ${esc(rel.author.login)} ${rel.draft ? 'připravuje' : `vydal(a) ${when(rel.published_at)}`}</p>
        <div class="markdown-body" data-relmd="${rel.id}">${rel.body ? markdown(rel.body, { c, name, ref: rel.tag_name, path: 'RELEASE.md' }) : '<p class="muted">Bez poznámek.</p>'}</div>
        <details class="assets"${full || rel.assets.length ? ' open' : ''}><summary><b>Soubory</b> <span class="pill">${rel.assets.length + 2}</span></summary>
          <ul class="asset-list">${rel.assets.map((a) => `<li>${icon('package', 15)}<a href="#" data-asset="${a.id}" data-name="${esc(a.name)}">${esc(a.name)}</a>${a.label ? ` <span class="muted small">${esc(a.label)}</span>` : ''}<span class="spacer"></span><span class="small muted">${fmtBytes(a.size)} · staženo ${a.download_count}×</span>${r.writable ? `<button class="btn small ghost danger" data-delasset="${a.id}" title="Smazat soubor">${icon('x', 13)}</button>` : ''}</li>`).join('')}
            <li>${icon('download', 15)}<a href="#" data-src="zip" data-tag="${esc(rel.tag_name)}">Zdrojový kód (zip)</a></li>
            <li>${icon('download', 15)}<a href="#" data-src="tar.gz" data-tag="${esc(rel.tag_name)}">Zdrojový kód (tar.gz)</a></li></ul>
          ${r.writable ? `<label class="btn small" style="margin-top:6px">${icon('upload', 14)}Přidat soubory<input type="file" multiple hidden data-upasset="${rel.id}"></label>` : ''}</details>
      </article>`;
    }

    function mountRelease(v, r) {
      const { c, name } = r;
      $$('[data-relmd]', v).forEach((el) => mountMarkdown(el, { c, name, ref: r.info.defaultBranch }));
      $$('[data-asset]', v).forEach((a) => { a.onclick = async (e) => { e.preventDefault(); download(await run(() => rr().downloadGitReleaseAsset(c, name, a.dataset.asset)), a.dataset.name); }; });
      $$('[data-src]', v).forEach((a) => { a.onclick = async (e) => { e.preventDefault(); download(await run(() => rr().gitArchive(c, name, { ref: a.dataset.tag, format: a.dataset.src })), `${name.split('/').pop()}-${a.dataset.tag}.${a.dataset.src}`); }; });
      $$('[data-delasset]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox('Smazat soubor z release?')) { await run(() => rr().deleteGitReleaseAsset(c, name, b.dataset.delasset), 'Smazáno'); ctx.route(); } }; });
      $$('[data-delrel]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox('Smazat release? Tag v repozitáři zůstane.')) { await run(() => rr().deleteGitRelease(c, name, b.dataset.delrel), 'Release smazán'); go(U(c, name, 'releases')); } }; });
      $$('[data-upasset]', v).forEach((inp) => {
        inp.onchange = async () => {
          for (const f of inp.files) await run(() => rr().uploadGitReleaseAsset(c, name, inp.dataset.upasset, f, { name: f.name }));
          toast('Soubory nahrány');
          ctx.route();
        };
      });
    }

    async function releaseForm(r, rel) {
      const { c, name, info } = r;
      if (!r.writable) throw new Error('Do tohoto repozitáře nemůžete zapisovat.');
      const tag = rel ? rel.tag_name : r.q.get('tag') || '';
      const tags = info.tags.map((t) => t.name);
      const html = `<div class="card" style="max-width:900px"><h2 style="margin-top:0">${icon('tag', 18)}${rel ? 'Upravit release' : 'Nový release'}</h2>
        <form class="form" id="f">
          <label>Tag <input name="tag_name" list="tagList" required value="${esc(tag)}" placeholder="v1.0.0"><datalist id="tagList">${tags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist></label>
          <label>Cíl (pro nový tag) <select name="target_commitish">${info.branches.map((b) => `<option${b.name === ((rel && rel.target_commitish) || info.defaultBranch) ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>
          <p class="small muted" style="grid-column:1/-1;margin:0" id="tagHint"></p>
          <label style="grid-column:1/-1">Název release <input name="name" value="${esc(rel ? rel.name : tag)}"></label>
          <div style="grid-column:1/-1"><div class="row"><div class="tabs small-tabs"><button type="button" class="active" data-et="edit">Psát</button><button type="button" data-et="preview">Náhled</button></div><span class="spacer"></span>${rel ? '' : '<label class="check"><input type="checkbox" name="generate_release_notes"> vygenerovat poznámky z commitů</label>'}</div>
            <textarea name="body" id="rbody" rows="12" placeholder="Popište tuto verzi (Markdown)">${esc(rel ? rel.body : '')}</textarea><div id="rprev" class="markdown-body hidden"></div></div>
          ${rel ? '' : '<label style="grid-column:1/-1">Soubory (binárky, balíčky…) <input type="file" id="assets" multiple></label>'}
          <label class="check"><input type="checkbox" name="prerelease"${rel && rel.prerelease ? ' checked' : ''}> předběžná verze (pre-release)</label>
          <label class="check"><input type="checkbox" name="draft"${rel && rel.draft ? ' checked' : ''}> uložit jako koncept</label>
        </form>
        <div class="row" style="margin-top:10px"><a class="btn" href="${U(c, name, 'releases')}">Zrušit</a><span class="spacer"></span><button class="btn primary" id="ok">${rel ? 'Uložit' : 'Vydat release'}</button></div></div>`;
      return {
        html,
        mount: (v) => {
          const f = $('#f', v);
          const hint = () => { const t = f.tag_name.value.trim(); $('#tagHint', v).textContent = !t ? '' : tags.includes(t) ? `Existující tag ${t}.` : `Tag ${t} se vytvoří z větve ${f.target_commitish.value} při vydání.`; };
          f.tag_name.oninput = hint;
          f.target_commitish.onchange = hint;
          hint();
          f.draft.onchange = () => { $('#ok', v).textContent = f.draft.checked ? 'Uložit koncept' : rel ? 'Uložit' : 'Vydat release'; };
          $$('[data-et]', v).forEach((b) => {
            b.onclick = () => {
              $$('[data-et]', v).forEach((x) => x.classList.toggle('active', x === b));
              const pv = b.dataset.et === 'preview';
              $('#rbody', v).classList.toggle('hidden', pv);
              const p = $('#rprev', v);
              p.classList.toggle('hidden', !pv);
              if (pv) { p.innerHTML = markdown($('#rbody', v).value || '_Bez poznámek._', { c, name, ref: info.defaultBranch, path: 'RELEASE.md' }); mountMarkdown(p, { c, name, ref: info.defaultBranch }); }
            };
          });
          $('#ok', v).onclick = async () => {
            const d = formData(f);
            if (!d.tag_name.trim()) return toast('Zadejte tag', true);
            const out = rel ? await run(() => rr().updateGitRelease(c, name, rel.id, d), 'Uloženo') : await run(() => rr().createGitRelease(c, name, d), d.draft ? 'Koncept uložen' : 'Release vydán');
            const files = rel ? [] : [...($('#assets', v).files || [])];
            for (const file of files) await run(() => rr().uploadGitReleaseAsset(c, name, out.id, file, { name: file.name }));
            go(U(c, name, 'releases', 'tag', out.tag_name));
          };
        },
      };
    }

    // ---- pull requests & issues
    SECTIONS.pulls = (r, sub) => collab(r, 'pulls', sub[0] ? Number(sub[0]) : null);
    SECTIONS.issues = (r, sub) => collab(r, 'issues', sub[0] ? Number(sub[0]) : null);

    async function collab(r, kind, number) {
      const { c, name, info, q } = r;
      const isPull = kind === 'pulls';
      const canWrite = r.writable || (r.perm.write && !info.mirror);
      const back = (params) => U(c, name, kind, params || {});
      const comments = (list) => `<div class="card"><h2>${icon('menu', 17)}Komentáře (${list.length})</h2>
        <ul class="feed">${list.map((cm) => `<li>${tile('git', 'users')}<div class="tx"><b>${esc(cm.user.login)}</b> <span class="when">${when(cm.created_at)}</span><div class="markdown-body" data-cmd>${markdown(cm.body, { c, name, ref: info.defaultBranch, path: 'c.md' })}</div></div></li>`).join('') || '<li class="muted">Zatím žádné komentáře.</li>'}</ul>
        ${canWrite ? `<form class="form" id="cf" style="margin-top:10px"><label style="grid-column:1/-1">Nový komentář <textarea name="body" required placeholder="Markdown"></textarea></label></form>
        <div class="row" style="margin-top:8px"><button class="btn primary" id="addC">${icon('plus', 15)}Přidat komentář</button></div>` : ''}</div>`;
      const editModal = (it, onSave) => modal(`<h2>Upravit #${it.number}</h2><form class="form" id="f">
          <label style="grid-column:1/-1">Název <input name="title" required value="${esc(it.title)}"></label>
          ${isPull ? '' : `<label style="grid-column:1/-1">Štítky (čárkou) <input name="labels" value="${esc((it.labels || []).map((l) => l.name).join(','))}"></label>`}
          <label style="grid-column:1/-1">Popis <textarea name="body" rows="8">${esc(it.body || '')}</textarea></label></form>
        <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Uložit</button></div>`, (el, close) => {
        $('#ok', el).onclick = async () => {
          const d = formData($('#f', el));
          if (!isPull) d.labels = d.labels.split(',').map((x) => x.trim()).filter(Boolean);
          await run(() => onSave(d), 'Uloženo');
          close(); ctx.route();
        };
      });

      if (number) {
        const it = isPull ? await rr().getGitPull(c, name, number) : await rr().getGitIssue(c, name, number);
        if (!isPull && it.pull_request) { go(U(c, name, 'pulls', number)); return { html: '' }; }
        const list = await rr().listGitIssueComments(c, name, number);
        const ms = MERGE_STATE[it.mergeable_state] || MERGE_STATE.unknown;
        let merge = '';
        if (isPull && it.merged) {
          merge = `<p>${icon('check', 15)} Sloučeno ${when(it.merged_at)}${it.merged_by ? ` uživatelem <b>${esc(it.merged_by.login)}</b>` : ''} jako <a href="${U(c, name, 'commit', it.merge_commit_sha)}"><code>${short(it.merge_commit_sha)}</code></a></p>`;
        } else if (isPull) {
          merge = `<p><span class="badge ${ms[0]}">${esc(it.mergeable_state)}</span> ${esc(ms[1])}${it.conflicts && it.conflicts.length ? `: <code>${it.conflicts.map(esc).join(', ')}</code>` : ''}</p>
            ${it.state === 'open' && canWrite ? `<form class="form" id="mf"><label>Způsob sloučení <select name="merge_method"><option value="merge">merge commit</option><option value="squash">squash (jeden commit)</option><option value="rebase">rebase (přehrát commity)</option></select></label>
              <label>Titulek commitu (nepovinné) <input name="commit_title" placeholder="${esc(it.title)}"></label></form>
              <div class="row" style="margin-top:8px"><button class="btn primary" id="merge"${it.mergeable === false ? ' disabled' : ''}>${icon('git', 15)}Sloučit do ${esc(it.base.ref)}</button></div>` : ''}`;
        }
        const html = `<div class="row"><a href="${back()}">← ${isPull ? 'pull requesty' : 'issues'}</a></div>
          <div class="card"><div class="row"><h2 style="margin:0">${esc(it.title)} <span class="muted">#${it.number}</span></h2>${STATE_BADGE(it)} ${labelBadges(it)}<span class="spacer"></span>
            ${canWrite ? `<button class="btn small" id="edit">${icon('edit', 15)}Upravit</button>${it.merged ? '' : `<button class="btn small${it.state === 'open' ? ' danger' : ''}" id="toggle">${it.state === 'open' ? 'Zavřít' : 'Znovu otevřít'}</button>`}` : ''}</div>
            <p class="muted small"><b>${esc(it.user.login)}</b> otevřel(a) ${when(it.created_at)}${isPull ? ` · <a href="${U(c, name, 'tree', it.head.ref)}"><code>${esc(it.head.ref)}</code></a> → <code>${esc(it.base.ref)}</code> · <code>${short(it.head.sha)}</code>` : ''}${it.closed_at ? ` · zavřeno ${when(it.closed_at)}` : ''}</p>
            <div class="markdown-body" data-cmd>${it.body ? markdown(it.body, { c, name, ref: info.defaultBranch, path: 'pr.md' }) : '<p class="muted">(bez popisu)</p>'}</div>
            ${isPull ? `<div class="row"><a class="btn small" href="${U(c, name, 'commits', it.head.ref)}">${icon('activity', 14)}Commity větve</a></div>` : ''}</div>
          ${isPull ? `<div class="card"><h2>${icon('git', 17)}Sloučení</h2>${merge}</div>` : ''}
          ${comments(list)}`;
        return {
          html,
          mount: (v) => {
            $$('[data-cmd]', v).forEach((el) => mountMarkdown(el, { c, name, ref: info.defaultBranch }));
            const on = (id, fn) => { const el = $(id, v); if (el) el.onclick = fn; };
            on('#addC', async () => {
              const d = formData($('#cf', v));
              if (!d.body.trim()) return toast('Napište text komentáře', true);
              await run(() => rr().createGitIssueComment(c, name, number, { body: d.body }), 'Komentář přidán');
              ctx.route();
            });
            on('#edit', () => editModal(it, (d) => (isPull ? rr().updateGitPull(c, name, number, d) : rr().updateGitIssue(c, name, number, d))));
            on('#toggle', async () => {
              const state = it.state === 'open' ? 'closed' : 'open';
              await run(() => (isPull ? rr().updateGitPull(c, name, number, { state }) : rr().updateGitIssue(c, name, number, { state })), state === 'closed' ? 'Zavřeno' : 'Znovu otevřeno');
              ctx.route();
            });
            on('#merge', async () => {
              const d = formData($('#mf', v));
              if (!d.commit_title) delete d.commit_title;
              if (!(await confirmBox(`Sloučit #${it.number} (${d.merge_method}) do ${it.base.ref}?`))) return;
              const res = await run(() => rr().mergeGitPull(c, name, number, d));
              toast(`${res.message} (${short(res.sha)})`);
              ctx.route();
            });
          },
        };
      }

      const state = ['open', 'closed', 'all'].includes(q.get('state')) ? q.get('state') : 'open';
      const labels = q.get('labels') || '';
      const rows = isPull ? await rr().listGitPulls(c, name, { state }) : await rr().listGitIssues(c, name, { state, labels });
      const stateSel = `<label class="dt-select">${icon('filter', 16)}<span class="sr">Stav</span><select id="cState">${[['open', 'otevřené'], ['closed', 'zavřené'], ['all', 'všechny']].map(([k, l]) => `<option value="${k}"${k === state ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
      const html = `<div class="card">
          <div class="row">${stateSel}${isPull ? '' : `<label class="dt-select">${icon('tag', 16)}<input id="cLabels" placeholder="štítky (a,b)" value="${esc(labels)}"></label>`}<span class="spacer"></span>
            ${canWrite ? `<button class="btn small primary" id="cNew">${icon('plus', 15)}${isPull ? 'Nový pull request' : 'Nové issue'}</button>` : ''}</div>
          <div class="table-wrap"><table><tr><th>#</th><th>Název</th>${isPull ? '<th>Větve</th>' : '<th>Štítky</th>'}<th>Stav</th><th>Autor</th><th>Komentáře</th><th>Změněno</th></tr>
          ${rows.map((it) => `<tr class="click" data-n="${it.number}"><td class="mono">#${it.number}</td><td><b>${esc(it.title)}</b></td>
            <td>${isPull ? `<code>${esc(it.head.ref)}</code> → <code>${esc(it.base.ref)}</code>` : labelBadges(it)}</td><td>${STATE_BADGE(it)}</td><td>${esc(it.user.login)}</td><td>${it.comments}</td><td>${when(it.updated_at)}</td></tr>`).join('')
            || `<tr><td colspan="7" class="muted">${isPull ? 'Žádné pull requesty.' : 'Žádné issues.'}</td></tr>`}</table></div></div>`;
      return {
        html,
        mount: (v) => {
          $$('tr[data-n]', v).forEach((tr) => { tr.onclick = () => go(U(c, name, kind, tr.dataset.n)); });
          $('#cState', v).onchange = (e) => go(back({ state: e.target.value, labels: labels || undefined }));
          const lab = $('#cLabels', v);
          if (lab) lab.onchange = (e) => go(back({ state, labels: e.target.value.trim() || undefined }));
          const nb = $('#cNew', v);
          if (!nb) return;
          const branches = info.branches.map((b) => b.name);
          const opts = (sel) => branches.map((b) => `<option${b === sel ? ' selected' : ''}>${esc(b)}</option>`).join('');
          const open = () => {
            if (isPull && branches.length < 2) return toast('Pull request potřebuje alespoň dvě větve – vytvořte větev nebo ji pošlete přes git push.', true);
            const compare = q.get('compare');
            modal(isPull ? `<h2>Nový pull request</h2><form class="form" id="f">
                <label>Sloučit větev (head) <select name="head">${opts(compare && branches.includes(compare) ? compare : branches.find((b) => b !== info.defaultBranch))}</select></label>
                <label>do větve (base) <select name="base">${opts(info.defaultBranch)}</select></label>
                <label style="grid-column:1/-1">Název <input name="title" required value="${esc(compare || '')}"></label>
                <label style="grid-column:1/-1">Popis <textarea name="body" rows="6" placeholder="Markdown"></textarea></label>
                <label class="check"><input type="checkbox" name="draft"> koncept (draft)</label></form>
              <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`
              : `<h2>Nové issue</h2><form class="form" id="f">
                <label style="grid-column:1/-1">Název <input name="title" required></label>
                <label style="grid-column:1/-1">Štítky (čárkou) <input name="labels" placeholder="bug,ui"></label>
                <label style="grid-column:1/-1">Popis <textarea name="body" rows="6" placeholder="Markdown"></textarea></label></form>
              <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Vytvořit</button></div>`, (el, close) => {
              $('#ok', el).onclick = async () => {
                const d = formData($('#f', el));
                if (!d.title.trim()) return toast('Zadejte název', true);
                if (!isPull) d.labels = d.labels.split(',').map((x) => x.trim()).filter(Boolean);
                const it = await run(() => (isPull ? rr().createGitPull(c, name, d) : rr().createGitIssue(c, name, d)), 'Vytvořeno');
                close();
                go(U(c, name, kind, it.number));
              };
            });
            return undefined;
          };
          nb.onclick = open;
          if (isPull && q.get('compare')) open();
        },
      };
    }

    // ---- settings
    SECTIONS.settings = async (r) => {
      const { c, name, info } = r;
      if (!r.perm.admin) throw Object.assign(new Error('Nastavení může měnit jen správce repozitáře.'), { status: 0 });
      const containers = (await rr().listRepos()).filter((x) => x.type === 'git');
      const tab = r.q.get('tab') || 'general';
      const TABS = [['general', 'Obecné'], ['access', 'Přístup'], ['branches', 'Větve'], ...(isAdmin() ? [['mirrors', 'Zrcadla']] : []), ['danger', 'Nebezpečná zóna']];
      const owner = name.includes('/') ? name.split('/').slice(0, -1).join('/') : '';
      const short0 = name.split('/').pop();
      let html = '';
      if (tab === 'general') {
        html = `<div class="card"><h2>Obecné</h2><form class="form" id="fs">
            <label style="grid-column:1/-1">Popis <input name="description" value="${esc(info.description)}"></label>
            <label>Výchozí větev <select name="defaultBranch">${info.branches.map((b) => `<option${b.name === info.defaultBranch ? ' selected' : ''}>${esc(b.name)}</option>`).join('') || `<option>${esc(info.defaultBranch || 'main')}</option>`}</select></label></form>
            <div class="row" style="margin-top:8px"><button class="btn primary" id="saveS">Uložit</button></div></div>
          <div class="card"><h2>Název a umístění</h2><p class="small muted">Přejmenování i přesun zachová historii, issues, pull requesty a releases. Staré URL (git clone/push i odkazy) budou dál fungovat přes přesměrování.</p>
            <form class="form" id="fm" style="grid-template-columns:minmax(0,1fr) auto minmax(0,2fr)">
              <label>Vlastník <input name="owner" value="${esc(owner)}" placeholder="(bez vlastníka)"></label><span style="align-self:end;padding-bottom:10px">/</span>
              <label>Název <input name="name" value="${esc(short0)}" required></label>
              ${containers.length > 1 ? `<label style="grid-column:1/-1">Úložiště (repozitář typu git) <select name="repo">${containers.map((x) => `<option${x.name === c ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}</form>
            <div class="row" style="margin-top:8px"><button class="btn" id="move">${icon('edit', 15)}Přejmenovat / přesunout</button></div></div>`;
      } else if (tab === 'access') {
        const collabs = Object.entries(info.collaborators || {});
        html = `<div class="card"><h2>Viditelnost</h2><form class="form" id="fv" style="grid-template-columns:1fr">
            <label class="radio"><input type="radio" name="visibility" value="public"${info.private ? '' : ' checked'}> ${icon('git', 16)}<span><b>Veřejný</b><small>Vidí ho každý, kdo smí číst v úložišti ${esc(c)}.</small></span></label>
            <label class="radio"><input type="radio" name="visibility" value="private"${info.private ? ' checked' : ''}> ${icon('lock', 16)}<span><b>Soukromý</b><small>Jen vlastník (${esc(info.owner || '–')}), spolupracovníci a správci.</small></span></label></form>
            <div class="row" style="margin-top:8px"><button class="btn primary" id="saveV">Uložit viditelnost</button></div></div>
          <div class="card"><h2>Spolupracovníci</h2><p class="small muted">Vlastník: <b>${esc(info.owner || '–')}</b>. Spolupracovníci mohou repozitář vidět i když je soukromý; „zápis“ smí push, „správce“ i nastavení.</p>
            <div class="table-wrap"><table>${collabs.map(([u, role]) => `<tr><td>${icon('users', 14)} <b>${esc(u)}</b></td><td><select data-crole="${esc(u)}">${['read', 'write', 'admin'].map((x) => `<option value="${x}"${x === role ? ' selected' : ''}>${{ read: 'čtení', write: 'zápis', admin: 'správce' }[x]}</option>`).join('')}</select></td><td class="actions"><button class="btn small ghost danger" data-crm="${esc(u)}">${icon('x', 14)}</button></td></tr>`).join('') || '<tr><td class="muted">Žádní spolupracovníci.</td></tr>'}</table></div>
            <form class="form" id="fc" style="margin-top:8px"><label>Uživatel <input name="user" placeholder="jméno"></label><label>Oprávnění <select name="role"><option value="read">čtení</option><option value="write" selected>zápis</option><option value="admin">správce</option></select></label></form>
            <div class="row" style="margin-top:8px"><button class="btn" id="addCol">${icon('plus', 15)}Přidat spolupracovníka</button>${isAdmin() ? '<span class="spacer"></span><button class="btn small" id="setOwner">Změnit vlastníka…</button>' : ''}</div></div>`;
      } else if (tab === 'branches') {
        html = `<div class="card"><h2>Ochrana větví</h2><form class="form" id="fp"><label style="grid-column:1/-1">Chráněné větve (vzory, čárkou) – zákaz force-push a smazání <input name="protectedBranches" value="${esc(info.protectedBranches.join(','))}" placeholder="main,release/*"></label></form>
          <div class="row" style="margin-top:8px"><button class="btn primary" id="saveP">Uložit</button><a class="btn" href="${U(c, name, 'branches')}">Správa větví →</a></div></div>`;
      } else if (tab === 'mirrors') {
        const m = info.mirror;
        html = `<div class="card"><h2>⇣ Pull zrcadlo (zdroj)</h2>
            ${m ? `<p>Stav <span class="badge ${m.status === 'ok' ? 'ok' : m.status === 'error' ? 'off' : ''}">${esc(m.status)}</span> · poslední synchronizace ${fmtDate(m.lastSync) || '–'}${m.lastError ? ` · <span class="error">${esc(m.lastError)}</span>` : ''}</p>
              <p class="small">Webhook pro okamžitou synchronizaci (GitHub → Settings → Webhooks, content type JSON): <code>${esc(m.webhookUrl)}</code>, secret <code>${esc(m.webhookSecret)}</code></p>` : '<p class="muted">Repozitář není zrcadlem. Nastavením URL se z něj stane zrcadlo jen pro čtení.</p>'}
            <form class="form" id="fmi">
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
            <form class="form" id="fpm" style="margin-top:10px">
              <label style="grid-column:1/-1">Cílová URL <input name="url" placeholder="https://github.com/firma/projekt.git"></label>
              <label>Token <input name="token" type="password"></label><label>Uživatel (výchozí x-access-token) <input name="username"></label>
              <label>Režim <select name="mode"><option value="mirror">mirror (vše včetně mazání)</option><option value="branches">jen větve a tagy</option></select></label>
              <label class="check"><input type="checkbox" name="createMissing"> GitHub: vytvořit, pokud neexistuje</label>
              <label class="check"><input type="checkbox" name="private" checked> jako privátní</label></form>
            <div class="row" style="margin-top:8px"><button class="btn" id="addPm">+ Přidat push zrcadlo</button>${info.pushMirrors.length ? '<button class="btn" id="push">⇡ Odeslat teď</button>' : ''}</div></div>`;
      } else {
        html = `<div class="card danger-zone"><h2>${icon('alert', 17)}Nebezpečná zóna</h2>
          <div class="row"><div><b>${info.private ? 'Zveřejnit' : 'Skrýt (soukromý)'}</b><p class="small muted" style="margin:0">Změní, kdo repozitář vidí.</p></div><span class="spacer"></span><a class="btn" href="${U(c, name, 'settings', { tab: 'access' })}">Změnit viditelnost</a></div>
          <hr><div class="row"><div><b>Smazat repozitář</b><p class="small muted" style="margin:0">Smaže kód, historii, issues, pull requesty, releases i soubory. Nelze vrátit.</p></div><span class="spacer"></span><button class="btn danger" id="delG">${icon('trash', 15)}Smazat repozitář</button></div></div>`;
      }
      return {
        html: `<div class="settings-grid"><nav class="settings-nav">${TABS.map(([k, l]) => `<a href="${U(c, name, 'settings', { tab: k })}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</nav><div>${html}</div></div>`,
        mount: (v) => {
          const on = (id, fn) => { const el = $(id, v); if (el) el.onclick = fn; };
          const reload = () => ctx.route();
          on('#saveS', async () => { await run(() => rr().updateGitRepo(c, name, formData($('#fs', v))), 'Uloženo'); reload(); });
          on('#move', async () => {
            const d = formData($('#fm', v));
            const newName = d.owner.trim() ? `${d.owner.trim().replace(/\/+$/, '')}/${d.name.trim()}` : d.name.trim();
            const target = d.repo || c;
            if (newName === name && target === c) return toast('Nic se nezměnilo', true);
            if (!(await confirmBox(`Přejmenovat / přesunout ${c}/${name} na ${target}/${newName}?`))) return;
            const g = await run(() => rr().moveGitRepo(c, name, { name: newName, repo: target }), 'Repozitář přesunut');
            forget(c); forget(target);
            go(U(target, g.name, 'settings'));
          });
          on('#saveV', async () => { const d = formData($('#fv', v)); await run(() => rr().setGitAccess(c, name, { visibility: $('[name=visibility]:checked', v).value || d.visibility }), 'Viditelnost změněna'); reload(); });
          const saveCollabs = async (next) => { await run(() => rr().setGitAccess(c, name, { collaborators: next }), 'Uloženo'); reload(); };
          on('#addCol', () => { const d = formData($('#fc', v)); if (!d.user.trim()) return toast('Zadejte uživatele', true); return saveCollabs({ ...(info.collaborators || {}), [d.user.trim()]: d.role }); });
          $$('[data-crole]', v).forEach((s) => { s.onchange = () => saveCollabs({ ...(info.collaborators || {}), [s.dataset.crole]: s.value }); });
          $$('[data-crm]', v).forEach((b) => { b.onclick = () => { const n = { ...(info.collaborators || {}) }; delete n[b.dataset.crm]; saveCollabs(n); }; });
          on('#setOwner', () => modal(`<h2>Vlastník repozitáře</h2><form class="form" id="f" style="grid-template-columns:1fr"><label>Uživatel <input name="owner" value="${esc(info.owner || '')}"></label><p class="small muted">Vlastník má práva správce. Prázdné = podle názvu (owner/…) nebo autora.</p></form>
              <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn primary" id="ok">Uložit</button></div>`, (el, close) => {
            $('#ok', el).onclick = async () => { await run(() => rr().setGitAccess(c, name, { owner: formData($('#f', el)).owner }), 'Uloženo'); close(); reload(); };
          }));
          on('#saveP', async () => { await run(() => rr().updateGitRepo(c, name, formData($('#fp', v))), 'Uloženo'); reload(); });
          on('#saveM', async () => {
            const d = formData($('#fmi', v));
            if (!d.url) return toast('Zadejte URL zdroje', true);
            if (!d.token) delete d.token;
            await run(() => rr().updateGitRepo(c, name, { mirror: d }), 'Zrcadlo uloženo');
            reload();
          });
          on('#offM', async () => { if (await confirmBox('Zrušit zrcadlení? Repozitář zůstane jako běžný.')) { await run(() => rr().updateGitRepo(c, name, { mirror: null }), 'Zrcadlo zrušeno'); reload(); } });
          on('#pull', async () => { toast('Synchronizuji…'); const res = await run(() => rr().gitSync(c, name, { direction: 'pull' })); toast(res.pull && res.pull.ok ? `Hotovo, změn: ${res.pull.changes.length}` : `Chyba: ${res.pull ? res.pull.error : ''}`, !(res.pull && res.pull.ok)); reload(); });
          on('#push', async () => { toast('Odesílám…'); const res = await run(() => rr().gitSync(c, name, { direction: 'push' })); toast(res.push.every((x) => x.ok) ? 'Odesláno' : res.push.map((x) => x.error).filter(Boolean).join('; '), !res.push.every((x) => x.ok)); reload(); });
          on('#addPm', async () => {
            const d = formData($('#fpm', v));
            if (!d.url) return toast('Zadejte cílovou URL', true);
            await run(() => rr().addGitPushMirror(c, name, d), 'Push zrcadlo přidáno');
            reload();
          });
          $$('[data-rmpm]', v).forEach((b) => { b.onclick = async () => { await run(() => rr().deleteGitPushMirror(c, name, b.dataset.rmpm), 'Odebráno'); reload(); }; });
          on('#delG', () => modal(`<h2>Smazat ${esc(name)}</h2><p>Tato akce je <b>nevratná</b>. Smaže repozitář <b>${esc(c)}/${esc(name)}</b> včetně historie, issues, pull requestů a releases.</p>
              <form class="form" id="f" style="grid-template-columns:1fr"><label>Pro potvrzení napište <code>${esc(name)}</code> <input name="confirm" autocomplete="off"></label></form>
              <div class="row"><span class="spacer"></span><button class="btn" data-close>Zrušit</button><button class="btn danger" id="ok" disabled>Smazat repozitář</button></div>`, (el, close) => {
            const inp = $('[name=confirm]', el);
            inp.oninput = () => { $('#ok', el).disabled = inp.value !== name; };
            $('#ok', el).onclick = async () => { await run(() => rr().deleteGitRepo(c, name), 'Repozitář smazán'); close(); forget(c); go(listUrl(c)); };
          }));
        },
      };
    };

    // ------------------------------------------------------------------ profile: SSH keys
    async function profile() {
      if (guest()) return setView('Můj účet', '<div class="card"><p class="muted">Přihlaste se.</p><button class="btn primary" data-login>Přihlásit</button></div>', 'users');
      const keys = await rr().listSshKeys().catch(() => []);
      const ssh = ctx.CFG.ssh;
      const host = ssh ? (ssh.host || location.hostname) : '';
      const example = ssh ? (Number(ssh.port) === 22 ? `git@${host}:vlastnik/projekt.git` : `ssh://git@${host}:${ssh.port}/vlastnik/projekt.git`) : '';
      const v = setView('Můj účet', `
        <div class="card"><div class="row">${tile('git', 'users')}<div><b style="font-size:18px">${esc(me().name)}</b><div class="small muted">${esc(me().role)}${me().via === 'portal' ? ' · účet portálu' : ''}</div></div></div></div>
        <div class="card"><h2>${icon('key', 17)}SSH klíče</h2>
          ${ssh ? `<p class="small muted">S klíčem se přihlásíte ke git přes SSH: <code>git clone ${esc(example)}</code>. Otisk klíče serveru ověříte při prvním připojení.</p>` : '<p class="small warn-text">SSH server není na tomto registru zapnutý (RR_SSH_PORT) – klíče lze uložit, ale přístup přes SSH zatím nefunguje.</p>'}
          <div class="table-wrap"><table><tr><th>Název</th><th>Typ</th><th>Otisk</th><th>Přidán</th><th>Naposledy použit</th><th></th></tr>
            ${keys.map((k) => `<tr><td><b>${esc(k.title)}</b></td><td><span class="pill">${esc(k.type)}</span></td><td class="mono small">${esc(k.fingerprint)}</td><td>${when(k.created)}</td><td>${k.lastUsed ? when(k.lastUsed) : '<span class="muted">nikdy</span>'}</td>
              <td class="actions"><button class="btn small ghost danger" data-delk="${esc(k.id)}" title="Odebrat">${icon('trash', 14)}</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Zatím žádné klíče.</td></tr>'}</table></div>
          <form class="form" id="fk" style="margin-top:10px;grid-template-columns:1fr">
            <label>Název <input name="title" placeholder="pracovní notebook"></label>
            <label>Veřejný klíč <textarea name="key" rows="3" class="mono" placeholder="ssh-ed25519 AAAA… vas@email"></textarea></label>
            <p class="small muted" style="margin:0">Klíč vytvoříte příkazem <code>ssh-keygen -t ed25519 -C "vas@email"</code> a jeho obsah najdete v <code>~/.ssh/id_ed25519.pub</code>.</p></form>
          <div class="row" style="margin-top:8px"><button class="btn primary" id="addK">${icon('plus', 15)}Přidat SSH klíč</button></div></div>`, 'users');
      $('#addK', v).onclick = async () => {
        const d = formData($('#fk', v));
        if (!d.key.trim()) return toast('Vložte veřejný klíč', true);
        await run(() => rr().addSshKey(d), 'Klíč přidán');
        ctx.route();
      };
      $$('[data-delk]', v).forEach((b) => { b.onclick = async () => { if (await confirmBox('Odebrat SSH klíč?')) { await run(() => rr().deleteSshKey(b.dataset.delk), 'Klíč odebrán'); ctx.route(); } }; });
      return v;
    }

    return { git: view, profile };
  };
})();

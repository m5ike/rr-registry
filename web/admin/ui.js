/* RR Registry – UI toolkit: icons, data tables (sort / group / search / columns / selection),
   window manager (windows inside the app + dock), command palette, small charts. No dependencies. */
(function (root) {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(`rr.ui.${k}`); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`rr.ui.${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------------ icons (24 px grid, stroke)
  const ICONS = {
    logo: null,
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    repo: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
    package: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
    folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z',
    file: 'M14 3H6v18h12V7zM14 3v4h4',
    image: 'M3 10h18v6a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 10V6h4v4M10 10V6h4v4M14 10V7h3v3',
    git: 'M6 4v10M18 4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM6 14a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM18 9c0 4-4 5-9.5 6.5',
    search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16.5 16.5L21 21',
    route: 'M4 12h6l4-6h6M10 12l4 6h6M17 3l3 3-3 3M17 15l3 3-3 3',
    cache: 'M13 3L5 13h6l-1 8 8-10h-6z',
    bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
    clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3 2',
    users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M21 20c0-2.8-1.7-5-4-5.7',
    key: 'M8 14a4 4 0 1 1 0-8 4 4 0 0 1 0 8zM11 10h10M18 10v4M21 10v3',
    gear: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1',
    terminal: 'M3 5h18v14H3zM7 9l3 3-3 3M12 15h5',
    download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
    upload: 'M12 21V9M7 14l5-5 5 5M4 4h16',
    filter: 'M3 5h18l-7 8v6l-4 2v-8z',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    sort: 'M8 9l4-4 4 4M8 15l4 4 4-4',
    sortUp: 'M12 19V5M6 11l6-6 6 6',
    sortDown: 'M12 5v14M6 13l6 6 6-6',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z',
    activity: 'M3 12h4l3-7 4 14 3-7h4',
    window: 'M3 5h18v14H3zM3 9h18M6.5 7h.01M9 7h.01',
    popout: 'M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    x: 'M6 6l12 12M18 6L6 18',
    check: 'M5 12l5 5 9-10',
    max: 'M5 5h14v14H5z',
    restore: 'M8 8h11v11H8zM5 16V5h11',
    chevron: 'M9 6l6 6-6 6',
    chevronDown: 'M6 9l6 6 6-6',
    up: 'M12 19V5M5 12l7-7 7 7',
    edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
    eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
    menu: 'M4 6h16M4 12h16M4 18h16',
    logout: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 8l-4 4 4 4M6 12h11',
    sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    columns: 'M4 4h16v16H4zM9.5 4v16M14.5 4v16',
    rows: 'M4 6h16M4 12h16M4 18h16',
    tag: 'M3 12V4h8l10 10-8 8zM7.5 7.5h.01',
    copy: 'M8 8h12v12H8zM4 16V4h12',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
    alert: 'M12 8v5M12 16.5h.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v6M12 7.5h.01',
    play: 'M7 4l13 8-13 8z',
    pin: 'M12 17v5M8 3h8l-1 7 3 3H6l3-3z',
    broom: 'M14 3l-4 9M6 13h9l2 8H4z',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
  };

  function icon(name, size = 18, extra = '') {
    if (name === 'logo') return logo(size);
    const d = ICONS[name] || ICONS.dots;
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${extra}><path d="${d}"/></svg>`;
  }

  function logo(size = 32) {
    return `<svg class="logo-mark" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 5 55.4 18.5v27L32 59 8.6 45.5v-27z" fill="var(--accent)" stroke="var(--accent)" stroke-width="3" stroke-linejoin="round"/><path d="M21 22l10 10-10 10M32 22l10 10-10 10" fill="none" stroke="var(--on-accent)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  /** Replace <i data-icon="name" data-size="18"></i> placeholders with SVG icons. */
  function hydrate(rootEl = document) {
    rootEl.querySelectorAll('i[data-icon]').forEach((el) => {
      el.outerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
    });
  }

  // ------------------------------------------------------------------ small charts
  function sparkline(values, { w = 120, h = 36, color = 'var(--accent)', fill = true } = {}) {
    const vals = values.length ? values : [0];
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const pts = vals.map((v, i) => [vals.length === 1 ? w / 2 : Math.round((i / (vals.length - 1)) * (w - 2)) + 1, Math.round(h - 3 - ((v - min) / (max - min || 1)) * (h - 8))]);
    const line = pts.map((p) => p.join(',')).join(' ');
    return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">${fill ? `<polyline points="1,${h} ${line} ${w - 1},${h}" fill="${color}" opacity="0.14" stroke="none"/>` : ''}<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  function ring(pct, { size = 120, stroke = 12, color = 'var(--ok)', label = '', sub = '' } = {}) {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(1, pct));
    return `<svg class="ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(label)} ${Math.round(p * 100)} %">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="${p > 0 ? 'round' : 'butt'}" stroke-dasharray="${(c * p).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="50%" text-anchor="middle" dy="0.1em" class="ring-v">${Math.round(p * 100)}%</text>
      ${sub ? `<text x="50%" y="50%" text-anchor="middle" dy="1.6em" class="ring-s">${esc(sub)}</text>` : ''}</svg>`;
  }

  /** Stacked bars: series = [{key, color, label}], data = [{title, values: {key: n}}]. */
  function bars(data, series, { height = 170 } = {}) {
    const max = Math.max(1, ...data.map((d) => series.reduce((n, s) => n + (d.values[s.key] || 0), 0)));
    return `<div class="bars" style="height:${height}px" role="img" aria-label="Graf">${data.map((d) => {
      const total = series.reduce((n, s) => n + (d.values[s.key] || 0), 0);
      return `<div class="bar" title="${esc(d.title)}: ${total}">${series.slice().reverse().map((s) => `<span style="height:${((d.values[s.key] || 0) / max) * 100}%;background:${s.color}"></span>`).join('')}</div>`;
    }).join('')}</div>`;
  }

  function legend(series) {
    return `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>`;
  }

  // ------------------------------------------------------------------ data table
  /**
   * table(host, opts) – sortable, groupable, searchable table with column toggles, density,
   * selection and "load more"; state (sort, group, hidden columns, density) persists per `id`.
   * columns: [{ key, label, value(row) -> sortable value, render(row) -> html, align, width,
   *             toggle (can be hidden), hidden (hidden by default), nowrap, sort:false }]
   */
  function table(host, opts) {
    const o = { pageSize: 100, empty: 'Nic tu není.', groups: [], ...opts };
    const saved = LS.get(`table.${o.id}`, {});
    const cols = o.columns.map((c) => ({ value: (r) => r[c.key], ...c }));
    const st = {
      sort: saved.sort && cols.some((c) => c.key === saved.sort) ? saved.sort : (o.sort || {}).key || null,
      dir: saved.dir || (o.sort || {}).dir || 1,
      group: saved.group !== undefined && (saved.group === '' || o.groups.some((g) => g.key === saved.group)) ? saved.group : o.group || '',
      hidden: saved.hidden || cols.filter((c) => c.hidden).map((c) => c.key),
      dense: !!saved.dense,
      q: o.q || '',
      collapsed: {},
      sel: new Set(),
      limit: o.pageSize,
    };
    let rows = o.rows || [];
    const save = () => LS.set(`table.${o.id}`, { sort: st.sort, dir: st.dir, group: st.group, hidden: st.hidden, dense: st.dense });
    const key = (r, i) => (o.rowKey ? o.rowKey(r) : String(i));
    const text = (r) => (o.search ? o.search(r) : cols.map((c) => c.value(r)).join(' ')).toString().toLowerCase();
    const toggles = cols.filter((c) => c.toggle);

    host.innerHTML = `<div class="dt${st.dense ? ' dense' : ''}">
      <div class="dt-bar">
        <label class="dt-search">${icon('search', 17)}<span class="sr">Hledat v tabulce</span>
          <input type="search" placeholder="${esc(o.placeholder || 'Hledat…')}" value="${esc(st.q)}"></label>
        ${o.groups.length ? `<label class="dt-select">${icon('layers', 16)}<span>Seskupit</span><select data-dt="group"><option value="">nic</option>${o.groups.map((g) => `<option value="${esc(g.key)}"${st.group === g.key ? ' selected' : ''}>${esc(g.label)}</option>`).join('')}</select></label>` : ''}
        ${toggles.length ? `<details class="dt-cols"><summary class="btn small ghost">${icon('columns', 16)}Sloupce</summary><div class="menu">${toggles.map((c) => `<label class="check"><input type="checkbox" data-col="${esc(c.key)}"${st.hidden.includes(c.key) ? '' : ' checked'}> ${esc(c.label)}</label>`).join('')}</div></details>` : ''}
        <button type="button" class="btn small ghost" data-dt="dense" aria-pressed="${st.dense}" title="Hustota řádků">${icon('rows', 16)}<span>${st.dense ? 'Kompaktní' : 'Pohodlná'}</span></button>
        <span class="dt-count"></span>
        ${o.toolbar ? `<div class="dt-extra">${o.toolbar}</div>` : ''}
      </div>
      ${o.actions ? '<div class="dt-selbar hidden"></div>' : ''}
      <div class="dt-wrap"></div>
      <div class="dt-foot"></div>
    </div>`;
    const el = host.firstElementChild;
    const wrap = el.querySelector('.dt-wrap');

    function visible() {
      return cols.filter((c) => !st.hidden.includes(c.key));
    }

    function compute() {
      const q = st.q.trim().toLowerCase();
      let list = rows.filter((r) => !q || q.split(/\s+/).every((t) => text(r).includes(t)));
      if (st.sort) {
        const c = cols.find((x) => x.key === st.sort);
        list = list.slice().sort((a, b) => {
          const x = c.value(a);
          const y = c.value(b);
          if (x == null || x === '') return 1;
          if (y == null || y === '') return -1;
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'cs', { numeric: true })) * st.dir;
        });
      }
      return list;
    }

    function render() {
      const list = compute();
      const vis = visible();
      const g = o.groups.find((x) => x.key === st.group);
      let groups;
      if (g) {
        const m = new Map();
        for (const r of list) {
          const k = String(g.value(r) ?? '–');
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(r);
        }
        groups = [...m.entries()].map(([k, items]) => ({ k, items }));
        if (g.order) groups.sort((a, b) => g.order(a.k, b.k));
      } else groups = [{ k: '', items: list }];
      let shown = 0;
      const head = `<thead><tr>${o.actions ? `<th class="dt-check"><input type="checkbox" data-dt="all" aria-label="Vybrat vše"${list.length && list.every((r) => st.sel.has(key(r, rows.indexOf(r)))) ? ' checked' : ''}></th>` : ''}
        ${vis.map((c) => {
          const active = st.sort === c.key;
          const ariaSort = active ? (st.dir === 1 ? 'ascending' : 'descending') : 'none';
          const lbl = esc(c.label || '');
          return `<th scope="col" class="${c.align === 'right' ? 'r' : ''}" style="${c.width ? `width:${c.width}` : ''}" aria-sort="${c.sort === false ? 'none' : ariaSort}">${c.sort === false || !c.label ? lbl : `<button type="button" class="dt-sort${active ? ' on' : ''}" data-sort="${esc(c.key)}">${lbl}${icon(active ? (st.dir === 1 ? 'sortUp' : 'sortDown') : 'sort', 13)}</button>`}</th>`;
        }).join('')}</tr></thead>`;
      const colspan = vis.length + (o.actions ? 1 : 0);
      const bodies = groups.map((grp) => {
        const collapsed = !!st.collapsed[grp.k];
        const gh = g ? `<tr class="dt-group"><th colspan="${colspan}" scope="rowgroup"><button type="button" data-grp="${esc(grp.k)}" aria-expanded="${!collapsed}">${icon(collapsed ? 'chevron' : 'chevronDown', 14)}
            ${g.render ? g.render(grp.k, grp.items) : `<b>${esc(grp.k)}</b>`}<span class="pill">${grp.items.length}</span>${g.summary ? `<span class="dt-gsum">${g.summary(grp.items)}</span>` : ''}</button></th></tr>` : '';
        let body = '';
        if (!collapsed) {
          for (const r of grp.items) {
            if (shown >= st.limit) break;
            shown++;
            const k = key(r, rows.indexOf(r));
            body += `<tr data-key="${esc(k)}" class="${o.onRow ? 'click' : ''}${st.sel.has(k) ? ' sel' : ''}${o.rowClass ? ` ${o.rowClass(r)}` : ''}">${o.actions ? `<td class="dt-check"><input type="checkbox" data-sel="${esc(k)}" aria-label="Vybrat"${st.sel.has(k) ? ' checked' : ''}></td>` : ''}${vis.map((c) => `<td data-label="${esc(c.label || '')}" class="${c.align === 'right' ? 'r' : ''}${c.nowrap ? ' nw' : ''}${c.cls ? ` ${c.cls}` : ''}">${c.render ? c.render(r) : esc(c.value(r) ?? '')}</td>`).join('')}</tr>`;
          }
        }
        return `<tbody>${gh}${body}</tbody>`;
      }).join('');
      wrap.innerHTML = list.length ? `<table>${head}${bodies}</table>` : `<div class="dt-empty">${icon('search', 28)}<p>${st.q ? `Nic neodpovídá „${esc(st.q)}“.` : esc(o.empty)}</p></div>`;
      el.querySelector('.dt-count').textContent = list.length === rows.length ? `${rows.length}` : `${list.length} z ${rows.length}`;
      el.querySelector('.dt-foot').innerHTML = shown < list.length ? `<button type="button" class="btn small" data-dt="more">Zobrazit další (${list.length - shown})</button>` : '';
      const selbar = el.querySelector('.dt-selbar');
      if (selbar) {
        const selRows = rows.filter((r, i) => st.sel.has(key(r, i)));
        selbar.classList.toggle('hidden', !selRows.length);
        selbar.innerHTML = selRows.length ? `<b>Vybráno: ${selRows.length}</b><span class="spacer"></span>${o.actions.map((a, i) => `<button type="button" class="btn small${a.danger ? ' danger' : ''}" data-act="${i}">${a.icon ? icon(a.icon, 15) : ''}${esc(a.label)}</button>`).join('')}<button type="button" class="btn small ghost" data-dt="clear" aria-label="Zrušit výběr">${icon('x', 15)}</button>` : '';
      }
      if (o.onRender) o.onRender(el);
    }

    el.querySelector('.dt-search input').addEventListener('input', (e) => { st.q = e.target.value; st.limit = o.pageSize; render(); });
    el.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.dt === 'group') { st.group = t.value; save(); render(); }
      else if (t.dataset.col) { st.hidden = t.checked ? st.hidden.filter((k) => k !== t.dataset.col) : [...st.hidden, t.dataset.col]; save(); render(); }
      else if (t.dataset.sel !== undefined) { if (t.checked) st.sel.add(t.dataset.sel); else st.sel.delete(t.dataset.sel); render(); }
      else if (t.dataset.dt === 'all') { const list = compute(); list.forEach((r) => { const k = key(r, rows.indexOf(r)); if (t.checked) st.sel.add(k); else st.sel.delete(k); }); render(); }
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button, a, input, select, label, summary');
      if (b) {
        if (b.dataset.sort) { st.dir = st.sort === b.dataset.sort ? -st.dir : 1; st.sort = b.dataset.sort; save(); render(); return; }
        if (b.dataset.grp !== undefined) { st.collapsed[b.dataset.grp] = !st.collapsed[b.dataset.grp]; render(); return; }
        if (b.dataset.dt === 'dense') { st.dense = !st.dense; el.classList.toggle('dense', st.dense); b.setAttribute('aria-pressed', st.dense); b.querySelector('span').textContent = st.dense ? 'Kompaktní' : 'Pohodlná'; save(); return; }
        if (b.dataset.dt === 'more') { st.limit += o.pageSize; render(); return; }
        if (b.dataset.dt === 'clear') { st.sel.clear(); render(); return; }
        if (b.dataset.act !== undefined) { const a = o.actions[Number(b.dataset.act)]; a.run(rows.filter((r, i) => st.sel.has(key(r, i)))); return; }
        return;
      }
      const tr = e.target.closest('tr[data-key]');
      if (tr && o.onRow) {
        const r = rows.find((x, i) => key(x, i) === tr.dataset.key);
        if (r) o.onRow(r, e);
      }
    });
    render();
    return {
      el,
      setRows(next) { rows = next; render(); },
      clearSelection() { st.sel.clear(); render(); },
      render,
    };
  }

  // ------------------------------------------------------------------ window manager
  const wm = {
    wins: new Map(),
    z: 50,
    layer: null,
    dock: null,
    init(layer, dock) { this.layer = layer; this.dock = dock; },
    mobile() { return window.innerWidth < 720; },
    open(opts) {
      const id = opts.id;
      if (this.wins.has(id)) {
        const w = this.wins.get(id);
        if (opts.title) w.setTitle(opts.title);
        this.show(id);
        if (opts.reload && w.render) w.reload();
        return w;
      }
      const n = this.wins.size;
      const W = Math.min(opts.width || 620, window.innerWidth - 24);
      const H = Math.min(opts.height || 440, window.innerHeight - 120);
      const x = opts.x ?? Math.max(12, Math.min(window.innerWidth - W - 12, 120 + n * 36 + (window.innerWidth > 1100 ? 220 : 0)));
      const y = opts.y ?? Math.max(64, 90 + n * 32);
      const el = document.createElement('section');
      el.className = 'win';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', opts.title);
      el.style.cssText = `left:${x}px;top:${y}px;width:${W}px;height:${H}px`;
      el.innerHTML = `<header class="win-bar">${icon(opts.icon || 'window', 16)}<span class="win-title"></span>
        <button type="button" class="win-btn" data-w="min" aria-label="Minimalizovat">${icon('minus', 15)}</button>
        <button type="button" class="win-btn" data-w="max" aria-label="Maximalizovat">${icon('max', 13)}</button>
        <button type="button" class="win-btn close" data-w="close" aria-label="Zavřít okno">${icon('x', 15)}</button></header>
        <div class="win-body"></div>`;
      el.querySelector('.win-title').textContent = opts.title;
      this.layer.appendChild(el);
      const body = el.querySelector('.win-body');
      const w = {
        id, el, body, opts, state: 'open', max: false, timers: [],
        setTitle: (t) => { el.querySelector('.win-title').textContent = t; el.setAttribute('aria-label', t); w.opts.title = t; this.renderDock(); },
        every: (ms, fn) => { w.timers.push(setInterval(() => { if (w.state === 'open') fn(); }, ms)); },
        reload: async () => {
          if (!opts.render) return;
          try { await opts.render(body, w); } catch (e) { body.innerHTML = `<p class="error pad">${esc(e.message)}</p>`; }
        },
        close: () => this.close(id),
      };
      this.wins.set(id, w);
      // drag (pointer events: mouse, pen and touch)
      const bar = el.querySelector('.win-bar');
      bar.addEventListener('pointerdown', (e) => {
        this.focus(id);
        if (e.target.closest('button') || w.max || this.mobile()) return;
        const dx = e.clientX - el.offsetLeft;
        const dy = e.clientY - el.offsetTop;
        bar.setPointerCapture(e.pointerId);
        const move = (ev) => {
          el.style.left = `${Math.max(-el.offsetWidth + 120, Math.min(window.innerWidth - 80, ev.clientX - dx))}px`;
          el.style.top = `${Math.max(0, Math.min(window.innerHeight - 50, ev.clientY - dy))}px`;
        };
        const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); el.classList.remove('dragging'); };
        el.classList.add('dragging');
        bar.addEventListener('pointermove', move);
        bar.addEventListener('pointerup', up);
      });
      bar.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) this.toggleMax(id); });
      el.addEventListener('pointerdown', () => this.focus(id));
      el.querySelector('[data-w="min"]').onclick = () => this.minimize(id);
      el.querySelector('[data-w="max"]').onclick = () => this.toggleMax(id);
      el.querySelector('[data-w="close"]').onclick = () => this.close(id);
      if (this.mobile()) this.toggleMax(id);
      this.focus(id);
      if (opts.html) body.innerHTML = opts.html;
      w.reload();
      if (opts.onMount) opts.onMount(body, w);
      this.renderDock();
      return w;
    },
    focus(id) {
      const w = this.wins.get(id);
      if (!w) return;
      if (w.el.style.zIndex !== String(this.z)) w.el.style.zIndex = ++this.z;
      this.wins.forEach((x) => x.el.classList.toggle('focused', x === w));
      this.renderDock();
    },
    show(id) {
      const w = this.wins.get(id);
      if (!w) return;
      w.state = 'open';
      w.el.classList.remove('min');
      this.focus(id);
    },
    minimize(id) {
      const w = this.wins.get(id);
      if (!w) return;
      w.state = 'min';
      w.el.classList.add('min');
      w.el.classList.remove('focused');
      this.renderDock();
    },
    toggleMax(id) {
      const w = this.wins.get(id);
      if (!w) return;
      w.max = !w.max;
      w.el.classList.toggle('max', w.max);
      w.el.querySelector('[data-w="max"]').innerHTML = icon(w.max ? 'restore' : 'max', 13);
      w.el.querySelector('[data-w="max"]').setAttribute('aria-label', w.max ? 'Obnovit velikost' : 'Maximalizovat');
      this.focus(id);
    },
    close(id) {
      const w = this.wins.get(id);
      if (!w) return;
      w.timers.forEach(clearInterval);
      if (w.opts.onClose) w.opts.onClose();
      w.el.remove();
      this.wins.delete(id);
      this.renderDock();
    },
    closeAll() { [...this.wins.keys()].forEach((id) => this.close(id)); },
    tile() {
      const list = [...this.wins.values()];
      if (!list.length) return;
      const cols = Math.ceil(Math.sqrt(list.length));
      const rowsN = Math.ceil(list.length / cols);
      const top = 64;
      const left = window.innerWidth > 1100 ? 260 : 12;
      const W = (window.innerWidth - left - 12) / cols;
      const H = (window.innerHeight - top - 90) / rowsN;
      list.forEach((w, i) => {
        w.state = 'open'; w.max = false;
        w.el.classList.remove('min', 'max');
        Object.assign(w.el.style, { left: `${left + (i % cols) * W + 4}px`, top: `${top + Math.floor(i / cols) * H + 4}px`, width: `${W - 8}px`, height: `${H - 8}px` });
      });
      this.renderDock();
    },
    renderDock() {
      if (!this.dock) return;
      const list = [...this.wins.values()];
      this.dock.classList.toggle('hidden', !list.length);
      const top = list.filter((w) => w.state === 'open').sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
      this.dock.innerHTML = list.map((w) => `<button type="button" class="dock-item${w === top ? ' on' : ''}${w.state === 'min' ? ' min' : ''}" data-win="${esc(w.id)}" title="${esc(w.opts.title)}">${icon(w.opts.icon || 'window', 18)}<span>${esc(w.opts.title)}</span></button>`).join('')
        + (list.length > 1 ? `<button type="button" class="dock-item tool" data-wtool="tile" title="Uspořádat okna do dlaždic">${icon('grid', 17)}</button><button type="button" class="dock-item tool" data-wtool="closeall" title="Zavřít všechna okna">${icon('x', 17)}</button>` : '');
      this.dock.querySelectorAll('[data-win]').forEach((b) => {
        b.onclick = () => {
          const w = this.wins.get(b.dataset.win);
          if (w.state === 'open' && w === top) this.minimize(w.id);
          else this.show(w.id);
        };
      });
      const t = this.dock.querySelector('[data-wtool="tile"]');
      if (t) t.onclick = () => this.tile();
      const c = this.dock.querySelector('[data-wtool="closeall"]');
      if (c) c.onclick = () => this.closeAll();
    },
  };

  // ------------------------------------------------------------------ command palette
  function palette({ items, search }) {
    const host = document.createElement('div');
    host.className = 'palette-wrap';
    host.innerHTML = `<div class="palette" role="dialog" aria-label="Příkazy a hledání">
      <label class="palette-input">${icon('search', 20)}<span class="sr">Hledat</span><input placeholder="Přejít na sekci, hledat balíček, spustit akci…" autocomplete="off"><kbd>Esc</kbd></label>
      <ul class="palette-list" role="listbox"></ul>
      <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> výběr</span><span><kbd>Enter</kbd> otevřít</span><span><kbd>⌘K</kbd> kdykoli</span></div></div>`;
    document.body.appendChild(host);
    const input = host.querySelector('input');
    const list = host.querySelector('.palette-list');
    let current = [];
    let idx = 0;
    let seq = 0;
    const close = () => { host.remove(); document.removeEventListener('keydown', onKey, true); };
    const draw = () => {
      list.innerHTML = current.map((it, i) => `<li role="option" aria-selected="${i === idx}" data-i="${i}" class="${i === idx ? 'on' : ''}">${icon(it.icon || 'chevron', 17)}<span class="pl-t">${esc(it.title)}</span>${it.hint ? `<span class="pl-h">${esc(it.hint)}</span>` : ''}${it.group ? `<span class="pl-g">${esc(it.group)}</span>` : ''}</li>`).join('') || '<li class="empty">Nic nenalezeno</li>';
      const on = list.querySelector('.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    };
    const update = async () => {
      const q = input.value.trim().toLowerCase();
      const my = ++seq;
      current = items.filter((it) => !q || `${it.title} ${it.hint || ''} ${it.group || ''} ${it.keywords || ''}`.toLowerCase().includes(q)).slice(0, 40);
      idx = 0;
      draw();
      if (q.length >= 2 && search) {
        const more = await search(q).catch(() => []);
        if (my !== seq) return;
        current = current.concat(more).slice(0, 60);
        draw();
      }
    };
    const choose = (it) => { if (!it) return; close(); it.run(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); idx = Math.min(current.length - 1, idx + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); idx = Math.max(0, idx - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(current[idx]); }
    };
    document.addEventListener('keydown', onKey, true);
    let t;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(update, 120); });
    list.addEventListener('click', (e) => { const li = e.target.closest('li[data-i]'); if (li) choose(current[Number(li.dataset.i)]); });
    host.addEventListener('pointerdown', (e) => { if (e.target === host) close(); });
    update();
    input.focus();
  }

  root.RRUI = { esc, icon, logo, hydrate, sparkline, ring, bars, legend, table, wm, palette, LS, ICONS };
})(window);

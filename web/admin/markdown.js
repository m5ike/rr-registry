/* RRMarkdown - small, dependency-free CommonMark/GFM subset renderer for README and documentation files.
   Safe by construction: raw HTML is escaped, URLs are filtered (no javascript:), every link and image goes
   through resolveLink / resolveImage so relative links of a repository open inside the web UI.

   RRMarkdown.render(text, { resolveLink(href) -> { href, internal }, resolveImage(src) -> url, slugPrefix })
   Supported: ATX + setext headings (with anchors), paragraphs, emphasis, strong, strikethrough, inline code,
   fenced + indented code, block quotes (incl. GitHub alerts), ordered / unordered / task lists (nested),
   tables (alignment), horizontal rules, links, reference links, images, autolinks, hard line breaks. */
(function (root) {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => {
    const s = String(u || '').trim();
    if (/^(javascript|vbscript|data):/i.test(s.replace(/[\s\u0000-\u001f]/g, '')) && !/^data:image\/(png|gif|jpe?g|webp|svg\+xml);/i.test(s)) return '#';
    return s;
  };
  const slugify = (t) => String(t).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;|&#\d+;/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');

  function render(src, opts = {}) {
    const resolveLink = opts.resolveLink || ((h) => ({ href: h, internal: false }));
    const resolveImage = opts.resolveImage || ((s) => s);
    const lines = String(src || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
    const refs = {};
    // reference definitions: [id]: url "title"
    const body = [];
    for (const l of lines) {
      const m = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+["'(](.*)["')])?\s*$/.exec(l);
      if (m) refs[m[1].toLowerCase()] = { url: m[2], title: m[3] || '' };
      else body.push(l);
    }
    const slugs = {};
    const uniqueSlug = (t) => {
      let s = slugify(t) || 'section';
      if (slugs[s] !== undefined) { slugs[s]++; s = `${s}-${slugs[s]}`; } else slugs[s] = 0;
      return (opts.slugPrefix || '') + s;
    };

    // ------------------------------------------------------------------ inline
    function inline(text) {
      const codes = [];
      // code spans first (their content is literal)
      let t = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => { codes.push(`<code>${esc(code.trim() === '' ? code : code.replace(/^ (.*) $/, '$1'))}</code>`); return `\u0000${codes.length - 1}\u0000`; });
      t = esc(t);
      const link = (label, href, title, isImg) => {
        const raw = href.replace(/^&lt;|&gt;$/g, '').replace(/&amp;/g, '&');
        if (/^(javascript|vbscript|data):/i.test(raw.replace(/[\s\u0000-\u001f]/g, '')) && !(isImg && /^data:image\//i.test(raw))) return isImg ? '' : `<a href="#">${label}</a>`;
        if (isImg) return `<img src="${esc(safeUrl(resolveImage(raw)))}" alt="${label}"${title ? ` title="${title}"` : ''} loading="lazy">`;
        const r = resolveLink(raw);
        const ext = !r.internal && /^[a-z][a-z0-9+.-]*:/i.test(r.href) && !/^mailto:/i.test(r.href);
        return `<a href="${esc(safeUrl(r.href))}"${title ? ` title="${title}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}${r.internal ? ' data-md-internal="1"' : ''}>${label}</a>`;
      };
      // images and links: ![alt](src "title"), [text](href "title"), [text][ref], [ref]
      t = t.replace(/(!?)\[((?:[^\][]|\[[^\]]*\])*)\]\(\s*(&lt;[^&]*&gt;|[^\s)]+)(?:\s+(?:&quot;(.*?)&quot;|&#39;(.*?)&#39;))?\s*\)/g, (m, bang, label, href, t1, t2) => link(bang ? label : label, href, t1 || t2 || '', !!bang));
      t = t.replace(/(!?)\[((?:[^\][]|\[[^\]]*\])+)\](?:\[([^\]]*)\])?/g, (m, bang, label, id) => {
        const ref = refs[(id || label).toLowerCase().replace(/&amp;/g, '&')];
        if (!ref) return m;
        return link(label, esc(ref.url), esc(ref.title), !!bang);
      });
      // autolinks <https://...> and bare URLs
      t = t.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (m, u) => `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer">${u}</a>`);
      t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+[^\s<.,:;"')\]])/g, (m, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
      // emphasis
      t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
      t = t.replace(/(^|[^\w*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/g, '$1<em>$2</em>');
      t = t.replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
      t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
      // hard breaks: two trailing spaces or a backslash
      t = t.replace(/( {2,}|\\)\n/g, '<br>\n');
      // emoji shortcodes used in READMEs
      t = t.replace(/:(white_check_mark|heavy_check_mark|x|warning|rocket|bulb|memo|tada|star):/g, (m, k) => ({ white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', warning: '⚠️', rocket: '🚀', bulb: '💡', memo: '📝', tada: '🎉', star: '⭐' }[k]));
      return t.replace(/\u0000(\d+)\u0000/g, (m, i) => codes[Number(i)]);
    }

    // ------------------------------------------------------------------ blocks
    let i = 0;
    const isBlank = (l) => /^\s*$/.test(l);
    const fenceRe = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
    const hrRe = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
    const listRe = /^( *)([-+*]|\d{1,9}[.)])\s+(.*)$/;
    const headRe = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
    const tableSep = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
    const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

    function blocks(ls) {
      const out = [];
      let j = 0;
      const startsBlock = (l, n) => fenceRe.test(l) || headRe.test(l) || hrRe.test(l) || /^ {0,3}>/.test(l) || listRe.test(l) || (l.includes('|') && n !== undefined && tableSep.test(n || ''));
      while (j < ls.length) {
        const l = ls[j];
        if (isBlank(l)) { j++; continue; }
        let m;
        if ((m = fenceRe.exec(l))) {
          const fence = m[1];
          const lang = m[2];
          const code = [];
          j++;
          while (j < ls.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(ls[j])) code.push(ls[j++]);
          j++;
          out.push(`<pre class="md-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
          continue;
        }
        if ((m = headRe.exec(l))) {
          const level = m[1].length;
          const text = inline(m[2] || '');
          const id = uniqueSlug(text);
          out.push(`<h${level} id="${esc(id)}"><a class="md-anchor" href="#${esc(id)}" aria-hidden="true">#</a>${text}</h${level}>`);
          j++;
          continue;
        }
        if (hrRe.test(l)) { out.push('<hr>'); j++; continue; }
        if (/^ {0,3}>/.test(l)) {
          const q = [];
          while (j < ls.length && (/^ {0,3}>/.test(ls[j]) || (!isBlank(ls[j]) && q.length && !startsBlock(ls[j])))) q.push(ls[j++].replace(/^ {0,3}> ?/, ''));
          const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(q[0] || '');
          if (alert) { q.shift(); out.push(`<blockquote class="md-alert md-${alert[1].toLowerCase()}"><p class="md-alert-title">${alert[1][0]}${alert[1].slice(1).toLowerCase()}</p>${blocks(q)}</blockquote>`); }
          else out.push(`<blockquote>${blocks(q)}</blockquote>`);
          continue;
        }
        if (listRe.test(l)) { j = list(ls, j, out); continue; }
        if (l.includes('|') && j + 1 < ls.length && tableSep.test(ls[j + 1])) {
          const head = splitRow(l);
          const align = splitRow(ls[j + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
          j += 2;
          const rows = [];
          while (j < ls.length && !isBlank(ls[j]) && ls[j].includes('|')) rows.push(splitRow(ls[j++]));
          const cell = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c || '')}</${tag}>`;
          out.push(`<div class="md-table"><table><thead><tr>${head.map((c, k) => cell('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell('td', r[k], k)).join('')}</tr>`).join('')}</tbody></table></div>`);
          continue;
        }
        if (/^ {4}/.test(l)) {
          const code = [];
          while (j < ls.length && (/^ {4}/.test(ls[j]) || isBlank(ls[j]))) code.push(ls[j++].slice(4));
          while (code.length && isBlank(code[code.length - 1])) code.pop();
          out.push(`<pre class="md-code"><code>${esc(code.join('\n'))}</code></pre>`);
          continue;
        }
        // paragraph (setext headings: a line of === or --- after it)
        const para = [];
        while (j < ls.length && !isBlank(ls[j])) {
          const setext = para.length && /^ {0,3}(=+|-+)\s*$/.test(ls[j]);
          if (!setext && para.length && startsBlock(ls[j], ls[j + 1])) break;
          if (setext) {
            const level = ls[j].trim()[0] === '=' ? 1 : 2;
            const text = inline(para.join('\n'));
            const id = uniqueSlug(text);
            out.push(`<h${level} id="${esc(id)}"><a class="md-anchor" href="#${esc(id)}" aria-hidden="true">#</a>${text}</h${level}>`);
            para.length = 0;
            j++;
            break;
          }
          para.push(ls[j++]);
        }
        if (para.length) out.push(`<p>${inline(para.join('\n'))}</p>`);
      }
      return out.join('\n');
    }

    function list(ls, j, out) {
      const first = listRe.exec(ls[j]);
      const indent = first[1].length;
      const ordered = /\d/.test(first[2]);
      const start = ordered ? parseInt(first[2], 10) : 1;
      const items = [];
      let loose = false;
      while (j < ls.length) {
        const m = listRe.exec(ls[j]);
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
        const contentIndent = m[1].length + m[2].length + 1;
        const item = [m[3]];
        j++;
        let blankSeen = false;
        while (j < ls.length) {
          const l = ls[j];
          if (isBlank(l)) { blankSeen = true; item.push(''); j++; continue; }
          const lm = listRe.exec(l);
          if (lm && lm[1].length <= indent) break;
          if (!/^\s/.test(l) && blankSeen) break;
          if (blankSeen && !lm) loose = true;
          blankSeen = false;
          item.push(l.replace(new RegExp(`^ {0,${contentIndent}}`), ''));
          j++;
        }
        while (item.length && isBlank(item[item.length - 1])) item.pop();
        items.push(item);
      }
      const html = items.map((it) => {
        let task = '';
        const tm = /^\[([ xX])\]\s+/.exec(it[0]);
        if (tm) { task = `<input type="checkbox" disabled${tm[1] !== ' ' ? ' checked' : ''}> `; it[0] = it[0].slice(tm[0].length); }
        const inner = blocks(it);
        const tight = !loose && it.filter(isBlank).length === 0;
        return `<li${task ? ' class="md-task"' : ''}>${task}${tight ? inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1') : inner}</li>`;
      }).join('');
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${html}</ol>` : `<ul>${html}</ul>`);
      return j;
    }

    return blocks(body);
  }

  /** Table of contents [{ level, text, id }] of rendered HTML (h1-h3). */
  function toc(html) {
    const out = [];
    String(html).replace(/<h([1-3]) id="([^"]+)">(?:<a[^>]*>#<\/a>)?([\s\S]*?)<\/h\1>/g, (m, l, id, t) => { out.push({ level: Number(l), id, text: t.replace(/<[^>]+>/g, '') }); return m; });
    return out;
  }

  const api = { render, toc, slugify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RRMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);

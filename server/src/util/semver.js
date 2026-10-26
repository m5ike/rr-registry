'use strict';
// Tiny semver helpers (parse / compare / sort) - range resolution is done by npm clients.

const RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

function parse(v) {
  const m = RE.exec(String(v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function valid(v) {
  return parse(v) !== null;
}

function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  for (const k of ['major', 'minor', 'patch']) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (!pa.pre.length && pb.pre.length) return 1;
  if (pa.pre.length && !pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && +x !== +y) return +x - +y;
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function sort(list) {
  return [...list].sort(compare);
}

function maxStable(list) {
  const stable = list.filter((v) => parse(v) && !parse(v).pre.length);
  const s = sort(stable.length ? stable : list);
  return s[s.length - 1];
}

module.exports = { parse, valid, compare, sort, maxStable };

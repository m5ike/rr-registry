'use strict';
// Group (virtual) repository - one URL for several npm or generic repositories (like Nexus groups).
//   reads:  npm package metadata is merged from all members (first member wins for a version),
//           everything else is served by the first member that has it; search covers all members
//   writes: go to the `deployTo` member (publishing through the group URL)
const path = require('path');
const { HttpError, NotFoundLocal, sendJson } = require('../util/http');
const { mkdirp } = require('../util/store');
const semver = require('../util/semver');

class GroupRepo {
  constructor(app, conf) {
    this.app = app;
    this.conf = conf;
    this.dir = path.join(app.config.dataDir, 'repos', conf.name);
    mkdirp(this.dir);
  }

  members() {
    return (this.conf.members || [])
      .map((n) => this.app.repoConfig(n))
      .filter((c) => c && c.type !== 'group' && c.type !== 'docker' && c.type !== 'git')
      .map((c) => this.app.repoHandler(c.name));
  }

  memberType() {
    const m = this.members()[0];
    return m ? m.conf.type : null;
  }

  packagePath(decoded) {
    const m = this.members()[0];
    return m && m.packagePath ? m.packagePath(decoded) : null;
  }

  readable(identity) {
    return this.members().filter((h) => this.app.auth.can(identity, 'read', h.conf));
  }

  listPackages(q = '') {
    const seen = new Map();
    for (const h of this.members()) {
      for (const p of h.listPackages(q)) if (!seen.has(p.name)) seen.set(p.name, { ...p, member: h.conf.name });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  names() {
    return this.listPackages().map((p) => p.name);
  }

  search(text, size, from) {
    const objects = [];
    const seen = new Set();
    for (const h of this.members()) {
      if (!h.search) continue;
      for (const o of h.search(text, 250, 0).objects) {
        if (seen.has(o.package.name)) continue;
        seen.add(o.package.name);
        objects.push(o);
      }
    }
    objects.sort((a, b) => b.searchScore - a.searchScore);
    return { objects: objects.slice(Number(from) || 0, (Number(from) || 0) + (Number(size) || 20)), total: objects.length, time: new Date().toUTCString() };
  }

  /** Merged npm packument of a package from all readable npm members. */
  mergedPackument(name, identity) {
    let doc = null;
    for (const h of this.readable(identity)) {
      if (h.conf.type !== 'npm') continue;
      const d = h.read(name);
      if (!d) continue;
      if (!doc) { doc = JSON.parse(JSON.stringify(d)); continue; }
      for (const [v, m] of Object.entries(d.versions)) {
        if (!doc.versions[v]) { doc.versions[v] = m; doc.time[v] = d.time[v]; }
      }
      for (const [t, v] of Object.entries(d['dist-tags'])) if (!doc['dist-tags'][t]) doc['dist-tags'][t] = v;
    }
    if (doc) {
      const stable = Object.keys(doc.versions);
      if (!doc.versions[doc['dist-tags'].latest]) doc['dist-tags'].latest = semver.maxStable(stable);
    }
    return doc;
  }

  async handle(ctx) {
    const { req, res, method } = ctx;
    const members = this.members();
    if (!members.length) throw new HttpError(500, `group ${this.conf.name} has no members`);
    if (method !== 'GET' && method !== 'HEAD') {
      const special = ctx.path.startsWith('/-/user/') || ctx.path === '/-/whoami' || ctx.path.startsWith('/-/npm/');
      if (special) return members[0].handle(ctx);
      if (!this.conf.deployTo) throw new HttpError(405, `group ${this.conf.name} is read-only (set deployTo to publish through it)`);
      return this.app.repoHandler(this.conf.deployTo).handle(ctx);
    }
    const identity = this.app.auth.require(req, 'read', this.conf);
    const npm = this.memberType() === 'npm';
    if (npm && ctx.path === '/-/v1/search') {
      const q = new URLSearchParams(ctx.search);
      return sendJson(res, 200, this.search(q.get('text') || '', q.get('size') || 20, q.get('from') || 0));
    }
    if (npm && ctx.pkgPath && ctx.path.replace(/\/+$/, '') === ctx.pkgPath) {
      const name = ctx.pkgPath.slice(1);
      const doc = this.mergedPackument(name, identity);
      if (!doc) throw new NotFoundLocal(`package ${name} not found in group ${this.conf.name}`);
      return sendJson(res, 200, members[0].serialize(doc, ctx.base));
    }
    for (const h of this.readable(identity)) {
      try {
        return await h.handle(ctx);
      } catch (e) {
        if (e instanceof NotFoundLocal || e.status === 404) continue;
        throw e;
      }
    }
    throw new NotFoundLocal(`not found in group ${this.conf.name}`);
  }
}

module.exports = { GroupRepo };

'use strict';
// Download statistics per repository and item (package, file, image, git repository),
// persisted in <data>/stats.json (flushed periodically).
const path = require('path');
const { readJsonFile, writeAtomic } = require('./util/store');

const MAX_ITEMS = 5000;
const DAYS = 90;

class Stats {
  constructor(app) {
    this.app = app;
    this.file = path.join(app.config.dataDir, 'stats.json');
    this.data = readJsonFile(this.file, { repos: {} });
    this.dirty = false;
  }

  hit(repo, item, n = 1) {
    const r = (this.data.repos[repo] = this.data.repos[repo] || { total: 0, items: {}, days: {} });
    const day = new Date().toISOString().slice(0, 10);
    r.total += n;
    r.days[day] = (r.days[day] || 0) + n;
    if (item) {
      if (r.items[item] !== undefined || Object.keys(r.items).length < MAX_ITEMS) r.items[item] = (r.items[item] || 0) + n;
    }
    r.last = new Date().toISOString();
    this.dirty = true;
  }

  get(repo, { top = 20 } = {}) {
    const r = this.data.repos[repo] || { total: 0, items: {}, days: {} };
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      days.push({ day: d, downloads: r.days[d] || 0 });
    }
    return {
      repo,
      total: r.total,
      last: r.last || null,
      top: Object.entries(r.items).sort((a, b) => b[1] - a[1]).slice(0, Number(top) || 20).map(([item, downloads]) => ({ item, downloads })),
      days,
    };
  }

  remove(repo) {
    delete this.data.repos[repo];
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
    for (const r of Object.values(this.data.repos)) for (const d of Object.keys(r.days)) if (d < cutoff) delete r.days[d];
    writeAtomic(this.file, JSON.stringify(this.data));
    this.dirty = false;
  }
}

module.exports = { Stats };

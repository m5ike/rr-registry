'use strict';
// Background tasks: git pull mirrors, repository cleanup policies, expired cache purge, stats flush.
// Every task can also be run on demand through the API (runTask).

class Scheduler {
  constructor(app) {
    this.app = app;
    this.timer = null;
    this.tasks = [
      {
        id: 'git-mirrors', name: 'Synchronizace git zrcadel', intervalSec: 60,
        description: 'Stáhne změny pull zrcadel, jejichž interval uplynul.',
        fn: async () => {
          const out = [];
          for (const r of app.listRepos().filter((x) => x.type === 'git')) out.push(...(await app.repoHandler(r.name).syncDue()));
          return { synced: out.length, failed: out.filter((x) => !x.ok).length, repos: out };
        },
      },
      {
        id: 'cleanup', name: 'Čištění repozitářů', intervalSec: 3600,
        description: 'Spustí pravidla čištění (retence) repozitářů, kterým uplynul interval.',
        fn: async () => {
          const out = [];
          for (const r of app.listRepos()) {
            const c = r.cleanup;
            if (!c || !c.enabled || r.immutable) continue;
            const every = (Number(c.intervalHours) || 24) * 3600 * 1000;
            if (r.cleanupLastRun && Date.now() - Date.parse(r.cleanupLastRun) < every) continue;
            const res = await app.runCleanup(r.name, { dryRun: false }, null);
            out.push({ repo: r.name, actions: res.actions.length, freedBytes: res.freedBytes });
          }
          return { repos: out };
        },
      },
      {
        id: 'cache-expired', name: 'Čištění expirované cache', intervalSec: 6 * 3600,
        description: 'Smaže z cache položky s prošlou platností a dočasná data importů starší než 24 h.',
        fn: async () => ({ removed: app.cache.purge({ expired: true }), importsRemoved: app.transfer.sweep() }),
      },
      {
        id: 'stats-flush', name: 'Uložení statistik', intervalSec: 60,
        description: 'Zapíše statistiky stahování na disk.',
        fn: async () => { app.statsStore.flush(); return { ok: true }; },
      },
    ];
    for (const t of this.tasks) Object.assign(t, { lastRun: null, lastResult: null, lastError: null, running: false, runs: 0 });
  }

  start() {
    if (this.timer) return;
    const started = Date.now();
    for (const t of this.tasks) t.nextRun = new Date(started + Math.min(t.intervalSec, 60) * 1000).toISOString();
    this.timer = setInterval(() => this.tick(), 15000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    for (const t of this.tasks) {
      if (t.running || (t.nextRun && Date.parse(t.nextRun) > Date.now())) continue;
      this.run(t.id).catch(() => {});
    }
  }

  get(id) {
    return this.tasks.find((t) => t.id === id);
  }

  async run(id) {
    const t = this.get(id);
    if (!t) return null;
    if (t.running) return this.info(t);
    t.running = true;
    try {
      t.lastResult = await t.fn();
      t.lastError = null;
    } catch (e) {
      t.lastError = e.message;
      this.app.log.warn(`task ${id}: ${e.message}`);
    } finally {
      t.running = false;
      t.runs++;
      t.lastRun = new Date().toISOString();
      t.nextRun = new Date(Date.now() + t.intervalSec * 1000).toISOString();
    }
    return this.info(t);
  }

  info(t) {
    const { fn, ...rest } = t;
    return rest;
  }

  list() {
    return this.tasks.map((t) => this.info(t));
  }
}

module.exports = { Scheduler };

'use strict';
// Plugin manager. A plugin module exports { name, description, create(app) } where create()
// returns an object with optional hooks:
//   beforeLocal(ctx) -> true when the request was handled (called before the local repository)
//   onNotFound(ctx)  -> true when handled (called when the local repository has no such item)
//   onStart()/onStop()
// Built-in plugins live in this directory, custom ones may be dropped into <data>/plugins/*.js.
const fs = require('fs');
const path = require('path');

const BUILTIN = {
  router: require('./router'),
};

class PluginManager {
  constructor(app) {
    this.app = app;
    this.plugins = [];
    this.available = { ...BUILTIN };
    const extDir = path.join(app.config.dataDir, 'plugins');
    try {
      for (const f of fs.readdirSync(extDir)) {
        if (!f.endsWith('.js')) continue;
        try {
          const mod = require(path.join(extDir, f));
          if (mod && mod.name && typeof mod.create === 'function') this.available[mod.name] = mod;
        } catch (e) {
          app.log.warn(`plugin ${f} failed to load: ${e.message}`);
        }
      }
    } catch { /* no custom plugins */ }
  }

  load() {
    const enabled = this.app.stores.settings.get().plugins || ['router'];
    this.plugins = [];
    for (const name of enabled) {
      const mod = this.available[name];
      if (!mod) { this.app.log.warn(`plugin ${name} not found`); continue; }
      this.plugins.push({ name, mod, inst: mod.create(this.app) });
    }
  }

  get(name) {
    const p = this.plugins.find((x) => x.name === name);
    return p && p.inst;
  }

  info() {
    const enabled = new Set(this.plugins.map((p) => p.name));
    return Object.values(this.available).map((m) => ({ name: m.name, description: m.description || '', enabled: enabled.has(m.name) }));
  }

  async run(hook, ctx) {
    for (const p of this.plugins) {
      if (typeof p.inst[hook] === 'function' && (await p.inst[hook](ctx))) return true;
    }
    return false;
  }
}

module.exports = { PluginManager };

'use strict';
// Event bus: every change in the registry (publish, push, upload, delete, mirror sync, ...) is emitted
// as an event. Events are delivered to webhooks (HMAC signed, retried) and to plugins (onEvent) -
// the routing plugin uses them for "push" replication to remote servers.
const crypto = require('crypto');
const { HttpError } = require('./util/http');

const EVENT_TYPES = [
  'npm.publish', 'npm.unpublish', 'npm.tag', 'npm.deprecate',
  'file.upload', 'file.delete',
  'docker.push', 'docker.delete',
  'git.create', 'git.push', 'git.sync', 'git.delete',
  'repo.create', 'repo.update', 'repo.delete', 'repo.cleanup',
  'replication.failed',
];
const FORMATS = ['json', 'slack', 'discord'];

function summary(ev) {
  const d = ev.data || {};
  const what = d.name ? `${d.name}${d.versions ? `@${d.versions.join(',')}` : d.ref ? `:${d.ref}` : ''}` : d.path || '';
  return `[${ev.type}] ${d.repo || ''}${what ? ` ${what}` : ''} (${ev.user})`;
}

class Events {
  constructor(app) {
    this.app = app;
    this.recent = [];
    this.deliveries = [];
  }

  get store() { return this.app.stores.webhooks; }

  emit(type, data = {}, identity = null) {
    const ev = { id: crypto.randomUUID(), type, time: new Date().toISOString(), user: identity ? identity.name : 'system', repo: data.repo || null, data };
    this.recent.push(ev);
    if (this.recent.length > 200) this.recent.shift();
    setImmediate(() => {
      for (const hook of this.store.get()) if (this.matches(hook, ev)) this.deliver(hook, ev).catch(() => {});
      this.app.plugins.notify('onEvent', ev).catch((e) => this.app.log.warn(`event ${type}: ${e.message}`));
    });
    return ev;
  }

  matches(hook, ev) {
    if (!hook.enabled) return false;
    const evs = hook.events || ['*'];
    const okEvent = evs.some((e) => e === '*' || e === ev.type || (e.endsWith('.*') && ev.type.startsWith(e.slice(0, -1))));
    const repos = hook.repos || ['*'];
    const okRepo = repos.includes('*') || (ev.repo && repos.includes(ev.repo));
    return okEvent && okRepo;
  }

  payload(hook, ev) {
    const base = { event: ev.type, delivery: ev.id, time: ev.time, user: ev.user, repo: ev.repo, data: ev.data, server: { name: 'rr-registry', title: this.app.stores.settings.get().title, version: this.app.config.version } };
    if (hook.format === 'slack') return { text: `${this.app.stores.settings.get().title}: ${summary(ev)}` };
    if (hook.format === 'discord') return { content: `${this.app.stores.settings.get().title}: ${summary(ev)}` };
    return base;
  }

  async deliver(hook, ev, attempt = 1) {
    const body = JSON.stringify(this.payload(hook, ev));
    const headers = {
      'content-type': 'application/json',
      'user-agent': `rr-registry/${this.app.config.version}`,
      'x-rr-event': ev.type,
      'x-rr-delivery': ev.id,
      ...(hook.headers || {}),
    };
    if (hook.secret) headers['x-rr-signature-256'] = `sha256=${crypto.createHmac('sha256', hook.secret).update(body).digest('hex')}`;
    const t0 = Date.now();
    const rec = { id: crypto.randomBytes(5).toString('hex'), hookId: hook.id, hook: hook.name, event: ev.type, delivery: ev.id, url: hook.url, attempt, time: new Date().toISOString() };
    try {
      const r = await fetch(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
      const text = (await r.text()).slice(0, 500);
      Object.assign(rec, { status: r.status, ok: r.ok, response: text, ms: Date.now() - t0 });
    } catch (e) {
      Object.assign(rec, { status: 0, ok: false, error: e.message, ms: Date.now() - t0 });
    }
    this.deliveries.push(rec);
    if (this.deliveries.length > 500) this.deliveries.shift();
    const cur = this.store.get().find((h) => h.id === hook.id);
    if (cur) {
      cur.lastDelivery = { time: rec.time, status: rec.status, ok: rec.ok, event: ev.type };
      this.store.save();
    }
    const retries = Number(hook.retries ?? 3);
    if (!rec.ok && attempt < retries && ev.type !== 'ping') {
      setTimeout(() => this.deliver(hook, ev, attempt + 1).catch(() => {}), attempt * 5000 * (this.app.config.retryScale ?? 1)).unref();
    }
    return rec;
  }

  // ---------- webhook management ----------
  publicHook(h) {
    return { ...h, secret: h.secret ? '***' : '' };
  }

  list() {
    return this.store.get().map((h) => this.publicHook(h));
  }

  get(id) {
    const h = this.store.get().find((x) => x.id === id || x.name === id);
    if (!h) throw new HttpError(404, `webhook ${id} not found`);
    return h;
  }

  normalize(input, cur = {}) {
    const h = { ...cur, ...input };
    h.id = cur.id || crypto.randomBytes(4).toString('hex');
    h.name = String(h.name || '').trim();
    if (!h.name) throw new HttpError(400, 'webhook name is required');
    if (!/^https?:\/\/[^/]+/.test(String(h.url || ''))) throw new HttpError(400, 'webhook url must be http(s)');
    const list = (v) => (Array.isArray(v) ? v : String(v || '*').split(',')).map((x) => String(x).trim()).filter(Boolean);
    h.events = list(h.events);
    for (const e of h.events) if (e !== '*' && !e.endsWith('.*') && !EVENT_TYPES.includes(e)) throw new HttpError(400, `unknown event ${e} (${EVENT_TYPES.join(', ')})`);
    h.repos = list(h.repos);
    h.format = h.format || 'json';
    if (!FORMATS.includes(h.format)) throw new HttpError(400, `format must be one of ${FORMATS.join(', ')}`);
    if (input.secret === '***') h.secret = cur.secret;
    h.secret = h.secret || '';
    h.headers = h.headers && typeof h.headers === 'object' ? h.headers : {};
    h.enabled = h.enabled !== false && h.enabled !== 'false';
    h.retries = Number(h.retries ?? 3);
    h.created = cur.created || new Date().toISOString();
    return h;
  }

  create(body) {
    const h = this.normalize(body);
    if (this.store.get().some((x) => x.name === h.name)) throw new HttpError(409, `webhook ${h.name} already exists`);
    this.store.update((l) => { l.push(h); });
    return this.publicHook(h);
  }

  update(id, body) {
    const cur = this.get(id);
    const h = this.normalize({ ...body, id: cur.id }, cur);
    this.store.update((l) => l.map((x) => (x.id === cur.id ? h : x)));
    return this.publicHook(h);
  }

  remove(id) {
    const cur = this.get(id);
    this.store.update((l) => l.filter((x) => x.id !== cur.id));
  }

  async test(id) {
    const h = this.get(id);
    const ev = { id: crypto.randomUUID(), type: 'ping', time: new Date().toISOString(), user: 'system', repo: null, data: { message: 'RR Registry webhook test' } };
    return this.deliver(h, ev);
  }

  listDeliveries({ id, limit = 100 } = {}) {
    return this.deliveries.filter((d) => !id || d.hookId === id).slice(-limit).reverse();
  }
}

module.exports = { Events, EVENT_TYPES, FORMATS };

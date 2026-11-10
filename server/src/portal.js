'use strict';
// AI Tools Portal integration (app contract 1) — single sign-on.
//
// Active only when the portal starts the registry (PORTAL_IDENTITY_KEY in the environment);
// standalone operation is unchanged.
//   - Browser users logged in to the portal: the gateway sends X-Portal-Identity
//     "user|role|ts|hmac-sha256(PORTAL_IDENTITY_KEY)" with the role the portal granted
//     in this app (admin | publisher | reader).
//   - CLI clients (npm login, docker login, git): Basic auth with the portal user name and
//     password is checked against the portal (POST /_portal/api/auth/verify).
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const ROLES = ['admin', 'publisher', 'reader'];
const POSITIVE_TTL = 60000;
const NEGATIVE_TTL = 10000;

class Portal {
  constructor(env = process.env, log = null) {
    this.key = env.PORTAL_IDENTITY_KEY || '';
    this.appId = env.PORTAL_APP_ID || '';
    this.url = (env.PORTAL_INTERNAL_URL || '').replace(/\/+$/, '');
    this.log = log;
    this.cache = new Map(); // sha256(user:pass) -> { id, until }
  }

  get enabled() { return !!this.key; }

  /** Identity from the gateway's signed header, or null. */
  identityFromHeader(req, maxSkewSec = 300) {
    const raw = req.headers['x-portal-identity'];
    if (!this.enabled || !raw) return null;
    const parts = String(raw).split('|');
    if (parts.length !== 4) return null;
    const [user, role, ts, sig] = parts;
    const expect = crypto.createHmac('sha256', this.key).update(`${user}|${role}|${ts}`).digest('hex');
    if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
    if (Math.abs(Date.now() / 1000 - Number(ts)) > maxSkewSec) return null;
    if (!user || !ROLES.includes(role)) return null;
    return { name: user, role, via: 'portal' };
  }

  /** Check user/password against the portal; resolves an identity or null. Cached briefly. */
  async verifyPassword(user, password) {
    if (!this.enabled || !this.url || !this.appId || !user || !password) return null;
    const k = crypto.createHash('sha256').update(`${user}\0${password}`).digest('hex');
    const hit = this.cache.get(k);
    if (hit && hit.until > Date.now()) return hit.id;
    let id = null;
    try {
      const r = await post(`${this.url}/_portal/api/auth/verify`, { username: user, password }, { authorization: `PortalApp ${this.appId} ${this.key}` });
      if (r.status === 200 && ROLES.includes(r.body.role)) id = { name: r.body.user, role: r.body.role, via: 'portal-password' };
      else if (r.status >= 500 || r.status === 0) {
        if (this.log) this.log.warn(`portal credential check failed: HTTP ${r.status}`);
        return null; // do not cache outages
      }
    } catch (e) {
      if (this.log) this.log.warn(`portal unreachable: ${e.message}`);
      return null;
    }
    this.cache.set(k, { id, until: Date.now() + (id ? POSITIVE_TTL : NEGATIVE_TTL) });
    if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value);
    return id;
  }
}

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

module.exports = { Portal };

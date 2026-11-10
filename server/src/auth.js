'use strict';
// Users, tokens and permission checks.
const crypto = require('crypto');
const { HttpError } = require('./util/http');

const ROLES = ['admin', 'publisher', 'reader'];
const LEVELS = { read: 1, publish: 2, admin: 3 };
const ROLE_LEVEL = { reader: 1, publisher: 2, admin: 3 };
const ACL_LEVEL = { none: 0, read: 1, publish: 2 };

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class Auth {
  constructor(app) {
    this.app = app;
  }

  get users() { return this.app.stores.users; }
  get tokens() { return this.app.stores.tokens; }

  hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    return `scrypt$${salt}$${hash}`;
  }

  verifyPassword(pw, stored) {
    const [, salt, hash] = String(stored || '').split('$');
    if (!salt || !hash) return false;
    return safeEqual(crypto.scryptSync(String(pw), salt, 32).toString('hex'), hash);
  }

  publicUser(u) {
    return { name: u.name, email: u.email || '', role: u.role, created: u.created };
  }

  listUsers() {
    const list = Object.values(this.users.get()).map((u) => this.publicUser(u));
    list.unshift({ name: this.app.config.adminUser, email: '', role: 'admin', builtin: true });
    return list;
  }

  validateUserName(name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(String(name || ''))) throw new HttpError(400, 'invalid user name');
  }

  createUser({ name, password, email = '', role = 'publisher' }) {
    this.validateUserName(name);
    if (!password || String(password).length < 4) throw new HttpError(400, 'password must have at least 4 characters');
    if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
    if (name === this.app.config.adminUser || this.users.get()[name]) throw new HttpError(409, `user ${name} already exists`);
    const u = { name, email, role, hash: this.hashPassword(password), created: new Date().toISOString() };
    this.users.update((d) => { d[name] = u; });
    return this.publicUser(u);
  }

  updateUser(name, { password, email, role }) {
    const u = this.users.get()[name];
    if (!u) throw new HttpError(404, `user ${name} not found`);
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
      u.role = role;
    }
    if (email !== undefined) u.email = email;
    if (password !== undefined) {
      if (String(password).length < 4) throw new HttpError(400, 'password must have at least 4 characters');
      u.hash = this.hashPassword(password);
    }
    this.users.save();
    return this.publicUser(u);
  }

  deleteUser(name) {
    if (!this.users.get()[name]) throw new HttpError(404, `user ${name} not found`);
    this.users.update((d) => { delete d[name]; });
    this.tokens.update((list) => list.filter((t) => t.user !== name));
  }

  /** Check credentials of the built-in admin or a stored user. Returns identity or null. */
  /**
   * Local users first, then (when attached to the AI Tools Portal) the portal account
   * with the role the portal granted in this app.
   */
  async checkCredentialsAsync(name, password) {
    const local = this.checkCredentials(name, password);
    if (local) return local;
    const portal = this.app.portal;
    return portal && portal.enabled ? portal.verifyPassword(name, password) : null;
  }

  /** Basic auth with portal credentials (docker/git/npm CLI): resolved before the synchronous checks. */
  async portalPreauth(req) {
    const portal = this.app.portal;
    if (!portal || !portal.enabled || req._identity !== undefined) return;
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!basic) return;
    const raw = Buffer.from(basic[1], 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i < 0) return;
    const user = raw.slice(0, i);
    const pass = raw.slice(i + 1);
    if (this.checkCredentials(user, pass) || this.tokenIdentity(pass)) return; // local accounts and tokens win
    const id = await portal.verifyPassword(user, pass);
    if (id) req._identity = id;
  }

  checkCredentials(name, password) {
    const c = this.app.config;
    if (name === c.adminUser && safeEqual(password, c.adminPassword)) return { name, role: 'admin' };
    const u = this.users.get()[name];
    if (u && this.verifyPassword(password, u.hash)) return { name, role: u.role };
    return null;
  }

  issueToken({ user, role, name = '', readonly = false, ttlSeconds = 0, kind = 'token' }) {
    const token = `rr_${crypto.randomBytes(24).toString('base64url')}`;
    const rec = {
      id: crypto.randomBytes(6).toString('hex'),
      name: name || kind,
      kind,
      user,
      role,
      readonly: !!readonly,
      hash: sha256(token),
      preview: `${token.slice(0, 7)}…${token.slice(-4)}`,
      created: new Date().toISOString(),
      expires: ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
      lastUsed: null,
    };
    this.tokens.update((list) => {
      const now = Date.now();
      const alive = list.filter((t) => !t.expires || Date.parse(t.expires) > now);
      alive.push(rec);
      return alive;
    });
    return { token, ...this.publicToken(rec) };
  }

  publicToken(t) {
    const { hash, ...rest } = t;
    return rest;
  }

  listTokens(user) {
    return this.tokens.get().filter((t) => !user || t.user === user).map((t) => this.publicToken(t));
  }

  revokeToken(idOrToken) {
    const h = sha256(idOrToken);
    const before = this.tokens.get().length;
    this.tokens.update((list) => list.filter((t) => t.id !== idOrToken && t.hash !== h));
    return before !== this.tokens.get().length;
  }

  /** Identity of an access token (or the api_token); null when unknown / expired. */
  tokenIdentity(tok) {
    const c = this.app.config;
    if (!tok) return null;
    if (c.apiToken && safeEqual(tok, c.apiToken)) return { name: 'api-token', role: 'admin', via: 'api_token' };
    const rec = this.tokens.get().find((t) => t.hash === sha256(tok));
    if (!rec || (rec.expires && Date.parse(rec.expires) <= Date.now())) return null;
    const u = this.users.get()[rec.user];
    const role = rec.user === c.adminUser ? 'admin' : u ? u.role : rec.role;
    return role ? { name: rec.user, role, readonly: rec.readonly, tokenId: rec.id, via: 'token' } : null;
  }

  /** Identify the caller of a request (Bearer token, Basic auth) - null when anonymous. */
  authenticate(req) {
    if (req._identity !== undefined) return req._identity;
    let id = null;
    const h = req.headers.authorization || '';
    const c = this.app.config;
    const bearer = /^Bearer\s+(.+)$/i.exec(h);
    const basic = /^Basic\s+(.+)$/i.exec(h);
    if (bearer) {
      const tok = bearer[1].trim();
      if (c.apiToken && safeEqual(tok, c.apiToken)) {
        id = { name: 'api-token', role: 'admin', via: 'api_token' };
      } else {
        const hash = sha256(tok);
        const rec = this.tokens.get().find((t) => t.hash === hash);
        if (rec && (!rec.expires || Date.parse(rec.expires) > Date.now())) {
          const u = this.users.get()[rec.user];
          const role = rec.user === c.adminUser ? 'admin' : u ? u.role : rec.role;
          if (role) {
            id = { name: rec.user, role, readonly: rec.readonly, tokenId: rec.id, via: 'token' };
            // Avoid writing the token file on every request.
            if (!rec.lastUsed || Date.now() - Date.parse(rec.lastUsed) > 60000) {
              rec.lastUsed = new Date().toISOString();
              this.tokens.save();
            }
          }
        }
      }
      if (!id) throw new HttpError(401, 'invalid or expired token');
    } else if (basic) {
      const raw = Buffer.from(basic[1], 'base64').toString('utf8');
      const i = raw.indexOf(':');
      const user = raw.slice(0, i);
      const pass = raw.slice(i + 1);
      id = this.checkCredentials(user, pass);
      if (id) id.via = 'basic';
      // `docker login -u <user> -p <token>`: a token (or the api_token) as the password
      else id = this.tokenIdentity(pass);
      if (!id) throw new HttpError(401, 'invalid credentials');
    } else if (this.app.portal && this.app.portal.enabled) {
      // signed identity of a user logged in to the AI Tools Portal (single sign-on)
      id = this.app.portal.identityFromHeader(req);
    }
    req._identity = id;
    return id;
  }

  can(identity, level, repo) {
    const need = LEVELS[level] || 3;
    if (!identity) {
      const s = this.app.stores.settings.get();
      return need === 1 && s.anonymousRead !== false && (!repo || repo.public !== false);
    }
    let have = identity.readonly ? 1 : ROLE_LEVEL[identity.role] || 0;
    // per-repository access list overrides the global role (admins are never restricted)
    if (repo && repo.acl && identity.role !== 'admin' && Object.prototype.hasOwnProperty.call(repo.acl, identity.name)) {
      const lvl = ACL_LEVEL[repo.acl[identity.name]] ?? 0;
      have = identity.readonly ? Math.min(1, lvl) : lvl;
    } else if (repo && repo.public === false && repo.acl && Object.keys(repo.acl).length && identity.role !== 'admin') {
      // private repository with an access list: users not on the list get nothing
      have = 0;
    }
    return have >= need;
  }

  /** Throw 401/403 unless the request may perform `level` (none|user|read|publish|admin). */
  require(req, level, repo) {
    const id = this.authenticate(req);
    if (level === 'none') return id;
    if (level === 'user') {
      if (!id) throw new HttpError(401, 'authentication required', { hint: 'use Bearer token or Basic auth' });
      return id;
    }
    if (!this.can(id, level, repo)) {
      if (!id) throw new HttpError(401, 'authentication required');
      throw new HttpError(403, `forbidden: ${level} permission required`);
    }
    return id;
  }
}

module.exports = { Auth, ROLES, sha256 };

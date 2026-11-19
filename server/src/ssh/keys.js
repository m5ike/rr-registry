'use strict';
// SSH public keys of users (git over SSH). Stored in <data>/config/sshkeys.json:
//   [{ id, user, role, title, type, key, fingerprint, created, lastUsed }]
// `role` is a snapshot for accounts that do not live in the registry (AI Tools Portal users); local users
// always get their current role.
const crypto = require('crypto');
const path = require('path');
const { HttpError } = require('../util/http');
const { JsonStore } = require('../util/store');

const KEY_TYPES = ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'];

/** Read an SSH "string" (uint32 length + bytes) at offset; returns [Buffer, nextOffset]. */
function readString(buf, off) {
  if (off + 4 > buf.length) throw new Error('truncated key');
  const n = buf.readUInt32BE(off);
  if (off + 4 + n > buf.length) throw new Error('truncated key');
  return [buf.subarray(off + 4, off + 4 + n), off + 4 + n];
}

/** "ssh-ed25519 AAAA... comment" -> { type, blob, comment, fingerprint }. */
function parsePublicKey(line) {
  const parts = String(line || '').trim().split(/\s+/);
  // authorized_keys lines may start with options; find the type token
  const i = parts.findIndex((p) => KEY_TYPES.includes(p));
  if (i < 0 || !parts[i + 1]) throw new HttpError(422, `unsupported or invalid SSH key (supported: ${KEY_TYPES.slice(0, 5).join(', ')})`);
  const type = parts[i];
  let blob;
  try { blob = Buffer.from(parts[i + 1], 'base64'); } catch { throw new HttpError(422, 'invalid key data'); }
  let inner;
  try { [inner] = readString(blob, 0); } catch { throw new HttpError(422, 'invalid key data'); }
  if (inner.toString() !== type) throw new HttpError(422, 'key type does not match the key data');
  if (type === 'ssh-rsa') {
    const [, o1] = readString(blob, 0);
    const [, o2] = readString(blob, o1);
    const [n] = readString(blob, o2);
    if ((n.length - (n[0] === 0 ? 1 : 0)) * 8 < 2048) throw new HttpError(422, 'RSA keys must have at least 2048 bits');
  }
  return { type, blob, key: `${type} ${blob.toString('base64')}`, comment: parts.slice(i + 2).join(' '), fingerprint: fingerprint(blob) };
}

function fingerprint(blob) {
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

class SshKeys {
  constructor(app) {
    this.app = app;
    this.store = new JsonStore(path.join(app.config.dataDir, 'config', 'sshkeys.json'), []);
  }

  view(k) {
    return { id: k.id, user: k.user, title: k.title, type: k.type, fingerprint: k.fingerprint, key: k.key, created: k.created, lastUsed: k.lastUsed || null };
  }

  /** Own keys; admins may list another user's keys (?user=name) or all (?user=*). */
  list(identity, user) {
    const all = this.store.get();
    if (user && user !== identity.name) {
      if (identity.role !== 'admin') throw new HttpError(403, 'only admin can list keys of other users');
      return all.filter((k) => user === '*' || k.user === user).map((k) => this.view(k));
    }
    return all.filter((k) => k.user === identity.name).map((k) => this.view(k));
  }

  add(identity, body = {}) {
    if (identity.readonly) throw new HttpError(403, 'read-only tokens cannot add keys');
    const owner = body.user && body.user !== identity.name ? body.user : identity.name;
    if (owner !== identity.name && identity.role !== 'admin') throw new HttpError(403, 'only admin can add keys for other users');
    const k = parsePublicKey(body.key);
    if (this.store.get().some((x) => x.fingerprint === k.fingerprint)) throw new HttpError(422, 'key is already in use');
    const rec = {
      id: crypto.randomBytes(6).toString('hex'),
      user: owner,
      role: owner === identity.name ? identity.role : undefined,
      title: String(body.title || k.comment || k.type).slice(0, 100),
      type: k.type,
      key: k.key,
      fingerprint: k.fingerprint,
      created: new Date().toISOString(),
    };
    this.store.update((l) => { l.push(rec); });
    this.app.audit(identity, 'ssh-key-add', `${owner} ${rec.fingerprint}`);
    return this.view(rec);
  }

  remove(identity, id) {
    const rec = this.store.get().find((k) => k.id === id);
    if (!rec || (rec.user !== identity.name && identity.role !== 'admin')) throw new HttpError(404, `key ${id} not found`);
    this.store.update((l) => l.filter((k) => k.id !== id));
    this.app.audit(identity, 'ssh-key-delete', `${rec.user} ${rec.fingerprint}`);
    return { ok: true };
  }

  /** The record of a public key blob, or null. */
  find(blob) {
    const fp = fingerprint(blob);
    return this.store.get().find((k) => k.fingerprint === fp) || null;
  }

  /** Identity of the key owner (current role of local users, the stored role of portal users). */
  identity(rec) {
    const c = this.app.config;
    const u = this.app.stores.users.get()[rec.user];
    const role = rec.user === c.adminUser ? 'admin' : u ? u.role : rec.role;
    if (!role) return null;
    return { name: rec.user, role, via: 'ssh-key', keyId: rec.id };
  }

  touch(rec) {
    if (rec.lastUsed && Date.now() - Date.parse(rec.lastUsed) < 60000) return;
    this.store.update((l) => { const k = l.find((x) => x.id === rec.id); if (k) k.lastUsed = new Date().toISOString(); });
  }
}

module.exports = { SshKeys, parsePublicKey, fingerprint, readString };

'use strict';
// Minimal SSH-2 server for git (no dependencies, node:crypto only):
//   key exchange  curve25519-sha256 (+ @libssh.org), strict KEX (Terrapin countermeasure), re-keying
//   host key      ssh-ed25519 (generated once: <data>/config/ssh_host_ed25519_key)
//   ciphers       aes128-ctr, aes192-ctr, aes256-ctr     MACs  hmac-sha2-256, hmac-sha2-512
//   user auth     publickey (ssh-ed25519, ecdsa-sha2-nistp256/384/521, rsa-sha2-256/512, ssh-rsa), password
//                 (registry password, access token or the portal password)
//   channels      session + exec of git-upload-pack / git-receive-pack / git-upload-archive, env GIT_PROTOCOL
//
//   git clone ssh://git@host:2222/owner/name.git        (repository from settings.gitRepo)
//   git clone ssh://git@host:2222/r/<repo>/owner/name.git
// Permissions are those of HTTP: repository ACL, private repositories, owners and collaborators.
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { readString } = require('./keys');

const MSG = {
  DISCONNECT: 1, IGNORE: 2, UNIMPLEMENTED: 3, DEBUG: 4, SERVICE_REQUEST: 5, SERVICE_ACCEPT: 6, EXT_INFO: 7,
  KEXINIT: 20, NEWKEYS: 21, KEX_ECDH_INIT: 30, KEX_ECDH_REPLY: 31,
  USERAUTH_REQUEST: 50, USERAUTH_FAILURE: 51, USERAUTH_SUCCESS: 52, USERAUTH_BANNER: 53, USERAUTH_PK_OK: 60,
  GLOBAL_REQUEST: 80, REQUEST_SUCCESS: 81, REQUEST_FAILURE: 82,
  CHANNEL_OPEN: 90, CHANNEL_OPEN_CONFIRMATION: 91, CHANNEL_OPEN_FAILURE: 92, CHANNEL_WINDOW_ADJUST: 93,
  CHANNEL_DATA: 94, CHANNEL_EXTENDED_DATA: 95, CHANNEL_EOF: 96, CHANNEL_CLOSE: 97, CHANNEL_REQUEST: 98,
  CHANNEL_SUCCESS: 99, CHANNEL_FAILURE: 100,
};
const KEX = ['curve25519-sha256', 'curve25519-sha256@libssh.org'];
const HOSTKEY = ['ssh-ed25519'];
const CIPHERS = { 'aes128-ctr': 16, 'aes192-ctr': 24, 'aes256-ctr': 32 };
const MACS = { 'hmac-sha2-256': ['sha256', 32], 'hmac-sha2-512': ['sha512', 64] };
const SIG_ALGS = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'];
const WINDOW = 2 * 1024 * 1024;
const MAX_PACKET = 32768;
const MAX_IN_PACKET = 512 * 1024;
const AUTH_TIMEOUT = 60 * 1000;
const IDLE_TIMEOUT = 30 * 60 * 1000;

// ------------------------------------------------------------------ encoding
const u8 = (n) => Buffer.from([n]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const bool = (v) => u8(v ? 1 : 0);
const str = (v) => { const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v)); return Buffer.concat([u32(b.length), b]); };
const nameList = (a) => str(a.join(','));
function mpint(buf) {
  let i = 0;
  while (i < buf.length && buf[i] === 0) i++;
  let b = buf.subarray(i);
  if (b.length && b[0] & 0x80) b = Buffer.concat([u8(0), b]);
  return str(b);
}
const b64u = (b) => Buffer.from(b).toString('base64url');
const unsigned = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };

class Reader {
  constructor(buf) { this.buf = buf; this.off = 0; }
  u8() { if (this.off + 1 > this.buf.length) throw new Error('truncated packet'); return this.buf[this.off++]; }
  u32() { if (this.off + 4 > this.buf.length) throw new Error('truncated packet'); const n = this.buf.readUInt32BE(this.off); this.off += 4; return n; }
  bool() { return this.u8() !== 0; }
  str() { const [b, o] = readString(this.buf, this.off); this.off = o; return b; }
  text() { return this.str().toString('utf8'); }
  list() { const s = this.text(); return s ? s.split(',') : []; }
}

// ------------------------------------------------------------------ public keys
/** KeyObject + verify parameters for an SSH public key blob. */
function publicKeyFromBlob(blob) {
  const r = new Reader(blob);
  const type = r.text();
  if (type === 'ssh-ed25519') {
    return { type, key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64u(r.str()) }, format: 'jwk' }) };
  }
  if (type === 'ssh-rsa') {
    const e = r.str();
    const n = r.str();
    return { type, key: crypto.createPublicKey({ key: { kty: 'RSA', n: b64u(unsigned(n)), e: b64u(unsigned(e)) }, format: 'jwk' }) };
  }
  const m = /^ecdsa-sha2-nistp(256|384|521)$/.exec(type);
  if (m) {
    r.str(); // curve identifier
    const q = r.str();
    const size = { 256: 32, 384: 48, 521: 66 }[m[1]];
    if (q[0] !== 4 || q.length !== 1 + 2 * size) throw new Error('unsupported EC point');
    return { type, size, hash: { 256: 'sha256', 384: 'sha384', 521: 'sha512' }[m[1]], key: crypto.createPublicKey({ key: { kty: 'EC', crv: `P-${m[1]}`, x: b64u(q.subarray(1, 1 + size)), y: b64u(q.subarray(1 + size)) }, format: 'jwk' }) };
  }
  throw new Error(`unsupported key type ${type}`);
}

/** Verify an SSH signature blob (string alg, string sig) over data with a public key blob. */
function verifySignature(keyBlob, sigBlob, data) {
  const pk = publicKeyFromBlob(keyBlob);
  const r = new Reader(sigBlob);
  const alg = r.text();
  const sig = r.str();
  if (pk.type === 'ssh-ed25519') return alg === 'ssh-ed25519' && crypto.verify(null, data, pk.key, sig);
  if (pk.type === 'ssh-rsa') {
    const hash = { 'rsa-sha2-256': 'sha256', 'rsa-sha2-512': 'sha512', 'ssh-rsa': 'sha1' }[alg];
    return !!hash && crypto.verify(hash, data, pk.key, sig);
  }
  if (alg !== pk.type) return false;
  const sr = new Reader(sig);
  const pad = (x) => { const u = unsigned(x); if (u.length > pk.size) return null; return Buffer.concat([Buffer.alloc(pk.size - u.length), u]); };
  const rr = pad(sr.str());
  const ss = pad(sr.str());
  if (!rr || !ss) return false;
  return crypto.verify(pk.hash, data, { key: pk.key, dsaEncoding: 'ieee-p1363' }, Buffer.concat([rr, ss]));
}

// ------------------------------------------------------------------ host key
function loadHostKey(file) {
  let pem;
  try { pem = fs.readFileSync(file, 'utf8'); } catch {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, pem, { mode: 0o600 });
  }
  const priv = crypto.createPrivateKey(pem);
  const pub = Buffer.from(crypto.createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url');
  const blob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  return { priv, blob, fingerprint: `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`, line: `ssh-ed25519 ${blob.toString('base64')}` };
}

// ------------------------------------------------------------------ connection
class Connection {
  constructor(server, socket) {
    this.server = server;
    this.app = server.app;
    this.socket = socket;
    this.inbuf = Buffer.alloc(0);
    this.version = null;
    this.serverVersion = `SSH-2.0-RRRegistry_${this.app.config.version || '1'}`;
    this.seqIn = 0;
    this.seqOut = 0;
    this.cin = null; // { decipher, mac, macLen, block }
    this.cout = null;
    this.firstKex = true;
    this.strict = false;
    this.kex = null; // in-progress key exchange
    this.outQueue = []; // payloads waiting for the end of a key exchange
    this.sessionId = null;
    this.identity = null;
    this.authFailures = 0;
    this.channels = new Map();
    this.nextChannel = 0;
    this.pendingFirst = null; // decrypted first block of a packet being received
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
    socket.setTimeout(IDLE_TIMEOUT, () => this.disconnect(11, 'idle timeout'));
    this.authTimer = setTimeout(() => { if (!this.identity) this.disconnect(2, 'authentication timeout'); }, AUTH_TIMEOUT);
    this.authTimer.unref();
    socket.write(`${this.serverVersion}\r\n`);
    this.sendKexInit();
  }

  log(msg) { if (this.app.config.sshDebug) this.app.log.info(`ssh ${this.socket.remoteAddress}: ${msg}`); }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authTimer);
    for (const ch of this.channels.values()) if (ch.child) ch.child.kill('SIGTERM');
    this.channels.clear();
    this.socket.destroy();
    this.server.connections.delete(this);
  }

  disconnect(code, reason) {
    if (this.closed) return;
    try { this.sendPacket(Buffer.concat([u8(MSG.DISCONNECT), u32(code), str(reason), str('')]), true); } catch { /* ignore */ }
    this.socket.end();
    setTimeout(() => this.destroy(), 200).unref();
  }

  // ---------- input ----------
  onData(d) {
    if (this.closed) return;
    this.inbuf = this.inbuf.length ? Buffer.concat([this.inbuf, d]) : d;
    try {
      if (!this.version) {
        for (;;) {
          const i = this.inbuf.indexOf('\n');
          if (i < 0) { if (this.inbuf.length > 8192) throw new Error('no version line'); return; }
          const line = this.inbuf.subarray(0, i).toString('utf8').replace(/\r$/, '');
          this.inbuf = this.inbuf.subarray(i + 1);
          if (line.startsWith('SSH-')) {
            if (!/^SSH-(2\.0|1\.99)-/.test(line)) throw new Error('unsupported protocol version');
            this.version = line;
            break;
          }
        }
      }
      let p;
      while (!this.closed && (p = this.readPacket())) this.dispatch(p);
    } catch (e) {
      this.log(`protocol error: ${e.message}`);
      this.disconnect(2, e.message);
    }
  }

  readPacket() {
    const c = this.cin;
    const block = c ? 16 : 8;
    if (!this.pendingFirst) {
      if (this.inbuf.length < block) return null;
      const first = this.inbuf.subarray(0, block);
      this.pendingFirst = c ? c.decipher.update(first) : Buffer.from(first);
    }
    const len = this.pendingFirst.readUInt32BE(0);
    if (len < 5 || len > MAX_IN_PACKET || (len + 4) % block !== 0) throw new Error('bad packet length');
    const total = 4 + len;
    const macLen = c ? c.macLen : 0;
    if (this.inbuf.length < total + macLen) return null;
    const rest = this.inbuf.subarray(block, total);
    const plain = Buffer.concat([this.pendingFirst, c ? c.decipher.update(rest) : rest]);
    if (c) {
      const mac = crypto.createHmac(c.hash, c.macKey).update(u32(this.seqIn)).update(plain).digest();
      if (!crypto.timingSafeEqual(mac, this.inbuf.subarray(total, total + macLen))) throw new Error('MAC error');
    }
    this.inbuf = this.inbuf.subarray(total + macLen);
    this.pendingFirst = null;
    this.seqIn = (this.seqIn + 1) >>> 0;
    const pad = plain[4];
    if (pad < 4 || pad > len - 1) throw new Error('bad padding');
    return plain.subarray(5, 4 + len - pad);
  }

  // ---------- output ----------
  /** Send a payload; non-KEX messages wait while a key exchange runs. */
  send(payload) {
    if ((this.kex && !this.kex.newKeysSent && !isKexMsg(payload[0])) || (this.outQueue.length && !isKexMsg(payload[0]))) { this.outQueue.push(payload); return; }
    this.sendPacket(payload);
  }

  sendPacket(payload, force) {
    if (this.closed && !force) return;
    const c = this.cout;
    const block = c ? 16 : 8;
    let pad = block - ((5 + payload.length) % block);
    if (pad < 4) pad += block;
    const packet = Buffer.concat([u32(1 + payload.length + pad), u8(pad), payload, crypto.randomBytes(pad)]);
    let out = packet;
    if (c) {
      const mac = crypto.createHmac(c.hash, c.macKey).update(u32(this.seqOut)).update(packet).digest();
      out = Buffer.concat([c.cipher.update(packet), mac]);
    }
    this.seqOut = (this.seqOut + 1) >>> 0;
    this.socket.write(out);
  }

  // ---------- key exchange ----------
  sendKexInit() {
    const kexAlgs = this.firstKex ? [...KEX, 'kex-strict-s-v00@openssh.com'] : KEX;
    const payload = Buffer.concat([
      u8(MSG.KEXINIT), crypto.randomBytes(16),
      nameList(kexAlgs), nameList(HOSTKEY),
      nameList(Object.keys(CIPHERS)), nameList(Object.keys(CIPHERS)),
      nameList(Object.keys(MACS)), nameList(Object.keys(MACS)),
      nameList(['none']), nameList(['none']), nameList([]), nameList([]),
      bool(false), u32(0),
    ]);
    this.kex = { serverInit: payload, newKeysSent: false };
    this.sendPacket(payload);
  }

  onKexInit(payload) {
    if (!this.kex) this.sendKexInit();
    const r = new Reader(payload);
    r.u8();
    r.off += 16;
    const lists = [];
    for (let i = 0; i < 10; i++) lists.push(r.list());
    const follows = r.bool();
    const pick = (client, server, what) => {
      const a = client.find((x) => server.includes(x));
      if (!a) throw new Error(`no matching ${what}`);
      return a;
    };
    const kexAlg = pick(lists[0], KEX, 'key exchange algorithm');
    pick(lists[1], HOSTKEY, 'host key algorithm');
    const encIn = pick(lists[2], Object.keys(CIPHERS), 'cipher');
    const encOut = pick(lists[3], Object.keys(CIPHERS), 'cipher');
    const macIn = pick(lists[4], Object.keys(MACS), 'MAC');
    const macOut = pick(lists[5], Object.keys(MACS), 'MAC');
    pick(lists[6], ['none'], 'compression');
    pick(lists[7], ['none'], 'compression');
    if (this.firstKex) {
      this.strict = lists[0].includes('kex-strict-c-v00@openssh.com');
      this.extInfo = lists[0].includes('ext-info-c');
      if (this.strict && this.seqIn !== 1) throw new Error('strict KEX: KEXINIT must be the first packet');
    }
    Object.assign(this.kex, { clientInit: payload, kexAlg, encIn, encOut, macIn, macOut, ignoreNext: follows && lists[0][0] !== kexAlg });
  }

  onEcdhInit(payload) {
    if (!this.kex || !this.kex.clientInit) throw new Error('unexpected KEX_ECDH_INIT');
    const r = new Reader(payload);
    r.u8();
    const qc = r.str();
    if (qc.length !== 32) throw new Error('bad curve25519 public key');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const qs = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
    const peer = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(qc) }, format: 'jwk' });
    const secret = crypto.diffieHellman({ privateKey, publicKey: peer });
    if (secret.every((b) => b === 0)) throw new Error('bad shared secret');
    const K = mpint(secret);
    const host = this.server.hostKey;
    const H = crypto.createHash('sha256').update(Buffer.concat([
      str(this.version), str(this.serverVersion), str(this.kex.clientInit), str(this.kex.serverInit),
      str(host.blob), str(qc), str(qs), K,
    ])).digest();
    if (!this.sessionId) this.sessionId = H;
    const sig = Buffer.concat([str('ssh-ed25519'), str(crypto.sign(null, H, host.priv))]);
    this.sendPacket(Buffer.concat([u8(MSG.KEX_ECDH_REPLY), str(host.blob), str(qs), str(sig)]));
    // keys: HASH(K || H || X || session_id), extended with HASH(K || H || K1 || ...)
    const derive = (letter, size) => {
      let out = crypto.createHash('sha256').update(K).update(H).update(letter).update(this.sessionId).digest();
      while (out.length < size) out = Buffer.concat([out, crypto.createHash('sha256').update(K).update(H).update(out).digest()]);
      return out.subarray(0, size);
    };
    const k = this.kex;
    const [hIn, mlIn] = MACS[k.macIn];
    const [hOut, mlOut] = MACS[k.macOut];
    k.next = {
      in: { decipher: crypto.createDecipheriv(nodeCipher(k.encIn), derive('C', CIPHERS[k.encIn]), derive('A', 16)), hash: hIn, macKey: derive('E', mlIn), macLen: mlIn },
      out: { cipher: crypto.createCipheriv(nodeCipher(k.encOut), derive('D', CIPHERS[k.encOut]), derive('B', 16)), hash: hOut, macKey: derive('F', mlOut), macLen: mlOut },
    };
    this.sendPacket(u8(MSG.NEWKEYS));
    this.cout = k.next.out;
    if (this.strict) this.seqOut = 0;
    k.newKeysSent = true;
    if (this.firstKex && this.extInfo) {
      this.sendPacket(Buffer.concat([u8(MSG.EXT_INFO), u32(1), str('server-sig-algs'), str(SIG_ALGS.join(','))]));
    }
    // messages held back during the exchange go out now, in order, with the new keys
    this.flushOutQueue();
  }

  flushOutQueue() {
    const q = this.outQueue;
    this.outQueue = [];
    for (const p of q) this.sendPacket(p);
  }

  onNewKeys() {
    if (!this.kex || !this.kex.next) throw new Error('unexpected NEWKEYS');
    this.cin = this.kex.next.in;
    if (this.strict) this.seqIn = 0;
    this.kex = null;
    this.firstKex = false;
    this.flushOutQueue();
  }

  // ---------- dispatch ----------
  dispatch(payload) {
    const type = payload[0];
    if (this.kex && this.kex.ignoreNext && (type === MSG.KEX_ECDH_INIT)) { this.kex.ignoreNext = false; return; }
    // strict KEX: during the first key exchange only KEX messages are allowed
    if (this.firstKex && this.strict && !isKexMsg(type)) throw new Error(`unexpected message ${type} during key exchange`);
    switch (type) {
      case MSG.KEXINIT: return this.onKexInit(payload);
      case MSG.KEX_ECDH_INIT: return this.onEcdhInit(payload);
      case MSG.NEWKEYS: return this.onNewKeys();
      case MSG.DISCONNECT: return this.destroy();
      case MSG.IGNORE: case MSG.DEBUG: case MSG.UNIMPLEMENTED: case MSG.EXT_INFO: return undefined;
      default:
    }
    if (!this.sessionId || (this.firstKex)) throw new Error(`message ${type} before key exchange`);
    switch (type) {
      case MSG.SERVICE_REQUEST: return this.onService(payload);
      case MSG.USERAUTH_REQUEST: return this.onAuth(payload).catch((e) => this.disconnect(2, e.message));
      default:
    }
    if (!this.identity) throw new Error(`message ${type} before authentication`);
    switch (type) {
      case MSG.GLOBAL_REQUEST: {
        const r = new Reader(payload); r.u8(); r.text();
        if (r.bool()) this.send(u8(MSG.REQUEST_FAILURE));
        return undefined;
      }
      case MSG.CHANNEL_OPEN: return this.onChannelOpen(payload);
      case MSG.CHANNEL_REQUEST: return this.onChannelRequest(payload);
      case MSG.CHANNEL_DATA: return this.onChannelData(payload);
      case MSG.CHANNEL_EXTENDED_DATA: return undefined;
      case MSG.CHANNEL_WINDOW_ADJUST: return this.onWindowAdjust(payload);
      case MSG.CHANNEL_EOF: return this.onChannelEof(payload);
      case MSG.CHANNEL_CLOSE: return this.onChannelClose(payload);
      case MSG.CHANNEL_SUCCESS: case MSG.CHANNEL_FAILURE: case MSG.REQUEST_SUCCESS: case MSG.REQUEST_FAILURE: return undefined;
      default:
        return this.send(Buffer.concat([u8(MSG.UNIMPLEMENTED), u32((this.seqIn - 1) >>> 0)]));
    }
  }

  onService(payload) {
    const r = new Reader(payload); r.u8();
    const name = r.text();
    if (name !== 'ssh-userauth') throw new Error(`service ${name} not available`);
    this.send(Buffer.concat([u8(MSG.SERVICE_ACCEPT), str(name)]));
  }

  // ---------- authentication ----------
  authFail() {
    this.authFailures++;
    if (this.authFailures > 10) return this.disconnect(14, 'too many authentication failures');
    return this.send(Buffer.concat([u8(MSG.USERAUTH_FAILURE), nameList(['publickey', 'password']), bool(false)]));
  }

  async onAuth(payload) {
    if (this.identity) return undefined;
    const r = new Reader(payload); r.u8();
    const user = r.text();
    const service = r.text();
    const method = r.text();
    if (service !== 'ssh-connection') return this.authFail();
    if (method === 'publickey') {
      const hasSig = r.bool();
      const alg = r.text();
      const blob = r.str();
      const rec = this.app.sshKeys.find(blob);
      let ok = false;
      try { ok = !!rec && SIG_ALGS.includes(alg) && !!publicKeyFromBlob(blob); } catch { ok = false; }
      if (!ok) return this.authFail();
      if (!hasSig) return this.send(Buffer.concat([u8(MSG.USERAUTH_PK_OK), str(alg), str(blob)]));
      const sig = r.str();
      const data = Buffer.concat([str(this.sessionId), u8(MSG.USERAUTH_REQUEST), str(user), str(service), str('publickey'), bool(true), str(alg), str(blob)]);
      let valid = false;
      try { valid = verifySignature(blob, sig, data); } catch { valid = false; }
      const id = valid ? this.app.sshKeys.identity(rec) : null;
      if (!id) return this.authFail();
      this.app.sshKeys.touch(rec);
      return this.authOk(id);
    }
    if (method === 'password') {
      r.bool();
      const pw = r.text();
      const auth = this.app.auth;
      let id = null;
      try { id = auth.checkCredentials(user, pw) || auth.tokenIdentity(pw); } catch { id = null; }
      if (!id && this.app.portal && this.app.portal.enabled) id = await this.app.portal.verifyPassword(user, pw).catch(() => null);
      if (!id) return this.authFail();
      return this.authOk({ ...id, via: 'ssh-password' });
    }
    return this.authFail();
  }

  authOk(id) {
    this.identity = id;
    clearTimeout(this.authTimer);
    this.log(`authenticated as ${id.name}`);
    this.send(u8(MSG.USERAUTH_SUCCESS));
  }

  // ---------- channels ----------
  channel(payload) {
    const r = new Reader(payload); r.u8();
    const id = r.u32();
    const ch = this.channels.get(id);
    return [ch, r];
  }

  onChannelOpen(payload) {
    const r = new Reader(payload); r.u8();
    const type = r.text();
    const remote = r.u32();
    const window = r.u32();
    const maxPacket = r.u32();
    if (type !== 'session' || this.channels.size >= 10) {
      return this.send(Buffer.concat([u8(MSG.CHANNEL_OPEN_FAILURE), u32(remote), u32(type !== 'session' ? 3 : 4), str(type !== 'session' ? 'only session channels are supported' : 'too many channels'), str('')]));
    }
    const id = this.nextChannel++;
    this.channels.set(id, { id, remote, remoteWindow: window, remoteMax: Math.min(maxPacket, MAX_PACKET), localWindow: WINDOW, env: {}, queue: [], queued: 0, child: null, exit: null, closed: false, eofSent: false });
    return this.send(Buffer.concat([u8(MSG.CHANNEL_OPEN_CONFIRMATION), u32(remote), u32(id), u32(WINDOW), u32(MAX_PACKET)]));
  }

  reply(ch, wantReply, ok) {
    if (wantReply) this.send(Buffer.concat([u8(ok ? MSG.CHANNEL_SUCCESS : MSG.CHANNEL_FAILURE), u32(ch.remote)]));
  }

  onChannelRequest(payload) {
    const [ch, r] = this.channel(payload);
    if (!ch) return undefined;
    const type = r.text();
    const want = r.bool();
    if (type === 'env') {
      const k = r.text();
      const v = r.text();
      if (k === 'GIT_PROTOCOL' && /^[A-Za-z0-9=:._-]{0,100}$/.test(v)) ch.env.GIT_PROTOCOL = v;
      return this.reply(ch, want, true);
    }
    if (type === 'pty-req' || type === 'window-change' || type === 'signal') return this.reply(ch, want, type !== 'signal');
    if (type === 'shell') {
      this.reply(ch, want, true);
      this.output(ch, 'ext', Buffer.from(`Hi ${this.identity.name}! You've successfully authenticated, but RR Registry does not provide shell access.\r\n`));
      ch.exit = 1;
      return this.finish(ch);
    }
    if (type === 'exec') {
      if (ch.child || ch.exit !== null) return this.reply(ch, want, false);
      const cmd = r.text();
      this.reply(ch, want, true);
      this.exec(ch, cmd).catch((e) => {
        this.output(ch, 'ext', Buffer.from(`ERROR: ${e.message}\n`));
        ch.exit = 1;
        this.finish(ch);
      });
      return undefined;
    }
    return this.reply(ch, want, false);
  }

  onChannelData(payload) {
    const [ch, r] = this.channel(payload);
    if (!ch) return;
    const data = r.str();
    ch.localWindow -= data.length;
    if (ch.child && ch.child.stdin.writable) ch.child.stdin.write(data);
    if (ch.localWindow < WINDOW / 2) {
      this.send(Buffer.concat([u8(MSG.CHANNEL_WINDOW_ADJUST), u32(ch.remote), u32(WINDOW - ch.localWindow)]));
      ch.localWindow = WINDOW;
    }
  }

  onWindowAdjust(payload) {
    const [ch, r] = this.channel(payload);
    if (!ch) return;
    ch.remoteWindow = Math.min(ch.remoteWindow + r.u32(), 0xffffffff);
    this.flush(ch);
  }

  onChannelEof(payload) {
    const [ch] = this.channel(payload);
    if (ch && ch.child) ch.child.stdin.end();
    else if (ch) ch.inputEnded = true;
  }

  onChannelClose(payload) {
    const [ch] = this.channel(payload);
    if (!ch) return;
    if (ch.child && ch.exit === null) ch.child.kill('SIGTERM');
    if (!ch.closed) this.send(Buffer.concat([u8(MSG.CHANNEL_CLOSE), u32(ch.remote)]));
    ch.closed = true;
    this.channels.delete(ch.id);
  }

  output(ch, kind, buf) {
    if (ch.closed || !buf.length) return;
    ch.queue.push({ kind, buf });
    ch.queued += buf.length;
    this.flush(ch);
  }

  flush(ch) {
    while (ch.queue.length && ch.remoteWindow > 0 && !ch.closed) {
      const item = ch.queue[0];
      const n = Math.min(item.buf.length, ch.remoteWindow, ch.remoteMax - 64);
      const chunk = item.buf.subarray(0, n);
      item.buf = item.buf.subarray(n);
      if (!item.buf.length) ch.queue.shift();
      ch.remoteWindow -= n;
      ch.queued -= n;
      this.send(item.kind === 'ext'
        ? Buffer.concat([u8(MSG.CHANNEL_EXTENDED_DATA), u32(ch.remote), u32(1), str(chunk)])
        : Buffer.concat([u8(MSG.CHANNEL_DATA), u32(ch.remote), str(chunk)]));
    }
    // back-pressure on the git process
    if (ch.child) {
      if (ch.queued > 4 * 1024 * 1024) { ch.child.stdout.pause(); ch.child.stderr.pause(); } else { ch.child.stdout.resume(); ch.child.stderr.resume(); }
    }
    if (ch.exit !== null && !ch.queue.length) this.finish(ch);
  }

  finish(ch) {
    if (ch.closed || ch.eofSent || ch.queue.length) return;
    ch.eofSent = true;
    this.send(Buffer.concat([u8(MSG.CHANNEL_REQUEST), u32(ch.remote), str('exit-status'), bool(false), u32(ch.exit || 0)]));
    this.send(Buffer.concat([u8(MSG.CHANNEL_EOF), u32(ch.remote)]));
    this.send(Buffer.concat([u8(MSG.CHANNEL_CLOSE), u32(ch.remote)]));
    ch.closed = true;
  }

  // ---------- git ----------
  async exec(ch, cmd) {
    const m = /^git[- ](upload-pack|receive-pack|upload-archive)\s+'?\/?([^'\s][^']*?)'?\s*$/.exec(cmd.trim());
    if (!m) throw new Error(`unsupported command - only git clone / fetch / push / archive are available`);
    const service = m[1];
    const write = service === 'receive-pack';
    const { handler, name } = this.server.resolve(m[2]);
    const app = this.app;
    const identity = this.identity;
    if (!app.auth.can(identity, write ? 'publish' : 'read', handler.conf)) throw new Error(`permission denied to ${handler.conf.name}`);
    if (write && handler.conf.allowPublish === false) throw new Error(`pushing to repository ${handler.conf.name} is disabled`);
    let repo = name;
    if (!handler.exists(repo)) {
      const red = handler.resolveRedirect(repo);
      if (red && red.repo === handler.conf.name && handler.exists(red.name)) repo = red.name;
      else if (write && handler.conf.autoCreate !== false && repo.toLowerCase() !== 'new') await handler.create(repo, {}, identity);
      else throw new Error(`repository ${repo} not found`);
    }
    try { handler.access(repo, identity, write ? 'write' : 'read'); } catch (e) {
      throw new Error(e.status === 404 ? `repository ${repo} not found` : e.message);
    }
    const meta = handler.meta(repo);
    if (write && meta.mirror) throw new Error(`${repo} is a read-only mirror of ${meta.mirror.url}`);
    if (write) require('../policies').checkQuota(handler);
    if (!write && meta.mirror && meta.mirror.enabled && meta.mirror.ttl && (!meta.mirror.lastSync || Date.now() - Date.parse(meta.mirror.lastSync) > meta.mirror.ttl * 1000)) {
      await handler.sync(repo, 'pull').catch((e) => app.log.warn(`mirror refresh ${repo}: ${e.message}`));
    }
    const before = write ? await handler.refSnapshot(repo) : null;
    const dir = handler.repoDir(repo);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...ch.env };
    if (write) Object.assign(env, { REMOTE_USER: identity.name, GL_USERNAME: identity.name });
    const child = spawn('git', [service, dir], { env });
    ch.child = child;
    child.stdout.on('data', (d) => this.output(ch, 'data', d));
    child.stderr.on('data', (d) => this.output(ch, 'ext', d));
    child.stdin.on('error', () => {});
    if (ch.inputEnded) child.stdin.end();
    child.on('error', (e) => { this.output(ch, 'ext', Buffer.from(`ERROR: ${e.message}\n`)); ch.exit = 1; this.flush(ch); });
    child.on('close', async (code) => {
      ch.child = null;
      if (service === 'upload-pack' && code === 0) app.statsStore.hit(handler.conf.name, repo);
      if (write && code === 0) {
        const base = app.config.publicUrl ? app.config.publicUrl.replace(/\/+$/, '') : '';
        await handler.afterRefChange(repo, before, identity, base, 'push-ssh').catch((e) => app.log.warn(`ssh push ${repo}: ${e.message}`));
      }
      ch.exit = code === null ? 1 : code;
      this.flush(ch);
    });
  }
}

const nodeCipher = (name) => name.replace(/^aes(\d+)-ctr$/, 'aes-$1-ctr');

function isKexMsg(t) {
  return t === MSG.KEXINIT || t === MSG.NEWKEYS || t === MSG.KEX_ECDH_INIT || t === MSG.KEX_ECDH_REPLY || t === MSG.DISCONNECT || (t >= 30 && t <= 49);
}

// ------------------------------------------------------------------ server
class SshServer {
  constructor(app) {
    this.app = app;
    this.port = 0;
    this.publicPort = Number(app.config.sshPublicPort) || 0;
    this.connections = new Set();
    this.server = null;
    this.hostKey = null;
  }

  /** Repository handler and name for an SSH path ("owner/name.git", "r/<repo>/owner/name.git", "git/owner/name.git"). */
  resolve(p) {
    const app = this.app;
    let rest = String(p).replace(/^\/+/, '').replace(/^~\//, '');
    let repoName = app.stores.settings.get().gitRepo;
    const rm = /^r\/([^/]+)\/(.+)$/.exec(rest);
    if (rm) { repoName = rm[1]; rest = rm[2]; } else if (/^git\//.test(rest) && !this.isRepo(repoName, rest)) rest = rest.slice(4);
    const conf = repoName && app.repoConfig(repoName);
    if (!conf || conf.type !== 'git') throw new Error(`git repository ${repoName || '(not configured)'} not found`);
    const handler = app.repoHandler(repoName);
    return { handler, name: handler.checkName(rest.replace(/\/+$/, '').replace(/\.git$/, '')) };
  }

  isRepo(repoName, name) {
    try { return this.app.repoHandler(repoName).exists(name.replace(/\.git$/, '')); } catch { return false; }
  }

  listen(port, host) {
    this.hostKey = loadHostKey(path.join(this.app.config.dataDir, 'config', 'ssh_host_ed25519_key'));
    this.server = net.createServer((socket) => {
      if (this.connections.size >= 200) { socket.destroy(); return; }
      this.connections.add(new Connection(this, socket));
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        this.port = this.server.address().port;
        if (!this.publicPort) this.publicPort = Number(this.app.config.sshPort) || this.port;
        this.app.log.info(`SSH (git) listening on ${host}:${this.port} - host key ${this.hostKey.fingerprint}`);
        resolve(this);
      });
    });
  }

  close() {
    for (const c of this.connections) c.destroy();
    this.connections.clear();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

module.exports = { SshServer, verifySignature, publicKeyFromBlob, loadHostKey };

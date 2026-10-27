'use strict';
// Helpers for running git and talking to the GitHub REST API.
const { spawn, spawnSync } = require('child_process');
const { HttpError } = require('./http');

let available = null;

/** Is a usable git binary (incl. http-backend) installed? */
function gitAvailable() {
  if (available === null) {
    const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
    available = r.status === 0 ? r.stdout.trim() : false;
  }
  return available;
}

/** Authorization header for a remote: {token} (GitHub: x-access-token) or {username, password}. */
function authHeader(auth) {
  if (!auth) return null;
  if (auth.header) return auth.header;
  const secret = auth.token || auth.password;
  if (!secret) return null;
  return `Basic ${Buffer.from(`${auth.username || 'x-access-token'}:${secret}`).toString('base64')}`;
}

/**
 * Run git. Resolves {code, stdout: Buffer, stderr: string}; never rejects on non-zero exit.
 * Credentials go through http.extraHeader so they never end up in the repository config.
 */
function run(args, { cwd, input, env, auth, timeoutMs = 10 * 60 * 1000 } = {}) {
  const pre = ['-c', 'credential.helper='];
  const h = authHeader(auth);
  if (h) pre.push('-c', `http.extraHeader=Authorization: ${h}`);
  return new Promise((resolve) => {
    const child = spawn('git', [...pre, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...env },
    });
    const out = [];
    let err = '';
    const timer = setTimeout(() => { err += `\ntimeout after ${timeoutMs} ms`; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { if (err.length < 64 * 1024) err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stdout: Buffer.alloc(0), stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(out), stderr: redact(err) }); });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Like run(), but throws an HttpError (status) when git fails; returns stdout as string. */
async function git(args, opts = {}, status = 500) {
  const r = await run(args, opts);
  if (r.code !== 0) throw new HttpError(status, `git ${args[0]} failed: ${r.stderr.trim().split('\n').slice(-3).join(' | ') || `exit ${r.code}`}`);
  return opts.raw ? r.stdout : r.stdout.toString('utf8');
}

/** Remove credentials from URLs before logging / returning them. */
function redact(s) {
  return String(s || '').replace(/(https?:\/\/)[^/@\s]+@/g, '$1***@');
}

/** Split https://user:token@host/path into a clean URL and auth. */
function splitUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new HttpError(400, `invalid URL: ${redact(url)}`); }
  if (!/^(https?|ssh|git|file):$/.test(u.protocol)) throw new HttpError(400, 'remote URL must be http(s), ssh, git or file');
  let auth = null;
  if (u.username || u.password) {
    auth = u.password ? { username: decodeURIComponent(u.username), token: decodeURIComponent(u.password) } : { token: decodeURIComponent(u.username) };
    u.username = '';
    u.password = '';
  }
  return { url: u.toString(), auth };
}

/** {owner, repo} for github.com URLs, otherwise null. */
function parseGithub(url) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url));
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** GitHub REST API call. */
async function github(apiPath, { token, method = 'GET', body, apiUrl = 'https://api.github.com' } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'rr-registry', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(apiUrl.replace(/\/+$/, '') + apiPath, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: r.status, ok: r.ok, data, link: r.headers.get('link') || '' };
}

/** All pages of a GitHub list endpoint (max `limit` items). */
async function githubList(apiPath, opts = {}, limit = 1000) {
  const out = [];
  for (let page = 1; out.length < limit && page <= 50; page++) {
    const sep = apiPath.includes('?') ? '&' : '?';
    const r = await github(`${apiPath}${sep}per_page=100&page=${page}`, opts);
    if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 502, `GitHub API ${apiPath}: ${r.status} ${(r.data && r.data.message) || ''}`);
    out.push(...r.data);
    if (r.data.length < 100) break;
  }
  return out.slice(0, limit);
}

/** Create owner/repo on GitHub unless it exists (owner may be a user or an organization). */
async function githubEnsureRepo({ owner, repo, token, private: priv = true, description = '' }) {
  const exists = await github(`/repos/${owner}/${repo}`, { token });
  if (exists.ok) return { created: false };
  const me = await github('/user', { token });
  const path = me.ok && me.data.login && me.data.login.toLowerCase() === owner.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
  const r = await github(path, { token, method: 'POST', body: { name: repo, private: !!priv, description } });
  if (!r.ok) throw new HttpError(502, `GitHub: cannot create ${owner}/${repo}: ${r.status} ${(r.data && r.data.message) || ''}`);
  return { created: true };
}

module.exports = { gitAvailable, run, git, redact, splitUrl, parseGithub, github, githubList, githubEnsureRepo, authHeader };

'use strict';
// Configuration: defaults <- .env file (project root) <- process environment <- overrides.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function parseEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function loadConfig(overrides = {}) {
  const env = { ...parseEnvFile(path.join(ROOT, '.env')), ...process.env };
  let version = '0.0.0';
  try { version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { /* ignore */ }
  const cfg = {
    root: ROOT,
    version,
    host: env.RR_HOST || '0.0.0.0',
    port: env.RR_PORT !== undefined && env.RR_PORT !== '' ? Number(env.RR_PORT) : 4873,
    dataDir: path.resolve(ROOT, env.RR_DATA_DIR || 'data'),
    publicUrl: env.RR_PUBLIC_URL || '',
    adminUser: env.RR_ADMIN_USER || 'admin',
    adminPassword: env.RR_ADMIN_PASSWORD || 'admin',
    apiToken: env.RR_API_TOKEN || '',
    defaultRepo: env.RR_DEFAULT_REPO || 'npm',
    upstream: env.RR_UPSTREAM !== undefined ? env.RR_UPSTREAM : 'https://registry.npmjs.org',
    cacheTtl: Number(env.RR_CACHE_TTL || 300),
    maxBodyMb: Number(env.RR_MAX_BODY_MB || 200),
    logRequests: env.RR_LOG_REQUESTS !== '0',
    distDir: path.join(ROOT, 'dist'),
    webDir: path.join(ROOT, 'web'),
    specFile: path.join(ROOT, 'api', 'spec.json'),
    ...overrides,
  };
  cfg.maxBody = cfg.maxBodyMb * 1024 * 1024;
  return cfg;
}

module.exports = { loadConfig, parseEnvFile, ROOT };

'use strict';
// Small HTTP helpers shared by all request handlers.

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

// Thrown by local repository handlers when the requested item does not exist
// locally, so that routing plugins can try a remote registry instead.
class NotFoundLocal extends HttpError {
  constructor(message) {
    super(404, message || 'not found');
  }
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const buf = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-length': buf.length, ...headers });
  res.end(res.req && res.req.method === 'HEAD' ? undefined : buf);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj, null, 2) + '\n', { 'content-type': 'application/json; charset=utf-8', ...headers });
}

function sendError(res, err) {
  const status = err.status || 500;
  const body = { error: err.message || 'internal error', ...((err.extra) || {}) };
  sendJson(res, status, body);
}

function readBody(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

function baseUrl(req, config) {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http')).split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.tgz': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream',
};

function mimeType(file) {
  const m = /\.[^./]+$/.exec(file);
  return (m && MIME[m[0].toLowerCase()]) || 'application/octet-stream';
}

module.exports = { HttpError, NotFoundLocal, send, sendJson, sendError, readBody, readJson, baseUrl, mimeType };

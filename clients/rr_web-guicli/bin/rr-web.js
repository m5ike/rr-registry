#!/usr/bin/env node
'use strict';
// rr-web - RR Registry Web GUI + CLI (Node.js). Maintainer: m5ike.
//   rr-web serve [--port 8090] [--server URL] [--open]   web GUI on localhost, API proxied to the server
//   rr-web <operation> [pathParams...] [--body JSON|@file.json] [--data file] [--query k=v ...] [--out file]
//   rr-web ops | login [user] | config [server URL] [token T] | help
// All API calls go through the generated client library lib/rr-client.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const RRClient = require('../lib/rr-client.js');

const CONFIG = process.env.RR_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'rr', 'config');

function loadConfig() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(CONFIG, 'utf8').split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) cfg[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
    }
  } catch { /* no config yet */ }
  return {
    server: process.env.RR_SERVER || cfg.RR_SERVER || 'http://localhost:4873',
    token: process.env.RR_TOKEN || cfg.RR_TOKEN || '',
    user: cfg.RR_USER || '',
  };
}

function saveConfig(c) {
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  const q = (v) => `'${String(v || '').replace(/'/g, "'\\''")}'`;
  fs.writeFileSync(CONFIG, `# rr client configuration - ${new Date().toISOString()}\nRR_SERVER=${q(c.server)}\nRR_TOKEN=${q(c.token)}\nRR_USER=${q(c.user)}\n`, { mode: 0o600 });
}

function parseArgs(argv) {
  const pos = [];
  const opt = { query: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--body' || a === '-b') opt.body = argv[++i];
    else if (a === '--data' || a === '-d') opt.data = argv[++i];
    else if (a === '--out' || a === '-o') opt.out = argv[++i];
    else if (a === '--query' || a === '-q') { const [k, ...v] = argv[++i].split('='); opt.query[k] = v.join('='); }
    else if (a === '--port' || a === '-p') opt.port = Number(argv[++i]);
    else if (a === '--server' || a === '-s') opt.server = argv[++i];
    else if (a === '--open') opt.open = true;
    else if (a === '--json') opt.json = true;
    else pos.push(a);
  }
  return { pos, opt };
}

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); });
  });
}

function usage() {
  const ops = Object.keys(RRClient.operations);
  console.log(`rr-web ${RRClient.version} - RR Registry Web GUI + CLI (maintainer m5ike)

Web GUI:
  rr-web serve [--port 8090] [--server URL] [--open]   spustí webové rozhraní na localhostu

Připojení:
  rr-web config [server <url>] [token <t>]             zobrazí/uloží ${CONFIG}
  rr-web login [uživatel]                              přihlášení (uloží token)

API (${ops.length} operací, viz "rr-web ops"):
  rr-web <operace> [parametry cesty...] [--body '{"k":"v"}'|--body @soubor.json] [--data soubor] [--query k=v] [--out soubor]
  např.  rr-web status
         rr-web listRepos
         rr-web createRepo --body '{"name":"internal","type":"npm"}'
         rr-web getPackage npm @m5ike/rr-client
         rr-web uploadPackage internal --data ./pkg-1.0.0.tgz
         rr-web search --query q=react
         rr-web downloadTarball npm lodash 4.17.21 --out lodash.tgz`);
}

function serve(cfg, opt) {
  const webDir = path.join(__dirname, '..', 'web');
  const target = new URL(opt.server || cfg.server);
  const port = opt.port || 8090;
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/downloads/') || u.pathname === '/install.sh') {
      const lib = target.protocol === 'https:' ? require('https') : http;
      const headers = { ...req.headers, host: target.host };
      const up = lib.request({ protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: (target.pathname.replace(/\/$/, '')) + req.url, headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
      up.on('error', (e) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: `server ${target.origin} unreachable: ${e.message}` })); });
      req.pipe(up);
      return;
    }
    if (u.pathname === '/config.js') {
      res.writeHead(200, { 'content-type': types['.js'] });
      res.end(`window.RR_CONFIG = { baseUrl: "", server: ${JSON.stringify(target.origin)}, standalone: true };\n`);
      return;
    }
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.resolve(webDir, rel);
    if (!full.startsWith(webDir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': types[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  srv.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`RR Web GUI: ${url}  ->  API ${target.origin}`);
    if (opt.open) {
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      require('child_process').spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
    }
  });
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const cmd = pos.shift() || 'help';
  const client = new RRClient({ baseUrl: opt.server || cfg.server, token: cfg.token });

  switch (cmd) {
    case 'help': case '-h': case '--help': return usage();
    case 'version': case '-v': case '--version': return console.log(`rr-web ${RRClient.version}`);
    case 'serve': case 'gui': return serve(cfg, opt);
    case 'ops':
      for (const [id, o] of Object.entries(RRClient.operations)) console.log(`${id.padEnd(18)} ${o.method.padEnd(6)} ${RRClient.basePath}${o.path}  [${o.auth}]`);
      return;
    case 'config': {
      if (!pos.length) {
        console.log(`config: ${CONFIG}\nserver: ${cfg.server}\ntoken:  ${cfg.token ? `${cfg.token.slice(0, 7)}…` : '(není)'}`);
        return;
      }
      while (pos.length) {
        const k = pos.shift();
        const v = pos.shift();
        if (k === 'server') cfg.server = v;
        else if (k === 'token') cfg.token = v;
        else throw new Error(`unknown config key ${k}`);
      }
      saveConfig(cfg);
      return console.log(`uloženo do ${CONFIG}`);
    }
    case 'login': {
      const user = pos[0] || (await ask('Uživatel: '));
      const pass = await ask('Heslo: ', true);
      const r = await client.signIn(user, pass, 30 * 24 * 3600);
      saveConfig({ ...cfg, token: r.token, user });
      return console.log(`přihlášen jako ${r.user.name} (${r.user.role})`);
    }
    case 'logout':
      await client.logout().catch(() => {});
      saveConfig({ ...cfg, token: '' });
      return console.log('odhlášeno');
    default: {
      const op = RRClient.operations[cmd];
      if (!op) throw new Error(`unknown command/operation "${cmd}" - see rr-web help / rr-web ops`);
      const args = [...pos];
      if (op.body === 'json') {
        let body = opt.body ? opt.body : '{}';
        if (body.startsWith('@')) body = fs.readFileSync(body.slice(1), 'utf8');
        args.push(JSON.parse(body));
      } else if (op.body === 'binary') {
        if (!opt.data) throw new Error('--data <file> is required');
        args.push(fs.readFileSync(opt.data));
      }
      args.push(opt.query);
      const r = await client[cmd](...args);
      if (r instanceof Uint8Array) {
        if (opt.out) { fs.writeFileSync(opt.out, r); console.error(`uloženo: ${opt.out} (${r.length} B)`); } else process.stdout.write(r);
      } else {
        console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
      }
    }
  }
}

main().catch((e) => {
  console.error(`rr-web: ${e.status ? `HTTP ${e.status}: ` : ''}${e.message}`);
  process.exit(1);
});

'use strict';
// Generators producing client libraries from api/spec.json:
//   js(spec)       -> rr-client.js  (UMD: Node >= 18 and browsers)
//   dts(spec)      -> rr-client.d.ts
//   bash(spec)     -> rr-api.sh     (bash + curl)
//   markdown(spec) -> docs/API.md

function pathParams(op) {
  return op.path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
}

function snake(id) {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function jsArgs(op) {
  const a = [...pathParams(op)];
  if (op.body === 'json') a.push('body');
  if (op.body === 'binary') a.push('data');
  a.push('query');
  return a;
}

function bashArgs(op) {
  const a = pathParams(op).map((p) => `<${p}>`);
  if (op.body === 'json') a.push("'<json>'");
  if (op.body === 'binary') a.push('<file>');
  a.push(op.query && op.query.length ? `[query: ${op.query.map((q) => `${q}=..`).join('&')}]` : '[query]');
  return a.join(' ');
}

function js(spec, version) {
  const ops = {};
  for (const op of spec.operations) {
    ops[op.id] = { method: op.method, path: op.path, auth: op.auth, body: op.body || null, response: op.response || 'json', query: op.query || [] };
  }
  const methods = spec.operations.map((op) => {
    const pp = pathParams(op);
    const args = jsArgs(op);
    const sig = args.map((a) => (a === 'query' ? 'query = {}' : a)).join(', ');
    const body = op.body === 'json' ? 'body' : op.body === 'binary' ? 'data' : 'undefined';
    return `    /**
     * ${op.summary}
     * ${op.method} ${spec.basePath}${op.path}  (auth: ${op.auth})${op.query ? `\n     * query: ${op.query.join(', ')}` : ''}
     */
    ${op.id}(${sig}) {
      return this._op('${op.id}', [${pp.join(', ')}], ${body}, query);
    }`;
  }).join('\n\n');

  return `/*!
 * @m5ike/rr-client v${version} - RR Registry API client (generated from api/spec.json, do not edit)
 * Maintainer: m5ike. Works in Node.js >= 18 (global fetch) and in browsers.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RRClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var BASE_PATH = ${JSON.stringify(spec.basePath)};
  var OPERATIONS = ${JSON.stringify(ops, null, 2).replace(/\n/g, '\n  ')};

  class RRError extends Error {
    constructor(status, message, body) {
      super(message);
      this.name = 'RRError';
      this.status = status;
      this.body = body;
    }
  }

  function encodeBasic(s) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
    return Buffer.from(s, 'utf8').toString('base64');
  }

  class RRClient {
    /**
     * @param {{baseUrl?: string, token?: string, username?: string, password?: string, fetch?: Function, headers?: object}} [opts]
     */
    constructor(opts) {
      opts = opts || {};
      this.baseUrl = String(opts.baseUrl || '').replace(/\\/+$/, '');
      this.token = opts.token || '';
      this.username = opts.username || '';
      this.password = opts.password || '';
      this.headers = opts.headers || {};
      this._fetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
      if (!this._fetch) throw new Error('fetch() is not available - use Node.js >= 18 or pass opts.fetch');
    }

    setToken(token) { this.token = token || ''; return this; }

    /** Login with username + password, store the session token in the client. */
    async signIn(username, password, ttl) {
      const r = await this.login({ username: username, password: password, ttl: ttl });
      this.token = r.token;
      return r;
    }

    url(path, query) {
      let u = this.baseUrl + BASE_PATH + path;
      const q = [];
      if (query) for (const k of Object.keys(query)) {
        const v = query[k];
        if (v === undefined || v === null || v === '') continue;
        q.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
      }
      return q.length ? u + '?' + q.join('&') : u;
    }

    async request(method, path, opts) {
      opts = opts || {};
      const headers = Object.assign({ accept: 'application/json' }, this.headers);
      if (this.token) headers.authorization = 'Bearer ' + this.token;
      else if (this.username) headers.authorization = 'Basic ' + encodeBasic(this.username + ':' + this.password);
      let body;
      if (opts.binary) {
        headers['content-type'] = 'application/octet-stream';
        body = opts.body;
      } else if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
      const res = await this._fetch(this.url(path, opts.query), { method: method, headers: headers, body: body });
      if (opts.rawResponse && res.ok) return new Uint8Array(await res.arrayBuffer());
      const text = await res.text();
      let data = text;
      try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
      if (!res.ok) {
        const msg = (data && data.error) || res.statusText || ('HTTP ' + res.status);
        throw new RRError(res.status, msg, data);
      }
      return data;
    }

    _op(id, args, body, query) {
      const op = OPERATIONS[id];
      let i = 0;
      const path = op.path.replace(/:([a-zA-Z]+)/g, function (_, name) {
        const v = args[i++];
        if (v === undefined || v === null || v === '') throw new Error(id + ': missing parameter ' + name);
        return encodeURIComponent(String(v));
      });
      return this.request(op.method, path, {
        query: query,
        body: op.body ? (body === undefined ? (op.body === 'json' ? {} : undefined) : body) : undefined,
        binary: op.body === 'binary',
        rawResponse: op.response === 'binary',
      });
    }

    /** Call an operation by id: client.call('getRepo', 'npm') */
    call(id) {
      const op = OPERATIONS[id];
      if (!op) throw new Error('unknown operation ' + id);
      return this[id].apply(this, Array.prototype.slice.call(arguments, 1));
    }

${methods}
  }

  RRClient.RRError = RRError;
  RRClient.operations = OPERATIONS;
  RRClient.basePath = BASE_PATH;
  RRClient.version = ${JSON.stringify(version)};
  RRClient.RRClient = RRClient;
  RRClient.default = RRClient;
  return RRClient;
});
`;
}

function dts(spec, version) {
  const tsArgs = (op) => {
    const a = pathParams(op).map((p) => `${p}: string`);
    if (op.body === 'json') a.push('body?: Record<string, any>');
    if (op.body === 'binary') a.push('data: Uint8Array | ArrayBuffer | Blob | string');
    const q = (op.query || []).map((k) => `${k}?: string | number | boolean`).join('; ');
    a.push(`query?: { ${q}${q ? '; ' : ''}[key: string]: any }`);
    return a.join(', ');
  };
  const lines = spec.operations.map((op) => `  /** ${op.summary} — ${op.method} ${spec.basePath}${op.path} */\n  ${op.id}(${tsArgs(op)}): Promise<${op.response === 'binary' ? 'Uint8Array' : 'any'}>;`);
  return `// @m5ike/rr-client v${version} - generated type definitions
export interface RRClientOptions {
  baseUrl?: string;
  token?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}
export declare class RRError extends Error {
  status: number;
  body: any;
}
declare class RRClient {
  constructor(opts?: RRClientOptions);
  static RRError: typeof RRError;
  static version: string;
  static operations: Record<string, { method: string; path: string; auth: string; body: string | null; response: string; query: string[] }>;
  baseUrl: string;
  token: string;
  setToken(token: string): this;
  signIn(username: string, password: string, ttl?: number): Promise<{ token: string; user: { name: string; role: string } }>;
  request(method: string, path: string, opts?: { query?: object; body?: any; binary?: boolean; rawResponse?: boolean }): Promise<any>;
  call(id: string, ...args: any[]): Promise<any>;
${lines.join('\n')}
}
export default RRClient;
export { RRClient };
`;
}

function bash(spec, version) {
  const fns = spec.operations.map((op) => {
    const pp = pathParams(op);
    let n = 0;
    const p = op.path.replace(/:([a-zA-Z]+)/g, () => `$(rr_urlencode "\${${++n}:?missing ${pp[n - 1]}}")`);
    const name = `rr_api_${snake(op.id)}`;
    let call;
    if (op.response === 'binary') {
      call = `rr_api_download ${op.method} "${p}" "\${${n + 1}:-}"`;
    } else if (op.body === 'json') {
      call = `rr_api_request ${op.method} "${p}" "\${${n + 2}:-}" json "\${${n + 1}:-}"`;
    } else if (op.body === 'binary') {
      call = `rr_api_request ${op.method} "${p}" "\${${n + 2}:-}" file "\${${n + 1}:?missing file}"`;
    } else {
      call = `rr_api_request ${op.method} "${p}" "\${${n + 1}:-}"`;
    }
    return `# ${op.id}: ${op.summary}\n#   ${op.method} ${spec.basePath}${op.path} (auth: ${op.auth})\n#   usage: ${name} ${bashArgs(op)}\n${name}() { ${call}; }`;
  }).join('\n\n');

  return `#!/usr/bin/env bash
# rr-api.sh v${version} - RR Registry API client library for bash.
# Generated from api/spec.json - do not edit. Maintainer: m5ike.
#
# Usage:   source rr-api.sh
#          RR_SERVER=http://localhost:4873 RR_TOKEN=... rr_api_list_repos
# Env:     RR_SERVER    server URL (default http://localhost:4873)
#          RR_TOKEN     API token (Bearer)  or  RR_USER + RR_PASSWORD (Basic auth)
#          RR_OUT       output file for binary downloads (default stdout)
#          RR_CURL_OPTS extra curl options (e.g. "-k")
# Query:   last argument of every function, e.g. "q=react&size=10" (use rr_query to build it)
# Result:  response body on stdout, exit status 1 on HTTP error (message on stderr),
#          HTTP status in RR_LAST_STATUS.

RR_API_VERSION=${JSON.stringify(version)}
: "\${RR_SERVER:=http://localhost:4873}"
RR_LAST_STATUS=""

rr_urlencode() {
  local LC_ALL=C s="$1" i c out=""
  for ((i = 0; i < \${#s}; i++)); do
    c="\${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+=$(printf '%s' "$c" | od -An -tx1 | tr -d ' \\n' | tr 'a-f' 'A-F' | sed 's/../%&/g') ;;
    esac
  done
  printf '%s' "$out"
}

# rr_query key=value [key=value ...]  -> url-encoded query string, empty values skipped
rr_query() {
  local out="" kv k v
  for kv in "$@"; do
    k="\${kv%%=*}"; v="\${kv#*=}"
    [ -z "$v" ] && continue
    out+="\${out:+&}$(rr_urlencode "$k")=$(rr_urlencode "$v")"
  done
  printf '%s' "$out"
}

_rr_curl_auth() {
  if [ -n "\${RR_TOKEN:-}" ]; then
    printf '%s\\n' "-H" "Authorization: Bearer $RR_TOKEN"
  elif [ -n "\${RR_USER:-}" ]; then
    printf '%s\\n' "-u" "$RR_USER:\${RR_PASSWORD:-}"
  fi
}

# rr_api_request METHOD PATH [QUERY] [none|json|file] [BODY]
rr_api_request() {
  local method="$1" path="$2" query="\${3:-}" mode="\${4:-none}" body="\${5:-}"
  local url="\${RR_SERVER%/}${spec.basePath}\${path}"
  [ -n "$query" ] && url+="?$query"
  local -a args=(-sS -X "$method" -w $'\\n%{http_code}' -H 'Accept: application/json')
  local line
  while IFS= read -r line; do args+=("$line"); done < <(_rr_curl_auth)
  case "$mode" in
    json) [ -z "$body" ] && body='{}'
      args+=(-H 'Content-Type: application/json' --data-binary "$body") ;;
    file)
      [ -f "$body" ] || { echo "rr: file not found: $body" >&2; return 1; }
      args+=(-H 'Content-Type: application/octet-stream' --data-binary "@$body") ;;
  esac
  # shellcheck disable=SC2086
  local out
  out=$(curl "\${args[@]}" \${RR_CURL_OPTS:-} "$url") || { echo "rr: cannot connect to $RR_SERVER" >&2; RR_LAST_STATUS=000; return 2; }
  RR_LAST_STATUS="\${out##*$'\\n'}"
  out="\${out%$'\\n'*}"
  if [ "\${RR_LAST_STATUS:-0}" -ge 400 ] 2>/dev/null; then
    local msg
    msg=$(printf '%s' "$out" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)
    echo "rr: HTTP $RR_LAST_STATUS: \${msg:-$out}" >&2
    return 1
  fi
  printf '%s\\n' "$out"
}

# rr_api_download METHOD PATH [QUERY]  -> binary body to \${RR_OUT:-stdout}
rr_api_download() {
  local method="$1" path="$2" query="\${3:-}"
  local url="\${RR_SERVER%/}${spec.basePath}\${path}"
  [ -n "$query" ] && url+="?$query"
  local -a args=(-sS -X "$method" --fail-with-body)
  local line
  while IFS= read -r line; do args+=("$line"); done < <(_rr_curl_auth)
  # shellcheck disable=SC2086
  if [ -n "\${RR_OUT:-}" ]; then
    curl "\${args[@]}" \${RR_CURL_OPTS:-} -o "$RR_OUT" "$url"
  else
    curl "\${args[@]}" \${RR_CURL_OPTS:-} "$url"
  fi
}

# List of generated operations: "<function> <METHOD> <path> - <summary>"
rr_api_operations() {
  cat <<'__RR_OPS__'
${spec.operations.map((op) => `rr_api_${snake(op.id)}\t${op.method}\t${spec.basePath}${op.path}\t${op.summary}`).join('\n')}
__RR_OPS__
}

${fns}
`;
}

function markdown(spec, version) {
  const groups = {};
  for (const op of spec.operations) (groups[op.group] = groups[op.group] || []).push(op);
  let md = `# RR Registry – Management API (v${version})

> Vygenerováno z \`api/spec.json\` nástrojem \`tools/gen-clients.js\` – needitovat ručně.

Základní cesta: \`${spec.basePath}\`
Autentizace: \`${spec.auth}\`

Úrovně oprávnění: **none** (veřejné), **read** (čtení – anonymně, pokud je povoleno), **user** (libovolný přihlášený),
**publish** (role publisher/admin), **admin**.

Každá operace je dostupná ve všech klientech:

* JavaScript (\`@m5ike/rr-client\`): \`await client.<id>(pathParams..., [body], [query])\`
* Bash (\`rr-api.sh\`): \`rr_api_<snake_id> pathParams... [body|file] [query]\`
* CLI \`rr\` / \`rr-web call <id>\`, Bash GUI \`rr-gui\` a Web GUI \`/admin/\`

`;
  for (const [g, ops] of Object.entries(groups)) {
    md += `## ${g}\n\n| Operace | Metoda a cesta | Auth | Popis | Bash |\n|---|---|---|---|---|\n`;
    for (const op of ops) {
      const q = op.query ? `<br>query: \`${op.query.join('`, `')}\`` : '';
      const b = op.body ? `<br>body: ${op.body}` : '';
      md += `| \`${op.id}\` | \`${op.method} ${spec.basePath}${op.path}\` | ${op.auth} | ${op.summary}${q}${b} | \`rr_api_${snake(op.id)}\` |\n`;
    }
    md += '\n';
  }
  md += `## Pull requesty a issues (kompatibilní s GitHubem)

Operace \`*GitPull*\`, \`*GitIssue*\` a \`listGitBranches\` používají názvy polí GitHub REST API, takže je klient napsaný
pro GitHub (např. ovladač AgentConf) může volat beze změn – jen s jinou základní URL
\`${spec.basePath}/repos/<repo>/git/<název>\` (název s lomítky URL-kódovaný: \`tym%2Fprojekt\`).
Pull requesty a issues sdílejí jednu číselnou řadu v rámci git repozitáře (od 1). Podporu ohlašuje
\`GET ${spec.basePath}/status\` a \`GET ${spec.basePath}/auth/whoami\` polem \`features\` (\`git.pulls\`, \`git.issues\`).

* **Pull** \`{ number, title, body, state, draft, head: {ref, sha}, base: {ref, sha}, html_url, merged, merged_at, merge_commit_sha, mergeable, mergeable_state, user: {login}, created_at, updated_at, comments }\`
* **Issue** \`{ number, title, body, state, labels: [{name}], html_url, user: {login}, created_at, updated_at, closed_at, comments }\`
* **Comment** \`{ id, body, user: {login}, created_at }\`

Chyby mají tělo \`{ error, message }\`: 422 neplatný vstup (větev neexistuje, head = base), 405 nelze sloučit
(zavřený / sloučený PR, konflikt), 409 základní větev se během slučování změnila (stačí zopakovat).

\`\`\`bash
R=http://localhost:4873/api/v1/repos/git/git/tym%2Fprojekt
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
     -d '{"title":"Nová funkce","head":"feature","base":"main"}' $R/pulls
curl -s -H "Authorization: Bearer $TOKEN" "$R/pulls?state=open&head=tym:feature"
curl -s -H "Authorization: Bearer $TOKEN" $R/pulls/1          # mergeable, mergeable_state
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
     -d '{"merge_method":"squash"}' $R/pulls/1/merge
\`\`\`

## Příklady

\`\`\`bash
# token z make menuconfig (RR_API_TOKEN) nebo z přihlášení
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4873/api/v1/repos
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \\
     -d '{"name":"internal","type":"npm"}' http://localhost:4873/api/v1/repos
curl -s -X POST -H "Authorization: Bearer $TOKEN" --data-binary @my-pkg-1.0.0.tgz \\
     http://localhost:4873/api/v1/repos/internal/packages
\`\`\`

\`\`\`js
const RRClient = require('@m5ike/rr-client');
const rr = new RRClient({ baseUrl: 'http://localhost:4873', token: process.env.RR_TOKEN });
console.log(await rr.listRepos());
await rr.createRoute({ name: 'corp', when: 'always', matchType: 'prefix', pattern: '/@corp/', target: 'https://npm.corp.example' });
\`\`\`
`;
  return md;
}

module.exports = { js, dts, bash, markdown, snake, pathParams };

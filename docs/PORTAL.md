# AI Tools Portal integration

Registry (RR Registry) runs standalone exactly as before. Since **1.3.0** it can also be
attached to the [AI Tools Portal](../../ai-tools) (app contract **1**), which then
routes, load-balances, health-checks, logs and TLS-terminates it.

| Item | Value |
|---|---|
| Manifest | [`portal.app.json`](../portal.app.json), also served at `GET /.well-known/portal-app.json` |
| Contract / portal range | `1` / `>=1.1.0 <2.0.0` (single sign-on needs portal 1.1) |
| Health check | `GET /-/ping` |
| App id | `registry` (until 1.5.5: `npm-registry`) |
| Routing | **host** (`registry.<domain>`) + one **host per repository type** (`npm-registry.<domain>`, `git-registry.<domain>`, … — see below), or a dedicated port. Path prefixes are not supported because Docker clients require `/v2/` at the host root. |
| Env set by the portal | `RR_HOST`, `RR_PORT`, `RR_PUBLIC_URL`, `RR_DATA_DIR` (+ `PORTAL_*`) |
| Auth | **single sign-on with the portal** (`portal-header`, since 1.5.0) — see below; local users, tokens and the API token keep working |
| Limits | body up to 4 GB, no upstream timeout (large image layers) |

```bash
aitools app add /path/to/npm-registry                # static mode (supervised node process)
aitools app add /path/to/npm-registry --route-port 4873   # + dedicated port on the gateway
npm config set registry https://registry.example.com/      # or https://npm-registry.example.com/
docker login registry.example.com                          # or docker-registry.example.com
git clone https://git-registry.example.com/tym/projekt.git # = https://registry.example.com/git/tym/projekt.git
```

## Hosts per repository type (1.6.0)

Every repository type that has at least one repository is also served at the root of its own host
`{type}-{app}.<domain>` (manifest `routing.dynamicHosts: "{name}-{app}.{domain}"`):

| Host | Serves at `/` | Same as |
|---|---|---|
| `npm-registry.<domain>` | npm registry of the default npm repository (or the first npm repository / npm group) | `registry.<domain>/` or `/r/<repo>/` |
| `docker-registry.<domain>` | Docker Registry API v2 (`/v2/`) | `registry.<domain>/v2/` |
| `git-registry.<domain>` | git smart HTTP (`/<name>.git`) of the default git repository | `registry.<domain>/git/<name>.git` |
| `generic-registry.<domain>` | files of the default generic repository (or the first generic one) | `registry.<domain>/r/<repo>/` |

- The API (`/api/v1/`), `/-/…` endpoints, explicit `/r/<repo>/` paths, access keys `/~key/` and the admin UI work on every
  type host; links in responses (npm tarball URLs, …) point to the host the client used.
- The registry reports the types to the portal at startup and whenever a repository is created or deleted
  (`PUT /_portal/api/apps/registry/hosts`, authenticated with `PORTAL_IDENTITY_KEY`); the portal adds or removes the
  gateway host routes. The dashboard widget *Připojení klientů → hosty* and `GET /api/v1/status` (`typeHosts`) list them.
- Needs portal **1.8.0** or newer. Older portals answer `404`: the registry logs it once and the type hosts can be
  added manually as routes in `apps.d/registry.yaml`.
- Standalone the same host names work as well (e.g. `npm-registry.localhost:4873`); the app id in the names is
  `PORTAL_APP_ID`, `RR_APP_ID` or `registry`.
- On `.localhost` domains nothing needs to be configured; elsewhere add DNS records (or a wildcard `*.<domain>`) and,
  for HTTPS, certificates for the new hosts.

## Aliases and repository hosts (1.7.4)

The manifest declares the alias **`rr`** (`routing.aliases`) and **subdomains** (`routing.subdomains: true`), so with
portal 1.9.2+ the registry also answers on `rr.<domain>`, `<type>-rr.<domain>` and every host below `registry.<domain>`
/ `rr.<domain>` – the public browser uses `<repository>.<type>.registry.<domain>` (see [BROWSER.md](BROWSER.md)).
Aliases are edited in the portal under *Gateway & routes → Domains and host names* (or `aliases:` in
`apps.d/registry.yaml`); the registry learns them from `PORTAL_APP_ALIASES` after a restart. DNS needs a record for each
name (a wildcard `*.<domain>` is easiest, `/etc/hosts` cannot hold wildcards).

## Migrating from the app id `npm-registry`

Until 1.5.5 the app id was `npm-registry`. An installed portal (1.8.0 or newer) moves over like this (docker mode;
in static mode move `data/apps/npm-registry` to `data/apps/registry` instead of copying the volume):

```bash
aitools update --from <ai-tools checkout>              # portal 1.8.0 (dynamic hosts)
docker stop aitools-npm-registry-web
docker volume create aitools_registry-data
docker run --rm -v aitools_npm-registry-data:/from:ro -v aitools_registry-data:/to alpine cp -a /from/. /to/
aitools app remove npm-registry                         # keeps data and the old volume
mv apps/npm-registry backups/                           # old git checkout (app add would reuse it)
aitools app add <registry repo> --git --ref portal/c1/v1.6.0
aitools user access <user> registry <role>              # per-user access is stored per app id
aitools docker up                                       # builds aitools/registry, removes the old container
```

Then point DNS (or `/etc/hosts`) at the new hosts: `registry.<domain>` and `{npm,docker,git,generic}-registry.<domain>`.
The old host `npm-registry.<domain>` keeps working — it is now the npm type host (npm, API, admin UI, `/v2/`, `/git/`).
Once everything works, the old volume can be removed: `docker volume rm aitools_npm-registry-data`.

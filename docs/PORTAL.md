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

## Migrating from the app id `npm-registry`

```bash
aitools app remove npm-registry          # keeps the data unless --purge
aitools app add <source of the registry> # attaches it as "registry"
# move the data: data/apps/npm-registry -> data/apps/registry (static) or the docker volume
aitools user access <user> registry <role>
```

## Versioning

Portal-compatible releases are tagged `portal/c<contract>/v<version>` (e.g.
`portal/c1/v1.3.0`) next to the plain `v<version>` tag. `aitools compat` shows
the tag that is deployed.

## Single sign-on (1.5.0)

Accounts and permissions are managed centrally in the portal (*App access*, or
`aitools user access <user> registry <role>`). Roles: **admin**, **publisher**, **reader**
(default for portal users: reader; portal administrators: admin).

| Client | How it signs in |
|---|---|
| Browser (home page, `/admin/`) behind the portal gateway | automatically: the gateway sends the signed identity `X-Portal-Identity` (user + role); the admin UI skips its login form, its logout logs out of the portal |
| `docker login`, git over HTTPS, Basic auth | portal user name + **portal password** — checked against the portal (`POST /_portal/api/auth/verify`, cached 60 s) |
| `npm login --auth-type=legacy`, web login form | portal credentials accepted; npm tokens of portal accounts expire after 30 days |
| Tokens, local users, `RR_API_TOKEN` | unchanged (local accounts win over portal accounts of the same name) |

Only active when the portal starts the registry (`PORTAL_IDENTITY_KEY`, `PORTAL_APP_ID`,
`PORTAL_INTERNAL_URL` in the environment); standalone the identity header is ignored.


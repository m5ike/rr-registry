# AI Tools Portal integration

RR Registry runs standalone exactly as before. Since **1.3.0** it can also be
attached to the [AI Tools Portal](../../ai-tools) (app contract **1**), which then
routes, load-balances, health-checks, logs and TLS-terminates it.

| Item | Value |
|---|---|
| Manifest | [`portal.app.json`](../portal.app.json), also served at `GET /.well-known/portal-app.json` |
| Contract / portal range | `1` / `>=1.1.0 <2.0.0` (single sign-on needs portal 1.1) |
| Health check | `GET /-/ping` |
| Routing | **host** (`npm-registry.<domain>`) or a dedicated port. Path prefixes are not supported because Docker clients require `/v2/` at the host root. |
| Env set by the portal | `RR_HOST`, `RR_PORT`, `RR_PUBLIC_URL`, `RR_DATA_DIR` (+ `PORTAL_*`) |
| Auth | **single sign-on with the portal** (`portal-header`, since 1.5.0) — see below; local users, tokens and the API token keep working |
| Limits | body up to 4 GB, no upstream timeout (large image layers) |

```bash
aitools app add /path/to/npm-registry                # static mode (supervised node process)
aitools app add /path/to/npm-registry --route-port 4873   # + dedicated port on the gateway
npm config set registry https://npm-registry.example.com/
docker login npm-registry.example.com
```

## Versioning

Portal-compatible releases are tagged `portal/c<contract>/v<version>` (e.g.
`portal/c1/v1.3.0`) next to the plain `v<version>` tag. `aitools compat` shows
the tag that is deployed.

## Single sign-on (1.5.0)

Accounts and permissions are managed centrally in the portal (*App access*, or
`aitools user access <user> npm-registry <role>`). Roles: **admin**, **publisher**, **reader**
(default for portal users: reader; portal administrators: admin).

| Client | How it signs in |
|---|---|
| Browser (home page, `/admin/`) behind the portal gateway | automatically: the gateway sends the signed identity `X-Portal-Identity` (user + role); the admin UI skips its login form, its logout logs out of the portal |
| `docker login`, git over HTTPS, Basic auth | portal user name + **portal password** — checked against the portal (`POST /_portal/api/auth/verify`, cached 60 s) |
| `npm login --auth-type=legacy`, web login form | portal credentials accepted; npm tokens of portal accounts expire after 30 days |
| Tokens, local users, `RR_API_TOKEN` | unchanged (local accounts win over portal accounts of the same name) |

Only active when the portal starts the registry (`PORTAL_IDENTITY_KEY`, `PORTAL_APP_ID`,
`PORTAL_INTERNAL_URL` in the environment); standalone the identity header is ignored.


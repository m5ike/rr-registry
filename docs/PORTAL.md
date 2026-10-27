# AI Tools Portal integration

RR Registry runs standalone exactly as before. Since **1.3.0** it can also be
attached to the [AI Tools Portal](../../ai-tools) (app contract **1**), which then
routes, load-balances, health-checks, logs and TLS-terminates it.

| Item | Value |
|---|---|
| Manifest | [`portal.app.json`](../portal.app.json), also served at `GET /.well-known/portal-app.json` |
| Contract / portal range | `1` / `>=1.0.0 <2.0.0` |
| Health check | `GET /-/ping` |
| Routing | **host** (`npm-registry.<domain>`) or a dedicated port. Path prefixes are not supported because Docker clients require `/v2/` at the host root. |
| Env set by the portal | `RR_HOST`, `RR_PORT`, `RR_PUBLIC_URL`, `RR_DATA_DIR` (+ `PORTAL_*`) |
| Auth | the registry's own (tokens / basic auth) — npm, docker and git clients authenticate directly |
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

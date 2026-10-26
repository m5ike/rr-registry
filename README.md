# RR Registry

Jednoduchý, samostatný **registr balíčků pro npm** a kompatibilní nástroje (yarn, pnpm, bun, deno `npm:`)
plus **obecné repozitáře souborů**, s **routovacím pluginem** (proxy na další registry s cache),
**správcovským REST API** a čtyřmi klienty: **Web GUI**, **CLI**, **bash CLI** a **bash GUI**.
Maintainer: **m5ike**. Bez externích závislostí – jen Node.js ≥ 18 (server) a bash + curl (klienti).

```
┌────────────────────────────── Docker kontejner ──────────────────────────────┐
│  Web Backend Server (Node.js)                                                │
│   ├─ /               homepage (info, rychlé stažení klientů, návod)          │
│   ├─ /admin/         Web GUI (konfigurace a správa)  ── používá rr-client.js │
│   ├─ /api/v1/*       správcovské API (49 operací, api/spec.json)             │
│   ├─ /, /r/<repo>/   npm registry protokol (publish, install, search, tagy…) │
│   ├─ /~<klíč>/       směrování dle klíče                                     │
│   ├─ plugin router   pravidla → vzdálené registry  ─┐                        │
│   └─ cache           data/cache (TTL, stale-if-error)◄┘                      │
│                                                                              │
│  data/ (bind mount) ── repos/<repo>/…  config/*.json  cache/  audit.log      │
└──────────────────────────────────────────────────────────────────────────────┘
        ▲ API                     ▲ API                  ▲ API            ▲ npm protokol
   rr (bash CLI)            rr-gui (bash GUI)     rr-web (Web GUI + CLI)   npm/yarn/pnpm/bun
   └──── rr-api.sh ────┘                          └─ rr-client.js ─┘
         (knihovny generované při sestavení z api/spec.json)
```

## Rychlý start

```bash
make menuconfig      # GUI konfigurace: port, heslo administrátora, api_token … (-> .env)
make up              # sestaví a spustí Docker kontejner
open http://localhost:4873/          # homepage, odkaz na /admin/
```

Bez Dockeru: `make config && make run` (Node.js ≥ 18). Kompletní instalace jedním příkazem: `make install`.

Použití registru:

```bash
npm config set registry http://localhost:4873/
npm login --registry http://localhost:4873/ --auth-type=legacy   # nebo token v .npmrc
npm publish
npm install lodash          # není lokálně → stáhne se z npmjs.org přes cache
```

Klientské nástroje z běžícího serveru:

```bash
curl -fsSL http://localhost:4873/install.sh | bash        # rr, rr-gui, rr-web do ~/.local/bin
rr login admin && rr status
rr-gui                                                    # textové menu
rr-web serve --open                                       # Web GUI lokálně
```

## Funkce

* **npm registry** – publish/unpublish, deprecate, dist-tagy, vyhledávání (`/-/v1/search`), `npm login` (legacy),
  `whoami`, scoped balíčky, `npm audit` (přeposlání na upstream), integrity sha512/sha1.
* **Více repozitářů** – typ `npm` nebo `generic` (libovolné soubory: PUT/GET/DELETE), výchozí repozitář na `/`,
  ostatní na `/r/<repo>/`, veřejné/soukromé, zákaz publikace.
* **Přímý přístup k úložišti** – strom adresářů, informace, obsah souborů, upload, mazání (API i GUI).
* **Routing plugin** – směrování dle masky URL (prefix/glob/regex/contains/exact), části URL (balíček / cesta / celá URL),
  klíče (`/~klic/`, `X-RR-Key`, `?rr_key=`), hlavičky, metody, repozitáře; režim *vždy* nebo *když není nalezeno lokálně*,
  řetězení fallbacků, přepis cest, vlastní hlavičky pro upstream. Viz [docs/ROUTING.md](docs/ROUTING.md).
* **Cache** – vzdálená metadata i tarbally na disku s TTL, odpovědi z cache do vypršení, při výpadku upstreamu stale kopie,
  deduplikace souběžných požadavků, správa přes API.
* **Uživatelé a tokeny** – role admin/publisher/reader, tokeny (i read-only, s expirací), hlavní `api_token` z menuconfig.
* **Správcovské API** – 49 operací, z [api/spec.json](api/spec.json) se při sestavení generují klientské knihovny
  (JS/TS, bash) a dokumentace [docs/API.md](docs/API.md). Server odmítne start, pokud by nějaká operace neměla handler.
* **Klientské balíčky** (maintainer m5ike) se při startu publikují do registru a jsou ke stažení na homepage:
  `@m5ike/rr-client`, `@m5ike/rr_bash-cli`, `@m5ike/rr_bash-gui`, `@m5ike/rr_web-guicli`.

## Struktura repozitáře

| Cesta | Obsah |
|---|---|
| `api/spec.json` | specifikace správcovského API (zdroj pravdy pro klienty) |
| `server/` | Web Backend Server (`bin/rr-server.js`, `src/…`: npm/generic repozitáře, auth, cache, pluginy, API, web) |
| `web/` | homepage (`home/`), Web GUI administrace (`admin/`), statické soubory |
| `clients/` | zdroje klientských balíčků (`rr-client`, `rr_bash-cli`, `rr_bash-gui`, `rr_web-guicli`, `shared/`) |
| `tools/` | `build.js` (kompilace), `gen-clients.js` (generátory JS/TS/bash/Markdown) |
| `scripts/` | `menuconfig.sh`, `install.sh`, `update.sh`, `backup.sh`, `uninstall.sh`, `test.sh` |
| `tests/` | unit a integrační testy (`node --test`) |
| `docs/` | [INSTALL](docs/INSTALL.md), [USAGE](docs/USAGE.md), [ROUTING](docs/ROUTING.md), [API](docs/API.md) |
| `dist/` | výstup sestavení (generované knihovny, `packages/*.tgz`) |
| `data/` | data registru (repozitáře, konfigurace, cache) – vytvoří se při startu |

## Make cíle

```
make menuconfig   GUI konfigurace (.env)        make up / down / restart / logs / status
make build        klienti + Docker image        make run       lokálně bez Dockeru
make test         unit + integrační + e2e       make test-docker  smoke test image
make update       záloha, pull, rebuild, restart make backup / restore FILE=…
make install      instalace                      make uninstall
```

## Testy

```bash
make test-unit                 # 18 unit/integračních testů (mock upstream registr)
make test-e2e                  # ~67 e2e kontrol: skutečný npm, rr, rr-api.sh, rr-web, instalátor
bash scripts/test.sh --online  # + instalace balíčku z npmjs.org přes proxy a cache
make test-docker               # sestavení image a test kontejneru
```

Licence MIT · © m5ike

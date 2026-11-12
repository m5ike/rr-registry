# Instalace, konfigurace a aktualizace

## Požadavky

| Režim | Požadavky |
|---|---|
| Docker (doporučeno) | Docker 20+ s `docker compose`, `make`, `bash`, `curl` |
| Lokálně (bez Dockeru) | Node.js ≥ 18, `make`, `bash`, `curl`, `git` (pro git repozitáře) |
| `make menuconfig` GUI | `whiptail` nebo `dialog` (jinak textové dotazy) |
| Bash klienti | `bash`, `curl`, `jq` (GUI vyžaduje i `whiptail`/`dialog`) |

macOS: `brew install newt jq`, Debian/Ubuntu: `apt install whiptail jq make curl`.

## Instalace

```bash
git clone <repo> rr-registry && cd rr-registry
make install                 # ověří závislosti, spustí menuconfig, sestaví a spustí kontejner
# volby: bash scripts/install.sh --docker|--native --yes --clients
```

Ruční postup:

```bash
make menuconfig              # vytvoří .env
make up                      # docker compose up -d --build
make status                  # GET /api/v1/status
```

Bez Dockeru: `make config` (výchozí hodnoty, vygeneruje heslo a token) a `make run`.
`scripts/install.sh --native` spuštěný jako root na Linuxu vytvoří systemd službu `rr-registry`.

## make menuconfig

Interaktivní menu (whiptail/dialog) zapisuje `.env`:

| Proměnná | Význam | Výchozí |
|---|---|---|
| `RR_PORT` | port web backendu (v kontejneru i na hostiteli) | 4873 |
| `RR_BIND` | adresa hostitele pro publikování portu | 0.0.0.0 |
| `RR_PUBLIC_URL` | veřejná URL (za reverzní proxy), jinak z hlavičky `Host` | – |
| `RR_ADMIN_USER` / `RR_ADMIN_PASSWORD` | vestavěný administrátor | admin / vygenerováno |
| `RR_API_TOKEN` | hlavní API token (Bearer) s právy administrátora | vygenerováno |
| `RR_DEFAULT_REPO` | výchozí npm repozitář (kořen `/`) – při prvním startu | npm |
| `RR_UPSTREAM` | fallback registr pro nenalezené balíčky – při prvním startu | https://registry.npmjs.org |
| `RR_CACHE_TTL` | výchozí platnost cache metadat (s) | 300 |
| `RR_MAX_BODY_MB` | maximální velikost uploadu | 200 |
| `RR_GIT_COMMITTER_NAME` / `RR_GIT_COMMITTER_EMAIL` | committer commitů, které vytváří server (sloučení pull requestů) | RR Registry / rr@localhost |
| `RR_DATA_PATH` | adresář dat na hostiteli (bind mount do `/data`) | ./data |
| `RR_UID` / `RR_GID` | uživatel procesu v kontejneru (vlastník dat) | aktuální uživatel |

Neinteraktivně: `make config` nebo `scripts/menuconfig.sh --defaults`. Po změně: `make restart`.

Za běhu se další nastavení (název, anonymní čtení, registrace, TTL, CORS, pluginy, výchozí repozitář)
mění ve Web GUI → *Nastavení*, `rr settings set …` nebo `PUT /api/v1/settings`; ukládají se do `data/config/settings.json`.

## Data na disku

```
data/
├── config/          settings.json, repos.json, routes.json, users.json, tokens.json, secret
├── repos/<repo>/    npm: <balíček>/packument.json + <název>-<verze>.tgz;  generic: libovolné soubory
├── cache/           vzdálený obsah (<hash>.json metadata + .bin tělo)
├── plugins/         volitelné vlastní pluginy (*.js)
└── audit.log        auditní záznam změn (JSON řádky)
```

## Aktualizace

```bash
make update          # = scripts/update.sh: záloha → git pull → build klientů → rebuild image → restart
bash scripts/update.sh --no-backup --no-pull --clients   # + aktualizace lokálních klientů
```

Data a `.env` zůstávají zachovány. Nová verze klientských balíčků (dle `VERSION`) se při startu sama publikuje do registru.

## Zálohy

```bash
make backup                                  # backups/rr-backup-YYYYmmdd-HHMMSS.tar.gz (bez cache)
make down && make restore FILE=backups/rr-backup-….tar.gz && make up
```

## Odinstalace

```bash
make uninstall                               # zastaví kontejner, data ponechá
bash scripts/uninstall.sh --purge --clients  # i data, .env, image a lokální klienty
```

## Reverzní proxy (HTTPS)

Nastavte `RR_PUBLIC_URL=https://npm.firma.cz`, nebo předávejte `X-Forwarded-Proto` a `X-Forwarded-Host`.
Příklad nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:4873;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  client_max_body_size 200m;
}
```

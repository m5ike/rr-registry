# Použití registru a klientů

## Připojení správců balíčků

| Nástroj | Nastavení |
|---|---|
| npm | `npm config set registry http://HOST:4873/` |
| npm (jen scope) | `.npmrc`: `@firma:registry=http://HOST:4873/r/internal/` |
| yarn 1 | `yarn config set registry http://HOST:4873/` |
| yarn berry | `yarn config set npmRegistryServer http://HOST:4873/` (+ `unsafeHttpWhitelist` pro http) |
| pnpm | `pnpm config set registry http://HOST:4873/` |
| bun | `bunfig.toml`: `[install] registry = "http://HOST:4873/"` |
| deno | `NPM_CONFIG_REGISTRY=http://HOST:4873/ deno run …` |

Autentizace pro publikaci – token do `.npmrc`:

```
//HOST:4873/:_authToken=<token>
```

Token získáte: `npm login --auth-type=legacy` (uživatelé vytvoření administrátorem), `rr token create`,
Web GUI → Tokeny, nebo použijte `RR_API_TOKEN` z `.env`.

Konkrétní repozitář: `http://HOST:4873/r/<repo>/`, se směrovacím klíčem: `http://HOST:4873/~<klíč>/` nebo
`http://HOST:4873/~<klíč>/r/<repo>/`.

## Generic repozitáře

```bash
curl -T app-1.0.zip -H "Authorization: Bearer $TOKEN" http://HOST:4873/r/files/app/app-1.0.zip
curl -O http://HOST:4873/r/files/app/app-1.0.zip
curl http://HOST:4873/r/files/app/            # výpis adresáře (JSON, v prohlížeči HTML)
curl -X DELETE -H "Authorization: Bearer $TOKEN" http://HOST:4873/r/files/app/app-1.0.zip
```

## Klienti

Všichni klienti volají správcovské API výhradně přes knihovny generované z `api/spec.json`
(`rr-client.js` pro JS/Web, `rr-api.sh` pro bash). Instalace:

```bash
curl -fsSL http://HOST:4873/install.sh | bash                    # vše do ~/.local
curl -fsSL http://HOST:4873/install.sh | bash -s -- rr_bash-cli  # jen jeden
npm install -g @m5ike/rr_bash-cli --registry http://HOST:4873/   # nebo přes npm
```

Konfigurace (sdílená): `~/.config/rr/config` (`RR_SERVER`, `RR_TOKEN`), proměnné prostředí mají přednost.

### rr – bash CLI (`@m5ike/rr_bash-cli`)

```bash
rr config server http://HOST:4873
rr login admin
rr status
rr repo list | show <r> | create <r> [npm|generic] [popis] | update <r> public=false | delete <r> [--purge]
rr pkg list <r> [filtr] | show <r> <bal> | publish <r> <soubor.tgz> [tag] | download <r> <bal> <ver>
rr pkg tag <r> <bal> <tag> <ver> | untag … | deprecate <r> <bal> <ver> <zpráva> | delete <r> <bal> [ver]
rr search <dotaz>
rr fs tree <r> [cesta] [hloubka] | stat | cat | get | put <r> <cesta> <soubor> | rm | mkdir
rr route list | add k=v… | update <id> k=v… | enable|disable|delete <id> | test <cesta> [repo] [klíč]
rr cache stats | list | purge [--expired] [filtr] | rm <klíč>
rr user list | add <jméno> <heslo> [role] | passwd | role | delete
rr token list | create <název> [--readonly] [--user u] [--ttl s] | revoke <id>
rr settings get | set key=value…          (hodnota s == je vždy řetězec: title==Můj registr)
rr logs | plugins | clients | rebuild-clients | npmrc [repo] | api | call <operace> args…
```

### rr-gui – bash GUI (`@m5ike/rr_bash-gui`)

Spusťte `rr-gui`. Menu: stav, repozitáře (detail, úpravy, mazání), balíčky (upload .tgz, verze, tagy,
deprecate, stažení), prohlížeč souborů (zobrazení, upload, mazání, adresáře), hledání, směrování
(průvodce novým pravidlem, test, úpravy polí), cache, uživatelé, tokeny, nastavení, logy, klienti, připojení.
`RR_DIALOG=dialog rr-gui` vynutí `dialog` místo `whiptail`.

### rr-web – Web GUI + CLI (`@m5ike/rr_web-guicli`)

```bash
rr-web serve --server http://HOST:4873 --port 8090 --open    # administrace lokálně (API se proxuje)
rr-web ops                                                    # seznam operací
rr-web listRepos
rr-web createRoute --body @pravidlo.json
rr-web uploadPackage internal --data ./lib-1.0.0.tgz
rr-web downloadTarball npm lodash 4.17.21 --out lodash.tgz
```

### @m5ike/rr-client – knihovna

```js
const RRClient = require('@m5ike/rr-client');
const rr = new RRClient({ baseUrl: 'http://HOST:4873', token: process.env.RR_TOKEN });
await rr.createRepo({ name: 'internal', type: 'npm' });
```

V prohlížeči: `<script src="http://HOST:4873/static/rr-client.js"></script>` → `window.RRClient`.

## Web GUI

`http://HOST:4873/admin/` – přihlášení jménem/heslem nebo tokenem. Sekce: Přehled, Repozitáře, Balíčky,
Soubory, Hledání, Směrování (včetně testu pravidel), Cache, Uživatelé, Tokeny, Nastavení (pluginy), Logy, Klienti.
Uživatelé s rolí publisher/reader vidí jen sekce, na které mají oprávnění.

## Oprávnění

| Role | Čtení | Publikace (npm, generic PUT) | Správa (repozitáře, pravidla, uživatelé, soubory přes API) |
|---|---|---|---|
| anonym | ano, pokud `anonymousRead` a repozitář `public` | ne | ne |
| reader / read-only token | ano | ne | ne |
| publisher | ano | ano | ne |
| admin, `RR_API_TOKEN` | ano | ano | ano |

# Pokročilé funkce repozitářů

Jsou inspirované běžnými správci artefaktů (Nexus, Artifactory, Gitea) a fungují pro všechny typy repozitářů,
pokud není uvedeno jinak. Nastavíte je ve Web GUI (Repozitáře → Upravit), v `rr-gui` (repozitář → Pokročilé / Pravidla čištění),
přes `rr repo update|policy|acl` nebo `PUT /api/v1/repos/<repo>`.

## Typy repozitářů

| Typ | Použití |
|---|---|
| `npm` | npm/yarn/pnpm/bun/deno balíčky |
| `docker` | Docker / OCI image (`/v2/`) |
| `git` | git repozitáře (`/git/`, viz [GIT.md](GIT.md)) |
| `generic` | libovolné soubory (PUT/GET/DELETE) |
| `group` | virtuální skupina npm nebo generic repozitářů |

## Skupinové repozitáře (`group`)

Jedna URL pro více repozitářů:

```bash
rr repo create vse group "Interní + veřejné" members=internal,npm deployTo=internal
npm config set registry http://localhost:4873/r/vse/
```

- **npm**: metadata balíčku se slučují ze všech členů. Při shodné verzi vyhrává dřívější člen, `latest` je nejvyšší stabilní verze. Vyhledávání prochází všechny členy.
- **generic**: soubor se obslouží z prvního člena, který ho má.
- **zápis** (`npm publish`, upload) jde do člena `deployTo`. Bez něj je skupina jen pro čtení.
- Pokud položka chybí ve všech členech, uplatní se směrovací pravidla, která skupina má (např. fallback na npmjs).

## Kvóty

`quotaMb` omezuje velikost úložiště repozitáře (0 = bez limitu). Zápis, který by kvótu překročil, server odmítne kódem **507**. Týká se npm publish, generic upload, docker push, git push a zápisů přes API.
Aktuální využití vrací `GET /api/v1/repos/<repo>` (`quota.usedBytes`) a Web GUI ho ukazuje v detailu repozitáře.

## Neměnné repozitáře (`immutable`)

Co jednou vyjde, už se nezmění:

| Typ | Co neměnnost zakazuje |
|---|---|
| npm | unpublish (verze i celý balíček) |
| generic | přepis a mazání souborů |
| docker | přepsání tagu jiným digestem a mazání |
| git | force-push a mazání refů; repozitáře nelze smazat přes API |

Pravidla čištění se v neměnném repozitáři nespouštějí.

## Přístupová práva (ACL)

`acl` přiřazuje konkrétním uživatelům oprávnění pro daný repozitář a má přednost před jejich globální rolí:

```bash
rr repo acl interni alice=publish bob=read eve=none
rr repo update interni public=false
```

- Úrovně jsou `none`, `read` a `publish`. Administrátor má přístup vždy.
- U soukromého repozitáře (`public=false`) s neprázdným ACL nemají uživatelé mimo seznam žádný přístup.
- Read-only token má nejvýš úroveň `read`.

## Pravidla čištění (retence)

```bash
rr repo policy nightly enabled=true maxVersions=10 maxAgeDays=90 prereleaseOnly=true intervalHours=24
rr repo cleanup nightly --dry-run      # náhled
rr repo cleanup nightly                # provedení
```

| Typ | Co se čistí |
|---|---|
| npm | starší verze balíčku nad `maxVersions` nebo starší než `maxAgeDays`; verze s dist-tagem zůstávají; `prereleaseOnly` omezí čištění na pre-release verze |
| docker | tagy image (kromě `latest`), potom garbage collection nepoužívaných dat |
| generic | soubory v každém adresáři (ponechá nejnovějších N); `pattern` (glob) omezí, kterých cest se pravidlo týká |
| git | `git gc` |

Automatické čištění spouští úloha `cleanup` po `intervalHours` hodinách. Náhled a ruční spuštění najdete ve Web GUI v detailu repozitáře.

## Statistiky stahování

Počty stažení se ukládají do `data/stats.json`. Sledují se npm tarbally, generic soubory, docker manifesty a git clone/fetch.
Celkový počet, nejstahovanější položky a posledních 30 dní:

```bash
rr repo stats npm
curl -H "Authorization: Bearer $TOKEN" http://localhost:4873/api/v1/repos/npm/stats
```

## Webhooky

```bash
rr webhook add name=ci url=https://ci.example.com/hooks/rr events=npm.publish,git.push repos=* secret=tajne
rr webhook add name=chat url=https://hooks.slack.com/services/… events=* format=slack
rr webhook test <id>
rr webhook deliveries
```

**Události:**

| Skupina | Typy |
|---|---|
| npm | `npm.publish`, `npm.unpublish`, `npm.tag`, `npm.deprecate` |
| soubory | `file.upload`, `file.delete` |
| docker | `docker.push`, `docker.delete` |
| git | `git.create`, `git.push`, `git.sync`, `git.delete` |
| repozitáře | `repo.create`, `repo.update`, `repo.delete`, `repo.cleanup` |
| replikace | `replication.failed` |

Filtrovat lze i skupinou (`npm.*`) a seznamem repozitářů.

**Formát:** JSON
```json
{ "event": "...", "delivery": "...", "time": "...", "user": "...", "repo": "...", "data": {...}, "server": {...} }
```
Volitelně `slack` (Slack/Mattermost) nebo `discord`.

**Hlavičky:** `X-RR-Event`, `X-RR-Delivery` a při nastaveném secretu `X-RR-Signature-256: sha256=<HMAC-SHA256(secret, tělo)>`.

**Opakování:** neúspěšné doručení se zopakuje (výchozí 3 pokusy).

**Přehled:** historie doručení a poslední události jsou ve Web GUI (🔔 Webhooky).

Ověření podpisu v Node.js:

```js
const ok = req.headers['x-rr-signature-256'] === 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
```

## Replikace (směrovací pravidla `push`)

Pravidlo s `when=push` po úspěšném zápisu automaticky zkopíruje obsah na vzdálený server (viz [ROUTING.md](ROUTING.md)):

| Typ | Co se replikuje |
|---|---|
| npm | publikované verze (PUT na cílový registr, např. jiný RR, Verdaccio, npmjs) |
| generic | nahrané soubory (PUT `cíl/cesta`), volitelně i mazání (`replicateDeletes`) |
| git | `git push` na `cíl/<název>.git` (režim `mirror` nebo `branches`, volitelně vytvoření na GitHubu) |

Fronta, stav a opakování: `rr replication list`, `rr replication retry <id>`, Web GUI → ⏱ Úlohy.

## Naplánované úlohy

| Úloha | Interval | Popis |
|---|---|---|
| `git-mirrors` | 60 s | synchronizuje pull zrcadla, kterým uplynul interval |
| `cleanup` | 1 h | spustí pravidla čištění repozitářů, kterým uplynul `intervalHours` |
| `cache-expired` | 6 h | smaže expirované položky cache |
| `stats-flush` | 60 s | uloží statistiky |

`rr task list`, `rr task run <id>`, `GET /api/v1/tasks`, `POST /api/v1/tasks/<id>/run`.

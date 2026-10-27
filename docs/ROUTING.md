# Směrování (routing plugin) a cache

Routing plugin rozhoduje, zda se požadavek obslouží z lokálního repozitáře, nebo se přepošle na jiný
server s registrem. Vzdálené odpovědi se ukládají do cache (`data/cache`) a další požadavky se
servírují přímo z ní, dokud nevyprší platnost.

## Průběh požadavku

```
požadavek ─► klíč? (/~klic/…, X-RR-Key, ?rr_key=) ─► repozitář (/ nebo /r/<repo>/)
          ─► pravidla "always" (dle priority) ── shoda ─► upstream (cache) ── 404 ─┐
          ─► lokální repozitář ── nalezeno ─► odpověď                              │
          ─► pravidla "notfound" (dle priority, řetězí se při 404) ◄───────────────┘
          ─► 404
```

## Pole pravidla

| Pole | Hodnoty | Popis |
|---|---|---|
| `name` | text | unikátní název |
| `enabled` | true/false | zapnuto |
| `priority` | číslo | nižší = vyhodnoceno dříve |
| `when` | `always` / `notfound` / `push` | přeposlat vždy, jen když položka lokálně chybí, nebo **push**: po úspěšném zápisu ho replikovat na cíl |
| `matchOn` | `package` / `path` / `url` | s čím se maska porovnává: cesta balíčku `/@scope/name` (i pro tarbally), cesta v repozitáři, nebo celá URL včetně query |
| `matchType` | `prefix` / `glob` / `regex` / `contains` / `exact` | typ masky (`glob`: `*` v rámci segmentu, `**` přes segmenty, `?`) |
| `pattern` | text | maska; prázdná = vše |
| `repo` / `repoType` | název nebo `*` / `npm`, `generic`, `*` | omezení na repozitář |
| `key` | text | pravidlo platí jen pro požadavky s tímto klíčem |
| `header` | `{name, pattern}` | podmínka na hlavičku požadavku (regex), např. `user-agent` ~ `^yarn` |
| `methods` | `GET,HEAD,…` | metody (pro `npm audit` přidejte `POST`) |
| `target` | URL | cílový registr |
| `stripPrefix` / `addPrefix` | cesta | úprava cesty před přeposláním |
| `headers` | objekt | hlavičky pro upstream (např. `Authorization` k privátnímu registru) |
| `cacheTtl` | sekundy / prázdné | platnost cache metadat (0 = necachovat), prázdné = výchozí z nastavení; u git pull-through doba, po které se zrcadlo obnoví |
| `token` / `username` | text | přihlášení k cíli (git: Basic `x-access-token:<token>`, npm/generic: `Authorization: Bearer`); API ho vrací jako `***` |
| `replicateDeletes` | true/false | push pravidla pro generic: replikovat i mazání |
| `gitMode` | `mirror` / `branches` | push pravidla pro git: všechny refy včetně mazání, nebo jen větve a tagy |
| `createMissing`, `private` | true/false | push pravidla pro git na GitHub: vytvořit chybějící repozitář (privátní) |

Tarbally se cachují s `tarballTtl` (výchozí 30 dní). V metadatech (packument) se URL tarballů přepisují
tak, aby šly přes tento registr – při stejném hostiteli jako `target` na běžnou cestu `/<balíček>/-/<soubor>.tgz`,
jinak na podepsanou URL `/-/rr/t/<pravidlo>/<podpis>/<url>` (nelze ji zneužít jako otevřenou proxy).

## Push pravidla – automatická replikace na vzdálený server

Pravidlo `when=push` se nevyhodnocuje při čtení. Spouští se po každém úspěšném zápisu do odpovídajícího repozitáře a cesty:

| Událost | Co se odešle |
|---|---|
| `npm publish` / upload balíčku | publikovaná verze → `PUT <target>/<balíček>` (npm protokol, token jako Bearer) |
| generic upload / smazání | `PUT` / `DELETE <target><cesta>` (mazání jen s `replicateDeletes=true`) |
| `git push` | `git push --mirror <target>/<název>.git` (nebo jen větve a tagy), volitelně vytvoří repozitář na GitHubu |

Replikace běží ve frontě na pozadí (2 souběžně). Neúspěšný pokus se opakuje 3× (po 10 s, 20 s), pak vznikne událost
`replication.failed` (lze ji poslat webhookem). Přehled: `rr replication list`, Web GUI → ⏱ Úlohy, `GET /api/v1/replications`.

```bash
# vše publikované do repozitáře "internal" zkopírovat i do druhého (záložního) registru
rr route add name=zaloha when=push repo=internal target=https://registry2.firma.cz token=rr_xxx
# buildy z generic repozitáře na vzdálený server, včetně mazání
rr route add name=buildy when=push repo=files matchOn=path pattern=/release/ target=https://files.firma.cz/r/files token=rr_xxx replicateDeletes=true
# git repozitáře týmu automaticky na GitHub (repozitáře se tam vytvoří)
rr route add name=github-out when=push repoType=git matchType=glob pattern='/firma/**' target=https://github.com token=ghp_xxx createMissing=true
```

## Git repozitáře

Pro repozitáře typu git znamená `notfound` / `always` **pull-through klonování**. Neexistující repozitář se při prvním
`git clone` naklonuje z `<target>/<název>.git` a uloží jako zrcadlo (jen pro čtení). Další klony a fetche se obslouží
lokálně a kopie se obnoví, když je starší než `cacheTtl`. Viz [GIT.md](GIT.md).

```bash
rr route add name=github-in repoType=git when=notfound target=https://github.com cacheTtl=600
git clone http://localhost:4873/git/octocat/Hello-World.git
```

## Příklady

```bash
# výchozí: co není lokálně, vezmi z npmjs.org (vytvoří se při prvním startu)
rr route add name=npmjs-fallback when=notfound target=https://registry.npmjs.org methods=GET,HEAD,POST priority=1000

# firemní scope vždy z interního registru s autentizací
rr-web createRoute --body '{"name":"corp","when":"always","matchType":"prefix","pattern":"/@corp/",
  "target":"https://npm.corp.example","headers":{"Authorization":"Bearer xxx"},"cacheTtl":60,"priority":10}'

# klíč: npm config set registry http://localhost:4873/~mirror/  → vše přes zrcadlo
rr route add name=mirror key=mirror when=always target=https://registry.npmmirror.com priority=5

# regex na část URL
rr route add name=react when=notfound matchType=regex pattern='^/(react|react-dom)$' target=https://registry.yarnpkg.com priority=50

# generic repozitář jako zrcadlo souborů: /r/files/nodejs/** → https://nodejs.org/dist/**
rr route add name=nodejs-dist repo=files matchOn=path matchType=glob pattern='/nodejs/**' \
   stripPrefix=/nodejs target=https://nodejs.org/dist cacheTtl=86400

# otestování
rr route test /@corp/utils
rr route test /react npm "" GET
```

## Cache

| Operace | CLI | API |
|---|---|---|
| statistiky | `rr cache stats` | `GET /api/v1/cache` |
| výpis | `rr cache list [filtr]` | `GET /api/v1/cache/entries?q=` |
| smazat expirované | `rr cache purge --expired` | `DELETE /api/v1/cache?expired=1` |
| smazat dle URL | `rr cache purge lodash` | `DELETE /api/v1/cache?q=lodash` |
| smazat vše | `rr cache purge` | `DELETE /api/v1/cache` |

Odpovědi nesou hlavičky `X-RR-Cache: HIT|MISS|STALE|BYPASS` a `X-RR-Route: <pravidlo>`.

## Vlastní pluginy

Soubor `data/plugins/muj.js`:

```js
module.exports = {
  name: 'muj',
  description: 'Příklad pluginu',
  create(app) {
    return {
      async beforeLocal(ctx) {            // ctx: req, res, repo, path, pkgPath, key, base, ...
        if (ctx.path === '/-/hello') { ctx.res.end('hi'); return true; }
        return false;
      },
      async onNotFound(ctx) { return false; },
    };
  },
};
```

Zapnutí: Web GUI → Nastavení → Pluginy, nebo `rr settings set 'plugins=["router","muj"]'`.

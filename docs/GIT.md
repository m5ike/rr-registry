# Git repozitáře, zrcadla a GitHub

Repozitář typu **`git`** hostuje bare git repozitáře a obsluhuje je git smart HTTP protokolem
(`git clone`, `fetch`, `pull`, `push`, protokol v2, částečné klony). Server k tomu používá `git http-backend`.
Docker image ho obsahuje (balíčky `git` a `git-daemon`), při spuštění bez Dockeru musí být git nainstalovaný.

## Adresy

| URL | Repozitář |
|---|---|
| `http://HOST:4873/git/<název>.git` | výchozí git repozitář (nastavení `gitRepo`, výchozí `git`) |
| `http://HOST:4873/r/<repo>/<název>.git` | libovolný repozitář typu git |

`<název>` může obsahovat lomítka (`tym/projekt`, max. 4 úrovně) a přípona `.git` je volitelná.
Když URL otevřete v prohlížeči, přesměruje vás do Web GUI.

```bash
git remote add rr http://localhost:4873/git/tym/projekt.git
git push rr main                       # první push repozitář vytvoří (autoCreate, role publisher+)
git clone http://localhost:4873/git/tym/projekt.git
```

Přihlášení probíhá přes HTTP Basic. Použít můžete:

- jméno a heslo uživatele,
- jméno a token (`rr_…`),
- libovolné jméno a jako heslo `RR_API_TOKEN`.

Čtení je anonymní, pokud je repozitář veřejný a v nastavení je povolené `anonymousRead`. Push vyžaduje roli publisher nebo admin, případně ACL `publish`.

Příklad pro git credential store:

```bash
git config --global credential.http://localhost:4873.username admin
```

## Správa repozitářů

| Akce | bash CLI | API |
|---|---|---|
| seznam | `rr git list git` | `GET /api/v1/repos/git/git` |
| nový prázdný | `rr git create git tym/projekt "Popis"` | `POST /api/v1/repos/git/git` `{name}` |
| detail (větve, tagy, zrcadla) | `rr git show git tym/projekt` | `GET …/git/tym%2Fprojekt` |
| commity | `rr git log git tym/projekt main 20` | `GET …/commits?ref=&limit=` |
| soubory | `rr git ls git tym/projekt main src` | `GET …/tree?ref=&path=` |
| obsah souboru | `rr git cat git tym/projekt README.md main` | `GET …/blob?ref=&path=` |
| archiv | `rr git archive git tym/projekt v1.0 out.tgz` | `GET …/archive?ref=&format=tar.gz\|zip` |
| chráněné větve | `rr git protect git tym/projekt main,release/*` | `PUT …` `{protectedBranches}` |
| výchozí větev / popis | – | `PUT …` `{defaultBranch, description}` |
| smazání | `rr git rm git tym/projekt` | `DELETE …` |

Ve Web GUI je sekce **🌿 Git**: seznam repozitářů, import, detail s výběrem větve nebo tagu, prohlížeč souborů s náhledem README, historie commitů, větve a tagy, stahování archivů a karta „Zrcadla a nastavení“.
V bash GUI (`rr-gui`) najdete totéž v menu **G – Git repozitáře**.

**Chráněné větve** (glob vzory jako `main`, `release/*`, `refs/tags/*`) nepovolují force-push ani smazání. Zajišťuje to `pre-receive` hook, který server do každého repozitáře instaluje.
**Neměnný repozitář** (`immutable`) zakazuje přepis a mazání všech refů a mazání repozitářů přes API.

## Pull zrcadlo (kopie vzdáleného repozitáře)

```bash
# jeden repozitář (token jen pro privátní repozitáře)
rr git import git octocat/Hello-World https://github.com/octocat/Hello-World.git --interval 3600
rr git import git firma/api https://github.com/firma/api.git --token ghp_xxx

# hromadně celá organizace / uživatel / moje repozitáře
rr git github git moje-org --token ghp_xxx --filter 'api-*' --limit 100
rr git github git --mine --token ghp_xxx
```

Zrcadlo je jen pro čtení (push se odmítne) a aktualizuje se několika způsoby:

- **plánovaně** po `interval` sekundách (úloha `git-mirrors`, 0 = jen ručně),
- **při přístupu**: `git clone/fetch` starší kopie než `ttl` sekund nejdřív stáhne změny,
- **ručně**: `rr git sync git octocat/Hello-World pull`, Web GUI → „Synchronizovat teď“,
- **webhookem z GitHubu**: `rr git show` vypíše URL `…/-/rr/hooks/git/<repo>/<název>` a secret.
  Na GitHubu je zadejte v Settings → Webhooks (Content type JSON, Secret). Podpis `X-Hub-Signature-256` se ověřuje.
  Funguje i GitLab (`X-Gitlab-Token`) nebo `?secret=`.

Zrušení zrcadla, po kterém z něj bude běžný repozitář: `rr git mirror git <název> off`.
Pro existující repozitář zrcadlo nastavíte přes `rr git mirror git <název> <url> --token T`.

## Push zrcadla (automatické odesílání na vzdálený server)

Po každém úspěšném `git push` do registru se repozitář odešle na nastavená push zrcadla:

```bash
rr git push-mirror add git tym/projekt https://github.com/firma/projekt.git --token ghp_xxx --create
rr git sync git tym/projekt push          # okamžitě
rr git push-mirror rm git tym/projekt <id>
```

- `--create`: když repozitář na GitHubu neexistuje, vytvoří se přes GitHub API (u uživatele nebo organizace, výchozí je privátní; `--public` vytvoří veřejný).
- `--branches`: odesílá jen větve a tagy (`--force`). Výchozí `mirror` odesílá všechny refy včetně mazání.
- Stav posledního odeslání a případná chyba se zobrazí v `rr git show` a ve Web GUI.

## Směrování pro git (routing plugin)

Pravidla routovacího pluginu fungují i pro git repozitáře (`repoType=git`):

* **`notfound` / `always` – pull-through klonování.** Klon neexistujícího repozitáře se automaticky naklonuje z `target/<název>.git`, uloží se jako zrcadlo a pak se obslouží lokálně. Kopie se obnoví, když je starší než `cacheTtl`.
  ```bash
  rr route add name=github repoType=git when=notfound target=https://github.com cacheTtl=600
  git clone http://localhost:4873/git/torvalds/linux.git       # první klon stáhne z GitHubu
  ```
* **`push` – automatická replikace.** Po každém push do odpovídajícího repozitáře se změny odešlou na `target/<název>.git`. Kopie se tak vytváří automaticky, pro všechny repozitáře podle masky.
  ```bash
  rr route add name=to-github when=push repo=git matchType=glob pattern='/firma/**' \
     target=https://github.com token=ghp_xxx createMissing=true
  rr replication list
  ```
  Repozitář `firma/api` se pošle na `https://github.com/firma/api.git`. Úlohy běží ve frontě a selhání se 3× opakuje. Po posledním neúspěchu vznikne událost `replication.failed` a úlohu lze spustit znovu (`rr replication retry <id>`).

## Události

Akce v git repozitářích generují události `git.create`, `git.push` (seznam změněných refů), `git.sync` a `git.delete`.
Ty lze posílat webhookem (viz [ADVANCED.md](ADVANCED.md)).

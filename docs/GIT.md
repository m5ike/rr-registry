# Git repozitáře, zrcadla a GitHub

Repozitář typu **`git`** hostuje bare git repozitáře a obsluhuje je git smart HTTP protokolem
(`git clone`, `fetch`, `pull`, `push`, protokol v2, částečné klony). Server k tomu používá `git http-backend`.
Docker image ho obsahuje (balíčky `git` a `git-daemon`), při spuštění bez Dockeru musí být git nainstalovaný.

## Adresy

| URL | Repozitář |
|---|---|
| `http://HOST:4873/git/<název>.git` | výchozí git repozitář (nastavení `gitRepo`, výchozí `git`) |
| `http://HOST:4873/r/<repo>/<název>.git` | libovolný repozitář typu git |
| `http://git-registry.<doména>/<název>.git` | výchozí git repozitář na vlastním hostu typu (bez `/git`) |
| `ssh://git@HOST:2222/<název>.git` | git přes SSH (`RR_SSH_PORT`), jiný repozitář: `ssh://git@HOST:2222/r/<repo>/<název>.git` |

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

### Host typu git a webové rozhraní (1.7)

Na hostu `git-registry.<doména>` (viz [PORTAL.md](PORTAL.md)) je jen git: webové rozhraní ve stylu GitHubu
s adresami bez typu registru – `git-registry.<doména>/<vlastník>/<název>`, `…/tree/<větev>/<cesta>`,
`…/blob/<větev>/<soubor>`, `…/commits/<větev>`, `…/releases`, `…/settings` – a klonování z
`git-registry.<doména>/<vlastník>/<název>.git`. Omylem přidané `/git/` v URL host toleruje.
Veřejné repozitáře lze procházet i bez přihlášení. Plná administrace celého registru je na hlavní adrese
`registry.<doména>/admin/`, kde je typ součástí cesty (`#/git/<repo>/<vlastník>/<název>`).

### SSH (1.7)

Server má vlastní SSH server pro git (bez závislostí): `RR_SSH_PORT` (výchozí v Dockeru a `.env.example` 2222, `0` = vypnuto),
pro URL za NATem `RR_SSH_PUBLIC_HOST` / `RR_SSH_PUBLIC_PORT`. Podporuje klíče ssh-ed25519, ecdsa-sha2-nistp256/384/521
a RSA (rsa-sha2-256/512), přihlášení heslem / tokenem a protokol v2. Oprávnění jsou stejná jako přes HTTPS.

```bash
rr ssh-key add ~/.ssh/id_ed25519.pub laptop        # nebo Web GUI → Můj účet a SSH klíče
git clone ssh://git@registry.firma.cz:2222/tym/projekt.git
ssh -p 2222 git@registry.firma.cz                  # „Hi <uživatel>! You've successfully authenticated…“
```

Klíč serveru (`data/config/ssh_host_ed25519_key`) se vytvoří při prvním startu; jeho otisk je v logu.

### Viditelnost, vlastník a spolupracovníci (1.7)

| | Kdo |
|---|---|
| **veřejný** repozitář | čte každý s právem čtení v úložišti, zapisuje role publisher+ |
| **soukromý** repozitář | jen vlastník, spolupracovníci a administrátoři; ostatním se jeví jako neexistující |
| **vlastník** | `owner/…` z názvu, jinak autor; má práva správce repozitáře (nastavení, přesun, smazání) |
| **spolupracovníci** | `read` / `write` / `admin` – `PUT …/access {collaborators: {bob: "write"}}` |

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
| nový jako na GitHubu | `rr git create git tym/projekt --private --readme --gitignore Node --license MIT` | `POST …` `{name, visibility, readme, gitignore, license}` |
| přejmenovat / přesunout | `rr git mv git tym/projekt tym/novy [git2]` | `POST …/move` `{name, repo}` |
| viditelnost / spolupracovníci | `rr git visibility …` · `rr git collab … bob write` | `PUT …/access` |
| větve | `rr git branch git tym/projekt create dev main` · `rename` · `default` · `protect` · `rm` | `GET …/branches?detailed=1`, `POST …/branches`, `PATCH …/branches/<větev>` `{name, default, protected}`, `DELETE` |
| tagy | `rr git tag git tym/projekt create v1.0 main "zpráva"` | `GET/POST …/tags`, `DELETE …/tags/<tag>` |
| releases | `rr git release git tym/projekt create v1.0 "Verze 1" --notes` · `upload 1 app.zip` | `…/releases`, `…/releases/<id>/assets?name=`, `…/releases/latest`, `…/releases/tags/<tag>` |
| soubor commitem | `rr git put git tym/projekt docs/a.md a.md main` | `PUT …/contents` `{path, content, encoding, branch, sha}`, `POST …/commit-files`, `DELETE …/contents?path=` |
| detail commitu | `rr git commit git tym/projekt <sha>` | `GET …/commits/<sha>` |
| smazání | `rr git rm git tym/projekt` | `DELETE …` |

Přejmenovaný nebo přesunutý repozitář je dál dostupný i pod starou adresou (clone, fetch, push) – dokud
staré jméno nepoužije nový repozitář. Výchozí větev, která v repozitáři neexistuje (např. první push `master`
do repozitáře s HEAD → `main`), server opraví automaticky.

Ve Web GUI je sekce **🌿 Git** ve stylu GitHubu: seznam repozitářů, **nový repozitář** (vlastník, viditelnost,
README / .gitignore / licence), u prázdného repozitáře **Rychlé nastavení** s HTTPS / SSH adresou a příkazy,
kód s vykresleným **README** (Markdown s odkazy na další dokumenty, obrázky z repozitáře a kotvami), soubory
s čísly řádků a náhledem Markdownu, **úpravy, nové soubory a nahrávání** přímo z prohlížeče (commit do větve
nebo nové větve), historie commitů s **diffy**, **větve** (před/za výchozí větví, přejmenování, ochrana),
**tagy**, **releases** s poznámkami a soubory, pull requesty a issues a **nastavení** (přejmenování, přesun,
viditelnost, spolupracovníci, ochrana větví, zrcadla, smazání).
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

## Pull requesty a issues

Každý git repozitář má **pull requesty** a **issues** s komentáři. API používá názvy polí GitHub REST API,
takže klient napsaný pro GitHub (např. ovladač AgentConf) s RR Registry funguje beze změn – jen s jinou základní URL
`/api/v1/repos/<repo>/git/<název>` (název s lomítky URL-kódovaný, `tym%2Fprojekt`). Server podporu ohlašuje
v `GET /api/v1/status` a `GET /api/v1/auth/whoami` polem `features: ["git.branches", "git.pulls", "git.issues"]`.

| Akce | API (`…/repos/git/git/tym%2Fprojekt`) | Oprávnění |
|---|---|---|
| větve (tvar GitHubu) | `GET …/branches` → `[{name, commit: {sha}, protected}]` | read |
| seznam PR | `GET …/pulls?state=open\|closed\|all&head=owner:větev&base=main` | read |
| nový PR | `POST …/pulls` `{title, head, base, body, draft}` | publish |
| detail PR + slučitelnost | `GET …/pulls/<n>` → `mergeable`, `mergeable_state: clean\|dirty\|unknown` | read |
| úprava / zavření PR | `PATCH …/pulls/<n>` `{title, body, state, base}` | publish |
| sloučení | `PUT …/pulls/<n>/merge` `{merge_method: merge\|squash\|rebase, commit_title, commit_message}` | publish |
| issues | `GET …/issues?state=&labels=a,b`, `POST …/issues` `{title, body, labels}` | read / publish |
| detail / úprava issue | `GET …/issues/<n>`, `PATCH …/issues/<n>` `{title, body, state, labels}` | read / publish |
| komentáře (issue i PR) | `GET/POST …/issues/<n>/comments` `{body}`, alias `…/pulls/<n>/comments` | read / publish |

* Pull requesty a issues sdílejí **jednu číselnou řadu** v rámci git repozitáře (od 1), stejně jako na GitHubu.
  `GET …/issues/<n>` funguje i pro číslo pull requestu, seznam issues pull requesty nevrací.
* `head` může být ve tvaru GitHubu `owner:větev` – porovnává se jen část za posledním `:`.
  Duplicitní PR server neodmítá (klient si existující otevřený PR hledá sám).
* `head.sha` a `base.sha` se počítají z aktuálních větví. Když se větev head smaže, zůstane poslední známé sha.
  Sloučený PR si pamatuje sha z okamžiku sloučení a `merge_commit_sha`.
* **Slučitelnost** se zjišťuje zkušebním sloučením přímo v bare repozitáři bez změny refů
  (`git merge-tree --write-tree`, git ≥ 2.40; starší git: dočasný index + `git merge-one-file`).
* **Sloučení** probíhá na serveru (`commit-tree` + `update-ref` s původní hodnotou jako compare-and-swap):
  * `merge` – merge commit s rodiči [base, head] a zprávou `Merge pull request #N from <head>` + název PR (nebo `commit_title`),
  * `squash` – jeden commit s jedním rodičem, zpráva `commit_title` nebo `<název> (#N)`,
  * `rebase` – commity `base..head` se přehrají na base jeden po druhém (autor a zpráva zůstávají); když je base předkem head, jen se posune (fast-forward).

  Autorem merge/squash commitu je přihlášený uživatel, committerem `RR Registry <rr@localhost>`
  (změníte proměnnými `RR_GIT_COMMITTER_NAME` a `RR_GIT_COMMITTER_EMAIL`).
  Sloučení do chráněné větve je povolené (jde o schválené sloučení, ne o force-push); do zrcadla sloučit nelze.
* Chyby mají tělo `{error, message}`: **422** neplatný vstup (větev neexistuje, head = base, chybí název),
  **405** nelze sloučit (zavřený nebo už sloučený PR, konflikt), **409** základní větev se během slučování změnila –
  stačí zopakovat, žádná změna se neztratí.
* Data se ukládají do `rr-pulls.json` v adresáři bare repozitáře – smažou se s repozitářem a export/import
  obsahu repozitářů ([TRANSFER.md](TRANSFER.md)) je přenáší s ním.

```bash
R=http://localhost:4873/api/v1/repos/git/git/tym%2Fprojekt
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"title":"Nová funkce","head":"feature","base":"main"}' $R/pulls
curl -s -H "Authorization: Bearer $TOKEN" $R/pulls/1 | grep mergeable
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"merge_method":"squash"}' $R/pulls/1/merge
```

Ve Web GUI má detail git repozitáře karty **Pull requesty** a **Issues**: seznam s filtrem stavu (a štítků),
detail se slučitelností a komentáři, formuláře pro založení, tlačítko **Sloučit** s volbou merge / squash / rebase
a zavření / znovuotevření. Odkazy `html_url` z API vedou přímo sem (`/admin/#/git/<repo>/<název>/pulls/<n>`).

## Události

Akce v git repozitářích generují události `git.create`, `git.push` (seznam změněných refů – i po sloučení PR, commitu z webu, změně větví a tagů; `via`), `git.sync`, `git.move`, `git.release` a `git.delete`,
pro pull requesty a issues `git.pull.opened`, `git.pull.closed`, `git.pull.reopened`, `git.pull.merged`,
`git.issue.opened`, `git.issue.closed`, `git.issue.reopened` a `git.comment`.
Ty lze posílat webhookem (viz [ADVANCED.md](ADVANCED.md)).

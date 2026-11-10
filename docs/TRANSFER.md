# Export a import (šifrovaný přenos registru)

V administraci v sekci **Nastavení → Export / Import** (dále v `rr export|import`, `rr-gui` → X a v API `/api/v1/exports`
a `/api/v1/imports`) lze přenést celý registr nebo jeho části na jiný server, do zálohy nebo do pracovní složky.
Všechny operace jsou jen pro administrátory.

## Co se exportuje – a v jakém pořadí

Sekce se exportují i importují vždy v tomto pořadí, každá smí záviset jen na předchozích:

| # | Sekce | Obsah | Tajné |
|---|---|---|---|
| 1 | `server` | administrátor, heslo administrátora, API token, veřejná URL | ano |
| 2 | `secret` | podpisový klíč (HMAC pro podepsané URL tarballů) | ano |
| 3 | `plugins` | vlastní pluginy `data/plugins/*.js` | |
| 4 | `users` | uživatelé, role, hashe hesel | ano |
| 5 | `tokens` | API/npm tokeny (hashe) – závisí na uživatelích | ano |
| 6 | `repos` | konfigurace repozitářů (typ, ACL, kvóty, retence); skupiny až po svých členech | |
| 7 | `content` | obsah repozitářů – npm balíčky, Docker vrstvy, git repozitáře (vč. hooků), soubory | |
| 8 | `routes` | směrovací pravidla vč. tokenů pro cílové servery | ano |
| 9 | `webhooks` | webhooky vč. tajných klíčů | ano |
| 10 | `settings` | nastavení serveru – odkazuje na repozitáře a pluginy | |
| 11 | `stats` | statistiky stahování | |
| 12 | `audit` | audit log | |
| 13 | `cache` | cache vzdálených registrů (ve výchozím stavu se neexportuje, lze ji obnovit stažením) | |

Exportovat lze celé sekce nebo jen vybrané položky (konkrétní repozitáře, uživatele, pravidla…).
Konfigurace portálu (`PORTAL_*`) se neexportuje – patří k nasazení, ne k datům registru.

## Šifrování

Soubor `.rrx` je vždy šifrovaný heslem (min. 8 znaků): klíč se odvodí funkcí **scrypt** (N=32768, r=8, p=1, náhodná sůl)
a data se šifrují **AES-256-GCM**. Hlavička souboru (verze, datum, parametry KDF) je ověřená jako AAD, takže soubor
nelze nepozorovaně změnit – špatné heslo i poškozený soubor import odmítne. Uvnitř je komprimovaný tar zapisovaný proudově,
takže velikost exportu není omezená pamětí.

Exporty se ukládají do `data/exports/` (stažení v UI / `rr export download`), dočasná data importu do `data/imports/<id>/`
(oprávnění 0600, rozšifrovaná data se mažou po dokončení importu, nedokončené importy po 24 h).

## Import krok za krokem

1. **Nahrání** souboru (`rr import file soubor.rrx`) nebo **vzdálený import** (viz níže).
2. **Odemčení heslem** – server rozšifruje balík a sestaví **plán**: jedna operace na položku, v pevném pořadí.
3. **Plán** ukazuje pro každou operaci akci (`vytvořit`, `přepsat`, `sloučit` obsah, `přeskočit`, `rozbalit`),
   cílovou cestu, velikost, **závislosti** a varování:
   - token potřebuje svého uživatele, obsah repozitáře jeho konfiguraci, skupina své členy, pravidlo a nastavení
     odkazované repozitáře, nastavení zapnuté pluginy;
   - závislost je splněná, když je vybraná v importu nebo už existuje na cílovém serveru; jinak je operace **blokovaná**;
   - **Doplnit chybějící závislosti** vybere potřebné položky z exportu automaticky.
4. **Výběr** – zaškrtněte operace / celé sekce. Volby:
   - *Když položka už existuje*: ponechat (přeskočit) nebo přepsat/sloučit; lze změnit i pro jednotlivé operace;
   - *přejmenování repozitáře* – obsah se importuje pod novým názvem;
   - *cíl*: **do běžícího registru**, nebo **do workspace** – `data/workspaces/<cesta>/`, jen rozbalí soubory bez změny
     konfigurace (kontrola, ruční migrace).
5. **Potvrzení cest** – plán vypíše všechny cílové cesty, import se spustí až po jejich potvrzení.
6. **Spuštění** – operace se provedou v pořadí; když selže závislost, závislé operace se neprovedou. Výsledek každé
   operace je vidět v plánu.

Import sekce `server` platí ihned a uloží se do `data/config/server.json`, který má přednost před `.env` (i po restartu).
Kdo byl přihlášen starým API tokenem, bude odhlášen.

## Vzdálený import z URL

- **jiný RR Registry** (`mode: server`): zadejte URL serveru, jeho administrátorský API token a heslo – cílový server si
  u zdroje vyžádá nový export, stáhne ho a export na zdroji smaže;
- **URL souboru** (`mode: file`): libovolná http(s) adresa souboru `.rrx` (volitelně s tokenem).

Operace vzdáleného importu jsou na začátku **neschválené** – každou je nutné **schválit** (jednotlivě, nebo „Schválit
všechny vybrané“ s potvrzením). Neschválené operace import nespustí.

## Příkazová řádka

```bash
rr export sections                                   # co lze exportovat
rr export create users,repos,content --note záloha   # heslo se zeptá (nebo RR_PASSPHRASE)
rr export list && rr export download <id> zaloha.rrx

rr import file zaloha.rrx                            # nahraje a odemkne, vypíše plán
rr import select <id> users=off repos:internal=on
rr import set <id> conflict=overwrite rename.internal=internal-old
rr import set <id> target=workspace path=kontrola
rr import deps <id>
rr import run <id> --confirm-paths

rr import url https://registry2.firma.cz --server --token <admin-token>
rr import approve <id> --all && rr import run <id> --confirm-paths
```

## API

| Operace | Metoda a cesta |
|---|---|
| sekce k exportu | `GET /api/v1/transfer/sections` |
| vytvořit export | `POST /api/v1/exports` `{passphrase, sections, items, note}` |
| seznam / stažení / smazání | `GET /api/v1/exports`, `GET /api/v1/exports/:id/download`, `DELETE /api/v1/exports/:id` |
| nahrát export | `POST /api/v1/imports` (tělo = soubor) |
| vzdálený import | `POST /api/v1/imports/remote` `{url, mode, token, passphrase, sections}` |
| odemknout | `POST /api/v1/imports/:id/unlock` `{passphrase}` |
| plán | `GET /api/v1/imports/:id` |
| výběr, schválení, volby | `PUT /api/v1/imports/:id` `{select, approve, revoke, includeDependencies, conflict, overrides, renames, target}` |
| spustit | `POST /api/v1/imports/:id/run` `{confirmPaths: true}` |
| zahodit | `DELETE /api/v1/imports/:id` |

Maximální velikost importovaného souboru: `RR_IMPORT_MAX_MB` (výchozí 20480 MB).

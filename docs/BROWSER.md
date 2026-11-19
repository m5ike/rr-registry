# Veřejný prohlížeč repozitářů

Každý repozitář (npm, Docker, git, generic i skupina) má anonymní HTML zobrazení – bez přihlášení, pokud je repozitář
veřejný (jinak s přihlášením nebo přes portál). Zobrazuje obsah a **README.md**:

| Typ | Co prohlížeč ukazuje |
|---|---|
| generic | adresáře a soubory, README.md každého adresáře, náhled textu / Markdownu / obrázků, stažení |
| npm | balíčky → verze (tarbally ke stažení), README balíčku, příkaz `npm install … --registry …`, dist-tagy |
| docker | image → tagy, příkazy `docker pull` |
| git | repozitáře → soubory výchozí větve, README, `git clone` přes HTTPS i SSH, stažení souborů a archivů |
| group | obsah členů (npm nebo generic) |

V kořeni může být navíc **úvodní text** repozitáře (Markdown, nastavení „Texty“).

## Adresy (masky URL)

```
http(s)://<typ>-{registry|rr}.<doména>/[<repozitář>/]<cesta>     host typu (bez názvu = výchozí repozitář typu)
http(s)://<repozitář>.<typ>.{registry|rr}.<doména>/<cesta>      host repozitáře
http(s)://{registry|rr}.<doména>/<typ>/[<repozitář>/]<cesta>      hlavní adresa
http(s)://{registry|rr}.<doména>/r/<repozitář>/<cesta>            (dosavadní adresa repozitáře)
```

Např. `https://generic-registry.firma.cz/files/builds/`, `https://files.generic.rr.firma.cz/builds/`,
`https://registry.firma.cz/generic/files/builds/`. Stránku dostane jen prohlížeč (`Accept: text/html`); klienti
(npm, git, curl, Docker) na stejných adresách pracují jako dřív – host repozitáře se pro ně chová jako `/r/<repozitář>/`.
Host typu **git** zůstává plnou aplikací ve stylu GitHubu (`git-registry.<doména>/<vlastník>/<název>`), prohlížeč
git repozitářů je na hostu repozitáře a na hlavní adrese. Administrace je jen na hlavní adrese (`/admin/`).
V portálu AI Tools jsou `rr` alias aplikace `registry` a hosty repozitářů subdomény (`**.registry.<doména>`).

## Vzhled a pravidla

Administrace → **Repozitáře → detail → Veřejný prohlížeč → Upravit vzhled a pravidla** (s živým náhledem),
API `PUT /api/v1/repos/<repo>` `{browser: {...}}`, `GET /api/v1/repos/<repo>/browser` (nastavení, volby, adresy).

| Oblast | Nastavení |
|---|---|
| Vzhled | nadpis, podnadpis, logo (URL nebo nahraný obrázek do 300 kB), hlavička (lišta, velký banner, jen nadpis, žádná), režim (podle systému / světlý / tmavý), barevné varianty (amber, ocean, forest, grape, rose, sunset, teal, slate, mono) nebo vlastní barva, písma z Google Fonts (text, nadpisy, kód), styl tlačítek (zaoblená, pill, hranatá, obrysová, jemná), zaoblení rohů, hustota |
| Zobrazení | výchozí a povolená zobrazení – **řádky, náhled** (miniatury obrázků), **bloky, detail** (tabulka) –, zobrazované detaily (velikost, datum, typ, verze, popis), hledání, řazení (název, datum, velikost, typ) a zda ho smí měnit návštěvník, README, náhled souborů, příkazy instalace, skryté soubory |
| Stahování | výběr více položek a stažení jako **ZIP, tar.gz nebo tar.bz2**, **omezení rychlosti** (kB/s pro každé stažení z prohlížeče; klienti registru omezeni nejsou) |
| Filtr | masky souborů **deny** (skrýt odpovídající) nebo **allow** (zobrazit jen odpovídající): `*` znaky kromě `/`, `**` cokoli, `?` jeden znak; maska bez `/` platí pro název kdekoli, `adresář/` pro celý adresář. Filtr platí i pro stažení a archivy. |
| Texty | úvod v Markdownu, patička |

Návštěvník si může přepnout zobrazení, řazení a světlý / tmavý režim (pamatuje si je prohlížeč).

## Data pro stránku

| Volání | |
|---|---|
| `GET /-/rr/browse/<repo>/list?path=/` | výpis, README, informace (instalace, clone, pull), formáty archivu; u souboru `kind: file` |
| `GET /-/rr/browse/<repo>/raw?path=<cesta>[&inline=1]` | jeden soubor (filtr, omezení rychlosti) |
| `GET|POST /-/rr/browse/<repo>/archive` `format=zip|tar.gz|tar.bz2`, `p=<cesta>` (víckrát), `base=<adresář>` | archiv výběru (adresáře rekurzivně, nejvýše 5000 souborů / 2 GB) |

tar.bz2 potřebuje program `bzip2` (v Docker image je).

## Přístupová práva v nástroji

Formulář repozitáře má u pole **Přístupová práva** tlačítko, které otevře nástrojové okno: seznam uživatelů
(našeptávání existujících účtů) s volbou *bez přístupu / čtení / čtení a zápis*, hromadné nastavení a náhled výsledku.
**Uložit** přepíše text v poli (`alice:publish,bob:read`); formulář se uloží až tlačítkem formuláře.

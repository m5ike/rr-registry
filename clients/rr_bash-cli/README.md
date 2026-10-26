# @m5ike/rr_bash-cli — `rr`

Příkazový řádek pro správu **RR Registry** napsaný v bashi. Veškerá volání jdou přes
generovanou knihovnu `lib/rr-api.sh` (vzniká při sestavení serveru z `api/spec.json`).
Maintainer: **m5ike**.

Závislosti: `bash ≥ 4`, `curl`; doporučeno `jq` (tabulkový výpis) a `column`.

## Instalace

```bash
# z běžícího registru (instalátor do ~/.local)
curl -fsSL http://localhost:4873/install.sh | bash -s -- rr_bash-cli
# nebo přes npm
npm install -g @m5ike/rr_bash-cli --registry http://localhost:4873/
```

## Příklady

```bash
rr config server http://localhost:4873
rr login admin                       # nebo: rr config token <RR_API_TOKEN>
rr status
rr repo create internal npm "Interní balíčky"
rr pkg publish internal ./my-lib-1.0.0.tgz
rr pkg list internal
rr fs tree files / 3
rr route add name=corp when=always matchType=prefix pattern=/@corp/ target=https://npm.corp.example
rr route test /@corp/utils
rr cache purge --expired
rr npmrc >> ~/.npmrc
rr help
```

Knihovnu lze použít i samostatně ve vlastních skriptech:

```bash
source "$(dirname "$(readlink -f "$(command -v rr)")")/../lib/rr-api.sh"
RR_SERVER=http://localhost:4873 RR_TOKEN=... rr_api_list_repos
```

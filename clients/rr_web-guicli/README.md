# @m5ike/rr_web-guicli — `rr-web`

Webové grafické rozhraní pro správu **RR Registry** + příkazová řádka v Node.js.
Obsahuje stejné Web GUI, jaké server nabízí na `/admin/`, ale lze ho spustit lokálně
proti libovolnému (i vzdálenému) serveru – API požadavky se proxují, takže není potřeba CORS.
Všechna volání jdou přes generovanou knihovnu `lib/rr-client.js` (`@m5ike/rr-client`).
Maintainer: **m5ike**.

## Instalace

```bash
npm install -g @m5ike/rr_web-guicli --registry http://localhost:4873/
# nebo
curl -fsSL http://localhost:4873/install.sh | bash -s -- rr_web-guicli
```

## Web GUI

```bash
rr-web serve --server http://registry.example:4873 --port 8090 --open
```

## CLI

Každá operace API je zároveň příkazem (`rr-web ops` je vypíše):

```bash
rr-web config server http://localhost:4873
rr-web login admin
rr-web status
rr-web listRepos
rr-web createRepo --body '{"name":"internal","type":"npm"}'
rr-web uploadPackage internal --data ./my-lib-1.0.0.tgz
rr-web listPackages internal --query q=lib
rr-web createRoute --body @route.json
rr-web purgeCache --query expired=1
```

Konfigurace se sdílí s bash klienty (`~/.config/rr/config`).

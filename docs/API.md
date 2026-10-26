# RR Registry – Management API (v1.1.0)

> Vygenerováno z `api/spec.json` nástrojem `tools/gen-clients.js` – needitovat ručně.

Základní cesta: `/api/v1`
Autentizace: `Authorization: Bearer <api_token | user token>  nebo  Basic <user:password>`

Úrovně oprávnění: **none** (veřejné), **read** (čtení – anonymně, pokud je povoleno), **user** (libovolný přihlášený),
**publish** (role publisher/admin), **admin**.

Každá operace je dostupná ve všech klientech:

* JavaScript (`@m5ike/rr-client`): `await client.<id>(pathParams..., [body], [query])`
* Bash (`rr-api.sh`): `rr_api_<snake_id> pathParams... [body|file] [query]`
* CLI `rr` / `rr-web call <id>`, Bash GUI `rr-gui` a Web GUI `/admin/`

## system

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `status` | `GET /api/v1/status` | none | Stav serveru, verze, statistiky | `rr_api_status` |
| `getSpec` | `GET /api/v1/spec` | none | Specifikace API (z ní se generují klientské knihovny) | `rr_api_get_spec` |
| `listClients` | `GET /api/v1/clients` | none | Seznam klientských balíčků ke stažení | `rr_api_list_clients` |
| `rebuildClients` | `POST /api/v1/clients/rebuild` | admin | Znovu vygenerovat klientské knihovny a publikovat je do registru | `rr_api_rebuild_clients` |
| `getLogs` | `GET /api/v1/logs` | admin | Poslední požadavky a audit log<br>query: `limit`, `type` | `rr_api_get_logs` |
| `listPlugins` | `GET /api/v1/plugins` | admin | Dostupné a zapnuté pluginy | `rr_api_list_plugins` |

## auth

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `login` | `POST /api/v1/auth/login` | none | Přihlášení jménem a heslem -> token {username, password}<br>body: json | `rr_api_login` |
| `logout` | `POST /api/v1/auth/logout` | user | Zneplatní aktuální token | `rr_api_logout` |
| `whoami` | `GET /api/v1/auth/whoami` | user | Informace o přihlášeném uživateli | `rr_api_whoami` |

## repos

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listRepos` | `GET /api/v1/repos` | read | Seznam repozitářů | `rr_api_list_repos` |
| `createRepo` | `POST /api/v1/repos` | admin | Vytvořit repozitář {name, type: npm|generic|docker, description, public, allowPublish}<br>body: json | `rr_api_create_repo` |
| `getRepo` | `GET /api/v1/repos/:repo` | read | Detail repozitáře | `rr_api_get_repo` |
| `updateRepo` | `PUT /api/v1/repos/:repo` | admin | Upravit repozitář {description, public, allowPublish}<br>body: json | `rr_api_update_repo` |
| `deleteRepo` | `DELETE /api/v1/repos/:repo` | admin | Smazat repozitář (purge=1 smaže i soubory)<br>query: `purge` | `rr_api_delete_repo` |

## packages

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listPackages` | `GET /api/v1/repos/:repo/packages` | read | Balíčky v repozitáři<br>query: `q` | `rr_api_list_packages` |
| `uploadPackage` | `POST /api/v1/repos/:repo/packages` | publish | Publikovat balíček z .tgz souboru<br>query: `tag`<br>body: binary | `rr_api_upload_package` |
| `getPackage` | `GET /api/v1/repos/:repo/packages/:pkg` | read | Detail balíčku (packument) | `rr_api_get_package` |
| `deletePackage` | `DELETE /api/v1/repos/:repo/packages/:pkg` | publish | Smazat balíček (všechny verze) | `rr_api_delete_package` |
| `deleteVersion` | `DELETE /api/v1/repos/:repo/packages/:pkg/versions/:version` | publish | Smazat verzi balíčku | `rr_api_delete_version` |
| `downloadTarball` | `GET /api/v1/repos/:repo/packages/:pkg/versions/:version/tarball` | read | Stáhnout .tgz dané verze | `rr_api_download_tarball` |
| `deprecateVersion` | `PUT /api/v1/repos/:repo/packages/:pkg/versions/:version/deprecate` | publish | Označit verzi jako zastaralou {message} (verze * = všechny)<br>body: json | `rr_api_deprecate_version` |
| `setDistTag` | `PUT /api/v1/repos/:repo/packages/:pkg/dist-tags/:tag` | publish | Nastavit dist-tag {version}<br>body: json | `rr_api_set_dist_tag` |
| `deleteDistTag` | `DELETE /api/v1/repos/:repo/packages/:pkg/dist-tags/:tag` | publish | Smazat dist-tag | `rr_api_delete_dist_tag` |
| `search` | `GET /api/v1/search` | read | Hledat balíčky ve všech npm repozitářích<br>query: `q`, `repo`, `size` | `rr_api_search` |

## files

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `tree` | `GET /api/v1/repos/:repo/tree` | read | Strom adresářů a souborů repozitáře<br>query: `path`, `depth` | `rr_api_tree` |
| `stat` | `GET /api/v1/repos/:repo/stat` | read | Informace o souboru/adresáři<br>query: `path` | `rr_api_stat` |
| `readFile` | `GET /api/v1/repos/:repo/files` | read | Obsah souboru<br>query: `path` | `rr_api_read_file` |
| `writeFile` | `PUT /api/v1/repos/:repo/files` | admin | Nahrát / přepsat soubor<br>query: `path`<br>body: binary | `rr_api_write_file` |
| `deleteFile` | `DELETE /api/v1/repos/:repo/files` | admin | Smazat soubor nebo adresář<br>query: `path` | `rr_api_delete_file` |
| `mkdir` | `POST /api/v1/repos/:repo/dirs` | admin | Vytvořit adresář<br>query: `path` | `rr_api_mkdir` |

## docker

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listImages` | `GET /api/v1/repos/:repo/images` | read | Docker image v repozitáři {name, tags, size, updated} | `rr_api_list_images` |
| `listImageTags` | `GET /api/v1/repos/:repo/images/:image/tags` | read | Tagy image {tag, digest, mediaType, size, created} (název image URL-enkódovaný, např. agentconf%2Fnode) | `rr_api_list_image_tags` |
| `deleteImageTag` | `DELETE /api/v1/repos/:repo/images/:image/tags/:tag` | publish | Smazat tag image (data uvolní garbage collection) | `rr_api_delete_image_tag` |
| `dockerGc` | `POST /api/v1/repos/:repo/gc` | admin | Garbage collection docker repozitáře {untagged: smazat i neotagované manifesty}<br>body: json | `rr_api_docker_gc` |

## routes

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listRoutes` | `GET /api/v1/routes` | admin | Pravidla směrování (routing plugin) | `rr_api_list_routes` |
| `createRoute` | `POST /api/v1/routes` | admin | Přidat pravidlo {name, when, matchOn, matchType, pattern, repo, key, target, cacheTtl, ...}<br>body: json | `rr_api_create_route` |
| `getRoute` | `GET /api/v1/routes/:id` | admin | Detail pravidla | `rr_api_get_route` |
| `updateRoute` | `PUT /api/v1/routes/:id` | admin | Upravit pravidlo<br>body: json | `rr_api_update_route` |
| `deleteRoute` | `DELETE /api/v1/routes/:id` | admin | Smazat pravidlo | `rr_api_delete_route` |
| `testRoute` | `POST /api/v1/routes/test` | admin | Otestovat, které pravidlo odpovídá {repo, path, key, method}<br>body: json | `rr_api_test_route` |

## cache

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `cacheStats` | `GET /api/v1/cache` | admin | Statistiky cache | `rr_api_cache_stats` |
| `listCache` | `GET /api/v1/cache/entries` | admin | Položky v cache<br>query: `q`, `limit` | `rr_api_list_cache` |
| `purgeCache` | `DELETE /api/v1/cache` | admin | Vyčistit cache (vše / expired=1 / q=filtr)<br>query: `expired`, `q` | `rr_api_purge_cache` |
| `deleteCacheEntry` | `DELETE /api/v1/cache/entries/:key` | admin | Smazat položku cache | `rr_api_delete_cache_entry` |

## users

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listUsers` | `GET /api/v1/users` | admin | Uživatelé | `rr_api_list_users` |
| `createUser` | `POST /api/v1/users` | admin | Vytvořit uživatele {name, password, email, role: admin|publisher|reader}<br>body: json | `rr_api_create_user` |
| `updateUser` | `PUT /api/v1/users/:name` | admin | Upravit uživatele {password, email, role}<br>body: json | `rr_api_update_user` |
| `deleteUser` | `DELETE /api/v1/users/:name` | admin | Smazat uživatele | `rr_api_delete_user` |

## tokens

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listTokens` | `GET /api/v1/tokens` | user | Tokeny (admin vidí všechny) | `rr_api_list_tokens` |
| `createToken` | `POST /api/v1/tokens` | user | Vytvořit token {name, readonly, user (jen admin), ttl}<br>body: json | `rr_api_create_token` |
| `revokeToken` | `DELETE /api/v1/tokens/:id` | user | Zneplatnit token | `rr_api_revoke_token` |

## settings

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `getSettings` | `GET /api/v1/settings` | admin | Nastavení serveru | `rr_api_get_settings` |
| `updateSettings` | `PUT /api/v1/settings` | admin | Změnit nastavení {defaultRepo, anonymousRead, allowRegistration, cacheTtl, tarballTtl, title, plugins}<br>body: json | `rr_api_update_settings` |

## Příklady

```bash
# token z make menuconfig (RR_API_TOKEN) nebo z přihlášení
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4873/api/v1/repos
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"name":"internal","type":"npm"}' http://localhost:4873/api/v1/repos
curl -s -X POST -H "Authorization: Bearer $TOKEN" --data-binary @my-pkg-1.0.0.tgz \
     http://localhost:4873/api/v1/repos/internal/packages
```

```js
const RRClient = require('@m5ike/rr-client');
const rr = new RRClient({ baseUrl: 'http://localhost:4873', token: process.env.RR_TOKEN });
console.log(await rr.listRepos());
await rr.createRoute({ name: 'corp', when: 'always', matchType: 'prefix', pattern: '/@corp/', target: 'https://npm.corp.example' });
```

# RR Registry – Management API (v1.6.1)

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
| `listTasks` | `GET /api/v1/tasks` | admin | Naplánované úlohy (zrcadla, čištění, cache) | `rr_api_list_tasks` |
| `runTask` | `POST /api/v1/tasks/:id/run` | admin | Spustit úlohu hned | `rr_api_run_task` |

## auth

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `login` | `POST /api/v1/auth/login` | none | Přihlášení jménem a heslem -> token {username, password}<br>body: json | `rr_api_login` |
| `logout` | `POST /api/v1/auth/logout` | user | Zneplatní aktuální token | `rr_api_logout` |
| `whoami` | `GET /api/v1/auth/whoami` | user | Informace o přihlášeném uživateli | `rr_api_whoami` |
| `listSshKeys` | `GET /api/v1/user/keys` | user | SSH klíče přihlášeného uživatele (admin: ?user=jméno nebo ?user=* pro všechny)<br>query: `user` | `rr_api_list_ssh_keys` |
| `addSshKey` | `POST /api/v1/user/keys` | user | Přidat SSH klíč {title, key} (ssh-ed25519, ecdsa-sha2-*, ssh-rsa)<br>body: json | `rr_api_add_ssh_key` |
| `deleteSshKey` | `DELETE /api/v1/user/keys/:id` | user | Odebrat SSH klíč | `rr_api_delete_ssh_key` |

## repos

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listRepos` | `GET /api/v1/repos` | read | Seznam repozitářů | `rr_api_list_repos` |
| `createRepo` | `POST /api/v1/repos` | admin | Vytvořit repozitář {name, type: npm|generic|docker|git|group, description, public, allowPublish, quotaMb, immutable, acl, cleanup, members, deployTo, autoCreate}<br>body: json | `rr_api_create_repo` |
| `getRepo` | `GET /api/v1/repos/:repo` | read | Detail repozitáře | `rr_api_get_repo` |
| `updateRepo` | `PUT /api/v1/repos/:repo` | admin | Upravit repozitář {description, public, allowPublish, quotaMb, immutable, acl: {uživatel: none|read|publish}, cleanup: {enabled, maxVersions, maxAgeDays, prereleaseOnly, pattern, intervalHours}, members, deployTo, autoCreate}<br>body: json | `rr_api_update_repo` |
| `deleteRepo` | `DELETE /api/v1/repos/:repo` | admin | Smazat repozitář (purge=1 smaže i soubory)<br>query: `purge` | `rr_api_delete_repo` |
| `runCleanup` | `POST /api/v1/repos/:repo/cleanup` | admin | Spustit čištění dle pravidel retence {dryRun, policy?: {maxVersions, maxAgeDays, prereleaseOnly, pattern}}<br>body: json | `rr_api_run_cleanup` |
| `getRepoStats` | `GET /api/v1/repos/:repo/stats` | read | Statistiky stahování repozitáře (celkem, nejstahovanější, posledních 30 dní)<br>query: `top` | `rr_api_get_repo_stats` |

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

## git

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listGitRepos` | `GET /api/v1/repos/:repo/git` | read | Git repozitáře v repozitáři typu git<br>query: `q` | `rr_api_list_git_repos` |
| `createGitRepo` | `POST /api/v1/repos/:repo/git` | publish | Vytvořit git repozitář {name, description, defaultBranch, visibility: public|private, readme, gitignore, license} nebo importovat/zrcadlit (jen admin) {importUrl, mirror, interval, ttl, token, username}<br>body: json | `rr_api_create_git_repo` |
| `githubImport` | `POST /api/v1/repos/:repo/git/github-import` | admin | Hromadný import / zrcadlení repozitářů z GitHubu {owner, token, kind: auto|user|org|mine, mirror, interval, filter, includeForks, includeArchived, limit, prefix}<br>body: json | `rr_api_github_import` |
| `getGitRepo` | `GET /api/v1/repos/:repo/git/:name` | read | Detail git repozitáře (větve, tagy, zrcadla, URL pro klonování) | `rr_api_get_git_repo` |
| `updateGitRepo` | `PUT /api/v1/repos/:repo/git/:name` | publish | Upravit git repozitář {description, defaultBranch, protectedBranches, mirror: {url, token, interval, ttl, enabled} | null} – správce repozitáře (vlastník); zrcadlení jen admin<br>body: json | `rr_api_update_git_repo` |
| `deleteGitRepo` | `DELETE /api/v1/repos/:repo/git/:name` | publish | Smazat git repozitář (správce repozitáře – vlastník nebo admin) | `rr_api_delete_git_repo` |
| `gitCommits` | `GET /api/v1/repos/:repo/git/:name/commits` | read | Historie commitů<br>query: `ref`, `limit`, `path` | `rr_api_git_commits` |
| `gitTree` | `GET /api/v1/repos/:repo/git/:name/tree` | read | Obsah adresáře ve větvi/tagu/commitu<br>query: `ref`, `path` | `rr_api_git_tree` |
| `gitBlob` | `GET /api/v1/repos/:repo/git/:name/blob` | read | Obsah souboru ve větvi/tagu/commitu<br>query: `ref`, `path` | `rr_api_git_blob` |
| `gitArchive` | `GET /api/v1/repos/:repo/git/:name/archive` | read | Stáhnout archiv (tar.gz/zip) větve/tagu<br>query: `ref`, `format` | `rr_api_git_archive` |
| `gitSync` | `POST /api/v1/repos/:repo/git/:name/sync` | publish | Synchronizovat zrcadla hned {direction: pull|push|both}<br>body: json | `rr_api_git_sync` |
| `addGitPushMirror` | `POST /api/v1/repos/:repo/git/:name/push-mirrors` | admin | Přidat push zrcadlo {url, token, username, mode: mirror|branches, createMissing, private}<br>body: json | `rr_api_add_git_push_mirror` |
| `deleteGitPushMirror` | `DELETE /api/v1/repos/:repo/git/:name/push-mirrors/:id` | admin | Odebrat push zrcadlo | `rr_api_delete_git_push_mirror` |
| `listGitBranches` | `GET /api/v1/repos/:repo/git/:name/branches` | read | Větve ve tvaru GitHubu [{name, commit: {sha}, protected}]; ?detailed=1 – s posledním commitem, výchozí, ahead/behind<br>query: `detailed` | `rr_api_list_git_branches` |
| `listGitPulls` | `GET /api/v1/repos/:repo/git/:name/pulls` | read | Pull requesty (nejnovější první); head může být „owner:větev“<br>query: `state`, `head`, `base` | `rr_api_list_git_pulls` |
| `createGitPull` | `POST /api/v1/repos/:repo/git/:name/pulls` | publish | Vytvořit pull request {title, head, base, body, draft} (422 když větev neexistuje nebo head = base)<br>body: json | `rr_api_create_git_pull` |
| `getGitPull` | `GET /api/v1/repos/:repo/git/:name/pulls/:number` | read | Detail pull requestu včetně mergeable / mergeable_state (clean|dirty|unknown) spočítaného z aktuálních větví | `rr_api_get_git_pull` |
| `updateGitPull` | `PATCH /api/v1/repos/:repo/git/:name/pulls/:number` | publish | Upravit pull request {title, body, state: open|closed, base, draft}<br>body: json | `rr_api_update_git_pull` |
| `mergeGitPull` | `PUT /api/v1/repos/:repo/git/:name/pulls/:number/merge` | publish | Sloučit pull request {merge_method: merge|squash|rebase, commit_title, commit_message, sha} → {merged, sha, message}; 405 konflikt/zavřený, 409 základní větev se změnila<br>body: json | `rr_api_merge_git_pull` |
| `listGitPullComments` | `GET /api/v1/repos/:repo/git/:name/pulls/:number/comments` | read | Komentáře pull requestu (alias …/issues/:number/comments) | `rr_api_list_git_pull_comments` |
| `createGitPullComment` | `POST /api/v1/repos/:repo/git/:name/pulls/:number/comments` | publish | Přidat komentář k pull requestu {body}<br>body: json | `rr_api_create_git_pull_comment` |
| `listGitIssues` | `GET /api/v1/repos/:repo/git/:name/issues` | read | Issues (bez pull requestů, nejnovější první); labels=a,b – musí mít všechny<br>query: `state`, `labels` | `rr_api_list_git_issues` |
| `createGitIssue` | `POST /api/v1/repos/:repo/git/:name/issues` | publish | Vytvořit issue {title, body, labels: [..]}<br>body: json | `rr_api_create_git_issue` |
| `getGitIssue` | `GET /api/v1/repos/:repo/git/:name/issues/:number` | read | Detail issue (funguje i pro číslo pull requestu) | `rr_api_get_git_issue` |
| `updateGitIssue` | `PATCH /api/v1/repos/:repo/git/:name/issues/:number` | publish | Upravit issue nebo pull request {title, body, state: open|closed, labels}<br>body: json | `rr_api_update_git_issue` |
| `listGitIssueComments` | `GET /api/v1/repos/:repo/git/:name/issues/:number/comments` | read | Komentáře issue nebo pull requestu | `rr_api_list_git_issue_comments` |
| `createGitIssueComment` | `POST /api/v1/repos/:repo/git/:name/issues/:number/comments` | publish | Přidat komentář k issue nebo pull requestu {body}<br>body: json | `rr_api_create_git_issue_comment` |
| `gitTemplates` | `GET /api/v1/git/templates` | none | Šablony pro nový git repozitář: názvy .gitignore a licencí, nebo obsah jedné (?gitignore=Node | ?license=MIT&holder=jméno)<br>query: `gitignore`, `license`, `holder` | `rr_api_git_templates` |
| `moveGitRepo` | `POST /api/v1/repos/:repo/git/:name/move` | publish | Přejmenovat nebo přesunout git repozitář {name, repo} – staré URL dál fungují (přesměrování)<br>body: json | `rr_api_move_git_repo` |
| `setGitAccess` | `PUT /api/v1/repos/:repo/git/:name/access` | publish | Viditelnost a oprávnění {visibility: public|private, owner, collaborators: {user: read|write|admin}}<br>body: json | `rr_api_set_git_access` |
| `gitCommit` | `GET /api/v1/repos/:repo/git/:name/commits/:sha` | read | Detail commitu se změněnými soubory a patchem | `rr_api_git_commit` |
| `createGitBranch` | `POST /api/v1/repos/:repo/git/:name/branches` | publish | Vytvořit větev {name, from}<br>body: json | `rr_api_create_git_branch` |
| `updateGitBranch` | `PATCH /api/v1/repos/:repo/git/:name/branches/:branch` | publish | Přejmenovat větev / nastavit jako výchozí / chránit {name, default, protected}<br>body: json | `rr_api_update_git_branch` |
| `deleteGitBranch` | `DELETE /api/v1/repos/:repo/git/:name/branches/:branch` | publish | Smazat větev (ne výchozí ani chráněnou) | `rr_api_delete_git_branch` |
| `listGitTags` | `GET /api/v1/repos/:repo/git/:name/tags` | read | Tagy (anotované i lehké) [{name, commit, annotated, tagger, date, message}] | `rr_api_list_git_tags` |
| `createGitTag` | `POST /api/v1/repos/:repo/git/:name/tags` | publish | Vytvořit tag {tag, ref, message} – se zprávou anotovaný<br>body: json | `rr_api_create_git_tag` |
| `deleteGitTag` | `DELETE /api/v1/repos/:repo/git/:name/tags/:tag` | publish | Smazat tag | `rr_api_delete_git_tag` |
| `listGitReleases` | `GET /api/v1/repos/:repo/git/:name/releases` | read | Releases (nejnovější první, koncepty jen pro zapisující) | `rr_api_list_git_releases` |
| `createGitRelease` | `POST /api/v1/repos/:repo/git/:name/releases` | publish | Vytvořit release {tag_name, target_commitish, name, body, draft, prerelease, generate_release_notes}<br>body: json | `rr_api_create_git_release` |
| `getGitRelease` | `GET /api/v1/repos/:repo/git/:name/releases/:id` | read | Detail release (id nebo „latest“) | `rr_api_get_git_release` |
| `getGitReleaseByTag` | `GET /api/v1/repos/:repo/git/:name/releases/tags/:tag` | read | Release podle tagu | `rr_api_get_git_release_by_tag` |
| `updateGitRelease` | `PATCH /api/v1/repos/:repo/git/:name/releases/:id` | publish | Upravit release {tag_name, target_commitish, name, body, draft, prerelease}<br>body: json | `rr_api_update_git_release` |
| `deleteGitRelease` | `DELETE /api/v1/repos/:repo/git/:name/releases/:id` | publish | Smazat release (tag zůstane) | `rr_api_delete_git_release` |
| `uploadGitReleaseAsset` | `POST /api/v1/repos/:repo/git/:name/releases/:id/assets` | publish | Nahrát soubor k release (?name=soubor&label=popis)<br>query: `name`, `label`<br>body: binary | `rr_api_upload_git_release_asset` |
| `downloadGitReleaseAsset` | `GET /api/v1/repos/:repo/git/:name/releases/assets/:asset/download` | read | Stáhnout soubor release | `rr_api_download_git_release_asset` |
| `deleteGitReleaseAsset` | `DELETE /api/v1/repos/:repo/git/:name/releases/assets/:asset` | publish | Smazat soubor release | `rr_api_delete_git_release_asset` |
| `putGitFile` | `PUT /api/v1/repos/:repo/git/:name/contents` | publish | Vytvořit / upravit soubor commitem {path, content, encoding: utf8|base64, message, branch, sha, create}<br>body: json | `rr_api_put_git_file` |
| `deleteGitFile` | `DELETE /api/v1/repos/:repo/git/:name/contents` | publish | Smazat soubor nebo adresář commitem (?path, branch, message, sha)<br>query: `path`, `branch`, `message`, `sha` | `rr_api_delete_git_file` |
| `commitGitFiles` | `POST /api/v1/repos/:repo/git/:name/commit-files` | publish | Commit více souborů najednou (nahrávání) {branch, from, message, files: [{path, content, encoding}], deletes: [path]}<br>body: json | `rr_api_commit_git_files` |

## routes

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listRoutes` | `GET /api/v1/routes` | admin | Pravidla směrování (routing plugin) | `rr_api_list_routes` |
| `createRoute` | `POST /api/v1/routes` | admin | Přidat pravidlo {name, when: always|notfound|push, matchOn, matchType, pattern, repo, repoType, key, target, token, cacheTtl, replicateDeletes, gitMode, createMissing, ...}<br>body: json | `rr_api_create_route` |
| `getRoute` | `GET /api/v1/routes/:id` | admin | Detail pravidla | `rr_api_get_route` |
| `updateRoute` | `PUT /api/v1/routes/:id` | admin | Upravit pravidlo<br>body: json | `rr_api_update_route` |
| `deleteRoute` | `DELETE /api/v1/routes/:id` | admin | Smazat pravidlo | `rr_api_delete_route` |
| `testRoute` | `POST /api/v1/routes/test` | admin | Otestovat, které pravidlo odpovídá {repo, path, key, method}<br>body: json | `rr_api_test_route` |
| `listReplications` | `GET /api/v1/replications` | admin | Fronta a historie replikací (pravidla when=push)<br>query: `limit`, `status` | `rr_api_list_replications` |
| `retryReplication` | `POST /api/v1/replications/:id/retry` | admin | Znovu spustit replikaci | `rr_api_retry_replication` |

## cache

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `cacheStats` | `GET /api/v1/cache` | admin | Statistiky cache | `rr_api_cache_stats` |
| `listCache` | `GET /api/v1/cache/entries` | admin | Položky v cache<br>query: `q`, `limit` | `rr_api_list_cache` |
| `purgeCache` | `DELETE /api/v1/cache` | admin | Vyčistit cache (vše / expired=1 / q=filtr)<br>query: `expired`, `q` | `rr_api_purge_cache` |
| `deleteCacheEntry` | `DELETE /api/v1/cache/entries/:key` | admin | Smazat položku cache | `rr_api_delete_cache_entry` |

## webhooks

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `listWebhooks` | `GET /api/v1/webhooks` | admin | Webhooky | `rr_api_list_webhooks` |
| `createWebhook` | `POST /api/v1/webhooks` | admin | Vytvořit webhook {name, url, events: [*|npm.*|git.push|...], repos, secret, format: json|slack|discord, headers, enabled}<br>body: json | `rr_api_create_webhook` |
| `updateWebhook` | `PUT /api/v1/webhooks/:id` | admin | Upravit webhook<br>body: json | `rr_api_update_webhook` |
| `deleteWebhook` | `DELETE /api/v1/webhooks/:id` | admin | Smazat webhook | `rr_api_delete_webhook` |
| `testWebhook` | `POST /api/v1/webhooks/:id/test` | admin | Odeslat testovací událost (ping) | `rr_api_test_webhook` |
| `listWebhookDeliveries` | `GET /api/v1/webhooks/deliveries` | admin | Historie doručení webhooků<br>query: `id`, `limit` | `rr_api_list_webhook_deliveries` |
| `listEvents` | `GET /api/v1/events` | admin | Poslední události a seznam typů událostí<br>query: `limit`, `type` | `rr_api_list_events` |

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
| `updateSettings` | `PUT /api/v1/settings` | admin | Změnit nastavení {defaultRepo, dockerRepo, gitRepo, anonymousRead, allowRegistration, cacheTtl, tarballTtl, title, plugins}<br>body: json | `rr_api_update_settings` |

## transfer

| Operace | Metoda a cesta | Auth | Popis | Bash |
|---|---|---|---|---|
| `transferSections` | `GET /api/v1/transfer/sections` | admin | Části, které lze exportovat (sekce, položky, velikosti) v pořadí exportu/importu | `rr_api_transfer_sections` |
| `listExports` | `GET /api/v1/exports` | admin | Vytvořené exporty | `rr_api_list_exports` |
| `createExport` | `POST /api/v1/exports` | admin | Vytvořit šifrovaný export {passphrase, sections: [server, secret, plugins, users, tokens, repos, content, routes, webhooks, settings, stats, audit, cache], items: {sekce: [id]}, note}<br>body: json | `rr_api_create_export` |
| `downloadExport` | `GET /api/v1/exports/:id/download` | admin | Stáhnout soubor exportu (.rrx) | `rr_api_download_export` |
| `deleteExport` | `DELETE /api/v1/exports/:id` | admin | Smazat export | `rr_api_delete_export` |
| `listImports` | `GET /api/v1/imports` | admin | Rozpracované a dokončené importy | `rr_api_list_imports` |
| `uploadImport` | `POST /api/v1/imports` | admin | Nahrát soubor exportu (.rrx) k importu<br>body: binary | `rr_api_upload_import` |
| `remoteImport` | `POST /api/v1/imports/remote` | admin | Vzdálený import z URL {url, mode: file|server, token, passphrase, sections} – operace je nutné schválit<br>body: json | `rr_api_remote_import` |
| `getImport` | `GET /api/v1/imports/:id` | admin | Stav importu a plán operací (pořadí, akce, cíle, závislosti, schválení) | `rr_api_get_import` |
| `unlockImport` | `POST /api/v1/imports/:id/unlock` | admin | Odemknout import heslem a sestavit plán {passphrase}<br>body: json | `rr_api_unlock_import` |
| `updateImport` | `PUT /api/v1/imports/:id` | admin | Výběr a schválení operací {select, approve, revoke, includeDependencies, conflict, overrides, renames, target}<br>body: json | `rr_api_update_import` |
| `runImport` | `POST /api/v1/imports/:id/run` | admin | Spustit import vybraných a schválených operací {confirmPaths: true}<br>body: json | `rr_api_run_import` |
| `deleteImport` | `DELETE /api/v1/imports/:id` | admin | Zahodit import (smaže dočasná data) | `rr_api_delete_import` |

## Pull requesty a issues (kompatibilní s GitHubem)

Operace `*GitPull*`, `*GitIssue*` a `listGitBranches` používají názvy polí GitHub REST API, takže je klient napsaný
pro GitHub (např. ovladač AgentConf) může volat beze změn – jen s jinou základní URL
`/api/v1/repos/<repo>/git/<název>` (název s lomítky URL-kódovaný: `tym%2Fprojekt`).
Pull requesty a issues sdílejí jednu číselnou řadu v rámci git repozitáře (od 1). Podporu ohlašuje
`GET /api/v1/status` a `GET /api/v1/auth/whoami` polem `features` (`git.pulls`, `git.issues`).

* **Pull** `{ number, title, body, state, draft, head: {ref, sha}, base: {ref, sha}, html_url, merged, merged_at, merge_commit_sha, mergeable, mergeable_state, user: {login}, created_at, updated_at, comments }`
* **Issue** `{ number, title, body, state, labels: [{name}], html_url, user: {login}, created_at, updated_at, closed_at, comments }`
* **Comment** `{ id, body, user: {login}, created_at }`

Chyby mají tělo `{ error, message }`: 422 neplatný vstup (větev neexistuje, head = base), 405 nelze sloučit
(zavřený / sloučený PR, konflikt), 409 základní větev se během slučování změnila (stačí zopakovat).

```bash
R=http://localhost:4873/api/v1/repos/git/git/tym%2Fprojekt
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"title":"Nová funkce","head":"feature","base":"main"}' $R/pulls
curl -s -H "Authorization: Bearer $TOKEN" "$R/pulls?state=open&head=tym:feature"
curl -s -H "Authorization: Bearer $TOKEN" $R/pulls/1          # mergeable, mergeable_state
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"merge_method":"squash"}' $R/pulls/1/merge
```

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

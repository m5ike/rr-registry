#!/usr/bin/env bash
# RR Registry - end-to-end tests. Maintainer: m5ike.
#   scripts/test.sh            start a temporary server and test it with real npm, rr (bash CLI),
#                              rr-api.sh, rr-web (Node CLI), the client installer and rr-gui syntax
#   scripts/test.sh --docker   build the Docker image and smoke-test a container
#   scripts/test.sh --online   additionally install a real package from npmjs.org through the proxy
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PASS=0; FAIL=0; FAILED=()
ok() { PASS=$((PASS + 1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
ko() { FAIL=$((FAIL + 1)); FAILED+=("$1"); printf '  \033[31m✘\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '      %s\n' "$2"; }
check() { local name="$1"; shift; local out; if out=$("$@" 2>&1); then ok "$name"; else ko "$name" "$(printf '%s' "$out" | tail -3)"; fi; }
contains() { local name="$1" needle="$2"; shift 2; local out; out=$("$@" 2>&1); if printf '%s' "$out" | grep -q -- "$needle"; then ok "$name"; else ko "$name" "očekáváno '$needle', výstup: $(printf '%s' "$out" | tail -3)"; fi; }
free_port() { node -e 'const s=require("net").createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})'; }

TMP="$(mktemp -d)"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  [ -n "${CID:-}" ] && docker rm -f "$CID" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

summary() {
  echo
  echo "Výsledek: $PASS OK, $FAIL selhalo"
  [ $FAIL -gt 0 ] && printf '  - %s\n' "${FAILED[@]}"
  [ $FAIL -eq 0 ]
}

# ------------------------------------------------------------------ docker smoke test
if [ "${1:-}" = "--docker" ]; then
  echo "== Docker smoke test =="
  check "docker build" docker build -t m5ike/rr-registry:test .
  PORT="$(free_port)"
  CID=$(docker run -d -e RR_PORT=4873 -e RR_API_TOKEN=docker-test-token-1234 -e RR_ADMIN_PASSWORD=dockerpw -p "$PORT:4873" m5ike/rr-registry:test)
  for _ in $(seq 1 40); do curl -fsS "http://localhost:$PORT/-/ping" >/dev/null 2>&1 && break; sleep 0.5; done
  contains "container /-/ping" "{}" curl -fsS "http://localhost:$PORT/-/ping"
  contains "container status API" '"maintainer": "m5ike"' curl -fsS "http://localhost:$PORT/api/v1/status"
  contains "container homepage" "rr_bash-gui" curl -fsS -H 'Accept: text/html' "http://localhost:$PORT/"
  contains "container client packages" "@m5ike/rr_web-guicli" curl -fsS "http://localhost:$PORT/downloads/"
  contains "container admin API with token" '"npm"' curl -fsS -H "Authorization: Bearer docker-test-token-1234" "http://localhost:$PORT/api/v1/repos"
  contains "container healthcheck defined" "ping" docker inspect --format '{{json .Config.Healthcheck}}' "$CID"
  GW="$TMP/dgit"; mkdir -p "$GW"
  ( cd "$GW" && git init -q -b main p && cd p && echo docker >README && git add . && git -c user.email=t@t -c user.name=T commit -qm init )
  check "container git push (git http-backend)" git -C "$GW/p" -c credential.helper= push -q "http://admin:dockerpw@localhost:$PORT/git/d/p.git" main
  contains "container git clone" "docker" bash -c "git -c credential.helper= clone -q http://localhost:$PORT/git/d/p.git '$GW/c' && cat '$GW/c/README'"
  summary; exit $?
fi

ONLINE=0; [ "${1:-}" = "--online" ] && ONLINE=1

echo "== Sestavení klientů =="
check "tools/build.js" node tools/build.js

echo "== Start serveru =="
PORT="$(free_port)"
TOKEN="e2e-token-$(date +%s)-abcdef"
export RR_SERVER="http://127.0.0.1:$PORT" RR_TOKEN="$TOKEN" RR_CONFIG="$TMP/rrconfig"
RR_UPSTREAM_VAL="https://registry.npmjs.org"; [ $ONLINE = 0 ] && RR_UPSTREAM_VAL=""
RR_API_TOKEN="$TOKEN" RR_ADMIN_PASSWORD=e2epass RR_UPSTREAM="$RR_UPSTREAM_VAL" RR_LOG_REQUESTS=0 \
  node server/bin/rr-server.js --port "$PORT" --host 127.0.0.1 --data "$TMP/data" >"$TMP/server.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do curl -fsS "$RR_SERVER/-/ping" >/dev/null 2>&1 && break; sleep 0.25; done
contains "server běží" "{}" curl -fsS "$RR_SERVER/-/ping"

echo "== npm klient =="
NPMRC="$TMP/npmrc"
printf 'registry=%s/\n//127.0.0.1:%s/:_authToken=%s\n' "$RR_SERVER" "$PORT" "$TOKEN" >"$NPMRC"
NPM=(npm --userconfig "$NPMRC" --cache "$TMP/npm-cache" --no-audit --no-fund --loglevel=error)
mkdir -p "$TMP/pkg" && cd "$TMP/pkg"
printf '{"name":"@e2e/hello","version":"1.0.0","description":"e2e hello","main":"index.js","keywords":["e2e"]}' >package.json
echo 'module.exports = "hello from rr";' >index.js
echo '# hello' >README.md
check "npm publish" "${NPM[@]}" publish
sed -i.bak 's/1.0.0/1.1.0/' package.json && rm -f package.json.bak
check "npm publish --tag beta" "${NPM[@]}" publish --tag beta
contains "npm view" "1.1.0" "${NPM[@]}" view @e2e/hello versions --json
contains "npm dist-tag ls" "beta: 1.1.0" "${NPM[@]}" dist-tag ls @e2e/hello
contains "npm search" "@e2e/hello" "${NPM[@]}" search e2e
check "npm deprecate" "${NPM[@]}" deprecate @e2e/hello@1.0.0 "old version"
contains "npm whoami" "api-token" "${NPM[@]}" whoami
mkdir -p "$TMP/app" && cd "$TMP/app" && echo '{"name":"app","version":"1.0.0"}' >package.json
check "npm install @e2e/hello@beta" "${NPM[@]}" install @e2e/hello@beta
contains "nainstalovaný balíček funguje" "hello from rr" node -e 'console.log(require("@e2e/hello"))'
check "npm install @m5ike/rr-client" "${NPM[@]}" install @m5ike/rr-client
contains "rr-client z registru" "listRepos" node -e 'const C=require("@m5ike/rr-client");console.log(Object.keys(C.operations).join(","))'
if [ $ONLINE = 1 ]; then
  check "npm install is-number (proxy npmjs.org)" "${NPM[@]}" install is-number@7
  contains "druhý požadavek z cache" "HIT" curl -sI "$RR_SERVER/is-number"
fi
check "npm unpublish @e2e/hello@1.0.0" "${NPM[@]}" unpublish @e2e/hello@1.0.0 --force
contains "verze odstraněna" '"1.1.0"' "${NPM[@]}" view @e2e/hello versions --json
cd "$ROOT"

echo "== bash CLI (rr) =="
RR="$ROOT/dist/clients/rr_bash-cli/bin/rr"
contains "rr version" "rr " "$RR" version
contains "rr status" '"maintainer": "m5ike"' "$RR" status
contains "rr repo create" '"internal"' "$RR" repo create internal npm "Interní"
contains "rr repo list" "internal" "$RR" repo list
( cd "$TMP/pkg" && "${NPM[@]}" pack --pack-destination "$TMP" >/dev/null 2>&1 )
contains "rr pkg publish" '"version": "1.1.0"' "$RR" pkg publish internal "$TMP/e2e-hello-1.1.0.tgz"
contains "rr pkg list" "@e2e/hello" "$RR" pkg list internal
contains "rr pkg tag" '"stable"' "$RR" pkg tag internal @e2e/hello stable 1.1.0
check "rr pkg download" "$RR" pkg download internal @e2e/hello 1.1.0 "$TMP/dl.tgz"
check "stažený tarball je platný" tar -tzf "$TMP/dl.tgz"
contains "rr search" "@e2e/hello" "$RR" search hello
contains "rr fs tree" "packument.json" "$RR" fs tree internal / 4
echo "data" >"$TMP/f.txt"
check "rr fs put" "$RR" fs put files a/b/f.txt "$TMP/f.txt"
contains "rr fs cat" "data" "$RR" fs cat files a/b/f.txt
contains "rr fs stat" '"size": 5' "$RR" fs stat files a/b/f.txt
check "rr fs rm" "$RR" fs rm files a
contains "rr route add" '"corp"' "$RR" route add name=corp when=always matchType=prefix pattern=/@corp/ target=https://npm.corp.example cacheTtl=600
contains "rr route test" '"corp"' "$RR" route test /@corp/x
contains "rr route list" "corp" "$RR" route list
contains "rr cache stats" '"entries"' "$RR" cache stats
contains "rr user add" '"publisher"' "$RR" user add eve evepass1 publisher
contains "rr token create" '"token": "rr_' "$RR" token create ci --readonly
contains "rr settings set" '"E2E"' "$RR" settings set title==E2E
contains "rr logs" "AUDIT" "$RR" logs 5
contains "rr npmrc" "_authToken=$TOKEN" "$RR" npmrc internal
contains "rr call (raw API)" '"name": "internal"' "$RR" call get_repo internal
contains "rr chyba vrací exit 1" "not found" bash -c "\"$RR\" repo show neexistuje; echo exit=\$?"
contains "rr login" "přihlášen jako admin" bash -c "printf 'e2epass\n' | RR_TOKEN= \"$RR\" login admin"

echo "== git repozitáře =="
GW="$TMP/gitwork"; mkdir -p "$GW"
GIT=(git -c credential.helper= -c user.email=e2e@example.com -c user.name=E2E)
( cd "$GW" && "${GIT[@]}" init -q -b main p && cd p && echo "e2e" >README.md && "${GIT[@]}" add . && "${GIT[@]}" commit -qm "first commit" )
check "git push vytvoří repozitář" "${GIT[@]}" -C "$GW/p" push -q "http://admin:e2epass@127.0.0.1:$PORT/git/e2e/proj.git" main
contains "git push bez přihlášení odmítnut" "terminal prompts disabled\|Authentication\|401" bash -c "GIT_TERMINAL_PROMPT=0 git -c credential.helper= -C '$GW/p' push '$RR_SERVER/git/e2e/proj.git' main 2>&1"
check "git clone" "${GIT[@]}" clone -q "$RR_SERVER/git/e2e/proj.git" "$GW/clone"
contains "naklonovaný obsah" "e2e" cat "$GW/clone/README.md"
contains "rr git list" "e2e/proj" "$RR" git list git
contains "rr git show" "clone:" "$RR" git show git e2e/proj
contains "rr git log" "first commit" "$RR" git log git e2e/proj main 5
contains "rr git ls" "README.md" "$RR" git ls git e2e/proj main
contains "rr git cat" "e2e" "$RR" git cat git e2e/proj README.md main
contains "rr git protect" '"main"' "$RR" git protect git e2e/proj main
( cd "$GW/p" && "${GIT[@]}" commit -q --amend -m rewritten )
contains "force-push do chráněné větve odmítnut" "protected" bash -c "git -c credential.helper= -C '$GW/p' push -f 'http://admin:e2epass@127.0.0.1:$PORT/git/e2e/proj.git' main 2>&1"
"${GIT[@]}" init -q --bare "$GW/upstream.git" && "${GIT[@]}" -C "$GW/clone" push -q "$GW/upstream.git" main
contains "rr git import (zrcadlo)" '"status": "ok"' "$RR" git import git mirror/up "file://$GW/upstream.git" --interval 0
contains "rr git sync" '"ok": true' "$RR" git sync git mirror/up pull
"${GIT[@]}" init -q --bare "$GW/target.git"
contains "rr git push-mirror add" '"mode": "mirror"' "$RR" git push-mirror add git e2e/proj "file://$GW/target.git"
contains "rr git sync push" '"ok": true' "$RR" git sync git e2e/proj push
contains "push zrcadlo obsahuje main" "refs/heads/main" git ls-remote "$GW/target.git"
check "rr git archive" "$RR" git archive git e2e/proj main "$TMP/p.tgz"
check "archiv je platný tar.gz" tar -tzf "$TMP/p.tgz"

echo "== pokročilé funkce repozitářů =="
contains "rr repo create group" '"group"' "$RR" repo create skupina group "Skupina" members=internal,npm deployTo=internal
contains "rr repo update (členové skupiny)" '"members"' "$RR" repo update skupina members=npm,internal
contains "skupina slučuje balíčky" "@e2e/hello" curl -fsS "$RR_SERVER/r/skupina/@e2e%2fhello"
contains "rr repo policy" '"maxVersions": 5' "$RR" repo policy internal enabled=true maxVersions=5
contains "rr repo acl" '"eve": "read"' "$RR" repo acl internal eve=read
contains "rr repo cleanup --dry-run" "dryRun: true" "$RR" repo cleanup internal --dry-run
contains "rr repo stats" "celkem:" "$RR" repo stats npm
contains "rr webhook add" '"name": "e2e"' "$RR" webhook add name=e2e url=http://127.0.0.1:9/hook events=git.*,npm.publish
contains "rr webhook list" "e2e" "$RR" webhook list
contains "rr events" "git.push" "$RR" events 50
contains "rr task list" "git-mirrors" "$RR" task list
contains "rr task run" '"runs": 1' "$RR" task run cache-expired
contains "rr route add push" '"push"' "$RR" route add name=repl when=push repo=internal target=http://127.0.0.1:9 token=x
contains "rr replication list" "STATUS" "$RR" replication list

echo "== export a import =="
export RR_PASSPHRASE="e2e export heslo"
contains "rr export sections" "content" "$RR" export sections
contains "rr export create" '"file"' "$RR" export create users,repos,content --note e2e
EXP_ID=$("$RR" export list | sed -n 2p | cut -d" " -f1)
check "rr export download" "$RR" export download "$EXP_ID" "$TMP/e2e.rrx"
contains "soubor exportu je šifrovaný" "RRX1" head -c 4 "$TMP/e2e.rrx"
contains "rr import file" "vybráno" "$RR" import file "$TMP/e2e.rrx"
IMP_ID=$("$RR" import list | sed -n 2p | cut -d" " -f1)
contains "rr import set workspace" "workspace" "$RR" import set "$IMP_ID" target=workspace path=e2e
contains "rr import run" "stav: done" "$RR" import run "$IMP_ID" --confirm-paths
contains "workspace obsahuje balíčky" "packument.json" bash -c "find '$TMP/data/workspaces/e2e' -name packument.json | head -1"
unset RR_PASSPHRASE

echo "== rr-api.sh knihovna =="
contains "rr_api_* funkce" '"version"' bash -c ". '$ROOT/dist/clients/rr_bash-cli/lib/rr-api.sh'; rr_api_status"
contains "rr_urlencode" "%40scope%2Fname" bash -c ". '$ROOT/dist/clients/rr_bash-cli/lib/rr-api.sh'; rr_urlencode @scope/name"
contains "rr_query" "q=a%20b&size=5" bash -c ". '$ROOT/dist/clients/rr_bash-cli/lib/rr-api.sh'; rr_query 'q=a b' 'repo=' 'size=5'"

echo "== bash GUI (rr-gui) =="
check "rr-gui syntaxe" bash -n "$ROOT/dist/clients/rr_bash-gui/bin/rr-gui"
check "rr-gui syntaxe (bash 3.2 kompatibilita /bin/bash)" /bin/bash -n "$ROOT/dist/clients/rr_bash-gui/bin/rr-gui"
contains "rr-gui --version" "rr-gui" "$ROOT/dist/clients/rr_bash-gui/bin/rr-gui" --version
contains "rr-gui obsahuje git menu" "screen_git_repo" cat "$ROOT/dist/clients/rr_bash-gui/bin/rr-gui"

echo "== rr-web (Node CLI + Web GUI) =="
RW="$ROOT/dist/clients/rr_web-guicli/bin/rr-web.js"
contains "rr-web status" '"m5ike"' node "$RW" status
contains "rr-web listRepos" '"internal"' node "$RW" listRepos
contains "rr-web createRepo" '"web-repo"' node "$RW" createRepo --body '{"name":"web-repo","type":"npm"}'
contains "rr-web uploadPackage" '"1.1.0"' node "$RW" uploadPackage web-repo --data "$TMP/e2e-hello-1.1.0.tgz"
contains "rr-web search" "@e2e/hello" node "$RW" search --query q=hello
contains "rr-web ops" "purgeCache" node "$RW" ops
WPORT="$(free_port)"
node "$RW" serve --port "$WPORT" --server "$RR_SERVER" >"$TMP/web.log" 2>&1 &
WEB_PID=$!
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$WPORT/" >/dev/null 2>&1 && break; sleep 0.25; done
contains "rr-web serve: GUI" "admin.js" curl -fsS "http://127.0.0.1:$WPORT/"
contains "rr-web serve: proxy API" '"rr-registry"' curl -fsS "http://127.0.0.1:$WPORT/api/v1/status"

echo "== Web GUI na serveru =="
contains "homepage" "rr_bash-cli" curl -fsS -H 'Accept: text/html' "$RR_SERVER/"
contains "admin" "RR Registry" curl -fsS "$RR_SERVER/admin/"
contains "rr-client.js pro prohlížeč" "root.RRClient" curl -fsS "$RR_SERVER/admin/rr-client.js"
contains "dokumentace API" "listRepos" curl -fsS "$RR_SERVER/docs/API.md"

echo "== Instalátor klientů =="
contains "install.sh" "Hotovo" bash -c "curl -fsSL '$RR_SERVER/install.sh' | HOME='$TMP/home' bash -s -- --prefix '$TMP/prefix' all"
check "nainstalovaný rr" "$TMP/prefix/bin/rr" version
check "nainstalovaný rr-web" "$TMP/prefix/bin/rr-web" version
check "nainstalovaný rr-gui" "$TMP/prefix/bin/rr-gui" --version
contains "odinstalace" "odinstalováno" bash -c "curl -fsSL '$RR_SERVER/install.sh' | bash -s -- --prefix '$TMP/prefix' --uninstall all"

echo "== Konfigurace (menuconfig --defaults) =="
contains "menuconfig --defaults" "Konfigurace uložena" env ENV_FILE="$TMP/test.env" bash scripts/menuconfig.sh --defaults
contains ".env obsahuje API token" "RR_API_TOKEN=rr_" cat "$TMP/test.env"

if [ $FAIL -gt 0 ]; then echo; echo "--- server log ---"; tail -20 "$TMP/server.log"; fi
summary

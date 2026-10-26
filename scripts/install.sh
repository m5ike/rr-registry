#!/usr/bin/env bash
# RR Registry - installation script. Maintainer: m5ike.
#   scripts/install.sh [--docker|--native] [--yes] [--clients]
#     --docker   run the web backend in Docker (default when docker is available)
#     --native   run directly with Node.js (installs a systemd unit on Linux when run as root)
#     --yes      non-interactive (generated passwords, no menuconfig)
#     --clients  install the client tools (rr, rr-gui, rr-web) into ~/.local/bin afterwards
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE=""; YES=0; CLIENTS=0
for a in "$@"; do
  case "$a" in
    --docker) MODE=docker ;; --native) MODE=native ;; --yes|-y) YES=1 ;; --clients) CLIENTS=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "neznámá volba $a" >&2; exit 1 ;;
  esac
done

ok() { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

echo "== RR Registry $(cat VERSION) – instalace =="
have_docker=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then have_docker=1; fi
fi
[ -z "$MODE" ] && { [ $have_docker = 1 ] && MODE=docker || MODE=native; }
ok "režim: $MODE"

command -v curl >/dev/null || die "chybí curl"
if [ "$MODE" = docker ]; then
  [ $have_docker = 1 ] || die "Docker (a docker compose) není dostupný nebo neběží"
  ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
else
  command -v node >/dev/null || die "chybí Node.js >= 18 (https://nodejs.org)"
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 18 ] || die "Node.js $major je příliš starý, potřeba >= 18"
  ok "node $(node -v)"
fi
command -v jq >/dev/null && ok "jq" || warn "jq není nainstalováno (doporučeno pro bash klienty)"
{ command -v whiptail >/dev/null || command -v dialog >/dev/null; } && ok "whiptail/dialog" || warn "whiptail/dialog chybí (potřeba pro make menuconfig GUI a rr-gui)"

if [ ! -f .env ]; then
  if [ $YES = 1 ] || [ ! -t 0 ]; then bash scripts/menuconfig.sh --defaults; else bash scripts/menuconfig.sh; fi
fi
[ -f .env ] || die "konfigurace .env nebyla vytvořena"
set -a; . ./.env; set +a
PORT="${RR_PORT:-4873}"
mkdir -p "${RR_DATA_PATH:-./data}"

node tools/build.js 2>/dev/null || warn "lokální sestavení klientů přeskočeno (sestaví se v Dockeru)"

if [ "$MODE" = docker ]; then
  make up
else
  if [ "$(id -u)" = 0 ] && command -v systemctl >/dev/null 2>&1; then
    cat >/etc/systemd/system/rr-registry.service <<UNIT
[Unit]
Description=RR Registry (m5ike)
After=network.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$(command -v node) $ROOT/server/bin/rr-server.js
Restart=on-failure
User=${SUDO_USER:-root}

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable --now rr-registry
    ok "systemd služba rr-registry spuštěna"
  else
    nohup node server/bin/rr-server.js >rr-registry.log 2>&1 &
    echo $! > .rr-registry.pid
    ok "server spuštěn na pozadí (PID $(cat .rr-registry.pid), log rr-registry.log)"
  fi
fi

printf '  čekám na server'
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$PORT/-/ping" >/dev/null 2>&1; then echo; ok "server odpovídá"; break; fi
  printf '.'; sleep 1
done
curl -fsS "http://localhost:$PORT/-/ping" >/dev/null 2>&1 || die "server neodpovídá na portu $PORT (make logs)"

if [ $CLIENTS = 1 ]; then
  curl -fsSL "http://localhost:$PORT/install.sh" | bash
fi

cat <<INFO

  RR Registry běží:     http://localhost:$PORT/
  Administrace:         http://localhost:$PORT/admin/   (uživatel ${RR_ADMIN_USER:-admin}, heslo v .env)
  npm:                  npm config set registry http://localhost:$PORT/
  Klienti:              curl -fsSL http://localhost:$PORT/install.sh | bash
  Konfigurace:          make menuconfig && make restart
INFO

#!/usr/bin/env bash
# RR Registry - update script. Maintainer: m5ike.
#   scripts/update.sh [--no-backup] [--no-pull] [--clients]
# Backs up data, pulls new sources (git), regenerates client libraries, rebuilds and restarts.
# Data in RR_DATA_PATH and .env are preserved; new client package versions are published on start.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BACKUP=1; PULL=1; CLIENTS=0
for a in "$@"; do
  case "$a" in --no-backup) BACKUP=0 ;; --no-pull) PULL=0 ;; --clients) CLIENTS=1 ;; *) echo "neznámá volba $a" >&2; exit 1 ;; esac
done
[ -f .env ] && { set -a; . ./.env; set +a; }
PORT="${RR_PORT:-4873}"
OLD="$(cat VERSION)"

echo "== RR Registry – aktualizace (aktuální verze $OLD) =="
[ $BACKUP = 1 ] && bash scripts/backup.sh
if [ $PULL = 1 ] && [ -d .git ] && git remote | grep -q .; then
  git pull --ff-only
fi
NEW="$(cat VERSION)"
node tools/build.js

if docker compose ps 2>/dev/null | grep -q rr-registry || docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${RR_CONTAINER:-rr-registry}$"; then
  make up
elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet rr-registry 2>/dev/null; then
  sudo systemctl restart rr-registry
elif [ -f .rr-registry.pid ] && kill -0 "$(cat .rr-registry.pid)" 2>/dev/null; then
  kill "$(cat .rr-registry.pid)"; sleep 1
  nohup node server/bin/rr-server.js >rr-registry.log 2>&1 & echo $! > .rr-registry.pid
else
  echo "Server neběží – spusťte: make up  (nebo make run)"
fi

for _ in $(seq 1 60); do curl -fsS "http://localhost:$PORT/-/ping" >/dev/null 2>&1 && break; sleep 1; done
if curl -fsS "http://localhost:$PORT/api/v1/status" >/dev/null 2>&1; then
  echo "Server běží, verze: $(curl -fsS "http://localhost:$PORT/api/v1/status" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)"
fi
[ $CLIENTS = 1 ] && curl -fsSL "http://localhost:$PORT/install.sh" | bash
echo "Aktualizace $OLD -> $NEW dokončena."

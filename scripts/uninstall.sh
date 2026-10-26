#!/usr/bin/env bash
# RR Registry - uninstall. Maintainer: m5ike.
#   scripts/uninstall.sh [--purge] [--clients]
#     --purge    also delete data directory, .env and the Docker image
#     --clients  also remove locally installed client tools (~/.local)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PURGE=0; CLIENTS=0
for a in "$@"; do case "$a" in --purge) PURGE=1 ;; --clients) CLIENTS=1 ;; esac; done
[ -f .env ] && { set -a; . ./.env; set +a; }

if command -v docker >/dev/null 2>&1; then
  (docker compose down 2>/dev/null || docker-compose down 2>/dev/null) || true
  [ $PURGE = 1 ] && docker image rm "m5ike/rr-registry:latest" 2>/dev/null || true
fi
if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/rr-registry.service ]; then
  sudo systemctl disable --now rr-registry || true
  sudo rm -f /etc/systemd/system/rr-registry.service
fi
if [ -f .rr-registry.pid ]; then kill "$(cat .rr-registry.pid)" 2>/dev/null || true; rm -f .rr-registry.pid; fi
if [ $CLIENTS = 1 ]; then bash clients/shared/install-clients.sh --uninstall all; fi
if [ $PURGE = 1 ]; then
  read -r -p "Smazat data ${RR_DATA_PATH:-./data} a .env? [y/N] " a
  if [ "$a" = y ]; then rm -rf "${RR_DATA_PATH:-./data}" .env dist; echo "data smazána"; fi
fi
echo "RR Registry odinstalován (zdrojové soubory zůstaly v $ROOT)."

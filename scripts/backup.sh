#!/usr/bin/env bash
# RR Registry - backup / restore of registry data and configuration. Maintainer: m5ike.
#   scripts/backup.sh                     -> backups/rr-backup-YYYYmmdd-HHMMSS.tar.gz
#   scripts/backup.sh --restore FILE      (stop the server first: make down)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] && { set -a; . ./.env; set +a; }
DATA="${RR_DATA_PATH:-./data}"
mkdir -p backups

if [ "${1:-}" = "--restore" ]; then
  f="${2:-}"; [ -f "$f" ] || { echo "zadejte existující soubor zálohy" >&2; exit 1; }
  [ -d "$DATA" ] && mv "$DATA" "$DATA.before-restore-$(date +%s)"
  mkdir -p "$DATA"
  tar -xzf "$f" -C "$DATA" --strip-components=2 ./data
  tar -xzf "$f" -C . ./.env 2>/dev/null || true
  echo "Obnoveno z $f do $DATA"
  exit 0
fi

out="backups/rr-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/data"
if [ -d "$DATA" ]; then
  # the cache is not needed in a backup
  (cd "$DATA" && tar --exclude=./cache -cf - .) | (cd "$stage/data" && tar -xf -)
fi
[ -f .env ] && cp .env "$stage/.env"
tar -czf "$out" -C "$stage" .
echo "Záloha: $out ($(du -h "$out" | cut -f1))"

#!/usr/bin/env bash
# RR Registry - client installer (served by the server at /install.sh). Maintainer: m5ike.
#
#   curl -fsSL __RR_SERVER__/install.sh | bash                      # all clients
#   curl -fsSL __RR_SERVER__/install.sh | bash -s -- rr_bash-cli    # selected clients
#   options: --prefix DIR (default ~/.local)   --uninstall
set -euo pipefail

SERVER="${RR_SERVER:-__RR_SERVER__}"
PREFIX="${PREFIX:-$HOME/.local}"
WANT=()
UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    all) WANT=(rr_bash-cli rr_bash-gui rr_web-guicli); shift ;;
    *) WANT+=("$1"); shift ;;
  esac
done
[ ${#WANT[@]} -gt 0 ] || WANT=(rr_bash-cli rr_bash-gui rr_web-guicli)

LIB="$PREFIX/lib/rr"
BIN="$PREFIX/bin"
mkdir -p "$LIB" "$BIN"

if [ "$UNINSTALL" = 1 ]; then
  for p in "${WANT[@]}"; do
    if [ -d "$LIB/$p" ]; then
      for b in "$LIB/$p"/bin/*; do rm -f "$BIN/$(basename "${b%.js}")"; done
      rm -rf "${LIB:?}/$p"
      echo "odinstalováno: $p"
    fi
  done
  exit 0
fi

command -v curl >/dev/null || { echo "potřebuji curl" >&2; exit 1; }
command -v tar >/dev/null || { echo "potřebuji tar" >&2; exit 1; }

echo "RR Registry klienti <- $SERVER"
INDEX="$(curl -fsSL "$SERVER/downloads/")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for p in "${WANT[@]}"; do
  file="$(printf '%s' "$INDEX" | tr ',' '\n' | sed -n "s/.*\"file\": *\"\(m5ike-${p}-[^\"]*\.tgz\)\".*/\1/p" | head -n1)"
  if [ -z "$file" ]; then echo "  ! balíček $p na serveru nenalezen" >&2; continue; fi
  curl -fsSL "$SERVER/downloads/$file" -o "$TMP/$file"
  rm -rf "${LIB:?}/$p"
  mkdir -p "$LIB/$p"
  tar -xzf "$TMP/$file" -C "$LIB/$p" --strip-components=1
  for b in "$LIB/$p"/bin/*; do
    chmod +x "$b"
    name="$(basename "$b")"; name="${name%.js}"
    ln -sf "$b" "$BIN/$name"
    echo "  ✔ $p -> $BIN/$name"
  done
done

CONF="${XDG_CONFIG_HOME:-$HOME/.config}/rr/config"
if [ ! -f "$CONF" ]; then
  mkdir -p "$(dirname "$CONF")"
  printf "RR_SERVER='%s'\nRR_TOKEN=''\nRR_USER=''\n" "$SERVER" >"$CONF"
  chmod 600 "$CONF"
  echo "  konfigurace: $CONF (server $SERVER)"
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "  Přidejte $BIN do PATH:  export PATH=\"$BIN:\$PATH\"" ;;
esac
echo "Hotovo. Vyzkoušejte: rr help | rr-gui | rr-web serve --open"

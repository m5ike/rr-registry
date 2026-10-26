#!/usr/bin/env bash
# rr-common.sh - shared helpers for rr (bash CLI) and rr-gui (bash GUI). Maintainer: m5ike.
# Configuration file: ${RR_CONFIG:-~/.config/rr/config}  (RR_SERVER, RR_TOKEN, RR_USER)

RR_CONFIG="${RR_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/rr/config}"

rr_config_load() {
  local env_server="${RR_SERVER:-}" env_token="${RR_TOKEN:-}"
  if [ -f "$RR_CONFIG" ]; then
    # shellcheck disable=SC1090
    . "$RR_CONFIG"
  fi
  # environment variables win over the config file
  [ -n "$env_server" ] && RR_SERVER="$env_server"
  [ -n "$env_token" ] && RR_TOKEN="$env_token"
  : "${RR_SERVER:=http://localhost:4873}"
  export RR_SERVER RR_TOKEN
}

rr_config_save() {
  mkdir -p "$(dirname "$RR_CONFIG")"
  umask 077
  {
    echo "# rr client configuration - $(date)"
    printf 'RR_SERVER=%q\n' "${RR_SERVER:-http://localhost:4873}"
    printf 'RR_TOKEN=%q\n' "${RR_TOKEN:-}"
    printf 'RR_USER=%q\n' "${RR_USER:-}"
  } >"$RR_CONFIG"
}

rr_have_jq() { command -v jq >/dev/null 2>&1; }

# Pretty print JSON from stdin (jq when available).
rr_json() {
  if rr_have_jq; then jq "${1:-.}"; else cat; fi
}

# JSON string escaping without jq.
rr_json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\t'/\\t}"; s="${s//$'\r'/\\r}"
  printf '"%s"' "$s"
}

# rr_json_obj key=value ...   (value "true"/"false"/numbers/[..]/{..} kept raw, prefix with = to force string)
rr_json_obj() {
  local out="" kv k v
  for kv in "$@"; do
    k="${kv%%=*}"; v="${kv#*=}"
    if [[ "$v" == =* ]]; then v=$(rr_json_str "${v#=}")
    elif [[ "$v" =~ ^(true|false|null|-?[0-9]+(\.[0-9]+)?)$ ]] || [[ "$v" == \[* ]] || [[ "$v" == \{* ]]; then :
    else v=$(rr_json_str "$v"); fi
    out+="${out:+,}$(rr_json_str "$k"):$v"
  done
  printf '{%s}' "$out"
}

rr_die() { echo "rr: $*" >&2; exit 1; }

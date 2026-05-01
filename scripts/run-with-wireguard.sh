#!/usr/bin/env bash
set -euo pipefail
conf=""
cleanup() {
  if [[ -n "$conf" && -f "$conf" ]]; then
    sudo wg-quick down "$conf" >/dev/null 2>&1 || true
    rm -f "$conf"
  fi
}
trap cleanup EXIT
if [[ -n "${WG_CONFIG_BASE64:-}" ]]; then
  umask 077
  conf=/tmp/wg-telecom-monthly.conf
  printf '%s' "$WG_CONFIG_BASE64" | base64 -d > "$conf"
  if ! command -v wg-quick >/dev/null 2>&1; then
    sudo apt-get update -y
    sudo apt-get install -y wireguard-tools resolvconf
  fi
  sudo wg-quick up "$conf"
  sudo wg show
else
  echo "WG_CONFIG_BASE64 not set; run without WireGuard."
fi
exec "$@"

#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${WG_CONFIG_BASE64:-}" ]]; then
  echo "WG_CONFIG_BASE64 not set; skip WireGuard setup."
  exit 0
fi
umask 077
conf=/tmp/wg-telecom-monthly.conf
printf '%s' "$WG_CONFIG_BASE64" | base64 -d > "$conf"
if ! command -v wg-quick >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y wireguard-tools resolvconf
fi
sudo wg-quick up "$conf"
trap 'sudo wg-quick down "$conf" >/dev/null 2>&1 || true' EXIT
sudo wg show
# Keep the tunnel up for the rest of this step. In GitHub Actions each step is a process;
# callers should source this script in the same shell or run the claim command from here.

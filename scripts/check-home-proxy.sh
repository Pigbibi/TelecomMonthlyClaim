#!/usr/bin/env bash
set -euo pipefail

proxy_url="${1:-${HOME_PROXY_URL:-}}"
health_url="${2:-${HOME_PROXY_HEALTH_URL:-https://wapbj.189.cn/}}"

if [[ -z "${proxy_url}" ]]; then
  echo "No home proxy configured; skipping proxy health check."
  exit 0
fi

case "${proxy_url}" in
  http://*|https://*|socks4://*|socks4a://*|socks5://*|socks5h://*) ;;
  *)
    echo "Unsupported proxy URL scheme." >&2
    exit 2
    ;;
esac

if ! curl -sSI \
  --proxy "${proxy_url}" \
  --connect-timeout "${HOME_PROXY_CONNECT_TIMEOUT:-8}" \
  --max-time "${HOME_PROXY_MAX_TIME:-20}" \
  "${health_url}" >/dev/null; then
  curl -fsS \
    --proxy "${proxy_url}" \
    --connect-timeout "${HOME_PROXY_CONNECT_TIMEOUT:-8}" \
    --max-time "${HOME_PROXY_MAX_TIME:-20}" \
    -o /dev/null \
    "${health_url}"
fi

echo "Home proxy check passed."

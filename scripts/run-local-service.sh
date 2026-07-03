#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env.local"
  set +a
elif [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

service="${1:-}"

case "$service" in
  sms-inbox)
    exec node scripts/sms-inbox-server.js
    ;;
  home-proxy)
    exec node scripts/home-http-proxy.js
    ;;
  home-claim-runner)
    exec node scripts/home-claim-runner.js
    ;;
  bwg-tunnel)
    : "${BWG_SSH_HOST:?Missing BWG_SSH_HOST in .env.local}"
    BWG_SSH_USER="${BWG_SSH_USER:-root}"
    BWG_SSH_PORT="${BWG_SSH_PORT:-22}"
    BWG_SSH_KEY="${BWG_SSH_KEY:-$HOME/.ssh/bwg_20260501}"
    SMS_INBOX_PORT="${SMS_INBOX_PORT:-8787}"
    HOME_PROXY_PORT="${HOME_PROXY_PORT:-13128}"
    BWG_SMS_PORT="${BWG_SMS_PORT:-18787}"
    BWG_HOME_PROXY_PORT="${BWG_HOME_PROXY_PORT:-13128}"
    HOME_CLAIM_RUNNER_PORT="${HOME_CLAIM_RUNNER_PORT:-19090}"
    BWG_HOME_CLAIM_RUNNER_PORT="${BWG_HOME_CLAIM_RUNNER_PORT:-19090}"

    if [ ! -r "$BWG_SSH_KEY" ]; then
      echo "SSH key not readable: $BWG_SSH_KEY" >&2
      exit 1
    fi

    exec ssh -i "$BWG_SSH_KEY" \
      -p "$BWG_SSH_PORT" \
      -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      -o StrictHostKeyChecking=accept-new \
      -N \
      -R "127.0.0.1:${BWG_SMS_PORT}:127.0.0.1:${SMS_INBOX_PORT}" \
      -R "127.0.0.1:${BWG_HOME_PROXY_PORT}:127.0.0.1:${HOME_PROXY_PORT}" \
      -R "127.0.0.1:${BWG_HOME_CLAIM_RUNNER_PORT}:127.0.0.1:${HOME_CLAIM_RUNNER_PORT}" \
      "${BWG_SSH_USER}@${BWG_SSH_HOST}"
    ;;
  *)
    echo "Usage: $0 {sms-inbox|home-proxy|home-claim-runner|bwg-tunnel}" >&2
    exit 2
    ;;
esac

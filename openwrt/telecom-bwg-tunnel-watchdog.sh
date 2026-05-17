#!/bin/sh
set -u

CONFIG="${TELECOM_CONFIG:-/etc/telecom-monthly-claim.env}"
TAG="telecom-bwg-watchdog"

log() {
  logger -t "$TAG" "$*" 2>/dev/null || true
  echo "$*"
}

run_with_timeout() {
  seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

load_config() {
  [ -r "$CONFIG" ] || {
    log "missing config: $CONFIG"
    return 1
  }
  . "$CONFIG"

  BWG_SSH_HOST="${BWG_SSH_HOST:?Missing BWG_SSH_HOST}"
  BWG_SSH_USER="${BWG_SSH_USER:-root}"
  BWG_SSH_PORT="${BWG_SSH_PORT:-22}"
  BWG_SSH_KEY="${BWG_SSH_KEY:-/root/.ssh/telecom_bwg_key}"
  BWG_SMS_PORT="${BWG_SMS_PORT:-18787}"
  BWG_HOME_PROXY_PORT="${BWG_HOME_PROXY_PORT:-13128}"
  SSH_CLIENT_BIN="${SSH_CLIENT_BIN:-ssh}"

  if [ "$SSH_CLIENT_BIN" = "auto" ]; then
    if command -v ssh >/dev/null 2>&1; then
      SSH_CLIENT_BIN="ssh"
    elif command -v dbclient >/dev/null 2>&1; then
      SSH_CLIENT_BIN="dbclient"
    fi
  fi
}

local_services_ok() {
  /etc/init.d/tinyproxy running >/dev/null 2>&1 || return 1
  curl -sSI --proxy "http://127.0.0.1:$(. "$CONFIG"; printf '%s' "${ROUTER_PROXY_PORT:-8888}")" \
    --connect-timeout 5 --max-time 12 https://wapbj.189.cn/ >/dev/null || return 1
}

remote_tunnel_ok() {
  [ "$(basename "$SSH_CLIENT_BIN")" = "ssh" ] || return 1
  [ -r "$BWG_SSH_KEY" ] || return 1

  remote_cmd="curl -sS --connect-timeout 5 --max-time 12 -o /dev/null http://127.0.0.1:${BWG_SMS_PORT}/cgi-bin/telecom-sms-health && curl -sSI --proxy http://127.0.0.1:${BWG_HOME_PROXY_PORT} --connect-timeout 5 --max-time 15 https://wapbj.189.cn/ >/dev/null"
  run_with_timeout 35 "$SSH_CLIENT_BIN" \
    -i "$BWG_SSH_KEY" \
    -p "$BWG_SSH_PORT" \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    -o StrictHostKeyChecking=accept-new \
    "${BWG_SSH_USER}@${BWG_SSH_HOST}" \
    "$remote_cmd" >/dev/null 2>&1
}

load_config || exit 1

changed=0
if ! local_services_ok; then
  log "local tinyproxy path is unhealthy; restarting tinyproxy"
  /etc/init.d/tinyproxy restart >/dev/null 2>&1 || true
  changed=1
fi

if ! /etc/init.d/telecom-bwg-tunnel running >/dev/null 2>&1; then
  log "telecom-bwg-tunnel is not running; restarting"
  /etc/init.d/telecom-bwg-tunnel restart >/dev/null 2>&1 || true
  changed=1
fi

if ! remote_tunnel_ok; then
  log "remote BWG tunnel probe failed; restarting telecom-bwg-tunnel"
  /etc/init.d/telecom-bwg-tunnel restart >/dev/null 2>&1 || true
  sleep 5
  if ! remote_tunnel_ok; then
    log "remote BWG tunnel probe still failed after restart"
    exit 1
  fi
  changed=1
fi

if [ "$changed" -eq 0 ]; then
  :
fi

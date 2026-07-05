#!/bin/sh
set -u

OVERALL=0
TMP_FILE="/tmp/repo-proxy-status.$$"
trap 'rm -f "$TMP_FILE"' EXIT INT TERM

ok() { printf 'ok   %s\n' "$1"; }
fail() { printf 'fail %s\n' "$1"; OVERALL=1; }
skip() { printf 'skip %s\n' "$1"; }

run_check() {
  label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    ok "$label"
  else
    fail "$label"
  fi
}

run_optional_service_check() {
  label="$1"
  service="$2"
  if [ -x "/etc/init.d/$service" ] && "/etc/init.d/$service" enabled >/dev/null 2>&1; then
    run_check "$label" service_running "$service"
  else
    skip "$label"
  fi
}

service_enabled() {
  [ -x "/etc/init.d/$1" ] && "/etc/init.d/$1" enabled >/dev/null 2>&1
}

service_running() {
  [ -x "/etc/init.d/$1" ] && "/etc/init.d/$1" running >/dev/null 2>&1
}

has_listener() {
  pattern="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -lntp 2>/dev/null | grep -F "$pattern" >/dev/null 2>&1
  else
    netstat -lntp 2>/dev/null | grep -F "$pattern" >/dev/null 2>&1
  fi
}

tinyproxy_http_ok() {
  curl -sSI --proxy http://127.0.0.1:8888 \
    --connect-timeout 5 \
    --max-time 15 \
    https://wapbj.189.cn/ >"$TMP_FILE" 2>/dev/null
}

tinyproxy_connect_policy_ok() {
  config_file="/var/etc/tinyproxy.conf"
  [ -r "$config_file" ] || return 1
  ! grep -q '^ConnectPort[[:space:]]' "$config_file"
}

tinyproxy_behavior_port_ok() {
  curl -ksS --proxy http://127.0.0.1:8888 \
    --connect-timeout 5 \
    --max-time 15 \
    https://bigdata-behaviordata.189.cn:9002/ >"$TMP_FILE" 2>/dev/null
}

schwab_vps_connection_ok() {
  # The Schwab/GitHub-hosted proxy tunnel is healthy when the dbclient SSH
  # connection managed by schwab-vps-router-tunnel is established.
  netstat -tnp 2>/dev/null | grep -F 'ESTABLISHED' | grep -F 'dbclient' >/dev/null 2>&1
}

telecom_remote_tunnel_ok() {
  config="${TELECOM_CONFIG:-/etc/telecom-monthly-claim.env}"
  [ -r "$config" ] || return 1
  # shellcheck disable=SC1090
  . "$config"

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
    else
      return 1
    fi
  fi

  [ "$(basename "$SSH_CLIENT_BIN")" = "ssh" ] || return 1
  [ -r "$BWG_SSH_KEY" ] || return 1

  remote_cmd="curl -sS --connect-timeout 5 --max-time 12 -o /dev/null http://127.0.0.1:${BWG_SMS_PORT}/cgi-bin/telecom-sms-health && curl -sSI --proxy http://127.0.0.1:${BWG_HOME_PROXY_PORT} --connect-timeout 5 --max-time 15 https://wapbj.189.cn/ >/dev/null"
  "$SSH_CLIENT_BIN" \
    -i "$BWG_SSH_KEY" \
    -p "$BWG_SSH_PORT" \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    -o StrictHostKeyChecking=accept-new \
    "${BWG_SSH_USER}@${BWG_SSH_HOST}" \
    "$remote_cmd"
}

business_remote_listener_ok() {
  config="$1"
  public_port_var="$2"
  default_public_port="$3"
  bwg_config="${BWG_TCP_FALLBACK_CONFIG:-/etc/bwg-tcp-fallback.env}"

  [ -r "$bwg_config" ] || return 1
  # shellcheck disable=SC1090
  . "$bwg_config"
  [ -r "$config" ] || return 1
  # shellcheck disable=SC1090
  . "$config"

  BWG_SSH_HOST="${BWG_SSH_HOST:?Missing BWG_SSH_HOST}"
  BWG_SSH_USER="${BWG_SSH_USER:-root}"
  BWG_SSH_PORT="${BWG_SSH_PORT:-22}"
  BWG_SSH_KEY="${BWG_SSH_KEY:-/root/.ssh/telecom_bwg_key}"
  SSH_CLIENT_BIN="${SSH_CLIENT_BIN:-ssh}"
  eval "public_port=\"\${$public_port_var:-$default_public_port}\""

  case "$public_port" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$(basename "$SSH_CLIENT_BIN")" = "ssh" ] || return 1
  [ -r "$BWG_SSH_KEY" ] || return 1

  "$SSH_CLIENT_BIN" \
    -i "$BWG_SSH_KEY" \
    -p "$BWG_SSH_PORT" \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    -o StrictHostKeyChecking=accept-new \
    "${BWG_SSH_USER}@${BWG_SSH_HOST}" \
    "ss -lnt 2>/dev/null | grep -E '[:.]${public_port}[[:space:]]' >/dev/null"
}

franchise_lead_remote_listener_ok() {
  business_remote_listener_ok \
    "${FRANCHISE_LEAD_ROUTER_PROXY_CONFIG:-/etc/franchise-lead-router-proxy.env}" \
    FRANCHISE_LEAD_REMOTE_PUBLIC_PORT \
    35747
}

job_platform_remote_listener_ok() {
  business_remote_listener_ok \
    "${JOB_PLATFORM_ROUTER_PROXY_CONFIG:-/etc/job-platform-router-proxy.env}" \
    JOB_PLATFORM_REMOTE_PUBLIC_PORT \
    35746
}

printf 'repo-proxy-status %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || date)"
printf '\n[router services]\n'
run_check 'tinyproxy service' service_running tinyproxy
run_check 'telecom-bwg-tunnel service' service_running telecom-bwg-tunnel
run_check 'schwab-vps-router-tunnel service' service_running schwab-vps-router-tunnel
run_check 'bwg-tcp-fallback service' service_running bwg-tcp-fallback
run_check 'bwg-tcp-transparent service' service_running bwg-tcp-transparent
run_optional_service_check 'franchise lead proxy tunnel service' franchise-lead-router-proxy-tunnel
run_optional_service_check 'job platform proxy tunnel service' job-platform-router-proxy-tunnel

printf '\n[local listeners]\n'
run_check 'tinyproxy 127.0.0.1:8888 listener' has_listener '127.0.0.1:8888'
run_check 'BWG mixed proxy :10809 listener' has_listener ':10809'
run_check 'BWG transparent :11090 listener' has_listener ':11090'
if service_enabled franchise-lead-router-proxy-tunnel; then
  run_check 'franchise lead local proxy :18088 listener' has_listener ':18088'
else
  skip 'franchise lead local proxy :18088 listener'
fi

printf '\n[path probes]\n'
run_check 'tinyproxy -> wapbj.189.cn path' tinyproxy_http_ok
run_check 'tinyproxy unrestricted CONNECT ports' tinyproxy_connect_policy_ok
run_check 'tinyproxy -> behavior data :9002 path' tinyproxy_behavior_port_ok
run_check 'Telecom BWG reverse tunnel endpoints' telecom_remote_tunnel_ok
if service_enabled franchise-lead-router-proxy-tunnel; then
  run_check 'Franchise lead remote public listener' franchise_lead_remote_listener_ok
else
  skip 'Franchise lead remote public listener'
fi
if service_enabled job-platform-router-proxy-tunnel; then
  run_check 'Job platform remote public listener' job_platform_remote_listener_ok
else
  skip 'Job platform remote public listener'
fi
run_check 'Schwab VPS router tunnel TCP connection' schwab_vps_connection_ok

printf '\n[notes]\n'
printf '%s\n' 'Guangzhou/Guangdong workflow proxy 127.0.0.1:11080 runs on the self-hosted runner; check it there with browser-proxy-watchdog.'
printf '%s\n' 'Business remote listener checks verify BWG-side ports only; repository workflows still perform their own proxy auth and target-site health checks.'
printf '%s\n' 'This script is read-only and does not restart services.'

exit "$OVERALL"

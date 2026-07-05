#!/usr/bin/env bash
set -euo pipefail

mode="${HOME_PROXY_MODE:-bwg}"
proxy_url="${HOME_PROXY_URL:-http://127.0.0.1:13128}"
health_url="${HOME_PROXY_HEALTH_URL:-https://wapbj.189.cn/}"
output_file="${GITHUB_OUTPUT:-/dev/null}"
env_file="${GITHUB_ENV:-/dev/null}"

write_output() {
  printf '%s=%s\n' "$1" "$2" >>"${output_file}"
}

write_env() {
  printf '%s=%s\n' "$1" "$2" >>"${env_file}"
}

redacted_proxy() {
  python3 - "$1" <<'PY'
import re, sys
raw = sys.argv[1]
print(re.sub(r'(//)([^/@:]+:[^/@]+@)', r'\1***:***@', raw))
PY
}

case "${mode}" in
  bwg|direct|proxy_pool|none) ;;
  *)
    echo "Unsupported HOME_PROXY_MODE: ${mode}" >&2
    exit 2
    ;;
esac

if [[ "${mode}" == "none" ]]; then
  write_output proxy-url ""
  write_output proxy-server ""
  write_output proxy-source none
  write_output proxy-ready false
  echo "Home proxy disabled by mode=none."
  exit 0
fi

if [[ "${mode}" == "direct" ]]; then
  if [[ "${proxy_url}" == "http://127.0.0.1:13128" || "${proxy_url}" == "http://localhost:13128" ]]; then
    proxy_url=""
  elif [[ -n "${proxy_url}" ]]; then
    bash "$(dirname "$0")/check-home-proxy.sh" "${proxy_url}" "${health_url}"
  fi
  write_env OPENWRT_HTTP_PROXY "${proxy_url}"
  write_output proxy-url "${proxy_url}"
  write_output proxy-server "${proxy_url}"
  write_output proxy-source direct
  write_output proxy-ready "$([[ -n "${proxy_url}" ]] && echo true || echo false)"
  echo "Direct mode selected; home proxy URL $( [[ -n "${proxy_url}" ]] && echo configured || echo cleared )."
  exit 0
fi

if [[ "${mode}" == "proxy_pool" ]]; then
  proxy_url="${PROXY_POOL_HTTP_PROXY:-}"
  if [[ -z "${proxy_url}" ]]; then
    echo "Missing PROXY_POOL_HTTP_PROXY for proxy_pool mode." >&2
    exit 1
  fi
  bash "$(dirname "$0")/check-home-proxy.sh" "${proxy_url}" "${health_url}"
  write_env OPENWRT_HTTP_PROXY "${proxy_url}"
  write_output proxy-url "${proxy_url}"
  write_output proxy-server "${proxy_url}"
  write_output proxy-source proxy-pool
  write_output proxy-ready true
  echo "Proxy pool mode selected; proxy $(redacted_proxy "${proxy_url}") verified."
  exit 0
fi

: "${BWG_SSH_HOST:?Missing BWG_SSH_HOST}"
: "${BWG_SSH_PRIVATE_KEY:?Missing BWG_SSH_PRIVATE_KEY}"

local_proxy_port="${HOME_PROXY_LOCAL_PORT:-13128}"
remote_proxy_endpoint="${HOME_PROXY_REMOTE_ENDPOINT:-127.0.0.1:13128}"
include_sms="${HOME_PROXY_INCLUDE_SMS_TUNNEL:-false}"
local_sms_port="${HOME_PROXY_LOCAL_SMS_PORT:-18787}"
remote_sms_endpoint="${HOME_PROXY_REMOTE_SMS_ENDPOINT:-127.0.0.1:18787}"
attempts="${HOME_PROXY_ATTEMPTS:-3}"
allow_direct_fallback="${HOME_PROXY_ALLOW_DIRECT_FALLBACK:-false}"

tmp_root="${RUNNER_TEMP:-/tmp}/home-proxy-tunnel"
mkdir -p "${tmp_root}" ~/.ssh
chmod 700 ~/.ssh
key_file="${tmp_root}/bwg_key"
printf '%s\n' "${BWG_SSH_PRIVATE_KEY}" >"${key_file}"
chmod 600 "${key_file}"

if [[ -n "${BWG_KNOWN_HOSTS:-}" ]]; then
  printf '%s\n' "${BWG_KNOWN_HOSTS}" > ~/.ssh/known_hosts
else
  ssh-keyscan -p "${BWG_SSH_PORT:-22}" -H "${BWG_SSH_HOST}" >> ~/.ssh/known_hosts 2>/dev/null
fi

forwards=(-L "127.0.0.1:${local_proxy_port}:${remote_proxy_endpoint}")
if [[ "${include_sms}" =~ ^(1|true|yes|on)$ ]]; then
  forwards=(-L "127.0.0.1:${local_sms_port}:${remote_sms_endpoint}" "${forwards[@]}")
fi

close_tunnel() {
  pkill -f "ssh .*127[.]0[.]0[.]1:${local_proxy_port}:${remote_proxy_endpoint//./[.]}" >/dev/null 2>&1 || true
}

ssh_log="${tmp_root}/ssh.log"
proxy_url="http://127.0.0.1:${local_proxy_port}"
tunnel_pid=""
proxy_ok=false
for attempt in $(seq 1 "${attempts}"); do
  echo "Opening BWG home proxy tunnel (${attempt}/${attempts})..."
  close_tunnel
  : >"${ssh_log}"
  nohup ssh -i "${key_file}" \
    -p "${BWG_SSH_PORT:-22}" \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -N \
    "${forwards[@]}" \
    "${BWG_SSH_USER:-root}@${BWG_SSH_HOST}" \
    >"${ssh_log}" 2>&1 &

  tunnel_pid=$!
  sleep 2
  if ! kill -0 "${tunnel_pid}" >/dev/null 2>&1; then
    echo "BWG home proxy tunnel exited early." >&2
    sed -E 's#(IdentityFile | -i )[^ ]+#\1<key>#g' "${ssh_log}" >&2 || true
  elif HOME_PROXY_URL="${proxy_url}" bash "$(dirname "$0")/check-home-proxy.sh" "${proxy_url}" "${health_url}"; then
    proxy_ok=true
    break
  else
    echo "BWG home proxy verification failed." >&2
  fi

  if [[ "${attempt}" != "${attempts}" ]]; then
    sleep $((attempt * 5))
  fi
done

if [[ "${proxy_ok}" != "true" ]]; then
  if [[ "${allow_direct_fallback}" =~ ^(1|true|yes|on)$ ]]; then
    write_env OPENWRT_HTTP_PROXY ""
    write_output proxy-url ""
    write_output proxy-server ""
    write_output proxy-source direct-fallback
    write_output proxy-ready false
    echo "BWG home proxy did not recover; continuing without OPENWRT_HTTP_PROXY."
    exit 0
  fi
  close_tunnel
  rm -f "${key_file}"
  exit 1
fi

write_env OPENWRT_HTTP_PROXY "${proxy_url}"
write_env HOME_PROXY_TUNNEL_PID "${tunnel_pid}"
write_env HOME_PROXY_TUNNEL_KEY_FILE "${key_file}"
write_output proxy-url "${proxy_url}"
write_output proxy-server "${proxy_url}"
write_output proxy-source bwg-tunnel
write_output proxy-ready true
write_output tunnel-pid "${tunnel_pid}"
write_output key-file "${key_file}"

echo "BWG home proxy tunnel started on ${proxy_url}."

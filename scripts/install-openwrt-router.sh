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
fi

ROUTER_SSH_TARGET="${ROUTER_SSH_TARGET:-root@192.168.5.1}"
ROUTER_SSH_KEY="${ROUTER_SSH_KEY:-}"
ROUTER_PROXY_PORT="${ROUTER_PROXY_PORT:-8888}"
ROUTER_UHTTPD_PORT="${ROUTER_UHTTPD_PORT:-80}"
BWG_SSH_HOST="${BWG_SSH_HOST:?Missing BWG_SSH_HOST in .env.local}"
BWG_SSH_USER="${BWG_SSH_USER:-root}"
BWG_SSH_PORT="${BWG_SSH_PORT:-22}"
BWG_SSH_KEY="${BWG_SSH_KEY:-$HOME/.ssh/bwg_20260501}"
BWG_SMS_PORT="${BWG_SMS_PORT:-18787}"
BWG_HOME_PROXY_PORT="${BWG_HOME_PROXY_PORT:-13128}"
SMS_INBOX_TOKEN="${SMS_INBOX_TOKEN:?Missing SMS_INBOX_TOKEN in .env.local}"
OPENWRT_BWG_KEY="${OPENWRT_BWG_KEY:-$HOME/.ssh/telecom_openwrt_bwg}"

router_ssh=(ssh)
router_scp=(scp -O)
if [ -n "$ROUTER_SSH_KEY" ]; then
  router_ssh+=(-i "$ROUTER_SSH_KEY")
  router_scp+=(-i "$ROUTER_SSH_KEY")
fi

if [ ! -f "$OPENWRT_BWG_KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "telecom-openwrt-bwg" -f "$OPENWRT_BWG_KEY"
fi
chmod 600 "$OPENWRT_BWG_KEY"

pub_key="$(cat "${OPENWRT_BWG_KEY}.pub")"

echo "Adding dedicated OpenWrt key to BWG authorized_keys..."
ssh -i "$BWG_SSH_KEY" -p "$BWG_SSH_PORT" "${BWG_SSH_USER}@${BWG_SSH_HOST}" \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && grep -qxF '$pub_key' ~/.ssh/authorized_keys || echo '$pub_key' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env"' EXIT
cat > "$tmp_env" <<EOF
SMS_INBOX_TOKEN='$SMS_INBOX_TOKEN'
SMS_INBOX_FILE='/tmp/telecom-sms-inbox.jsonl'
BWG_SSH_HOST='$BWG_SSH_HOST'
BWG_SSH_USER='$BWG_SSH_USER'
BWG_SSH_PORT='$BWG_SSH_PORT'
BWG_SSH_KEY='/root/.ssh/telecom_bwg_key'
BWG_SMS_PORT='$BWG_SMS_PORT'
BWG_HOME_PROXY_PORT='$BWG_HOME_PROXY_PORT'
ROUTER_UHTTPD_PORT='$ROUTER_UHTTPD_PORT'
ROUTER_PROXY_HOST='127.0.0.1'
ROUTER_PROXY_PORT='$ROUTER_PROXY_PORT'
SSH_CLIENT_BIN='auto'
EOF

echo "Copying files to OpenWrt router ${ROUTER_SSH_TARGET}..."
"${router_ssh[@]}" "$ROUTER_SSH_TARGET" 'mkdir -p /root/.ssh /usr/libexec /www/cgi-bin /etc/init.d && chmod 700 /root/.ssh'
"${router_scp[@]}" "$OPENWRT_BWG_KEY" "$ROUTER_SSH_TARGET:/root/.ssh/telecom_bwg_key"
"${router_scp[@]}" "$tmp_env" "$ROUTER_SSH_TARGET:/etc/telecom-monthly-claim.env"
"${router_scp[@]}" openwrt/telecom-sms-inbox.cgi "$ROUTER_SSH_TARGET:/usr/libexec/telecom-sms-inbox.cgi"
"${router_scp[@]}" openwrt/telecom-bwg-tunnel.init "$ROUTER_SSH_TARGET:/etc/init.d/telecom-bwg-tunnel"
"${router_scp[@]}" openwrt/telecom-bwg-tunnel-watchdog.sh "$ROUTER_SSH_TARGET:/usr/bin/telecom-bwg-tunnel-watchdog"

"${router_ssh[@]}" "$ROUTER_SSH_TARGET" <<'REMOTE'
set -eu
chmod 600 /root/.ssh/telecom_bwg_key /etc/telecom-monthly-claim.env
chmod 755 /usr/libexec/telecom-sms-inbox.cgi /etc/init.d/telecom-bwg-tunnel /usr/bin/telecom-bwg-tunnel-watchdog
cat > /www/cgi-bin/telecom-sms-health <<'EOF'
#!/bin/sh
exec /usr/libexec/telecom-sms-inbox.cgi health
EOF
cat > /www/cgi-bin/telecom-sms <<'EOF'
#!/bin/sh
exec /usr/libexec/telecom-sms-inbox.cgi sms
EOF
cat > /www/cgi-bin/telecom-messages <<'EOF'
#!/bin/sh
exec /usr/libexec/telecom-sms-inbox.cgi messages
EOF
chmod 755 /www/cgi-bin/telecom-sms-health /www/cgi-bin/telecom-sms /www/cgi-bin/telecom-messages
if ! command -v tinyproxy >/dev/null 2>&1; then
  opkg update
  opkg install tinyproxy
fi
uci -q set tinyproxy.@tinyproxy[0].enabled='1'
uci -q set tinyproxy.@tinyproxy[0].Listen='127.0.0.1'
uci -q set tinyproxy.@tinyproxy[0].Port="$(. /etc/telecom-monthly-claim.env; printf '%s' "$ROUTER_PROXY_PORT")"
uci commit tinyproxy
/etc/init.d/tinyproxy enable
/etc/init.d/tinyproxy restart
if ! command -v ssh >/dev/null 2>&1 || ssh -V 2>&1 | grep -qi dropbear; then
  opkg update
  opkg install openssh-client
fi
/etc/init.d/telecom-bwg-tunnel enable
/etc/init.d/telecom-bwg-tunnel restart
(crontab -l 2>/dev/null | grep -v '/usr/bin/telecom-bwg-tunnel-watchdog' || true; echo '*/2 * * * * /usr/bin/telecom-bwg-tunnel-watchdog >/dev/null 2>&1') | crontab -
/usr/bin/telecom-bwg-tunnel-watchdog || true
REMOTE

echo "OpenWrt install done."
echo "Use these GitHub secrets with router mode:"
echo "  SMS_INBOX_URL=http://127.0.0.1:18787/cgi-bin/telecom-messages"
echo "  SMS_INBOX_HEALTH_URL=http://127.0.0.1:18787/cgi-bin/telecom-sms-health"
echo "  OPENWRT_HTTP_PROXY=http://127.0.0.1:13128"

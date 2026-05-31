#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BWG_SSH_HOST="${BWG_SSH_HOST:?Missing BWG_SSH_HOST}"
BWG_SSH_USER="${BWG_SSH_USER:-root}"
BWG_SSH_PORT="${BWG_SSH_PORT:-22}"
BWG_SSH_KEY="${BWG_SSH_KEY:-$HOME/.ssh/bwg_20260501}"
PUBLIC_PORT="${TELECOM_PUBLIC_WEBHOOK_PORT:-18789}"

ssh_cmd=(ssh -i "$BWG_SSH_KEY" -p "$BWG_SSH_PORT" "${BWG_SSH_USER}@${BWG_SSH_HOST}")
scp_cmd=(scp -i "$BWG_SSH_KEY" -P "$BWG_SSH_PORT")

"${ssh_cmd[@]}" 'mkdir -p /opt/telecom-public-webhook'
"${scp_cmd[@]}" "$REPO_ROOT/bwg/telecom-public-webhook-proxy.py" "${BWG_SSH_USER}@${BWG_SSH_HOST}:/opt/telecom-public-webhook/proxy.py"

"${ssh_cmd[@]}" "PUBLIC_PORT='$PUBLIC_PORT'" 'bash -s' <<'REMOTE'
set -euo pipefail
chmod 755 /opt/telecom-public-webhook/proxy.py
cat > /etc/systemd/system/telecom-public-webhook.service <<EOF
[Unit]
Description=Telecom public SMS webhook proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=TELECOM_PUBLIC_WEBHOOK_HOST=0.0.0.0
Environment=TELECOM_PUBLIC_WEBHOOK_PORT=${PUBLIC_PORT}
Environment=TELECOM_UPSTREAM_HOST=127.0.0.1
Environment=TELECOM_UPSTREAM_PORT=18787
ExecStart=/usr/bin/python3 /opt/telecom-public-webhook/proxy.py
Restart=always
RestartSec=5
User=root
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now telecom-public-webhook.service
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port=${PUBLIC_PORT}/tcp
  firewall-cmd --reload
fi
systemctl --no-pager --full status telecom-public-webhook.service | sed -n '1,40p'
ss -lntp | grep ":${PUBLIC_PORT}" || true
REMOTE

echo "Public webhook URL: http://${BWG_SSH_HOST}:${PUBLIC_PORT}/telecom-sms?token=<SMS_INBOX_TOKEN>"

#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is for macOS launchd only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/TelecomMonthlyClaim"
DOMAIN="gui/$(id -u)"

mkdir -p "$AGENTS_DIR" "$LOG_DIR"
chmod +x "$REPO_ROOT/scripts/run-local-service.sh"

if [ ! -f "$REPO_ROOT/.env.local" ]; then
  echo "Missing $REPO_ROOT/.env.local; copy .env.example and fill local secrets first." >&2
  exit 1
fi

for required_key in SMS_INBOX_TOKEN BWG_SSH_HOST; do
  if ! grep -q "^${required_key}=" "$REPO_ROOT/.env.local"; then
    echo "Missing ${required_key} in .env.local" >&2
    exit 1
  fi
done

write_plist() {
  local label="$1"
  local service="$2"
  local plist="$AGENTS_DIR/${label}.plist"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${REPO_ROOT}/scripts/run-local-service.sh</string>
    <string>${service}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/${label}.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/${label}.err.log</string>
</dict>
</plist>
EOF
}

install_one() {
  local label="$1"
  local service="$2"
  local plist="$AGENTS_DIR/${label}.plist"

  write_plist "$label" "$service"
  launchctl bootout "$DOMAIN" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "$DOMAIN" "$plist"
  echo "Started ${label}; logs: ${LOG_DIR}/${label}.out.log / ${LOG_DIR}/${label}.err.log"
}

install_one "com.lisiyi.telecom-sms-inbox" "sms-inbox"
install_one "com.lisiyi.telecom-home-proxy" "home-proxy"
install_one "com.lisiyi.telecom-home-claim-runner" "home-claim-runner"
install_one "com.lisiyi.telecom-bwg-tunnel" "bwg-tunnel"

echo
echo "Installed launchd services:"
launchctl print "$DOMAIN" | grep -E "com\\.lisiyi\\.telecom-(sms-inbox|home-proxy|bwg-tunnel)" || true

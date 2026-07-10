#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${TELECOM_CDP_PORT:-9222}"
OS_NAME="$(uname -s)"
KEEP_CDP_OPEN="${TELECOM_KEEP_CDP_OPEN:-false}"
SKIP_ENTRY_VALIDATION="${TELECOM_SKIP_ENTRY_VALIDATION:-false}"

export BROWSER_CDP_URL="${BROWSER_CDP_URL:-http://127.0.0.1:${PORT}}"
export TELECOM_REQUIRE_REAL_CHROME="${TELECOM_REQUIRE_REAL_CHROME:-true}"
export TELECOM_MINIMAL_LOGIN="${TELECOM_MINIMAL_LOGIN:-true}"
export TELECOM_SKIP_ORIGIN_WARMUP="${TELECOM_SKIP_ORIGIN_WARMUP:-true}"
export TELECOM_CDP_PROFILE_MODE="${TELECOM_CDP_PROFILE_MODE:-native}"
export TELECOM_SLIDER_MODE="${TELECOM_SLIDER_MODE:-api}"
export TELECOM_KEEP_VALIDATED_PAGE_OPEN="${TELECOM_KEEP_VALIDATED_PAGE_OPEN:-true}"
export TELECOM_REUSE_VALIDATED_PAGE="${TELECOM_REUSE_VALIDATED_PAGE:-true}"
export SEND_CODE_ATTEMPTS="${SEND_CODE_ATTEMPTS:-1}"

if [ "${TELECOM_MINIMAL_LOGIN}" = "true" ] && [ "${TELECOM_ALLOW_MULTI_SEND_RETRY:-false}" != "true" ]; then
  export SEND_CODE_ATTEMPTS=1
fi

if [ "$OS_NAME" = "Darwin" ]; then
  export TELECOM_USE_DEFAULT_CHROME="${TELECOM_USE_DEFAULT_CHROME:-1}"
  START_SCRIPT="$ROOT_DIR/scripts/start-chrome-cdp.sh"
else
  START_SCRIPT="$ROOT_DIR/scripts/start-chrome-cdp-linux.sh"
fi

start_output=''
if ! start_output="$("$START_SCRIPT" 2>&1)"; then
  printf '%s\n' "$start_output"
  exit 1
fi
printf '%s\n' "$start_output"

CHROME_CDP_PID="$(printf '%s\n' "$start_output" | sed -n 's/^CHROME_CDP_PID=//p' | tail -1)"
XVFB_PID="$(printf '%s\n' "$start_output" | sed -n 's/^XVFB_PID=//p' | tail -1)"

if [ -n "${GITHUB_ENV:-}" ]; then
  if [ -n "$CHROME_CDP_PID" ]; then
    echo "CHROME_CDP_PID=$CHROME_CDP_PID" >> "$GITHUB_ENV"
  fi
  if [ -n "$XVFB_PID" ]; then
    echo "XVFB_PID=$XVFB_PID" >> "$GITHUB_ENV"
  fi
fi

cleanup() {
  local status=$?
  if [ "$KEEP_CDP_OPEN" != "true" ]; then
    if [ -n "$CHROME_CDP_PID" ]; then
      kill "$CHROME_CDP_PID" 2>/dev/null || true
    fi
    if [ -n "$XVFB_PID" ]; then
      kill "$XVFB_PID" 2>/dev/null || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

curl -sf "$BROWSER_CDP_URL/json/version" >/dev/null

if [ "$SKIP_ENTRY_VALIDATION" != "true" ]; then
  node "$ROOT_DIR/scripts/validate-entry-page.js"
fi

node "$ROOT_DIR/scripts/telecom-monthly-claim.js"

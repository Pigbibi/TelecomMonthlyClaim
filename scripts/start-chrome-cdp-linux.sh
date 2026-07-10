#!/usr/bin/env bash
# Linux/CI: real Google Chrome with minimal CDP flags only.
# Avoid anti-detect / window-size flags that diverge from a normal Chrome process.
set -euo pipefail

PROFILE="${TELECOM_CHROME_PROFILE:-${HOME:-/tmp}/.telecom-claim-cdp}"
PORT="${TELECOM_CDP_PORT:-9222}"
PROXY="${OPENWRT_HTTP_PROXY:-${HTTP_PROXY:-}}"
HEADLESS="${TELECOM_CDP_HEADLESS:-false}"
DISPLAY_VALUE="${DISPLAY:-${TELECOM_XVFB_DISPLAY:-:99}}"
XVFB_SCREEN="${TELECOM_XVFB_SCREEN:-1366x768x24}"
DISABLE_EXTENSIONS="${TELECOM_DISABLE_CHROME_EXTENSIONS:-true}"
FORCE_FRESH="${TELECOM_FORCE_FRESH_CDP_SESSION:-true}"
PROFILE_TEMP=false

if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  if [ "$FORCE_FRESH" = "1" ] || [ "$FORCE_FRESH" = "true" ]; then
    echo "Fresh Chrome session requested; stopping existing CDP session on ${PORT} ..."
    pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true
    sleep 1
  else
    echo "Chrome CDP already listening on ${PORT} (profile: ${PROFILE})"
    exit 0
  fi
fi

if [ -z "${TELECOM_CHROME_PROFILE:-}" ] && { [ "$FORCE_FRESH" = "1" ] || [ "$FORCE_FRESH" = "true" ]; }; then
  PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/telecom-claim-cdp.XXXXXX")"
  PROFILE_TEMP=true
fi
mkdir -p "$PROFILE"

ensure_xvfb() {
  if [ "$(uname -s)" != "Linux" ] || [ "$HEADLESS" = "true" ]; then
    return 0
  fi
  if [ -n "${DISPLAY:-}" ]; then
    echo "Using existing DISPLAY=${DISPLAY}"
    return 0
  fi
  if ! command -v Xvfb >/dev/null 2>&1; then
    echo "Xvfb is required for headed Chrome CDP on Linux but was not found" >&2
    exit 1
  fi

  echo "Starting Xvfb on ${DISPLAY_VALUE} (${XVFB_SCREEN})"
  Xvfb "${DISPLAY_VALUE}" -screen 0 "${XVFB_SCREEN}" -ac +extension RANDR >/tmp/telecom-xvfb.log 2>&1 &
  XVFB_PID=$!
  export DISPLAY="${DISPLAY_VALUE}"
  echo "XVFB_PID=${XVFB_PID}"
  if [ -n "${GITHUB_ENV:-}" ]; then
    echo "DISPLAY=${DISPLAY_VALUE}" >> "$GITHUB_ENV"
    echo "XVFB_PID=${XVFB_PID}" >> "$GITHUB_ENV"
  fi

  for _ in $(seq 1 20); do
    if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
      echo "Xvfb exited before becoming ready" >&2
      tail -n 40 /tmp/telecom-xvfb.log >&2 || true
      exit 1
    fi
    if command -v xdpyinfo >/dev/null 2>&1 && xdpyinfo -display "${DISPLAY_VALUE}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "Xvfb did not become ready on ${DISPLAY_VALUE}" >&2
  tail -n 40 /tmp/telecom-xvfb.log >&2 || true
  exit 1
}

ensure_xvfb

CHROME_BIN="${TELECOM_CHROME_BIN:-}"
if [ -z "$CHROME_BIN" ]; then
  for candidate in \
    google-chrome-stable \
    google-chrome \
    chromium-browser \
    chromium \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  do
    if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
      CHROME_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$CHROME_BIN" ]; then
  echo "No Chrome/Chromium binary found for CDP" >&2
  exit 1
fi

# Keep flags minimal. Only add what the environment actually requires.
ARGS=(
  --remote-debugging-port="${PORT}"
  --user-data-dir="${PROFILE}"
)

if [ -n "$PROXY" ]; then
  ARGS+=(--proxy-server="$PROXY")
fi
if [ "$DISABLE_EXTENSIONS" = "1" ] || [ "$DISABLE_EXTENSIONS" = "true" ]; then
  ARGS+=(--disable-extensions --disable-component-extensions-with-background-pages)
fi

# GitHub Actions Linux runners need --no-sandbox under the default user.
if [ "$(uname -s)" = "Linux" ]; then
  ARGS+=(--no-sandbox)
fi

if [ "$HEADLESS" = "true" ]; then
  ARGS+=(--headless=new)
fi

ARGS+=(about:blank)

echo "Starting Chrome CDP via ${CHROME_BIN} on port ${PORT} (minimal flags)"
"$CHROME_BIN" "${ARGS[@]}" >/tmp/telecom-chrome-cdp.log 2>&1 &
CHROME_PID=$!
echo "CHROME_CDP_PID=${CHROME_PID}"
echo "CHROME_CDP_PROFILE_DIR=${PROFILE}"
echo "CHROME_CDP_PROFILE_TEMP=${PROFILE_TEMP}"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "CHROME_CDP_PID=${CHROME_PID}" >> "$GITHUB_ENV"
fi

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome CDP ready on ${PORT} via ${CHROME_BIN} (profile: ${PROFILE})"
    exit 0
  fi
  sleep 1
done

echo "Chrome CDP failed to start on port ${PORT}" >&2
tail -n 40 /tmp/telecom-chrome-cdp.log >&2 || true
kill "$CHROME_PID" 2>/dev/null || true
exit 1

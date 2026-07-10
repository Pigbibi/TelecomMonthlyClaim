#!/usr/bin/env bash
# macOS: start Chrome for claim CDP with the closest-to-real profile possible.
#
# Modes:
#   TELECOM_USE_DEFAULT_CHROME=1  (default if no TELECOM_CHROME_PROFILE)
#     Copy the user's Default Chrome profile into ~/.telecom-claim-chrome-real
#     and launch that copy with ONLY --remote-debugging-port.
#     (Directly attaching CDP to the live Default profile is unreliable on macOS
#     because Chrome often ignores the flag / SingletonLock fights.)
#
#   TELECOM_CHROME_PROFILE=/path
#     Launch a separate profile dir with CDP only.
set -euo pipefail
PORT="${TELECOM_CDP_PORT:-9222}"
PROFILE="${TELECOM_CHROME_PROFILE:-}"
USE_DEFAULT="${TELECOM_USE_DEFAULT_CHROME:-}"
CHROME_BIN="${TELECOM_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
REAL_COPY="${TELECOM_REAL_PROFILE_COPY:-$HOME/.telecom-claim-chrome-real}"
SRC_PROFILE="${TELECOM_SRC_CHROME_PROFILE:-$HOME/Library/Application Support/Google/Chrome}"
DISABLE_EXTENSIONS="${TELECOM_DISABLE_CHROME_EXTENSIONS:-true}"
FORCE_FRESH="${TELECOM_FORCE_FRESH_CDP_SESSION:-true}"
PROFILE_TEMP=false

if [ -z "$USE_DEFAULT" ] && [ -z "$PROFILE" ]; then
  USE_DEFAULT=1
fi

if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  if [ "$FORCE_FRESH" = "1" ] || [ "$FORCE_FRESH" = "true" ]; then
    echo "Fresh Chrome session requested; stopping existing CDP session on ${PORT} ..."
    pkill -f "remote-debugging-port=${PORT}" 2>/dev/null || true
    sleep 1
  else
    echo "Chrome CDP already listening on ${PORT}"
    curl -sf "http://127.0.0.1:${PORT}/json/version" | head -c 200; echo
    pgrep -lf "remote-debugging-port=${PORT}" | head -1 || true
    exit 0
  fi
fi

if [ ! -x "$CHROME_BIN" ]; then
  echo "Chrome binary not found: $CHROME_BIN" >&2
  exit 1
fi

# Stop any Chrome that would fight the profile / port.
if pgrep -x "Google Chrome" >/dev/null 2>&1; then
  echo "Quitting running Google Chrome..."
  osascript -e 'tell application "Google Chrome" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    if ! pgrep -x "Google Chrome" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  pkill -x "Google Chrome" 2>/dev/null || true
  sleep 1
fi

ARGS=(--remote-debugging-port="${PORT}" --remote-allow-origins=*)
if [ -n "${OPENWRT_HTTP_PROXY:-}" ]; then
  ARGS+=(--proxy-server="${OPENWRT_HTTP_PROXY}")
fi
if [ "$DISABLE_EXTENSIONS" = "1" ] || [ "$DISABLE_EXTENSIONS" = "true" ]; then
  # The copied real profile may contain content-script extensions that inject on all pages
  # and perturb Telecom's anti-bot checks. Keep profile cookies/storage, but launch without extensions.
  ARGS+=(--disable-extensions --disable-component-extensions-with-background-pages)
fi

if [ "$USE_DEFAULT" = "1" ] || [ "$USE_DEFAULT" = "true" ]; then
  if [ -z "${TELECOM_REAL_PROFILE_COPY:-}" ] && { [ "$FORCE_FRESH" = "1" ] || [ "$FORCE_FRESH" = "true" ]; }; then
    REAL_COPY="$(mktemp -d "${TMPDIR:-/tmp}/telecom-claim-chrome-real.XXXXXX")"
    PROFILE_TEMP=true
  fi
  echo "Syncing real Chrome profile into ${REAL_COPY} ..."
  mkdir -p "$REAL_COPY/Default"
  if [ -d "$SRC_PROFILE/Default" ]; then
    rsync -a \
      --exclude 'Cache' --exclude 'Code Cache' --exclude 'GPUCache' \
      --exclude 'Service Worker/CacheStorage' --exclude 'ShaderCache' \
      --exclude 'GrShaderCache' --exclude 'Crashpad' --exclude 'BrowserMetrics' \
      "$SRC_PROFILE/Default/" "$REAL_COPY/Default/" >/dev/null
  fi
  cp -f "$SRC_PROFILE/Local State" "$REAL_COPY/" 2>/dev/null || true
  rm -f "$REAL_COPY/SingletonLock" "$REAL_COPY/SingletonSocket" "$REAL_COPY/SingletonCookie" 2>/dev/null || true
  ARGS+=(--user-data-dir="${REAL_COPY}")
  echo "Starting real-profile copy with CDP only: ${ARGS[*]}"
else
  if [ -z "${TELECOM_CHROME_PROFILE:-}" ] && { [ "$FORCE_FRESH" = "1" ] || [ "$FORCE_FRESH" = "true" ]; }; then
    PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/telecom-claim-profile.XXXXXX")"
    PROFILE_TEMP=true
  fi
  mkdir -p "$PROFILE"
  ARGS+=(--user-data-dir="${PROFILE}")
  echo "Starting separate-profile Chrome with CDP only: ${ARGS[*]}"
fi

nohup "$CHROME_BIN" "${ARGS[@]}" >/tmp/telecom-chrome-cdp.log 2>&1 &
echo "CHROME_CDP_PID=$!"
if [ "$USE_DEFAULT" = "1" ] || [ "$USE_DEFAULT" = "true" ]; then
  echo "CHROME_CDP_PROFILE_DIR=${REAL_COPY}"
else
  echo "CHROME_CDP_PROFILE_DIR=${PROFILE}"
fi
echo "CHROME_CDP_PROFILE_TEMP=${PROFILE_TEMP}"
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "CHROME_CDP_PID=$!" >> "$GITHUB_ENV"
fi

for _ in $(seq 1 45); do
  if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "Chrome CDP ready on ${PORT}"
    pgrep -lf "remote-debugging-port=${PORT}" | head -1 || true
    exit 0
  fi
  sleep 1
done
echo "Chrome CDP failed to start on port ${PORT}" >&2
tail -n 40 /tmp/telecom-chrome-cdp.log >&2 || true
exit 1

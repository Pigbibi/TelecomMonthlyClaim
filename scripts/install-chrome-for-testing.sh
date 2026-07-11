#!/usr/bin/env bash
set -euo pipefail

case "$(uname -m)" in
  arm64) platform="mac-arm64" ;;
  x86_64) platform="mac-x64" ;;
  *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
esac

cache_root="${TELECOM_CFT_CACHE_DIR:-$HOME/Library/Caches/telecom-chrome-for-testing}"
binary="$cache_root/$platform/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
if [ -x "$binary" ]; then
  printf '%s\n' "$binary"
  exit 0
fi

mkdir -p "$cache_root"
metadata="$(mktemp "${TMPDIR:-/tmp}/chrome-for-testing.XXXXXX.json")"
archive="$(mktemp "${TMPDIR:-/tmp}/chrome-for-testing.XXXXXX.zip")"
extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/chrome-for-testing.XXXXXX")"
cleanup() {
  rm -f "$metadata" "$archive"
  rm -rf "$extract_dir"
}
trap cleanup EXIT

curl -fsSL --retry 3 --retry-delay 2 \
  'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json' \
  -o "$metadata"
download_url="$(node - "$metadata" "$platform" <<'NODE'
const fs = require('node:fs');
const [file, platform] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const item = data.channels?.Stable?.downloads?.chrome?.find(entry => entry.platform === platform);
if (!item?.url) process.exit(1);
process.stdout.write(item.url);
NODE
)"
curl -fsSL --retry 3 --retry-delay 2 "$download_url" -o "$archive"
ditto -x -k "$archive" "$extract_dir"
rm -rf "$cache_root/$platform"
mv "$extract_dir/chrome-$platform" "$cache_root/$platform"
test -x "$binary"
printf '%s\n' "$binary"

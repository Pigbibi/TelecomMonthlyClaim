#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
if [ "${1:-}" = "--state-only" ]; then
  node "$script_dir/sync-claim-state.js" persist "${RUN_LOG_STATE_FILE:?Missing monthly state file}"
elif [ "${RUN_LOG_STATUS:-}" = "success" ]; then
  printf 'Last success: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >> "${GITHUB_STEP_SUMMARY:?Missing job summary}"
fi

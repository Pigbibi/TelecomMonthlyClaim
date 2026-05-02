#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_TOKEN:?Missing GITHUB_TOKEN}"
: "${GITHUB_REPOSITORY:?Missing GITHUB_REPOSITORY}"
: "${GITHUB_RUN_ID:?Missing GITHUB_RUN_ID}"
: "${GITHUB_WORKFLOW:?Missing GITHUB_WORKFLOW}"

branch="${RUN_LOG_BRANCH:-logs}"
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

repo_url="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"

git init "$workdir" >/dev/null
cd "$workdir"
git remote add origin "$repo_url"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git fetch --depth=1 origin "$branch"
  git checkout -B "$branch" FETCH_HEAD
else
  git checkout --orphan "$branch"
  git rm -rf . >/dev/null 2>&1 || true
  cat > README.md <<'EOF'
# TelecomMonthlyClaim run logs

This branch stores sanitized GitHub Actions heartbeat and workflow run metadata.
It intentionally does not store phone numbers, SMS codes, tokens, or telecom page contents.
EOF
fi

generated_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
day="$(date -u +%Y-%m-%d)"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"

mkdir -p "runs/${day}"
log_file="runs/${day}/${GITHUB_RUN_ID}-${run_attempt}.json"

RUN_LOG_FILE="$log_file" RUN_LOG_GENERATED_AT="$generated_at" node <<'NODE'
const fs = require('node:fs');

const env = process.env;
const runUrl = `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;

const data = {
  generatedAt: env.RUN_LOG_GENERATED_AT,
  kind: env.RUN_LOG_KIND || 'workflow',
  repository: env.GITHUB_REPOSITORY,
  workflow: env.GITHUB_WORKFLOW,
  runId: env.GITHUB_RUN_ID,
  runNumber: env.GITHUB_RUN_NUMBER || '',
  runAttempt: env.GITHUB_RUN_ATTEMPT || '1',
  runUrl,
  eventName: env.GITHUB_EVENT_NAME || '',
  refName: env.GITHUB_REF_NAME || '',
  sha: env.GITHUB_SHA || '',
  actor: env.GITHUB_ACTOR || '',
  status: env.RUN_LOG_STATUS || 'unknown',
  claimOutcome: env.RUN_LOG_CLAIM_OUTCOME || 'unknown',
  forceRun: env.RUN_LOG_FORCE_RUN || '',
  dryRun: env.RUN_LOG_DRY_RUN || '',
};

fs.writeFileSync(env.RUN_LOG_FILE, `${JSON.stringify(data, null, 2)}\n`);
fs.writeFileSync('latest.json', `${JSON.stringify(data, null, 2)}\n`);
NODE

git add README.md latest.json runs
git commit -m "Record workflow run ${GITHUB_RUN_ID}" >/dev/null

for attempt in 1 2 3; do
  if git push origin HEAD:"$branch"; then
    echo "Recorded run log on ${branch}: ${log_file}"
    exit 0
  fi
  if [ "$attempt" -lt 3 ]; then
    git fetch --depth=20 origin "$branch"
    git rebase "origin/$branch"
  fi
done

echo "Failed to push run log to ${branch}" >&2
exit 1

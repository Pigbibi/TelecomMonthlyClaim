#!/usr/bin/env node
const fs = require('node:fs');
const { readClaimStateStatus } = require('../src/claim-state');

function resolveClaimOutcome({ shouldRun, stepOutcome, stateStatus, dryRun = false, probeOnly = false }) {
  if (probeOnly && stepOutcome === 'success') return 'probe';
  if (stepOutcome && !['success', 'skipped'].includes(stepOutcome)) return stepOutcome;
  if (dryRun) return stepOutcome || 'skipped';
  if (shouldRun && stateStatus) return stateStatus;
  return stepOutcome || 'skipped';
}

function appendOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) {
    console.log(`${name}=${value}`);
    return;
  }
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function main() {
  const outcome = resolveClaimOutcome({
    shouldRun: process.env.SHOULD_RUN === 'true',
    stepOutcome: process.env.STEP_OUTCOME || 'skipped',
    stateStatus: readClaimStateStatus(process.env.STATE_FILE || ''),
    dryRun: process.env.DRY_RUN === 'true',
    probeOnly: process.env.PROBE_ONLY === 'true',
  });
  appendOutput('claim_outcome', outcome);
}

if (require.main === module) {
  main();
}

module.exports = { resolveClaimOutcome };

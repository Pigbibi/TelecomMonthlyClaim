#!/usr/bin/env node
const fs = require('node:fs');

function readStateStatus(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) return '';
  try {
    const status = JSON.parse(fs.readFileSync(stateFile, 'utf8')).status;
    return typeof status === 'string' ? status : '';
  } catch {
    return '';
  }
}

function resolveClaimOutcome({ shouldRun, stepOutcome, stateStatus }) {
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
    stateStatus: readStateStatus(process.env.STATE_FILE || ''),
  });
  appendOutput('claim_outcome', outcome);
}

if (require.main === module) {
  main();
}

module.exports = { readStateStatus, resolveClaimOutcome };

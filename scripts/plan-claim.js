#!/usr/bin/env node
const fs = require('node:fs');
const { claimStateFile, readClaimStateStatus } = require('../src/claim-state');

function appendOutput(name, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function decideClaimPlan({ forceRun, stateStatus, stateFile }) {
  const alreadySuccessful = stateStatus === 'success';
  return {
    shouldRun: forceRun || !alreadySuccessful,
    stateFile,
  };
}

function main() {
  const forceRun = /^true$/i.test(process.env.FORCE_RUN || '');
  const stateFile = claimStateFile();
  const { shouldRun } = decideClaimPlan({
    forceRun,
    stateStatus: readClaimStateStatus(stateFile),
    stateFile,
  });

  appendOutput('should_run', shouldRun ? 'true' : 'false');
  appendOutput('state_file', stateFile);

  if (!shouldRun) {
    console.log(`State ${stateFile} already records success; skip external tunnel. Set FORCE_RUN=true to override.`);
  } else if (forceRun) {
    console.log('FORCE_RUN=true; claim will run even if state already records success.');
  } else {
    console.log(`No successful state found in ${stateFile}; claim will run.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { decideClaimPlan };

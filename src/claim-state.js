const fs = require('node:fs');
const { stateMonth } = require('./retry-date');

// The claim CLI, the logs-branch sync and the workflow plan step all address
// monthly state through this path; a second spelling silently splits history.
function claimStateFileName(month = stateMonth()) {
  return `${month}.json`;
}

function claimStateFile(month = stateMonth(), directory = 'state') {
  return `${directory}/${claimStateFileName(month)}`;
}

function readClaimStateStatus(file) {
  if (!file || !fs.existsSync(file)) return '';
  try {
    const status = JSON.parse(fs.readFileSync(file, 'utf8')).status;
    return typeof status === 'string' ? status : '';
  } catch {
    return '';
  }
}

function isSoftTerminalStatus(status) {
  return status === 'skipped_unavailable' || status === 'success';
}

function shouldWriteFailureState(priorStatus) {
  return !isSoftTerminalStatus(priorStatus);
}

module.exports = {
  claimStateFileName,
  claimStateFile,
  readClaimStateStatus,
  shouldWriteFailureState,
  isSoftTerminalStatus,
};

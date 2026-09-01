const fs = require('node:fs');

function readClaimStateStatus(file) {
  if (!file || !fs.existsSync(file)) return '';
  try {
    return String(JSON.parse(fs.readFileSync(file, 'utf8')).status || '');
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

module.exports = { readClaimStateStatus, shouldWriteFailureState, isSoftTerminalStatus };

const fs = require('node:fs');

function readClaimStateStatus(file) {
  if (!file || !fs.existsSync(file)) return '';
  try {
    return String(JSON.parse(fs.readFileSync(file, 'utf8')).status || '');
  } catch {
    return '';
  }
}

function shouldWriteFailureState(priorStatus) {
  return priorStatus !== 'success';
}

module.exports = { readClaimStateStatus, shouldWriteFailureState };

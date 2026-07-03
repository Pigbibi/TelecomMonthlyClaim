const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readStateStatus, resolveClaimOutcome } = require('../scripts/resolve-run-log-outcome');

test('uses state status for attempted claim even when workflow step is green', () => {
  assert.equal(resolveClaimOutcome({
    shouldRun: true,
    stepOutcome: 'success',
    stateStatus: 'failed',
  }), 'failed');
});

test('keeps skipped outcome when claim was not attempted', () => {
  assert.equal(resolveClaimOutcome({
    shouldRun: false,
    stepOutcome: 'skipped',
    stateStatus: 'success',
  }), 'skipped');
});

test('reads status from monthly state file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-state-'));
  const file = path.join(dir, '2026-07.json');
  fs.writeFileSync(file, JSON.stringify({ status: 'failed' }));

  assert.equal(readStateStatus(file), 'failed');
});

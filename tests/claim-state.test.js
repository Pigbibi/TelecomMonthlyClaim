const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readClaimStateStatus, shouldWriteFailureState } = require('../src/claim-state');
const { stateMonth } = require('../src/retry-date');

test('preserves a prior monthly success when a forced repeat fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ status: 'success' }));

  assert.equal(readClaimStateStatus(file), 'success');
  assert.equal(shouldWriteFailureState('success'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allows failed state for missing or non-successful prior state', () => {
  assert.equal(readClaimStateStatus('/missing/telecom-state.json'), '');
  assert.equal(shouldWriteFailureState(''), true);
  assert.equal(shouldWriteFailureState('failed'), true);
});

test('records an explicit already-claimed page as success without launching a browser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-already-claimed-'));
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/telecom-monthly-claim.js')], {
    cwd: dir,
    env: {
      ...process.env,
      TELECOM_PHONE: '18500000000',
      TELECOM_ENTRY_URL: 'https://example.test/entry',
      TELECOM_ALREADY_CLAIMED: 'true',
      FORCE_RUN: 'true',
    },
    stdio: 'pipe',
  });

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state', `${stateMonth()}.json`), 'utf8'));
  assert.equal(state.status, 'success');
  assert.equal(state.successEvidence, 'already_claimed_page');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('does not mutate state for an already-claimed dry run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-already-claimed-dry-'));
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/telecom-monthly-claim.js')], {
    cwd: dir,
    env: {
      ...process.env,
      TELECOM_PHONE: '18500000000',
      TELECOM_ENTRY_URL: 'https://example.test/entry',
      TELECOM_ALREADY_CLAIMED: 'true',
      DRY_RUN_BEFORE_FINAL_SUBMIT: 'true',
      FORCE_RUN: 'true',
    },
    stdio: 'pipe',
  });

  assert.equal(fs.existsSync(path.join(dir, 'state')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

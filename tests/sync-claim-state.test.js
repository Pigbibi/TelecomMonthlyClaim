const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreState, exportState } = require('../scripts/sync-claim-state');

const month = '2026-10';
const targetPackage = 'voice200';
const success = { status: 'success', month, targetPackage, successEvidence: 'sms_receipt' };
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-state-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function gitState(state) {
  return args => {
    if (args[0] === 'fetch') return '';
    if (args[0] === 'ls-tree') return state !== null ? `state/${month}.json\n` : '';
    if (args[0] === 'show') return typeof state === 'string' ? state : JSON.stringify(state);
    throw new Error('Unexpected git command');
  };
}

test('restores confirmed success before deciding to claim and strips sensitive fields', t => {
  const directory = temp(t);
  const state = restoreState({ month, targetPackage, directory,
    runGit: gitState({ ...success, phone: 'synthetic-private', error: 'synthetic-secret', body: 'synthetic-SMS' }) });
  assert.deepEqual(state, success);
  const file = path.join(directory, `${month}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), success);
  assert.equal(require('../src/claim-state').readClaimStateStatus(file), 'success');
});

test('missing remote and legacy state allows a new month', t => {
  const directory = temp(t);
  assert.equal(restoreState({ month, targetPackage, directory, runGit: gitState(null) }), null);
  assert.equal(fs.existsSync(path.join(directory, `${month}.json`)), false);
});

test('migrates legacy success and never replaces it with failed state', t => {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, `${month}.json`), JSON.stringify(success));
  assert.deepEqual(restoreState({ month, targetPackage, directory,
    runGit: gitState({ ...success, status: 'failed' }) }), success);
});

test('remote read failure stops even with legacy success and hides git error details', t => {
  const directory = temp(t);
  fs.writeFileSync(path.join(directory, `${month}.json`), JSON.stringify(success));
  assert.throws(() => restoreState({ month, targetPackage, directory,
    runGit: () => { throw new Error('synthetic-private-token'); } }),
  /^Error: Unable to read monthly state from logs; claim stopped\.$/);
});

test('corrupt remote state and mismatched package or month stop the claim', t => {
  const directory = temp(t);
  for (const state of ['', '{broken', 'null', { ...success, targetPackage: '5g' }, { ...success, month: '2026-09' }]) {
    assert.throws(() => restoreState({ month, targetPackage, directory, runGit: gitState(state) }), /claim stopped/);
  }
});

test('exports only safe fields and preserves prior confirmed success', t => {
  const dir = temp(t);
  const source = path.join(dir, `${month}.json`);
  const destination = path.join(dir, 'logs', 'state', `${month}.json`);
  fs.writeFileSync(source, JSON.stringify({ ...success, error: 'synthetic-secret' }));
  exportState(source, destination, { targetPackage });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), success);
  fs.writeFileSync(source, JSON.stringify({ ...success, status: 'failed' }));
  exportState(source, destination, { targetPackage });
  assert.deepEqual(JSON.parse(fs.readFileSync(destination)), success);
});

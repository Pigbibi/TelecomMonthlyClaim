const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const planScript = path.join(root, 'scripts/plan-claim.js');
const { decideClaimPlan } = require('../scripts/plan-claim');
const month = require('../src/retry-date').stateMonth();

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-private-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, 'checkout');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(checkout);
  fs.mkdirSync(bin);
  const ledger = path.join(directory, 'ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ months: {} }));
  fs.writeFileSync(path.join(bin, 'gcloud'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'storage') process.exit(2);
if (args[1] === 'objects') process.stdout.write('1');
else if (args[1] === 'cat') process.stdout.write(fs.readFileSync(process.env.TEST_LEDGER));
else if (args[1] === 'cp') {
  if (process.env.TEST_REJECT_WRITE === 'true' || !args.includes('--if-generation-match=1')) process.exit(1);
  fs.copyFileSync(args[2], process.env.TEST_LEDGER);
} else process.exit(2);
`, { mode: 0o755 });
  return { checkout, ledger, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
    TEST_LEDGER: ledger, PRIVATE_STATE_BUCKET: 'synthetic-private-state',
    TELECOM_TARGET_PACKAGE: 'voice200', RUN_LOG_STATE_FILE: `state/${month}.json`,
    FORCE_RUN: 'false', GITHUB_OUTPUT: path.join(directory, 'output') } };
}

test('persists private state and the next workflow skips claiming', t => {
  const { env, checkout, ledger } = fixture(t);
  fs.mkdirSync(path.join(checkout, 'state'));
  const stateFile = path.join(checkout, `state/${month}.json`);
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'success', month, targetPackage: 'voice200',
    successEvidence: 'sms_receipt', error: 'synthetic-private' }));
  execFileSync('bash', [path.join(root, 'scripts/write-run-log-branch.sh'), '--state-only'],
    { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.rmSync(path.join(checkout, 'state'), { recursive: true });
  execFileSync(process.execPath, [path.join(root, 'scripts/sync-claim-state.js'), 'restore'], { cwd: checkout, env });
  execFileSync(process.execPath, [planScript], { cwd: checkout, env });
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /should_run=false/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile)).status, 'success');
  assert.doesNotMatch(fs.readFileSync(ledger, 'utf8'), /synthetic-private/);
  // A later failure cannot replace a prior success.
  fs.writeFileSync(stateFile, JSON.stringify({ status: 'failed', month, targetPackage: 'voice200' }));
  execFileSync('bash', [path.join(root, 'scripts/write-run-log-branch.sh'), '--state-only'],
    { cwd: checkout, env });
  assert.equal(JSON.parse(fs.readFileSync(ledger)).months[month].status, 'success');
});

test('force run overrides a recorded success in the plan step', () => {
  const stateFile = `state/${month}.json`;
  assert.equal(decideClaimPlan({ forceRun: false, stateStatus: 'success', stateFile }).shouldRun, false);
  assert.equal(decideClaimPlan({ forceRun: true, stateStatus: 'success', stateFile }).shouldRun, true);
  assert.equal(decideClaimPlan({ forceRun: false, stateStatus: '', stateFile }).shouldRun, true);
});

test('private state write rejection fails and keeps local success', t => {
  const { env, checkout } = fixture(t);
  fs.mkdirSync(path.join(checkout, 'state'));
  const file = path.join(checkout, `state/${month}.json`);
  fs.writeFileSync(file, JSON.stringify({ status: 'success', month, targetPackage: 'voice200' }));
  const result = spawnSync('bash', [path.join(root, 'scripts/write-run-log-branch.sh'), '--state-only'],
    { cwd: checkout, env: { ...env, TEST_REJECT_WRITE: 'true' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /gs:\/\/|synthetic-private-state/);
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'success');
});

test('missing private storage stops restore before the claim decision', t => {
  const { env, checkout, ledger } = fixture(t);
  fs.unlinkSync(ledger);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/sync-claim-state.js'), 'restore'],
    { cwd: checkout, env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /claim stopped/);
  assert.equal(fs.existsSync(env.GITHUB_OUTPUT), false);
});

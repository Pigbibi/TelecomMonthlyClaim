const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/monthly-claim.yml'), 'utf8');
const plan = workflow.split('      - name: Decide whether claim is needed')[1]
  .split('        run: |\n')[1].split('\n      - ')[0]
  .split('\n').map(line => line.replace(/^          /, '')).join('\n');
const month = require('../src/retry-date').stateMonth();
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-state-workflow-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const remote = path.join(directory, 'remote.git');
  const checkout = path.join(directory, 'checkout');
  fs.mkdirSync(checkout);
  const git = (...args) => execFileSync(realGit, args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '--bare', remote);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Synthetic Test');
  git('config', 'user.email', 'synthetic@example.test');
  git('remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(checkout, 'README.md'), 'Synthetic state test\n');
  git('add', 'README.md');
  git('commit', '-m', 'Synthetic main');
  git('checkout', '--orphan', 'logs');
  git('commit', '-m', 'Synthetic logs');
  git('push', 'origin', 'logs');
  git('checkout', 'main');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin);
  // Only the fixture writer's remote URL is redirected; no GitHub calls occur.
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
if [ "$1" = remote ] && [ "$2" = add ] && [ "$3" = origin ]; then
  exec "$TEST_REAL_GIT" remote add origin "$TEST_LOCAL_REMOTE"
fi
if [ "$1" = push ] && [ "\${TEST_REJECT_PUSH:-}" = true ]; then
  echo 'Synthetic state persistence rejection' >&2
  exit 1
fi
exec "$TEST_REAL_GIT" "$@"
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_REAL_GIT: realGit,
    TEST_LOCAL_REMOTE: remote, GITHUB_TOKEN: 'synthetic-only', GITHUB_REPOSITORY: 'synthetic/fixture',
    GITHUB_RUN_ID: '123', GITHUB_WORKFLOW: 'Synthetic workflow', TELECOM_TARGET_PACKAGE: 'voice200',
    RUN_LOG_STATE_FILE: `state/${month}.json`, RUN_LOG_BRANCH: 'logs', FORCE_RUN: 'false',
    GITHUB_OUTPUT: path.join(directory, 'output') };
  return { git, env, checkout, directory };
}

test('persists state on logs and the next workflow skips claiming without changing main', t => {
  const { git, env, checkout } = fixture(t);
  const mainHead = git('rev-parse', 'main');
  fs.mkdirSync(path.join(checkout, 'state'));
  fs.writeFileSync(path.join(checkout, `state/${month}.json`), JSON.stringify({
    status: 'success', month, targetPackage: 'voice200', successEvidence: 'sms_receipt', error: 'synthetic-private' }));
  execFileSync('bash', [path.join(root, 'scripts/write-run-log-branch.sh'), '--state-only'],
    { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(git('rev-parse', 'main'), mainHead);
  fs.rmSync(path.join(checkout, 'state'), { recursive: true });
  execFileSync(process.execPath, [path.join(root, 'scripts/sync-claim-state.js'), 'restore'], { cwd: checkout, env });
  execFileSync('bash', ['-e', '-c', plan], { cwd: checkout, env });
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /should_run=false/);
  const restored = fs.readFileSync(path.join(checkout, `state/${month}.json`), 'utf8');
  assert.doesNotMatch(restored, /synthetic-private/);
  assert.equal(JSON.parse(restored).status, 'success');
});

test('state write rejection remains a failing step and keeps local success for diagnosis', t => {
  const { env, checkout } = fixture(t);
  fs.mkdirSync(path.join(checkout, 'state'));
  fs.writeFileSync(path.join(checkout, `state/${month}.json`), JSON.stringify({ status: 'success', month, targetPackage: 'voice200' }));
  const result = spawnSync('bash', [path.join(root, 'scripts/write-run-log-branch.sh'), '--state-only'],
    { cwd: checkout, env: { ...env, TEST_REJECT_PUSH: 'true' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Synthetic state persistence rejection/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(checkout, `state/${month}.json`))).status, 'success');
});

#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stateMonth } = require('../src/retry-date');

function sanitizeState(state, { month, targetPackage }) {
  if (!state || state.month !== month || state.targetPackage !== targetPackage
    || !['success', 'failed', 'skipped_unavailable'].includes(state.status)) {
    throw new Error('Monthly state has an invalid month, package or status; claim stopped.');
  }
  const result = { status: state.status, month, targetPackage };
  if (typeof state.expectedPlanId === 'string' && /^[A-Za-z0-9_-]*$/.test(state.expectedPlanId)) {
    result.expectedPlanId = state.expectedPlanId;
  }
  if (['page', 'sms_receipt', 'already_claimed_page', 'configured_package_unavailable'].includes(state.successEvidence)) {
    result.successEvidence = state.successEvidence;
  }
  if (typeof state.sourceRunId === 'string' && /^\d+$/.test(state.sourceRunId)) {
    result.sourceRunId = state.sourceRunId;
  }
  return result;
}

function parseState(text, options) {
  let state;
  try { state = JSON.parse(text); } catch {
    throw new Error('Monthly state is not valid JSON; claim stopped.');
  }
  return sanitizeState(state, options);
}

function restoreState({ month = stateMonth(), targetPackage = process.env.TELECOM_TARGET_PACKAGE || 'voice200',
  directory = 'state', runGit = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) } = {}) {
  const relativeFile = `state/${month}.json`;
  let remoteText = null;
  try {
    runGit(['fetch', '--no-tags', '--depth=1', 'origin', 'refs/heads/logs']);
    const found = runGit(['ls-tree', '--name-only', 'FETCH_HEAD', '--', relativeFile]).trim();
    if (found === relativeFile) remoteText = runGit(['show', `FETCH_HEAD:${relativeFile}`]);
    else if (found) throw new Error('Unexpected state path');
  } catch {
    throw new Error('Unable to read monthly state from logs; claim stopped.');
  }
  const options = { month, targetPackage };
  const file = path.join(directory, `${month}.json`);
  const remote = remoteText !== null ? parseState(remoteText, options) : null;
  const legacy = fs.existsSync(file) ? parseState(fs.readFileSync(file, 'utf8'), options) : null;
  // A confirmed success must survive a stale or failed repeat attempt.
  const state = remote?.status === 'success' ? remote
    : legacy?.status === 'success' ? legacy : remote || legacy;
  if (state) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  }
  return state;
}

function exportState(source, destination, { targetPackage = process.env.TELECOM_TARGET_PACKAGE || 'voice200' } = {}) {
  const month = path.basename(source, '.json');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Invalid monthly state filename');
  const options = { month, targetPackage };
  const current = parseState(fs.readFileSync(source, 'utf8'), options);
  const prior = fs.existsSync(destination) ? parseState(fs.readFileSync(destination, 'utf8'), options) : null;
  const state = prior?.status === 'success' ? prior : current;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(state, null, 2)}\n`);
}

if (require.main === module) {
  try {
    if (process.argv[2] === 'export') exportState(process.argv[3], process.argv[4]);
    else if (process.argv[2] === 'restore') {
      const state = restoreState();
      console.log(state ? `Restored monthly state: ${state.status}` : 'No state recorded for this month.');
    } else throw new Error('Use restore or export');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { sanitizeState, parseState, restoreState, exportState };

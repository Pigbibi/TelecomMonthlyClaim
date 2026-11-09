#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stateMonth } = require('../src/retry-date');
const { claimStateFile } = require('../src/claim-state');

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

function stateUri() {
  const bucket = process.env.PRIVATE_STATE_BUCKET || '';
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) {
    throw new Error('Configure PRIVATE_STATE_BUCKET before running claims.');
  }
  return `gs://${bucket}/TelecomMonthlyClaim/state.json`;
}

function runStorage(args) {
  try {
    return execFileSync('gcloud', ['storage', ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Private state storage unavailable; claim stopped.');
  }
}

function readLedger(runGcloud, uri = stateUri()) {
  try {
    const ledger = JSON.parse(runGcloud(['cat', uri]));
    if (!ledger || typeof ledger.months !== 'object' || Array.isArray(ledger.months)
      || ledger.months === null) throw new Error('Invalid ledger');
    return ledger;
  } catch {
    throw new Error('Unable to read monthly state from private storage; claim stopped.');
  }
}

function restoreState({ month = stateMonth(), targetPackage = process.env.TELECOM_TARGET_PACKAGE || 'voice200',
  directory = 'state', runGcloud = runStorage } = {}) {
  const ledger = readLedger(runGcloud);
  const remoteText = Object.hasOwn(ledger.months, month) ? JSON.stringify(ledger.months[month]) : null;
  const options = { month, targetPackage };
  const file = claimStateFile(month, directory);
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

function persistState(source, { targetPackage = process.env.TELECOM_TARGET_PACKAGE || 'voice200',
  runGcloud = runStorage } = {}) {
  if (!source || !fs.existsSync(source)) throw new Error('Monthly state missing; persistence stopped.');
  const month = path.basename(source, '.json');
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('Invalid monthly state filename');
  const uri = stateUri();
  const generation = runGcloud(['objects', 'describe', uri, '--format=value(generation)']).trim();
  if (!/^\d+$/.test(generation)) throw new Error('Private state generation missing; persistence stopped.');
  const ledger = readLedger(runGcloud, `${uri}#${generation}`);
  const options = { month, targetPackage };
  const current = parseState(fs.readFileSync(source, 'utf8'), options);
  const prior = Object.hasOwn(ledger.months, month)
    ? sanitizeState(ledger.months[month], options) : null;
  ledger.months[month] = prior?.status === 'success' ? prior : current;
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'private-claim-state-'));
  const file = path.join(temporary, 'state.json');
  try {
    fs.writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 });
    runGcloud(['cp', file, uri, `--if-generation-match=${generation}`]);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(temporary);
  }
}

if (require.main === module) {
  try {
    if (process.argv[2] === 'persist') persistState(process.argv[3]);
    else if (process.argv[2] === 'export') exportState(process.argv[3], process.argv[4]);
    else if (process.argv[2] === 'restore') {
      const state = restoreState();
      console.log(state ? `Restored monthly state: ${state.status}` : 'No state recorded for this month.');
    } else throw new Error('Use restore, persist or export');
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { sanitizeState, parseState, restoreState, exportState, persistState };

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFailureIssue } = require('../scripts/create-failure-issue');

test('state persistence failure does not claim the carrier submission failed', async () => {
  const calls = [];
  await createFailureIssue({ month: '2026-10', kind: 'state_persistence', runUrl: 'https://example.test/run',
    github: async (path, options = {}) => { calls.push({ path, options }); return []; } });
  const issue = JSON.parse(calls[1].options.body);
  assert.equal(issue.title, 'Telecom monthly state persistence failed: 2026-10');
  assert.match(issue.body, /claim may already have succeeded/);
  assert.doesNotMatch(issue.body, /claim attempt failed|final retry day/);
});

test('state read failure reports the submission was stopped', async () => {
  const calls = [];
  await createFailureIssue({ month: '2026-10', kind: 'state_read',
    github: async (path, options = {}) => { calls.push({ path, options }); return []; } });
  const issue = JSON.parse(calls[1].options.body);
  assert.match(issue.body, /stopped to prevent a duplicate/);
});

test('deduplicates issues by month and failure kind', async () => {
  const calls = [];
  const created = await createFailureIssue({ month: '2026-10', kind: 'state_persistence',
    github: async (...args) => {
      calls.push(args);
      return [{ title: 'Telecom monthly state persistence failed: 2026-10' }];
    } });
  assert.equal(created, false);
  assert.equal(calls.length, 1);
});

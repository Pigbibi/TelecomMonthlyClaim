const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFailureIssue } = require('../scripts/resolve-failure-issue');

test('does not close a failure issue without confirmed success', async () => {
  const calls = [];
  const closed = await resolveFailureIssue({
    month: '2026-09',
    stateStatus: 'skipped_unavailable',
    github: async (...args) => {
      calls.push(args);
      return [];
    },
  });

  assert.equal(closed, false);
  assert.deepEqual(calls, []);
});

test('closes the matching monthly failure issue after confirmed success', async () => {
  const calls = [];
  const github = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/issues?')) {
      return [{ number: 22, title: 'Telecom monthly claim failed: 2026-09' }];
    }
    return { number: 22, state: 'closed' };
  };

  const closed = await resolveFailureIssue({
    month: '2026-09',
    stateStatus: 'success',
    github,
  });

  assert.equal(closed, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /^\/issues\?state=open/);
  assert.equal(calls[1].path, '/issues/22');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].options.body), { state: 'closed' });
});

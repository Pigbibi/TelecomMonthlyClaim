const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLeaseUrl,
  leaseIdFromEnv,
  manageInterceptLease,
} = require('../scripts/manage-intercept-lease');

test('builds a workflow-specific lease URL from the protected inbox URL', () => {
  assert.equal(
    String(buildLeaseUrl(
      'https://relay.example.test/messages?ignored=true',
      'telecom-claim-silent',
      'telecom-123-2',
    )),
    'https://relay.example.test/intercepts/leases/telecom-claim-silent/telecom-123-2',
  );
  assert.equal(leaseIdFromEnv({ GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }), 'telecom-123-2');
});

test('acquires and releases an intercept lease with the inbox bearer token', async () => {
  const calls = [];
  const env = {
    PUSHPLUS_RELAY_INBOX_URL: 'https://relay.example.test/messages',
    PUSHPLUS_RELAY_INBOX_TOKEN: 'secret-token',
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '2',
    PUSHPLUS_INTERCEPT_LEASE_TTL_SECONDS: '1800',
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('{}', { status: 200 });
  };

  await manageInterceptLease('acquire', 'telecom-claim-silent', { env, fetchImpl });
  await manageInterceptLease('release', 'telecom-claim-silent', { env, fetchImpl });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.headers.authorization, 'Bearer secret-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { ttlSeconds: 1800 });
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(calls[1].url, calls[0].url);
});

test('skips lease management when no relay inbox is configured', async () => {
  const result = await manageInterceptLease('acquire', 'telecom-claim-silent', {
    env: {},
    fetchImpl: async () => {
      throw new Error('fetch must not run');
    },
  });
  assert.equal(result.skipped, true);
});

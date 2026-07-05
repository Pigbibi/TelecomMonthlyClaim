const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workflowText = fs.readFileSync(path.join(root, '.github/workflows/monthly-claim.yml'), 'utf8');

test('monthly workflow does not depend on Pigbibi private home proxy actions', () => {
  assert.doesNotMatch(workflowText, /Pigbibi\/HomeProxyActions/);
  assert.doesNotMatch(workflowText, /Pigbibi\/InternalHomeProxyActions/);
  assert.doesNotMatch(workflowText, /Pigbibi\/BwgRouterSelfHeal\/actions\/setup-home-proxy/);
  assert.doesNotMatch(workflowText, /uses:\s\.\/actions\/setup-home-proxy/);
});

test('monthly workflow documents generic proxy modes instead of BWG-only execution', () => {
  assert.match(workflowText, /connectivity_mode:/);
  assert.match(workflowText, /TELECOM_CONNECTIVITY_MODE:/);
  assert.doesNotMatch(workflowText, /BWG_SSH_PRIVATE_KEY/);
  assert.match(workflowText, /Unsupported TELECOM_CONNECTIVITY_MODE/);
});

test('repository does not ship Pigbibi internal home proxy automation', () => {
  for (const relativePath of [
    'actions/setup-home-proxy/action.yml',
    'scripts/setup-home-proxy.sh',
    'scripts/check-home-proxy.sh',
    'scripts/home-http-proxy.js',
    'scripts/install-openwrt-router.sh',
    'scripts/install-bwg-public-webhook.sh',
    'openwrt/telecom-bwg-tunnel.init',
    'bwg/telecom-public-webhook-proxy.py',
  ]) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), false, relativePath);
  }
});

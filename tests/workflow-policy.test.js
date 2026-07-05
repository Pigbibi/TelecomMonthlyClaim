const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const workflowText = fs.readFileSync(path.join(root, '.github/workflows/monthly-claim.yml'), 'utf8');
const actionText = fs.readFileSync(path.join(root, 'actions/setup-home-proxy/action.yml'), 'utf8');

test('monthly workflow uses local home proxy action only', () => {
  assert.match(workflowText, /uses:\s\.\/actions\/setup-home-proxy/);
  assert.doesNotMatch(workflowText, /Pigbibi\/HomeProxyActions/);
  assert.doesNotMatch(workflowText, /Pigbibi\/BwgRouterSelfHeal\/actions\/setup-home-proxy/);
});

test('local home proxy action delegates to repository scripts', () => {
  assert.match(actionText, /using:\s*composite/);
  assert.match(actionText, /setup-home-proxy\.sh/);
  assert.match(actionText, /bwg-ssh-private-key:/);
});

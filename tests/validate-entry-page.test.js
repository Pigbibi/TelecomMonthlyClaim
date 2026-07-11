const test = require('node:test');
const assert = require('node:assert/strict');
const { clearEntryBrowserData, isEntryRenderReady } = require('../scripts/validate-entry-page');

test('accepts a rendered login form even when the page has no body text', () => {
  assert.equal(isEntryRenderReady({
    htmlLength: 19000,
    bodyLength: 0,
    visiblePhoneInputs: 1,
  }), true);
});

test('rejects a blank WAF page without visible login controls', () => {
  assert.equal(isEntryRenderReady({
    htmlLength: 19000,
    bodyLength: 0,
    visiblePhoneInputs: 0,
  }), false);
});

test('clears cookies, cache, and entry-origin storage before navigation', async () => {
  const calls = [];
  const session = {
    send: async (method, params) => calls.push([method, params]),
    detach: async () => calls.push(['detach']),
  };
  const context = {
    clearCookies: async () => calls.push(['clearCookies']),
    newCDPSession: async () => session,
  };

  await clearEntryBrowserData(context, {}, 'https://wapbj.189.cn/example?token=redacted');

  assert.deepEqual(calls, [
    ['clearCookies'],
    ['Network.clearBrowserCache', undefined],
    ['Storage.clearDataForOrigin', { origin: 'https://wapbj.189.cn', storageTypes: 'all' }],
    ['detach'],
  ]);
});

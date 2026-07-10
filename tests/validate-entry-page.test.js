const test = require('node:test');
const assert = require('node:assert/strict');
const { isEntryRenderReady } = require('../scripts/validate-entry-page');

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

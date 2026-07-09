const test = require('node:test');
const assert = require('node:assert/strict');
const { mobileUserAgent, chromeLaunchArgs } = require('../src/browser-stealth');

test('mobile user agent tracks launched Chrome version', () => {
  const ua = mobileUserAgent('Google Chrome 150.0.7871.46');
  assert.match(ua, /Chrome\/150\.0\.7871\.46 Mobile/);
  assert.match(ua, /Android 13; Pixel 7/);
});

test('chrome launch args hide automation hints', () => {
  const args = chromeLaunchArgs();
  assert.ok(args.some(a => a.includes('AutomationControlled')));
  assert.ok(args.some(a => a.includes('window-size')));
});

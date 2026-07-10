const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyCdpBrowserProfile,
  mobileUserAgent,
  chromeLaunchArgs,
  resolveCdpProfileMode,
} = require('../src/browser-stealth');

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

test('cdp browser profile applies mobile emulation overrides', async () => {
  const commands = [];
  const page = {
    setViewportSize: async size => { commands.push(['viewport', size]); },
    context: () => ({
      newCDPSession: async () => ({
        send: async (method, payload) => { commands.push([method, payload]); },
      }),
    }),
  };

  await applyCdpBrowserProfile(page, 'Google Chrome 150.0.7871.46', 'wechat');

  assert.deepEqual(commands[0], ['viewport', { width: 393, height: 873 }]);
  assert.equal(commands[1][0], 'Emulation.setDeviceMetricsOverride');
  assert.equal(commands[1][1].mobile, true);
  assert.equal(commands[2][0], 'Emulation.setTouchEmulationEnabled');
  assert.equal(commands[2][1].enabled, true);
  assert.equal(commands[3][0], 'Emulation.setUserAgentOverride');
  assert.match(commands[3][1].userAgent, /Android 13; Pixel 7/);
  assert.match(commands[3][1].userAgent, /Chrome\/150\.0\.7871\.46 Mobile/);
  assert.equal(commands[3][1].userAgentMetadata.mobile, true);
  assert.equal(commands[3][1].userAgentMetadata.platform, 'Android');
  assert.equal(commands[3][1].userAgentMetadata.platformVersion, '13.0.0');
  assert.equal(commands[3][1].userAgentMetadata.model, 'Pixel 7');
});

test('minimal-login real Chrome CDP path keeps native browser profile', async () => {
  const commands = [];
  const page = {
    setViewportSize: async size => { commands.push(['viewport', size]); },
    context: () => ({
      newCDPSession: async () => ({
        send: async (method, payload) => { commands.push([method, payload]); },
      }),
    }),
  };

  const result = await applyCdpBrowserProfile(page, 'Google Chrome 150.0.7871.46', 'wechat', {
    mode: 'native',
    minimalLogin: true,
  });

  assert.deepEqual(commands, []);
  assert.deepEqual(result, { applied: false, mode: 'native' });
});

test('auto CDP profile mode resolves to native for minimal login and emulated otherwise', () => {
  assert.equal(resolveCdpProfileMode('auto', { minimalLogin: true }), 'native');
  assert.equal(resolveCdpProfileMode('auto', { minimalLogin: false }), 'emulated');
  assert.equal(resolveCdpProfileMode('force', { minimalLogin: true }), 'emulated');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

test('loads direct proxy fallback flag from env', () => {
  const originalEnv = { ...process.env };
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.ALLOW_DIRECT_PROXY_FALLBACK = 'true';
  process.env.OPENWRT_HTTP_PROXY = 'http://127.0.0.1:13128';

  try {
    const config = loadConfig();
    assert.equal(config.allowDirectProxyFallback, true);
    assert.equal(config.openwrtProxy, 'http://127.0.0.1:13128');
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
});

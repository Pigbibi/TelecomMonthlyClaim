const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');

function withCleanTelecomEnv(fn) {
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('TELECOM_')
      || key.startsWith('SMS_')
      || key === 'OPENWRT_HTTP_PROXY'
      || key === 'HTTPS_PROXY'
      || key === 'HTTP_PROXY'
      || key === 'ALLOW_DIRECT_PROXY_FALLBACK'
    ) {
      delete process.env[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  }
}

test('defaults to the 200-minute voice package preset', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';

  const config = loadConfig();

  assert.equal(config.targetPackage, 'voice200');
  assert.equal(config.productName, '互联网卡网龄享200分钟国内语音');
  assert.equal(config.expectedPlanId, '24BJ102053');
  assert.equal(config.actionDelayMs, 800);
  assert.equal(config.postSuccessWaitMs, 8000);
}));

test('loads the 5GB data package preset by target package', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_TARGET_PACKAGE = '5g';

  const config = loadConfig();

  assert.equal(config.targetPackage, '5g');
  assert.equal(config.productName, '互联网卡网龄享5GB国内通用流量');
  assert.equal(config.expectedPlanId, '24BJ100433');
}));

test('allows product and plan overrides from env', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_TARGET_PACKAGE = 'custom';
  process.env.TELECOM_PRODUCT_NAME = '自定义产品';
  process.env.TELECOM_EXPECTED_PLAN_ID = 'PLAN123';

  const config = loadConfig();

  assert.equal(config.targetPackage, 'custom');
  assert.equal(config.productName, '自定义产品');
  assert.equal(config.expectedPlanId, 'PLAN123');
}));

test('requires product override for unknown target package', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_TARGET_PACKAGE = 'custom';

  assert.throws(() => loadConfig(), /Missing TELECOM_PRODUCT_NAME/);
}));

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

test('loads pacing delays from env', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_ACTION_DELAY_MS = '1200';
  process.env.TELECOM_POST_SUCCESS_WAIT_MS = '15000';

  const config = loadConfig();

  assert.equal(config.actionDelayMs, 1200);
  assert.equal(config.postSuccessWaitMs, 15000);
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, normalizeTelecomEntryUrl } = require('../src/config');

function withCleanTelecomEnv(fn) {
  const originalEnv = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('TELECOM_')
      || key.startsWith('SMS_')
      || key === 'OPENWRT_HTTP_PROXY'
      || key === 'PROXY_POOL_HTTP_PROXY'
      || key === 'HTTPS_PROXY'
      || key === 'HTTP_PROXY'
      || key === 'BROWSER_CDP_URL'
      || key === 'BROWSER_CHANNEL'
      || key === 'HEADLESS'
      || key.startsWith('PUSHPLUS_')
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

test('loads proxy pool proxy from env', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.PROXY_POOL_HTTP_PROXY = 'http://proxy-pool.example.test:8080';

  const config = loadConfig();

  assert.equal(config.proxyPoolProxy, 'http://proxy-pool.example.test:8080');
}));

test('defaults stealth mode to disabled unless explicitly enabled', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';

  assert.equal(loadConfig().stealthMode, false);

  process.env.TELECOM_STEALTH_MODE = 'true';
  assert.equal(loadConfig().stealthMode, true);
}));

test('defaults to headed Chrome unless HEADLESS=true', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';

  assert.equal(loadConfig().headless, false);
  assert.equal(loadConfig().browserChannel, 'chrome');
  assert.equal(loadConfig().browserProfile, 'wechat');
  assert.equal(loadConfig().cdpProfileMode, 'auto');

  process.env.HEADLESS = 'true';
  assert.equal(loadConfig().headless, true);
  process.env.TELECOM_BROWSER_PROFILE = 'desktop';
  assert.equal(loadConfig().browserProfile, 'desktop');
  process.env.TELECOM_CDP_PROFILE_MODE = 'native';
  assert.equal(loadConfig().cdpProfileMode, 'native');
}));

test('enables minimal login by default when BROWSER_CDP_URL is set', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';

  assert.equal(loadConfig().minimalLogin, false);
  assert.equal(loadConfig().skipOriginWarmup, false);

  process.env.BROWSER_CDP_URL = 'http://127.0.0.1:9222';
  assert.equal(loadConfig().minimalLogin, true);
  assert.equal(loadConfig().skipOriginWarmup, true);

  process.env.TELECOM_MINIMAL_LOGIN = 'false';
  process.env.TELECOM_SKIP_ORIGIN_WARMUP = 'false';
  assert.equal(loadConfig().minimalLogin, false);
  assert.equal(loadConfig().skipOriginWarmup, false);
}));

test('normalizes telecom entry url to https on wapbj host', () => {
  assert.equal(
    normalizeTelecomEntryUrl('http://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?a=1'),
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?a=1',
  );
  assert.equal(
    normalizeTelecomEntryUrl('https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?a=1'),
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?a=1',
  );
});

test('defaults slider mode to api (native submitVerify)', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  assert.equal(loadConfig().sliderMode, 'api');
}));

test('loads slider mode from env', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_SLIDER_MODE = 'api';
  assert.equal(loadConfig().sliderMode, 'api');
}));

test('loads pacing delays from env', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_ACTION_DELAY_MS = '1200';
  process.env.TELECOM_POST_SUCCESS_WAIT_MS = '15000';

  const config = loadConfig();

  assert.equal(config.actionDelayMs, 1200);
  assert.equal(config.postSuccessWaitMs, 15000);
}));


test('loads PushPlus SMS inbox provider settings', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.SMS_INBOX_PROVIDER = 'pushplus';
  process.env.PUSHPLUS_TOKEN = 'token-1';
  process.env.PUSHPLUS_SECRET_KEY = 'secret-1';
  process.env.PUSHPLUS_PAGE_SIZE = '20';
  process.env.PUSHPLUS_BASE_URL = 'https://pushplus.example.test';
  process.env.PUSHPLUS_KEYWORD = '北京电信掌上营业厅';
  process.env.PUSHPLUS_TITLE_KEYWORD = '短信转发';
  process.env.PUSHPLUS_RELAY_INBOX_URL = 'https://relay.example.test/messages';
  process.env.PUSHPLUS_RELAY_INBOX_TOKEN = 'relay-token-1';
  process.env.SMS_SENDER = '10001';

  const config = loadConfig();

  assert.equal(config.smsInboxProvider, 'pushplus');
  assert.equal(config.pushPlusToken, 'token-1');
  assert.equal(config.pushPlusSecretKey, 'secret-1');
  assert.equal(config.pushPlusPageSize, 20);
  assert.equal(config.pushPlusBaseUrl, 'https://pushplus.example.test');
  assert.equal(config.pushPlusKeyword, '北京电信掌上营业厅');
  assert.equal(config.pushPlusTitleKeyword, '短信转发');
  assert.equal(config.pushPlusRelayInboxUrl, 'https://relay.example.test/messages');
  assert.equal(config.pushPlusRelayInboxToken, 'relay-token-1');
  assert.equal(config.smsSender, '10001');
}));

test('loads Chrome extension preflight SMS handoff flag', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_LOGIN_SMS_ALREADY_SENT = 'true';
  assert.equal(loadConfig().loginSmsAlreadySent, true);
}));

test('loads Chrome extension completed-login handoff flag', () => withCleanTelecomEnv(() => {
  process.env.TELECOM_PHONE = '18500000000';
  process.env.TELECOM_ENTRY_URL = 'https://example.test/entry';
  process.env.TELECOM_LOGIN_ALREADY_COMPLETE = 'true';
  process.env.TELECOM_CONFIRM_SMS_ALREADY_SENT = 'true';
  assert.equal(loadConfig().loginAlreadyComplete, true);
  assert.equal(loadConfig().confirmationSmsAlreadySent, true);
}));

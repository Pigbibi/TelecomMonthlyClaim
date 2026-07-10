function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

const PACKAGE_PRESETS = {
  '5g': {
    productName: '互联网卡网龄享5GB国内通用流量',
    expectedPlanId: '24BJ100433',
  },
  voice200: {
    productName: '互联网卡网龄享200分钟国内语音',
    expectedPlanId: '24BJ102053',
  },
};

function optionalEnv(name, fallback = '') {
  return process.env[name] || fallback;
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return Number(value);
}

function normalizeTelecomEntryUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return url;
  return url.replace(/^http:\/\/wapbj\.189\.cn(?=\/)/i, 'https://wapbj.189.cn');
}

function loadConfig() {
  const phone = requireEnv('TELECOM_PHONE');
  const entryUrl = normalizeTelecomEntryUrl(requireEnv('TELECOM_ENTRY_URL'));
  const targetPackage = process.env.TELECOM_TARGET_PACKAGE || 'voice200';
  const preset = PACKAGE_PRESETS[targetPackage] || {};
  const productName = optionalEnv('TELECOM_PRODUCT_NAME', preset.productName);
  if (!productName) {
    throw new Error(`Missing TELECOM_PRODUCT_NAME for target package: ${targetPackage}`);
  }
  return {
    phone,
    entryUrl,
    targetPackage,
    productName,
    expectedPlanId: optionalEnv('TELECOM_EXPECTED_PLAN_ID', preset.expectedPlanId),
    smsInboxProvider: optionalEnv('SMS_INBOX_PROVIDER', 'http').toLowerCase(),
    smsInboxUrl: process.env.SMS_INBOX_URL || '',
    smsInboxToken: process.env.SMS_INBOX_TOKEN || '',
    smsSender: process.env.SMS_SENDER || '10001',
    smsTimeoutMs: numberEnv('SMS_TIMEOUT_MS', 90000),
    smsPollMs: numberEnv('SMS_POLL_MS', 5000),
    pushPlusToken: process.env.PUSHPLUS_TOKEN || '',
    pushPlusSecretKey: process.env.PUSHPLUS_SECRET_KEY || '',
    pushPlusAccessKey: process.env.PUSHPLUS_ACCESS_KEY || '',
    pushPlusBaseUrl: optionalEnv('PUSHPLUS_BASE_URL', 'https://www.pushplus.plus'),
    pushPlusPageSize: numberEnv('PUSHPLUS_PAGE_SIZE', 10),
    pushPlusKeyword: process.env.PUSHPLUS_KEYWORD || '',
    pushPlusTitleKeyword: process.env.PUSHPLUS_TITLE_KEYWORD || '',
    pushPlusDebug: process.env.PUSHPLUS_DEBUG === 'true',
    pushPlusRelayInboxUrl: process.env.PUSHPLUS_RELAY_INBOX_URL || '',
    pushPlusRelayInboxToken: process.env.PUSHPLUS_RELAY_INBOX_TOKEN || '',
    sendCodeAttempts: numberEnv('SEND_CODE_ATTEMPTS', 3),
    loginSmsAlreadySent: process.env.TELECOM_LOGIN_SMS_ALREADY_SENT === 'true',
    actionDelayMs: numberEnv('TELECOM_ACTION_DELAY_MS', 800),
    postSuccessWaitMs: numberEnv('TELECOM_POST_SUCCESS_WAIT_MS', 8000),
    openwrtProxy: process.env.OPENWRT_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    proxyPoolProxy: process.env.PROXY_POOL_HTTP_PROXY || '',
    headless: process.env.HEADLESS === 'true',
    browserChannel: process.env.BROWSER_CHANNEL || 'chrome',
    browserCdpUrl: process.env.BROWSER_CDP_URL || '',
    browserProfile: optionalEnv('TELECOM_BROWSER_PROFILE', 'wechat').toLowerCase(),
    cdpProfileMode: optionalEnv('TELECOM_CDP_PROFILE_MODE', 'auto').toLowerCase(),
    // Prefer real Chrome via CDP. When true, refuse Playwright-launched browsers.
    requireRealChrome: process.env.TELECOM_REQUIRE_REAL_CHROME === 'true'
      || process.env.TELECOM_REQUIRE_REAL_CHROME === '1'
      || !!process.env.BROWSER_CDP_URL,
    stealthMode: process.env.TELECOM_STEALTH_MODE === 'true',
    blockHeavyAssets: process.env.TELECOM_BLOCK_HEAVY_ASSETS === 'true',
    // June-era baseline: one goto into entry, no origin warmup / less slider thrash.
    // Default on for CDP; override with TELECOM_MINIMAL_LOGIN=false.
    minimalLogin: process.env.TELECOM_MINIMAL_LOGIN === 'false'
      ? false
      : (process.env.TELECOM_MINIMAL_LOGIN === 'true' || !!process.env.BROWSER_CDP_URL),
    skipOriginWarmup: process.env.TELECOM_SKIP_ORIGIN_WARMUP === 'true'
      || (process.env.TELECOM_SKIP_ORIGIN_WARMUP !== 'false' && !!process.env.BROWSER_CDP_URL),
    finalRetryDay: numberEnv('FINAL_RETRY_DAY', 3),
    failOnlyFinalDay: process.env.FAIL_ONLY_FINAL_DAY !== 'false',
    forceRun: process.env.FORCE_RUN === 'true',
    dryRunBeforeFinalSubmit: process.env.DRY_RUN_BEFORE_FINAL_SUBMIT === 'true',
    allowDirectProxyFallback: process.env.ALLOW_DIRECT_PROXY_FALLBACK === 'true',
    // Slider: native submitVerify with image-matched natural distance (no mouse).
    // TELECOM_SLIDER_MODE kept for compatibility; only "api" is supported.
    sliderMode: optionalEnv('TELECOM_SLIDER_MODE', 'api').toLowerCase(),
  };
}

module.exports = { PACKAGE_PRESETS, loadConfig, normalizeTelecomEntryUrl };

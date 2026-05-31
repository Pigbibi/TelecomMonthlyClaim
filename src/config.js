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

function loadConfig() {
  const phone = requireEnv('TELECOM_PHONE');
  const targetPackage = process.env.TELECOM_TARGET_PACKAGE || 'voice200';
  const preset = PACKAGE_PRESETS[targetPackage] || {};
  const productName = optionalEnv('TELECOM_PRODUCT_NAME', preset.productName);
  if (!productName) {
    throw new Error(`Missing TELECOM_PRODUCT_NAME for target package: ${targetPackage}`);
  }
  return {
    phone,
    entryUrl: requireEnv('TELECOM_ENTRY_URL'),
    targetPackage,
    productName,
    expectedPlanId: optionalEnv('TELECOM_EXPECTED_PLAN_ID', preset.expectedPlanId),
    smsInboxUrl: process.env.SMS_INBOX_URL || '',
    smsInboxToken: process.env.SMS_INBOX_TOKEN || '',
    smsSender: process.env.SMS_SENDER || '10001',
    smsTimeoutMs: numberEnv('SMS_TIMEOUT_MS', 90000),
    smsPollMs: numberEnv('SMS_POLL_MS', 5000),
    sendCodeAttempts: numberEnv('SEND_CODE_ATTEMPTS', 3),
    actionDelayMs: numberEnv('TELECOM_ACTION_DELAY_MS', 800),
    postSuccessWaitMs: numberEnv('TELECOM_POST_SUCCESS_WAIT_MS', 8000),
    openwrtProxy: process.env.OPENWRT_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    headless: process.env.HEADLESS !== 'false',
    browserChannel: process.env.BROWSER_CHANNEL || 'chrome',
    finalRetryDay: numberEnv('FINAL_RETRY_DAY', 3),
    failOnlyFinalDay: process.env.FAIL_ONLY_FINAL_DAY !== 'false',
    forceRun: process.env.FORCE_RUN === 'true',
    dryRunBeforeFinalSubmit: process.env.DRY_RUN_BEFORE_FINAL_SUBMIT === 'true',
    allowDirectProxyFallback: process.env.ALLOW_DIRECT_PROXY_FALLBACK === 'true',
  };
}

module.exports = { PACKAGE_PRESETS, loadConfig };

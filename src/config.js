function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function loadConfig() {
  const phone = requireEnv('TELECOM_PHONE');
  return {
    phone,
    entryUrl: requireEnv('TELECOM_ENTRY_URL'),
    targetPackage: process.env.TELECOM_TARGET_PACKAGE || '5g',
    productName: process.env.TELECOM_PRODUCT_NAME || '互联网卡网龄享5GB国内通用流量',
    expectedPlanId: process.env.TELECOM_EXPECTED_PLAN_ID || '24BJ100433',
    smsInboxUrl: process.env.SMS_INBOX_URL || '',
    smsInboxToken: process.env.SMS_INBOX_TOKEN || '',
    smsSender: process.env.SMS_SENDER || '10001',
    smsTimeoutMs: Number(process.env.SMS_TIMEOUT_MS || 90000),
    smsPollMs: Number(process.env.SMS_POLL_MS || 5000),
    sendCodeAttempts: Number(process.env.SEND_CODE_ATTEMPTS || 3),
    openwrtProxy: process.env.OPENWRT_HTTP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '',
    headless: process.env.HEADLESS !== 'false',
    browserChannel: process.env.BROWSER_CHANNEL || 'chrome',
    finalRetryDay: Number(process.env.FINAL_RETRY_DAY || 3),
    failOnlyFinalDay: process.env.FAIL_ONLY_FINAL_DAY !== 'false',
    forceRun: process.env.FORCE_RUN === 'true',
    dryRunBeforeFinalSubmit: process.env.DRY_RUN_BEFORE_FINAL_SUBMIT === 'true',
  };
}

module.exports = { loadConfig };

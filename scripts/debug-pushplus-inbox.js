#!/usr/bin/env node
const { PACKAGE_PRESETS } = require('../src/config');
const { SmsInboxClient, summarizePushPlusDetail } = require('../src/sms-inbox-client');
const { parseTelecomSms } = require('../src/sms-parser');

function loadDebugConfig() {
  const targetPackage = process.env.TELECOM_TARGET_PACKAGE || 'voice200';
  const preset = PACKAGE_PRESETS[targetPackage] || {};
  const smsInboxProvider = String(process.env.SMS_INBOX_PROVIDER || 'pushplus').toLowerCase();
  return {
    phone: process.env.TELECOM_PHONE || '',
    targetPackage,
    productName: process.env.TELECOM_PRODUCT_NAME || preset.productName || '',
    expectedPlanId: process.env.TELECOM_EXPECTED_PLAN_ID || preset.expectedPlanId || '',
    smsInboxProvider,
    smsSender: process.env.SMS_SENDER || '10001',
    pushPlusToken: process.env.PUSHPLUS_TOKEN || '',
    pushPlusSecretKey: process.env.PUSHPLUS_SECRET_KEY || '',
    pushPlusAccessKey: process.env.PUSHPLUS_ACCESS_KEY || '',
    pushPlusBaseUrl: process.env.PUSHPLUS_BASE_URL || 'https://www.pushplus.plus',
    pushPlusPageSize: Number(process.env.PUSHPLUS_PAGE_SIZE || 10),
    pushPlusKeyword: process.env.PUSHPLUS_KEYWORD || '',
    pushPlusTitleKeyword: process.env.PUSHPLUS_TITLE_KEYWORD || '',
    pushPlusDebug: process.env.PUSHPLUS_DEBUG === 'true',
    pushPlusRelayInboxUrl: process.env.PUSHPLUS_RELAY_INBOX_URL || '',
    pushPlusRelayInboxToken: process.env.PUSHPLUS_RELAY_INBOX_TOKEN || '',
  };
}

function summarizeMatch(message, config) {
  const login = parseTelecomSms(message, {
    stage: 'login',
    expectedPhone: config.phone,
    product: config.productName,
    planId: config.expectedPlanId,
  });
  const confirm = parseTelecomSms(message, {
    stage: 'confirm',
    expectedPhone: config.phone,
    product: config.productName,
    planId: config.expectedPlanId,
  });
  return {
    login: !!login,
    confirm: !!confirm,
  };
}

async function main() {
  const config = loadDebugConfig();
  if (String(config.smsInboxProvider || '').toLowerCase() !== 'pushplus') {
    throw new Error('SMS_INBOX_PROVIDER must be pushplus');
  }
  if (!config.pushPlusRelayInboxUrl && (!config.pushPlusToken || !config.pushPlusSecretKey) && !config.pushPlusAccessKey) {
    throw new Error('Missing PUSHPLUS_TOKEN/PUSHPLUS_SECRET_KEY (or PUSHPLUS_ACCESS_KEY) for direct PushPlus debugging');
  }

  const minutes = Math.max(1, Number(process.env.PUSHPLUS_LOOKBACK_MINUTES || 180));
  const limit = Math.max(1, Math.min(Number(process.env.PUSHPLUS_DEBUG_LIMIT || 10), 20));
  const since = Date.now() - minutes * 60 * 1000;
  const client = new SmsInboxClient(config);
  const messages = await client.fetchMessages(since);

  const summary = messages.slice(0, limit).map(message => ({
    id: message.id || '',
    sender: message.sender || '',
    receivedAt: new Date(Number(message.receivedAt || Date.now())).toISOString(),
    ...summarizePushPlusDetail(message.text || ''),
    ...summarizeMatch(message, config),
  }));

  console.log(JSON.stringify({
    provider: config.smsInboxProvider,
    relayInbox: !!config.pushPlusRelayInboxUrl,
    lookbackMinutes: minutes,
    limit,
    keyword: !!config.pushPlusKeyword,
    titleKeyword: !!config.pushPlusTitleKeyword,
    smsSender: config.smsSender || '',
    count: messages.length,
    messages: summary,
  }, null, 2));
}

main().catch(err => {
  console.error(err.message || err);
  process.exitCode = 1;
});

#!/usr/bin/env node
const http = require('node:http');
const https = require('node:https');

const RUNNER_URL = process.env.HOME_CLAIM_RUNNER_URL || 'http://127.0.0.1:19090/run';
const TIMEOUT_MS = Number(process.env.HOME_CLAIM_RUNNER_TIMEOUT_MS || 20 * 60 * 1000);
const ENV_KEYS = [
  'TELECOM_PHONE',
  'TELECOM_ENTRY_URL',
  'TELECOM_TARGET_PACKAGE',
  'TELECOM_PRODUCT_NAME',
  'TELECOM_EXPECTED_PLAN_ID',
  'TELECOM_ACTION_DELAY_MS',
  'TELECOM_POST_SUCCESS_WAIT_MS',
  'SMS_INBOX_PROVIDER',
  'SMS_INBOX_URL',
  'SMS_INBOX_HEALTH_URL',
  'SMS_INBOX_TOKEN',
  'SMS_SENDER',
  'SMS_TIMEOUT_MS',
  'SMS_POLL_MS',
  'PUSHPLUS_TOKEN',
  'PUSHPLUS_SECRET_KEY',
  'PUSHPLUS_ACCESS_KEY',
  'PUSHPLUS_BASE_URL',
  'PUSHPLUS_PAGE_SIZE',
  'PUSHPLUS_TITLE_KEYWORD',
  'PUSHPLUS_DEBUG',
  'PUSHPLUS_RELAY_INBOX_URL',
  'PUSHPLUS_RELAY_INBOX_TOKEN',
  'SEND_CODE_ATTEMPTS',
  'HEADLESS',
  'BROWSER_CHANNEL',
  'FINAL_RETRY_DAY',
  'FAIL_ONLY_FINAL_DAY',
  'FORCE_RUN',
  'DRY_RUN_BEFORE_FINAL_SUBMIT',
];

function requestJson(url, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(parsed, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: TIMEOUT_MS,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode: res.statusCode, payload: JSON.parse(text) });
        } catch {
          reject(new Error(`Invalid runner response (${res.statusCode}): ${text.slice(0, 500)}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('home claim runner timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

(async () => {
  const env = {};
  for (const key of ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.OPENWRT_HTTP_PROXY = '';
  env.HTTP_PROXY = '';
  env.HTTPS_PROXY = '';
  const { statusCode, payload } = await requestJson(RUNNER_URL, { env });
  if (payload.output) process.stdout.write(payload.output.endsWith('\n') ? payload.output : `${payload.output}\n`);
  if (statusCode >= 400 || payload.exitCode) process.exit(payload.exitCode || 1);
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});

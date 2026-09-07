const test = require('node:test');
const assert = require('node:assert/strict');
const { SmsInboxClient, normalizeMessage, parsePushPlusUpdateTime } = require('../src/sms-inbox-client');
const { parseTelecomSms } = require('../src/sms-parser');

const text = '【办理提醒】成功办理测试套餐（方案编号:TEST_PLAN），立即生效。';
const config = { productName: '测试套餐', expectedPlanId: 'TEST_PLAN', successSmsSender: '10000' };

for (const provider of ['http', 'pushplus']) {
  for (const invalid of ['stale', 'missing-time', 'invalid-time', 'future', 'missing-sender', 'wrong-sender', 'substring-sender']) {
    test(`${provider} receipt rejects ${invalid} evidence`, async t => {
      const now = Date.now();
      const msg = { id: 'synthetic', sender: '10000', text, receivedAt: now };
      if (invalid === 'stale') msg.receivedAt = now - 2000;
      if (invalid === 'missing-time') delete msg.receivedAt;
      if (invalid === 'invalid-time') msg.receivedAt = 'not-a-date';
      if (invalid === 'future') msg.receivedAt = now + 60000;
      if (invalid === 'missing-sender') delete msg.sender;
      if (invalid === 'wrong-sender') msg.sender = '10001';
      if (invalid === 'substring-sender') msg.sender = 'fake-10000';
      t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ messages: [msg] }) }));
      t.mock.method(console, 'log', () => {});
      const client = new SmsInboxClient({ ...config, smsInboxProvider: provider,
        smsInboxUrl: 'https://inbox.invalid', pushPlusRelayInboxUrl: 'https://inbox.invalid' });
      assert.equal(await client.waitForReceipt({ since: now - 1000, timeoutMs: 10, pollMs: 1 }), null);
    });
  }
}

test('fresh receipt accepts numeric and ISO timestamps, but duplicate is ignored', async t => {
  t.mock.method(console, 'log', () => {});
  for (const iso of [false, true]) {
    const now = Date.now();
    t.mock.method(global, 'fetch', async () => ({ ok: true, json: async () => [{
      id: 'synthetic', sender: '10000', text, receivedAt: iso ? new Date(now).toISOString() : now,
    }] }));
    const client = new SmsInboxClient({ ...config, smsInboxUrl: 'https://inbox.invalid' });
    const options = { since: now - 1000, timeoutMs: 10, pollMs: 1 };
    assert.equal((await client.waitForReceipt(options))?.stage, 'receipt');
    assert.equal(await client.waitForReceipt(options), null);
  }
});

test('timestamp normalization never fabricates current time', () => {
  assert.equal(normalizeMessage({ text }).receivedAt, null);
  for (const value of [undefined, null, '', 'not-a-date', '2026-13-01 00:00:00', '2026-02-31 00:00:00']) {
    assert.equal(Number.isFinite(parsePushPlusUpdateTime(value)), false);
  }
});

test('receipt parser requires exact explicit sender', () => {
  const options = { stage: 'receipt', product: config.productName, planId: config.expectedPlanId };
  for (const sender of ['', '100001', 'fake-10000', '+8610000']) {
    assert.equal(parseTelecomSms({ sender, text }, options), null);
  }
  assert.equal(parseTelecomSms({ sender: ' 10000 ', text }, options)?.stage, 'receipt');
});

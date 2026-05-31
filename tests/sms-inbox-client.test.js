const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SmsInboxClient,
  normalizeMessage,
  htmlToText,
  parsePushPlusUpdateTime,
  summarizePushPlusDetail,
} = require('../src/sms-inbox-client');

test('unwraps JSON payload from SMS forwarding apps', () => {
  const msg = normalizeMessage({
    id: 'router-1',
    sender: '10001',
    receivedAt: 1777660755000,
    text: '{"sender":"10001","text":"10001\\n验证码：123456。尊敬的用户，感谢使用北京电信掌上营业厅。\\nSIM1_"}',
  });

  assert.equal(msg.id, 'router-1');
  assert.equal(msg.sender, '10001');
  assert.equal(msg.receivedAt, 1777660755000);
  assert.equal(msg.text.includes('验证码：123456'), true);
  assert.equal(msg.text.includes('SIM1_'), true);
});

test('converts PushPlus html message details to searchable text', () => {
  const text = htmlToText('<html><body><p>验证码&#65306;123456&nbsp;尊敬的用户</p><script>ignore()</script></body></html>');

  assert.equal(text.includes('验证码：123456'), true);
  assert.equal(text.includes('ignore'), false);
});

test('summarizes PushPlus details without exposing the code', () => {
  const summary = summarizePushPlusDetail('验证码：406560。尊敬的用户，感谢使用北京电信掌上营业厅。发件号码: 10001');

  assert.equal(summary.hasTelecomSender, true);
  assert.equal(summary.hasCodeHint, true);
  assert.equal(summary.hasBeijingTelecomLoginText, true);
});

test('parses PushPlus updateTime as China local time', () => {
  assert.equal(
    parsePushPlusUpdateTime('2026-06-01 08:00:10'),
    Date.UTC(2026, 5, 1, 0, 0, 10),
  );
});

test('reads login code from PushPlus messages without logging SMS body', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({ pathname: parsed.pathname, options });
    if (parsed.pathname === '/api/common/openApi/getAccessKey') {
      return {
        ok: true,
        json: async () => ({ code: 200, msg: '请求成功', data: { accessKey: 'access-key-1', expiresIn: 7200 } }),
      };
    }
    if (parsed.pathname === '/api/open/message/list') {
      assert.equal(options.headers['access-key'], 'access-key-1');
      return {
        ok: true,
        json: async () => ({
          code: 200,
          msg: '请求成功',
          data: {
            list: [
              {
                title: '短信转发',
                shortCode: 'short-1',
                channel: 'wechat',
                updateTime: '2026-06-01 08:00:10',
              },
            ],
          },
        }),
      };
    }
    if (parsed.pathname === '/shortMessage/short-1') {
      return {
        ok: true,
        text: async () => '<html><body><div>验证码：123456。尊敬的用户，感谢使用北京电信掌上营业厅。</div></body></html>',
      };
    }
    throw new Error(`unexpected fetch: ${parsed.pathname}`);
  };

  try {
    const client = new SmsInboxClient({
      smsInboxProvider: 'pushplus',
      pushPlusToken: 'token-1',
      pushPlusSecretKey: 'secret-1',
      pushPlusBaseUrl: 'https://www.pushplus.plus',
      pushPlusPageSize: 10,
      phone: '18500000000',
      productName: '互联网卡网龄享200分钟国内语音',
      expectedPlanId: '24BJ102053',
    });

    const sms = await client.waitForCode({
      stage: 'login',
      since: Date.UTC(2026, 5, 1, 0, 0, 0),
      timeoutMs: 100,
      pollMs: 1,
    });

    assert.deepEqual(sms, { code: '123456', stage: 'login', source: 'pushplus' });
    assert.deepEqual(calls.map(call => call.pathname), [
      '/api/common/openApi/getAccessKey',
      '/api/open/message/list',
      '/shortMessage/short-1',
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

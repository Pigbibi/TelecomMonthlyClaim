const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMessage } = require('../src/sms-inbox-client');

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

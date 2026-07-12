const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTelecomSms } = require('../src/sms-parser');
const { stateMonth, isFinalRetryDay } = require('../src/retry-date');

test('parses first Beijing Telecom login code', () => {
  const msg = { sender: '10001', text: '验证码：123456。尊敬的用户，感谢使用北京电信掌上营业厅。' };
  assert.deepEqual(parseTelecomSms(msg, { stage: 'login' }), { code: '123456', stage: 'login' });
});

test('parses login code when the wording around the code changes', () => {
  const msg = { sender: '10001', text: '您的验证码为123456，请妥善保管。尊敬的用户，感谢使用北京电信掌上营业厅。' };
  assert.deepEqual(parseTelecomSms(msg, { stage: 'login' }), { code: '123456', stage: 'login' });
});

test('parses second confirmation code with phone and product checks', () => {
  const text = '【办理提醒】尊敬的客户，您的验证码是：654321，号码18500000000于2026年05月02日在中国电信北京公司wap电子渠道办理互联网卡网龄享200分钟国内语音（方案编号：24BJ102053），立即生效，当月有效';
  assert.equal(parseTelecomSms({ sender: '10001', text }, {
    stage: 'confirm', expectedPhone: '18500000000', product: '互联网卡网龄享200分钟国内语音', planId: '24BJ102053',
  }).code, '654321');
});

test('parses confirmation code when punctuation changes', () => {
  const text = '【办理提醒】尊敬的客户，您的验证码是654321。号码18500000000于2026年05月02日在中国电信北京公司wap电子渠道办理互联网卡网龄享200分钟国内语音(方案编号:24BJ102053)，立即生效，当月有效';
  assert.equal(parseTelecomSms({ sender: '10001', text }, {
    stage: 'confirm', expectedPhone: '18500000000', product: '互联网卡网龄享200分钟国内语音', planId: '24BJ102053',
  }).code, '654321');
});

test('rejects confirmation code for mismatched plan when plan is configured', () => {
  const text = '【办理提醒】尊敬的客户，您的验证码是：654321，号码18500000000于2026年05月02日办理互联网卡网龄享200分钟国内语音（方案编号：24BJ102053）';
  assert.equal(parseTelecomSms({ sender: '10001', text }, {
    stage: 'confirm', expectedPhone: '18500000000', product: '互联网卡网龄享200分钟国内语音', planId: '24BJ999999',
  }), null);
});

test('rejects confirmation code for wrong phone', () => {
  const text = '【办理提醒】尊敬的客户，您的验证码是：654321，号码18500000000于2026年05月02日办理互联网卡网龄享200分钟国内语音（方案编号：24BJ102053）';
  assert.equal(parseTelecomSms({ sender: '10001', text }, { stage: 'confirm', expectedPhone: '18511112222' }), null);
});

test('parses 200-minute success receipt from service sender', () => {
  const text = '【办理提醒】尊敬的客户，您于2026年07月13日在【中国电信】wap电子渠道成功办理互联网卡网龄享200分钟国内语音（方案编号24BJ102053），立即生效，当月有效';
  assert.deepEqual(parseTelecomSms({ sender: '10000', text }, {
    stage: 'receipt', product: '互联网卡网龄享200分钟国内语音', planId: '24BJ102053',
  }), {
    stage: 'receipt',
    product: '互联网卡网龄享200分钟国内语音',
    planId: '24BJ102053',
  });
});

test('parses 5GB success receipt despite carrier channel wording difference', () => {
  const text = '【办理提醒】尊敬的客户，您于2026年04月06日在【北京电信】wap电子渠道成功办理互联网卡网龄享5GB国内通用流量（方案编号24BJ100433），立即生效，当月有效';
  assert.deepEqual(parseTelecomSms({ sender: '10000', text }, {
    stage: 'receipt', product: '互联网卡网龄享5GB国内通用流量', planId: '24BJ100433',
  }), {
    stage: 'receipt',
    product: '互联网卡网龄享5GB国内通用流量',
    planId: '24BJ100433',
  });
});

test('rejects success receipt from wrong sender or for wrong plan', () => {
  const text = '【办理提醒】成功办理互联网卡网龄享200分钟国内语音（方案编号24BJ102053）';
  const options = { stage: 'receipt', product: '互联网卡网龄享200分钟国内语音', planId: '24BJ102053' };
  assert.equal(parseTelecomSms({ sender: '10001', text }, options), null);
  assert.equal(parseTelecomSms({ sender: '10000', text }, { ...options, planId: '24BJ999999' }), null);
});

test('supports a configured success receipt sender', () => {
  const text = '【办理提醒】成功办理互联网卡网龄享200分钟国内语音（方案编号24BJ102053）';
  assert.equal(parseTelecomSms({ sender: 'carrier-service', text }, {
    stage: 'receipt', sender: 'carrier-service', product: '互联网卡网龄享200分钟国内语音', planId: '24BJ102053',
  })?.stage, 'receipt');
});

test('computes Beijing retry month/day', () => {
  assert.equal(stateMonth(new Date('2026-05-02T00:00:00+08:00')), '2026-05');
  assert.equal(isFinalRetryDay(new Date('2026-05-03T00:00:00+08:00'), 3), true);
});

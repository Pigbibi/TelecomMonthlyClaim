const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPackageGate, summarizePackageGate } = require('../src/package-gate');

test('classifies a rendered target package as ready', () => {
  assert.equal(classifyPackageGate({
    url: 'https://wapbj.189.cn/wap2017/preDepositCfg_list',
    bodyText: '互联网卡网龄享200分钟国内语音 去办理',
    productName: '互联网卡网龄享200分钟国内语音',
  }).state, 'ready');
});

test('classifies explicit duplicate claim wording', () => {
  assert.equal(classifyPackageGate({
    url: 'https://wapbj.189.cn/wap2017/index',
    dialogText: '该优惠本月已办理，无需重复办理',
    productName: '互联网卡网龄享5GB国内通用流量',
  }).state, 'already_claimed');
});

test('keeps an unknown modal blocked and masks sensitive diagnostics', () => {
  const gate = classifyPackageGate({
    url: 'https://wapbj.189.cn/path?token=secret-value',
    dialogText: '号码18500000000，验证码123456，服务暂不可用',
    productName: '互联网卡网龄享200分钟国内语音',
  });
  const summary = summarizePackageGate(gate);

  assert.equal(gate.state, 'blocked');
  assert.equal(summary.urlPath, '/path');
  assert.equal(summary.dialog.includes('18500000000'), false);
  assert.equal(summary.dialog.includes('123456'), false);
});

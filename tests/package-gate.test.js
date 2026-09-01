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

test('accepts redesigned preDepositCfq_list package path', () => {
  assert.equal(classifyPackageGate({
    url: 'https://wapbj.189.cn/echnwap/preDepositCfq_list',
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

test('accepts shortened redesigned package labels', () => {
  assert.equal(classifyPackageGate({
    url: 'https://wapbj.189.cn/echnwap/preDepositCfq_list',
    bodyText: '请选择档位',
    packageLabels: ['网龄享200分钟国内语音', '去办理'],
    productName: '互联网卡网龄享200分钟国内语音',
  }).state, 'ready');
});

test('summary keeps waiting when list has not rendered offers yet', () => {
  const summary = summarizePackageGate(classifyPackageGate({
    url: 'https://wapbj.189.cn/echnwap/preDepositCfq_list',
    bodyText: '加载中',
    packageLabels: ['加载中'],
    productName: '互联网卡网龄享200分钟国内语音',
  }));
  assert.equal(summary.state, 'waiting');
  assert.deepEqual(summary.packageLabels, ['加载中']);
});

test('marks non-matching offers as unavailable instead of claiming them', () => {
  const gate = classifyPackageGate({
    url: 'https://wapbj.189.cn/echnwap/preDepositCfq_list',
    bodyText: '3GB通用流量-网龄活动专用 提交订单',
    packageLabels: ['3GB通用流量-网龄活动专用', '提交订单'],
    productName: '互联网卡网龄享200分钟国内语音',
  });
  assert.equal(gate.state, 'unavailable');
  assert.deepEqual(gate.packageLabels, ['3GB通用流量-网龄活动专用']);
});

test('uses preActiveMeta offers when DOM labels are incomplete', () => {
  const gate = classifyPackageGate({
    url: 'https://wapbj.189.cn/echnwap/preDepositCfq_list',
    bodyText: '加载中',
    packageLabels: [],
    metaOffers: ['3GB通用流量-网龄活动专用'],
    productName: '互联网卡网龄享200分钟国内语音',
  });
  assert.equal(gate.state, 'unavailable');
  assert.deepEqual(gate.packageLabels, ['3GB通用流量-网龄活动专用']);
});

test('summary includes page family', () => {
  const summary = summarizePackageGate(classifyPackageGate({
    url: 'https://wapbj.189.cn/echnwap/preDepositCfq_list',
    bodyText: '互联网卡网龄享200分钟国内语音',
    packageLabels: ['互联网卡网龄享200分钟国内语音'],
    productName: '互联网卡网龄享200分钟国内语音',
  }));
  assert.equal(summary.state, 'ready');
  assert.equal(summary.pageFamily, 'echnwap');
});

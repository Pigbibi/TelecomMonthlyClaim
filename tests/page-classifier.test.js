const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyTelecomPageObservation } = require('../src/page-classifier');

test('classifies new one-click login shell with SMS fallback', () => {
  const state = classifyTelecomPageObservation({
    url: 'https://wapbj.189.cn/echnwap/preDepositHigh_login?campaignId=171xxx',
    bodyText: '本机号码一键登录 其他登录方式 短信验证码登录',
    actionTexts: ['本机号码一键登录', '短信验证码登录', '业务规则'],
  });

  assert.equal(state.state, 'entry_shell');
  assert.equal(state.confidence > 0.9, true);
});

test('classifies visible SMS login form', () => {
  const state = classifyTelecomPageObservation({
    bodyText: '短信验证码登录 请输入短信验证码 点击获取',
    hasPhone: true,
    hasCode: true,
    hasSendBtn: true,
  });

  assert.equal(state.state, 'sms_login_form');
});

test('classifies slider error popup before generic SMS form', () => {
  const state = classifyTelecomPageObservation({
    bodyText: '请完成安全验证 获取验证码失败，请重试',
    dialogs: ['请完成安全验证 获取验证码失败，请重试'],
    hasPhone: true,
    hasCode: true,
    hasSendBtn: true,
    slider: { popup: true, track: false, canvas: false, message: '获取验证码失败，请重试' },
  });

  assert.equal(state.state, 'slider_error');
});

test('classifies package list page', () => {
  const state = classifyTelecomPageObservation({
    url: 'https://wapbj.189.cn/echnwap/preDepositCfg_list',
    bodyText: '请选择档位 去办理',
  });

  assert.equal(state.state, 'package_list');
});

test('classifies final confirm page from confirm controls', () => {
  const state = classifyTelecomPageObservation({
    activeNameText: '互联网卡网龄享200分钟国内语音',
    hasPayConfirmBtn: true,
  });

  assert.equal(state.state, 'final_confirm');
});

test('classifies success page from result url', () => {
  const state = classifyTelecomPageObservation({
    url: 'https://wapbj.189.cn/echnwap/preDeposit_result',
  });

  assert.equal(state.state, 'success_page');
});

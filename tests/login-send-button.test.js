const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LOGIN_PHONE_SELECTORS,
  clickLoginSmsButton,
  detectLoginFormState,
  ensureSmsLoginForm,
  firstVisibleLocator,
  hasProxyTunnelFailures,
  isRetryableLoginSendError,
  isTelecomWafRejection,
} = require('../scripts/telecom-monthly-claim');

function fakePage(visibleSelectors) {
  const clicked = [];
  return {
    clicked,
    locator(selector) {
      const visible = visibleSelectors.has(selector);
      const locator = {
        first: () => locator,
        count: async () => (visible ? 1 : 0),
        isVisible: async () => visible,
        click: async () => { clicked.push(selector); },
      };
      return locator;
    },
    evaluate: async () => '',
  };
}

test('clicks the legacy login SMS send button selector', async () => {
  const page = fakePage(new Set(['.content_send_unlog']));

  const selector = await clickLoginSmsButton(page, { actionDelayMs: 0 });

  assert.equal(selector, '.content_send_unlog');
  assert.deepEqual(page.clicked, ['.content_send_unlog']);
});

test('falls back to visible text selector when legacy class changes', async () => {
  const page = fakePage(new Set(['button:has-text("验证码")']));

  const selector = await clickLoginSmsButton(page, { actionDelayMs: 0 });

  assert.equal(selector, 'button:has-text("验证码")');
  assert.deepEqual(page.clicked, ['button:has-text("验证码")']);
});

test('clicks the Vant login SMS send button text', async () => {
  const page = fakePage(new Set(['button:has-text("点击获取")']));

  const selector = await clickLoginSmsButton(page, { actionDelayMs: 0 });

  assert.equal(selector, 'button:has-text("点击获取")');
  assert.deepEqual(page.clicked, ['button:has-text("点击获取")']);
});

test('phone selectors include Vant field fallback for minimal login page', () => {
  assert.equal(LOGIN_PHONE_SELECTORS.includes('input.van-field__control'), true);
});

test('detectLoginFormState uses broad selector lists for minimal login readiness', async () => {
  let payload = null;
  const page = {
    evaluate: async (_fn, args) => {
      payload = args;
      return {
        htmlLength: 12345,
        bodyLength: 12,
        title: '预存平台登录',
        formReady: true,
        hasPhone: true,
        hasCode: true,
        hasSendBtn: true,
        phone: { selector: 'input.van-field__control' },
        code: { selector: 'input.checknum-input' },
        send: { selector: '.checknum-button' },
      };
    },
  };

  const state = await detectLoginFormState(page);

  assert.equal(payload.phoneSelectors.includes('input.van-field__control'), true);
  assert.equal(payload.codeSelectors.includes('input.checknum-input'), true);
  assert.equal(payload.sendSelectors.includes('.checknum-button.slider-sms-btn'), true);
  assert.equal(state.formReady, true);
});

test('ensureSmsLoginForm clicks SMS login tab for minimal entry page', async () => {
  let smsTabClicked = false;
  const page = {
    locator(selector) {
      const visible = smsTabClicked && selector === 'input.van-field__control';
      return {
        count: async () => (visible ? 1 : 0),
        nth: () => ({
          evaluate: async () => true,
          isVisible: async () => true,
        }),
      };
    },
    getByText(text) {
      return {
        isVisible: async () => text === '短信验证码登录',
        click: async () => { smsTabClicked = true; },
      };
    },
  };

  const match = await ensureSmsLoginForm(page, { actionDelayMs: 0 });

  assert.equal(smsTabClicked, true);
  assert.equal(match.selector, 'input.van-field__control');
});

test('picks a visible input when the first matching Vant input is hidden', async () => {
  const page = {
    locator(selector) {
      const visibleByIndex = selector === 'input[placeholder*="手机号码"]' ? [false, true] : [];
      return {
        count: async () => visibleByIndex.length,
        nth: index => ({
          id: `${selector}:${index}`,
          isVisible: async () => visibleByIndex[index],
        }),
      };
    },
  };

  const match = await firstVisibleLocator(page, ['input[placeholder*="手机号码"]']);

  assert.equal(match.selector, 'input[placeholder*="手机号码"]');
  assert.equal(match.locator.id, 'input[placeholder*="手机号码"]:1');
});

test('does not trust Playwright visibility when DOM rect says input is hidden', async () => {
  const page = {
    locator(selector) {
      return {
        count: async () => (selector === 'input[placeholder*="手机号码"]' ? 2 : 0),
        nth: index => ({
          id: `${selector}:${index}`,
          evaluate: async () => index === 1,
          isVisible: async () => true,
        }),
      };
    },
  };

  const match = await firstVisibleLocator(page, ['input[placeholder*="手机号码"]']);

  assert.equal(match.locator.id, 'input[placeholder*="手机号码"]:1');
});

test('retries blank telecom slider challenge rejections', () => {
  assert.equal(
    isRetryableLoginSendError(new Error('Telecom slider challenge rejected with blank HTTP 400; getSliderChallenge HTTP 400')),
    true,
  );
});

test('retries slider busy and missing puzzle image failures', () => {
  assert.equal(
    isRetryableLoginSendError(new Error('Telecom slider challenge busy (服务繁忙); getSliderChallenge rejected before puzzle image')),
    true,
  );
  assert.equal(
    isRetryableLoginSendError(new Error('Telecom slider puzzle image missing after challenge; getSliderChallenge HTTP 400')),
    true,
  );
});

test('retries proxy tunnel slider failures', () => {
  assert.equal(
    isRetryableLoginSendError(new Error('Proxy tunnel failed during slider challenge; ERR_TUNNEL_CONNECTION_FAILED, getSliderChallenge HTTP 400')),
    true,
  );
});

test('retries login phone field failures even when proxy tunnel errors are present', () => {
  assert.equal(
    isRetryableLoginSendError(new Error('Login phone field not found after opening SMS login form; page summary: {"diagnostics":[{"error":"net::ERR_TUNNEL_CONNECTION_FAILED"}]}')),
    true,
  );
});

test('detects proxy tunnel failures from page diagnostics', () => {
  assert.equal(
    hasProxyTunnelFailures({ __telecomDiagnostics: [{ error: 'net::ERR_TUNNEL_CONNECTION_FAILED' }] }),
    true,
  );
  assert.equal(
    hasProxyTunnelFailures({ __telecomDiagnostics: [{ status: 412 }] }),
    false,
  );
});

test('classifies blank telecom slider challenge as WAF rejection', () => {
  assert.equal(
    isTelecomWafRejection(new Error('Telecom slider challenge rejected with blank HTTP 400; getSliderChallenge HTTP 400')),
    true,
  );
});

test('preActiveMeta HTTP 400 fails fast without reloading', async () => {
  const { waitForTelecomApiReady } = require('../scripts/telecom-monthly-claim');
  const page = {
    __telecomDiagnostics: [{
      type: 'response',
      url: 'https://wapbj.189.cn/wap2017/re/wapFree/preDepositNew/preActiveMeta?token=abc',
      status: 400,
    }],
    evaluate: async () => 5000,
  };
  const ready = await waitForTelecomApiReady(page, { actionDelayMs: 0 }, [/preActiveMeta/], 2000);
  assert.equal(ready, false);
});

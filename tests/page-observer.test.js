const test = require('node:test');
const assert = require('node:assert/strict');
const { observeTelecomPage } = require('../src/page-observer');

function makeElement({
  tagName = 'DIV',
  innerText = '',
  value = '',
  placeholder = '',
  id = '',
  className = '',
  type = '',
  visible = true,
  width = 160,
  height = 40,
} = {}) {
  return {
    tagName,
    innerText,
    textContent: innerText,
    value,
    id,
    className,
    disabled: false,
    getAttribute(name) {
      return {
        placeholder,
        type,
        title: '',
        'aria-label': '',
      }[name] || '';
    },
    getBoundingClientRect() {
      return { width, height };
    },
    __visible: visible,
  };
}

test('observeTelecomPage ignores Playwright-only selectors and falls back to visible send text', async () => {
  const phone = makeElement({
    tagName: 'INPUT',
    value: '18519200015',
    className: 'van-field__control',
    type: 'text',
  });
  const code = makeElement({
    tagName: 'INPUT',
    placeholder: '请输入短信验证码',
    className: 'van-field__control',
    type: 'text',
  });
  const send = makeElement({
    tagName: 'BUTTON',
    innerText: '点击获取',
    className: 'van-button',
  });
  const submit = makeElement({
    tagName: 'BUTTON',
    innerText: '立即办理',
  });
  const selectorMap = new Map([
    ['input.van-field__control', [phone, code]],
    ['input[placeholder*="短信验证码"]', [code]],
    ['button,a,span,div,input', [phone, code, send, submit]],
    ['li', []],
    ['canvas', []],
    ['#slider_track_btn,.slider-btn,.slider-track,.sliderContainer,.slider', []],
    ['#slider_bg_image', []],
    ['#slider_block_image', []],
    ['#wap-dialog,.wap-dialog,.diaog-popup,#dialog-box,.puzzle-verify-popup,.van-popup', []],
    ['.puzzle-msg,.slider-check-msg,.puzzle-title,.puzzle-verify-popup,.captcha-wrapper', []],
  ]);

  const page = {
    async evaluate(fn, args) {
      const previous = {
        document: global.document,
        location: global.location,
        getComputedStyle: global.getComputedStyle,
      };
      global.getComputedStyle = element => ({
        display: element?.__visible === false ? 'none' : 'block',
        visibility: element?.__visible === false ? 'hidden' : 'visible',
        pointerEvents: 'auto',
      });
      global.location = { href: 'https://wapbj.189.cn/echnwap/preDepositHigh_login?campaignId=171xxx' };
      global.document = {
        title: '预存平台登录',
        readyState: 'complete',
        scripts: [],
        body: { innerText: '18519200015 请输入短信验证码 点击获取 立即办理' },
        documentElement: { outerHTML: '<html>mock telecom page</html>' },
        querySelectorAll(selector) {
          if (selector.includes(':has-text(')) {
            throw new Error(`Invalid selector: ${selector}`);
          }
          return selectorMap.get(selector) || [];
        },
        querySelector() {
          return null;
        },
      };
      try {
        return fn(args);
      } finally {
        global.document = previous.document;
        global.location = previous.location;
        global.getComputedStyle = previous.getComputedStyle;
      }
    },
  };

  const observation = await observeTelecomPage(page, {
    phoneSelectors: ['input.van-field__control'],
    codeSelectors: ['input[placeholder*="短信验证码"]'],
    sendSelectors: ['button:has-text("点击获取")'],
  });

  assert.equal(observation.hasPhone, true);
  assert.equal(observation.hasCode, true);
  assert.equal(observation.hasSendBtn, true);
  assert.equal(observation.phone.filled, true);
  assert.equal(observation.phone.valueLength, 11);
  assert.equal(observation.send.selector, '__send_text_fallback__');
  assert.equal(observation.pageState, 'sms_login_form');
});

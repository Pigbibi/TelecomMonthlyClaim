const PREFLIGHT_URL = '__PREFLIGHT_URL__';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function postStatus(payload) {
  await fetch(`${PREFLIGHT_URL}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function send(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

async function evaluate(target, expression) {
  const result = await send(target, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  return result.result?.value;
}

async function waitForPhoneInput(target, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(target, `(() => {
      const selectors = ['#phoneNumber', '#phone', 'input[type="tel"]', 'input[placeholder*="手机"]', 'input.van-field__control'];
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const input = selectors.map(selector => document.querySelector(selector)).find(visible);
      return input ? { ready: true } : { ready: false, htmlLength: document.documentElement?.outerHTML?.length || 0 };
    })()`);
    if (state?.ready) return true;
    await sleep(800);
  }
  return false;
}

async function focusPhoneInput(target) {
  return evaluate(target, `(() => {
    const selectors = ['#phoneNumber', '#phone', 'input[type="tel"]', 'input[placeholder*="手机"]', 'input.van-field__control'];
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const input = selectors.map(selector => document.querySelector(selector)).find(visible);
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, ''); else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function clickSmsButton(target) {
  const point = await evaluate(target, `(() => {
    const selectors = ['.checknum-button.slider-sms-btn', '.checknum-button', '.slider-sms-btn', '.content_send_unlog', '#sendCode'];
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const button = selectors.map(selector => document.querySelector(selector)).find(visible);
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!point) return false;
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await sleep(250);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(120);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return true;
}

async function waitForSlider(target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(target, `(() => {
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      const message = document.querySelector('#slider_check_msg,.slider-check-msg,.puzzle-msg')?.innerText?.trim() || '';
      const ready = !!(bg?.complete && bg.naturalWidth > 40 && block?.complete && block.naturalWidth > 10);
      return { ready, busy: !ready && /服务繁忙|请稍后再试/.test(message), message: message.slice(0, 80) };
    })()`);
    if (state?.ready || state?.busy) return state;
    await sleep(500);
  }
  return { ready: false, busy: false, message: 'slider-timeout' };
}

async function run() {
  let target = null;
  try {
    const config = await fetch(`${PREFLIGHT_URL}/config`).then(response => response.json());
    const tab = await chrome.tabs.create({ url: config.entryUrl, active: true });
    target = { tabId: tab.id };
    await chrome.debugger.attach(target, '1.3');
    if (!await waitForPhoneInput(target)) throw new Error('phone-input-timeout');
    if (!await focusPhoneInput(target)) throw new Error('phone-input-missing');
    for (const digit of String(config.phone || '')) {
      await send(target, 'Input.insertText', { text: digit });
      await sleep(70 + Math.floor(Math.random() * 90));
    }
    await sleep(900 + Math.floor(Math.random() * 900));
    if (!await clickSmsButton(target)) throw new Error('sms-button-missing');
    const slider = await waitForSlider(target);
    await chrome.debugger.detach(target).catch(() => {});
    target = null;
    await postStatus(slider.ready ? { stage: 'slider-ready' } : {
      stage: slider.busy ? 'slider-busy' : 'slider-timeout',
      message: slider.message,
    });
  } catch (error) {
    if (target) await chrome.debugger.detach(target).catch(() => {});
    await postStatus({ stage: 'error', message: String(error?.message || error).slice(0, 120) }).catch(() => {});
  }
}

void run();

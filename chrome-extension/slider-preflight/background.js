const PREFLIGHT_URL = '__PREFLIGHT_URL__';
const MATCH_FUNCTION_SOURCE = '__MATCH_FUNCTION_SOURCE__';

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

async function solveSlider(target) {
  const match = await evaluate(target, `(${MATCH_FUNCTION_SOURCE})({})`);
  if (!match?.ok || !match.btn || !Number.isFinite(match.moveX) || match.moveX < 40) {
    throw new Error(`slider-match-failed:${match?.reason || 'invalid-result'}`);
  }
  const startX = match.btn.cx;
  const startY = match.btn.cy;
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY });
  await sleep(250);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 50; step += 1) {
    const t = step / 50;
    const ease = 1 - Math.pow(1 - t, 2.4);
    await send(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + match.moveX * ease,
      y: startY + Math.sin(t * Math.PI * 3) * 2,
      button: 'left',
    });
    await sleep(24 + (step % 5) * 8);
  }
  await send(target, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: startX + match.moveX,
    y: startY,
    button: 'left',
    clickCount: 1,
  });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const state = await evaluate(target, `(() => {
      const text = document.body?.innerText || '';
      const slider = document.querySelector('#slider_check,.slider-check-box');
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return {
        sent: /验证码已下发|请注意查收/.test(text),
        failed: /服务繁忙|验证失败|请稍后再试/.test(text),
        sliderVisible: visible(slider),
      };
    })()`);
    if (state?.sent || (!state?.sliderVisible && !state?.failed)) return { ok: true, naturalX: match.naturalX };
    if (state?.failed) return { ok: false, reason: 'slider-validation-failed', naturalX: match.naturalX };
    await sleep(500);
  }
  return { ok: false, reason: 'sms-send-timeout', naturalX: match.naturalX };
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
    const solved = slider.ready ? await solveSlider(target) : { ok: false, reason: slider.message || 'slider-not-ready' };
    await chrome.debugger.detach(target).catch(() => {});
    target = null;
    await postStatus(solved.ok ? { stage: 'sms-sent' } : {
      stage: slider.busy ? 'slider-busy' : 'slider-timeout',
      message: solved.reason || slider.message,
    });
  } catch (error) {
    if (target) await chrome.debugger.detach(target).catch(() => {});
    await postStatus({ stage: 'error', message: String(error?.message || error).slice(0, 120) }).catch(() => {});
  }
}

void run();

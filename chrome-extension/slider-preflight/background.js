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

function sliderEndpoint(url = '') {
  if (url.includes('/getSliderChallenge')) return 'getSliderChallenge';
  if (url.includes('/validSlider')) return 'validSlider';
  if (url.includes('/sendRandByUnlog')) return 'sendRandByUnlog';
  return '';
}

function createNetworkMonitor(tabId) {
  const requests = new Map();
  const events = [];
  const listener = (source, method, params) => {
    if (source.tabId !== tabId) return;
    if (method === 'Network.requestWillBeSent') {
      const endpoint = sliderEndpoint(params.request?.url || '');
      if (endpoint) requests.set(params.requestId, { endpoint, method: params.request?.method || '' });
      return;
    }
    const request = requests.get(params.requestId);
    if (!request) return;
    if (method === 'Network.responseReceived') {
      events.push({ ...request, status: params.response?.status || 0, mimeType: params.response?.mimeType || '' });
    } else if (method === 'Network.loadingFailed') {
      events.push({ ...request, failed: true, error: String(params.errorText || '').slice(0, 80) });
    }
  };
  chrome.debugger.onEvent.addListener(listener);
  return {
    snapshot: () => events.slice(-8),
    stop: () => chrome.debugger.onEvent.removeListener(listener),
  };
}

async function captureFailureScreenshot(target) {
  try {
    await send(target, 'Page.enable');
    const screenshot = await send(target, 'Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!screenshot?.data) return false;
    const response = await fetch(`${PREFLIGHT_URL}/screenshot`, { method: 'POST', body: screenshot.data });
    return response.ok;
  } catch {
    return false;
  }
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
    const match = selectors.map(selector => ({ selector, button: document.querySelector(selector) }))
      .find(candidate => visible(candidate.button));
    if (!match) return null;
    const button = match.button;
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, selector: match.selector };
  })()`);
  if (!point) return false;
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await sleep(250);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(120);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return point;
}

async function waitForSlider(target, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(target, `(() => {
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      const slider = document.querySelector('#slider_check,.slider-check-box');
      const message = document.querySelector('#slider_check_msg,.slider-check-msg,.puzzle-msg')?.innerText?.trim() || '';
      const ready = !!(bg?.complete && bg.naturalWidth > 40 && block?.complete && block.naturalWidth > 10);
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      return {
        ready,
        busy: !ready && /服务繁忙|请稍后再试/.test(message),
        message: message.slice(0, 80),
        sliderVisible: visible(slider),
        bgPresent: !!bg,
        blockPresent: !!block,
        bgWidth: bg?.naturalWidth || 0,
        blockWidth: block?.naturalWidth || 0,
        webdriver: navigator.webdriver === true,
        htmlLength: document.documentElement?.outerHTML?.length || 0,
      };
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

async function waitForLoginCode(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${PREFLIGHT_URL}/login-code`);
    if (response.status === 200) {
      const payload = await response.json();
      if (/^\d{4,8}$/.test(String(payload.code || ''))) return String(payload.code);
    }
    await sleep(1500);
  }
  throw new Error('login-code-timeout');
}

async function clickVisible(target, selectors, textPattern = '') {
  const point = await evaluate(target, `(() => {
    const selectors = ${JSON.stringify(selectors)};
    const pattern = ${JSON.stringify(textPattern)} ? new RegExp(${JSON.stringify(textPattern)}) : null;
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    let element = selectors.map(selector => document.querySelector(selector)).find(visible);
    if (!element && pattern) element = [...document.querySelectorAll('button,a,div,span')]
      .filter(node => visible(node) && pattern.test((node.innerText || '').trim()))
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      })[0];
    if (!element) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  if (!point) return false;
  await send(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await sleep(100);
  await send(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return true;
}

async function submitLoginCode(target, code) {
  await evaluate(target, `(() => {
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    for (const dialog of [...document.querySelectorAll('#wap-dialog,.wap-dialog,.diaog-popup')].filter(visible)) {
      const close = [...dialog.querySelectorAll('button,a,div,span')]
        .filter(visible)
        .find(node => /^(我知道了|知道了|确定)$/.test((node.innerText || '').replace(/\s+/g, '')));
      if (close) close.click();
    }
    return true;
  })()`);
  await sleep(500);
  const focused = await evaluate(target, `(() => {
    const input = document.querySelector('#code,input[placeholder*="验证码"],input.checknum-input');
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, ''); else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!focused) throw new Error('login-code-input-missing');
  for (const digit of code) {
    await send(target, 'Input.insertText', { text: digit });
    await sleep(80 + Math.floor(Math.random() * 80));
  }
  await evaluate(target, `(() => {
    const input = document.querySelector('#code,input[placeholder*="验证码"],input.checknum-input');
    if (!input) return false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return true;
  })()`);
  await sleep(700);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (!await clickVisible(target, ['.know-box.button'], '^(立即领取|立即办理)$')) throw new Error('login-submit-missing');
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const state = await evaluate(target, `(() => ({
        complete: location.href.includes('preDepositCfg_list') || /请选择档位|去办理/.test(document.body?.innerText || ''),
        failed: /短信输入错误|验证码.*错误|验证码.*过期|服务繁忙/.test(document.body?.innerText || ''),
      }))()`);
      if (state?.complete) return true;
      if (state?.failed) return false;
      await sleep(500);
    }
    await evaluate(target, `(() => {
      const dialog = [...document.querySelectorAll('#wap-dialog,.wap-dialog,.diaog-popup')]
        .find(element => getComputedStyle(element).display !== 'none');
      const close = dialog && [...dialog.querySelectorAll('button,a,div,span')]
        .find(node => /^(我知道了|知道了|确定)$/.test((node.innerText || '').replace(/\s+/g, '')));
      close?.click();
      return !!close;
    })()`).catch(() => false);
    await sleep(700);
  }
  return false;
}

async function run() {
  let target = null;
  let networkMonitor = null;
  let smsClick = null;
  try {
    const config = await fetch(`${PREFLIGHT_URL}/config`).then(response => response.json());
    const tab = await chrome.tabs.create({ url: config.entryUrl, active: true });
    target = { tabId: tab.id };
    await postStatus({ stage: 'tab-opened' });
    await chrome.debugger.attach(target, '1.3');
    await postStatus({ stage: 'debugger-attached' });
    await send(target, 'Network.enable');
    networkMonitor = createNetworkMonitor(tab.id);
    await postStatus({ stage: 'network-ready' });
    if (!await waitForPhoneInput(target)) throw new Error('phone-input-timeout');
    await postStatus({ stage: 'phone-ready' });
    if (!await focusPhoneInput(target)) throw new Error('phone-input-missing');
    for (const digit of String(config.phone || '')) {
      await send(target, 'Input.insertText', { text: digit });
      await sleep(70 + Math.floor(Math.random() * 90));
    }
    await sleep(900 + Math.floor(Math.random() * 900));
    smsClick = await clickSmsButton(target);
    if (!smsClick) throw new Error('sms-button-missing');
    await postStatus({ stage: 'sms-clicked' });
    const slider = await waitForSlider(target);
    const solved = slider.ready ? await solveSlider(target) : { ok: false, reason: slider.message || 'slider-not-ready' };
    if (!solved.ok) {
      await captureFailureScreenshot(target);
      const diagnostic = {
        clickSelector: smsClick.selector,
        slider,
        network: networkMonitor?.snapshot() || [],
      };
      networkMonitor?.stop();
      networkMonitor = null;
      await chrome.debugger.detach(target).catch(() => {});
      target = null;
      await postStatus({
        stage: slider.busy ? 'slider-busy' : 'slider-timeout',
        message: solved.reason || slider.message,
        diagnostic,
      });
      return;
    }
    await postStatus({ stage: 'sms-sent' });
    const code = await waitForLoginCode();
    const loggedIn = await submitLoginCode(target, code);
    networkMonitor?.stop();
    networkMonitor = null;
    await chrome.debugger.detach(target).catch(() => {});
    target = null;
    await postStatus({ stage: loggedIn ? 'login-complete' : 'login-failed' });
  } catch (error) {
    const diagnostic = { network: networkMonitor?.snapshot() || [] };
    if (target) await captureFailureScreenshot(target);
    networkMonitor?.stop();
    if (target) await chrome.debugger.detach(target).catch(() => {});
    await postStatus({
      stage: 'error',
      message: String(error?.message || error).slice(0, 120),
      diagnostic,
    }).catch(() => {});
  }
}

void run();

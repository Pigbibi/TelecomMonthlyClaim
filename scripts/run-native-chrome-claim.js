#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { computeSliderImageMatchInPage } = require('../src/slider-local-match');
const { loadConfig } = require('../src/config');
const { SmsInboxClient } = require('../src/sms-inbox-client');

const root = path.resolve(__dirname, '..');
const entryUrl = process.env.TELECOM_ENTRY_URL;
const phone = process.env.TELECOM_PHONE;

if (!entryUrl) throw new Error('Missing TELECOM_ENTRY_URL');
if (!phone) throw new Error('Missing TELECOM_PHONE');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function resolveChromeBinary() {
  if (process.env.TELECOM_CHROME_BIN) return process.env.TELECOM_CHROME_BIN;
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  for (const name of ['google-chrome-stable', 'google-chrome']) {
    try {
      return execFileSync('command', ['-v', name], { encoding: 'utf8', shell: true }).trim();
    } catch {}
  }
  return '';
}

async function waitForCdp(cdpUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await wait(250);
  }
  throw new Error('Fresh system Chrome did not expose CDP');
}

async function waitForPageTarget(cdpUrl, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`${cdpUrl}/json`).then(response => response.json());
      const target = targets.find(item => item.type === 'page');
      if (target) return target;
    } catch {}
    await wait(500);
  }
  throw new Error('Fresh system Chrome did not open a page target');
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.networkRequests = new Map();
    this.networkResponseIds = new Map();
    this.networkEvents = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data || '{}'));
      if (!message.id) {
        this.trackNetworkEvent(message.method, message.params || {});
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
        return;
      }
      if (!this.pending.has(message.id)) return;
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || 'CDP command failed'));
      else resolve(message.result || {});
    });
  }

  trackNetworkEvent(method, params) {
    if (method === 'Network.requestWillBeSent') {
      try {
        const url = new URL(params.request?.url);
        if (url.hostname === 'wapbj.189.cn' && /getSliderChallenge|validSlider|sendRand|sendCode|SecondConfirmation/i.test(url.pathname)) {
          this.networkRequests.set(params.requestId, { pathname: url.pathname, method: params.request?.method || '' });
        }
      } catch {}
      return;
    }
    const request = this.networkRequests.get(params.requestId);
    if (!request) return;
    if (method === 'Network.responseReceived') {
      this.networkEvents.push({ ...request, status: params.response?.status || 0 });
      this.networkResponseIds.set(request.pathname, params.requestId);
    } else if (method === 'Network.loadingFailed') {
      this.networkEvents.push({ ...request, failed: true, error: String(params.errorText || '').slice(0, 80) });
    }
    if (this.networkEvents.length > 20) this.networkEvents.splice(0, this.networkEvents.length - 20);
  }

  recentNetworkEvents() {
    return this.networkEvents.slice(-10);
  }

  async recentNetworkDiagnostics() {
    const events = this.recentNetworkEvents().map(event => ({ ...event }));
    for (const event of events) {
      const requestId = this.networkResponseIds.get(event.pathname);
      if (!requestId || event.failed) continue;
      try {
        const result = await this.send('Network.getResponseBody', { requestId }, 5000);
        const body = String(result?.body || '');
        event.bodyBytes = body.length;
        const payload = JSON.parse(body);
        for (const key of ['code', 'status', 'resultCode', 'success']) {
          const value = payload?.[key];
          if (['string', 'number', 'boolean'].includes(typeof value) && String(value).length <= 24) {
            event[key] = value;
          }
        }
      } catch {}
    }
    return events;
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}, timeoutMs = method.startsWith('Input.') ? 15000 : 10000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 10000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitForPhoneInput(client, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await client.evaluate(`(() => {
      const input = document.querySelector('#phoneNumber,#phone,input[type="tel"],input[placeholder*="手机"]');
      if (!input) return false;
      const rect = input.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })()`);
    if (ready) return;
    await wait(500);
  }
  throw new Error('Native Chrome phone input did not become ready');
}

async function navigateToEntryPage(client) {
  let documentStatus = null;
  client.on('Network.responseReceived', event => {
    try {
      const url = new URL(event.response?.url);
      if (event.type === 'Document' && url.hostname === 'wapbj.189.cn') {
        documentStatus = event.response?.status;
      }
    } catch {}
  });
  await client.send('Page.enable');
  await client.send('Network.enable');
  const navigation = await client.send('Page.navigate', { url: entryUrl }, 30000);
  if (navigation.errorText) throw new Error(`Native Chrome entry navigation failed: ${navigation.errorText}`);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => ({
      readyState: document.readyState,
      telecom: location.hostname === 'wapbj.189.cn',
      hasPhone: !!document.querySelector('#phoneNumber,#phone,input[type="tel"],input[placeholder*="手机"]'),
    }))()`);
    if (state?.telecom && state?.hasPhone) return;
    // HTTP 400/412 is also used by the site's JavaScript browser-check page.
    // Keep the real browser alive so that challenge can set its cookie and
    // navigate to the application instead of aborting on the intermediate URL.
    await wait(500);
  }
  throw new Error(`Native Chrome entry page did not render${documentStatus == null ? '' : ` (HTTP ${documentStatus})`}`);
}

async function openSliderChallenge(client, phone) {
  const networkEvents = [];
  const describeUrl = rawUrl => {
    try {
      const url = new URL(rawUrl);
      return url.hostname === 'wapbj.189.cn' ? url.pathname : '';
    } catch {
      return '';
    }
  };
  client.on('Network.requestWillBeSent', event => {
    const pathname = describeUrl(event.request?.url);
    if (pathname && /getSliderChallenge|validSlider|sendRand|sendCode|SecondConfirmation/i.test(pathname)) {
      networkEvents.push({ phase: 'request', pathname });
    }
  });
  client.on('Network.responseReceived', event => {
    const pathname = describeUrl(event.response?.url);
    if (pathname && /getSliderChallenge|validSlider|sendRand|sendCode|SecondConfirmation/i.test(pathname)) {
      networkEvents.push({ phase: 'response', pathname, status: event.response?.status });
    }
  });
  await client.send('Network.enable');
  await waitForPhoneInput(client);
  const focused = await client.evaluate(`(() => {
    const input = document.querySelector('#phoneNumber,#phone,input[type="tel"],input[placeholder*="手机"]');
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, ''); else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!focused) throw new Error('Native Chrome phone input missing');
  for (const digit of String(phone || '')) {
    await client.send('Input.insertText', { text: digit });
    await wait(70 + Math.floor(Math.random() * 90));
  }
  await wait(900 + Math.floor(Math.random() * 900));
  const point = await client.evaluate(`(() => {
    const selectors = ['.content_send_unlog','#sendCode','.slider-sms-btn','.checknum-button.slider-sms-btn','.checknum-button'];
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textButton = [...document.querySelectorAll('button,a,div,span')]
      .filter(element => visible(element) && /^(获取验证码|点击获取)$/.test((element.innerText || '').replace(/\s+/g, '')))
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      })[0];
    const button = textButton || selectors.map(selector => document.querySelector(selector)).find(visible);
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    button.click();
    return {
      x,
      y,
      text: (button.innerText || button.textContent || '').trim(),
      disabled: !!button.disabled,
      hitInsideButton: hit === button || button.contains(hit),
    };
  })()`);
  if (!point) throw new Error('Native Chrome SMS button missing');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => {
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      const message = document.querySelector('#slider_check_msg,.slider-check-msg,.puzzle-msg')?.innerText?.trim() || '';
      return {
        ready: !!(bg?.complete && bg.naturalWidth > 40 && block?.complete && block.naturalWidth > 10),
        busy: /服务繁忙|请稍后再试/.test(message),
      };
    })()`);
    if (state?.ready) return;
    if (state?.busy) throw new Error('Native Chrome getSliderChallenge was rejected before Playwright attachment');
    await wait(500);
  }
  const finalState = await client.evaluate(`(() => ({
    buttonText: (document.querySelector('.checknum-button.slider-sms-btn,.checknum-button,.slider-sms-btn,.content_send_unlog,#sendCode')?.innerText || '').trim(),
    sliderPresent: !!document.querySelector('#slider_bg_image,#slider_check,.slider-check-box'),
    candidates: [...new Set([
      ...document.querySelectorAll('.content_send_unlog,#sendCode,.slider-sms-btn,.checknum-button.slider-sms-btn,.checknum-button'),
      ...document.elementsFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)}),
    ])].slice(0, 12).map(element => {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement;
      return {
        tag: element.tagName,
        id: element.id || '',
        className: String(element.className || '').slice(0, 120),
        text: (element.innerText || '').replace(/\s+/g, '').slice(0, 30),
        onclick: !!element.onclick,
        role: element.getAttribute('role') || '',
        rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        parent: parent ? [parent.tagName, parent.id || '', String(parent.className || '').slice(0, 80)] : null,
      };
    }),
  }))()`);
  console.log('Native Chrome slider open diagnostics', {
    buttonText: point.text,
    buttonDisabled: point.disabled,
    hitInsideButton: point.hitInsideButton,
    finalButtonText: finalState?.buttonText,
    sliderPresent: finalState?.sliderPresent,
    candidates: finalState?.candidates,
    networkEvents: networkEvents.slice(-8),
  });
  throw new Error('Native Chrome slider challenge did not become ready before Playwright attachment');
}

async function dragSlider(client, { startX, startY, moveX }) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY });
  await wait(250);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 30; step += 1) {
    const t = step / 30;
    const ease = 1 - Math.pow(1 - t, 2.4);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + moveX * ease,
      y: startY + Math.sin(t * Math.PI * 3) * 2,
      button: 'left',
    });
    await wait(24 + (step % 5) * 8);
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: startX + moveX,
    y: startY,
    button: 'left',
    clickCount: 1,
  });
}

async function solveSliderChallenge(client) {
  const match = await client.evaluate(`(${computeSliderImageMatchInPage.toString()})({})`, 30000);
  if (!match?.ok || !match.btn || !Number.isFinite(match.moveX) || match.moveX < 40) {
    throw new Error(`Native Chrome slider match failed: ${match?.reason || 'invalid-result'}`);
  }
  console.log('Native Chrome slider match', {
    method: match.method,
    naturalX: match.naturalX,
    flatX: match.flat?.naturalX,
    flatRun: match.flat?.run,
    holeX: match.hole?.naturalX,
    textureX: match.texture?.naturalX,
    edgeX: match.edge?.naturalX,
    edgeScore: match.edge?.score,
  });
  const startX = match.btn.cx;
  const startY = match.btn.cy;
  await dragSlider(client, { startX, startY, moveX: match.moveX });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => {
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
    if (state?.sent || (!state?.sliderVisible && !state?.failed)) return match.naturalX;
    if (state?.failed) throw new Error('Native Chrome slider validation failed before Playwright attachment');
    await wait(500);
  }
  throw new Error('Native Chrome slider validation timed out before Playwright attachment');
}

async function clickPageElement(client, selectors, textPattern = '') {
  const point = await client.evaluate(`(() => {
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
      .filter(node => visible(node) && pattern.test((node.innerText || '').replace(/\\s+/g, '')))
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
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await wait(200);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await wait(100);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  return true;
}

async function submitLoginCode(client, code) {
  await clickPageElement(client, [], '^(我知道了|知道了|确定)$').catch(() => false);
  await wait(500);
  const focused = await client.evaluate(`(() => {
    const input = document.querySelector('#code,input[placeholder*="验证码"],input.checknum-input');
    if (!input) return false;
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    if (setter) setter.call(input, ''); else input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!focused) throw new Error('Native Chrome login code input missing');
  for (const digit of String(code || '')) {
    await client.send('Input.insertText', { text: digit });
    await wait(80 + Math.floor(Math.random() * 80));
  }
  await client.evaluate(`(() => {
    const input = document.querySelector('#code,input[placeholder*="验证码"],input.checknum-input');
    input?.dispatchEvent(new Event('change', { bubbles: true }));
    input?.blur();
    return !!input;
  })()`);
  await wait(700);
  if (!await clickPageElement(client, ['.know-box.button'], '^(立即领取|立即办理)$')) {
    throw new Error('Native Chrome login submit button missing');
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => ({
      complete: location.href.includes('preDepositCfg_list') || /请选择档位|去办理/.test(document.body?.innerText || ''),
      failed: /短信输入错误|验证码.*错误|验证码.*过期|服务繁忙/.test(document.body?.innerText || ''),
    }))()`);
    if (state?.complete) return;
    if (state?.failed) throw new Error('Native Chrome login verification failed before Playwright attachment');
    await wait(500);
  }
  throw new Error('Native Chrome login verification timed out before Playwright attachment');
}

async function waitForPageState(client, expression, timeoutMs, errorMessage) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.evaluate(expression)) return;
    await wait(500);
  }
  throw new Error(errorMessage);
}

async function selectTargetPackage(client, productName) {
  await waitForPageState(
    client,
    `(() => location.href.includes('preDepositCfg_list')
      && [...document.querySelectorAll('li')].some(node => (node.innerText || '').includes(${JSON.stringify(productName)})))()`,
    30000,
    'Native Chrome target package did not render',
  );
  const selected = await client.evaluate(`(() => {
    const name = ${JSON.stringify(productName)};
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const item = [...document.querySelectorAll('li')].find(node => visible(node) && (node.innerText || '').includes(name));
    if (!item) return false;
    item.click();
    return true;
  })()`);
  if (!selected) throw new Error('Native Chrome target package missing');
  await wait(1000);
  if (!await clickPageElement(client, ['#conduct'])) throw new Error('Native Chrome package submit button missing');
  await waitForPageState(
    client,
    `(() => !!document.querySelector('#activeName') && !!document.querySelector('#payConfirm'))()`,
    20000,
    'Native Chrome confirm page did not become ready',
  );
}

async function openConfirmationSlider(client) {
  let popupReady = false;
  for (let attempt = 1; attempt <= 2 && !popupReady; attempt += 1) {
    await wait(attempt === 1 ? 1200 : 800);
    if (!await clickPageElement(client, ['#payConfirm'])) throw new Error('Native Chrome pay confirm button missing');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      popupReady = await client.evaluate(`(() => {
        const popup = document.querySelector('#secondPopCombo');
        if (!popup) return false;
        const rect = popup.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })()`);
      if (popupReady) break;
      await wait(500);
    }
  }
  if (!popupReady) throw new Error('Native Chrome second confirmation popup missing');
  if (!await clickPageElement(client, ['#SecondConfirmationSms'])) {
    throw new Error('Native Chrome confirmation SMS button missing');
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => {
      const root = document.querySelector('#secondPop_puzzle_check') || document;
      const canvas = [...root.querySelectorAll('canvas:not(.block),canvas')]
        .find(item => item.width >= 100 && item.height >= 50 && item.getBoundingClientRect().width > 0);
      const slider = root.querySelector('#slider_track_btn,.slider-btn,.slider,[class*="slider" i]');
      const message = document.querySelector('#secondPop_msg,.puzzle-msg,.slider-check-msg')?.innerText?.trim() || '';
      return {
        ready: !!(canvas && slider),
        busy: /服务繁忙|请稍后再试/.test(message),
      };
    })()`);
    if (state?.ready) return;
    if (state?.busy) throw new Error('Native Chrome confirmation slider challenge was rejected');
    await wait(500);
  }
  throw new Error('Native Chrome confirmation slider did not become ready');
}

async function solveConfirmationSlider(client) {
  const info = await client.evaluate(`(() => {
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const root = document.querySelector('#secondPop_puzzle_check') || document;
    const canvas = [...root.querySelectorAll('canvas:not(.block),canvas')]
      .find(item => visible(item) && item.width >= 100 && item.height >= 50);
    if (!canvas) return null;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let minx = canvas.width; let count = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (data[(y * canvas.width + x) * 4 + 3] === 0) {
          count += 1;
          minx = Math.min(minx, x);
        }
      }
    }
    const slider = [...root.querySelectorAll('#slider_track_btn,.slider-btn,.slider,[class*="slider" i]')]
      .filter(visible)
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
    if (!slider || count < 500 || minx >= canvas.width) return null;
    const sliderRect = slider.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    return {
      naturalX: minx,
      moveX: Math.round(minx * canvasRect.width / canvas.width),
      startX: sliderRect.x + sliderRect.width / 2,
      startY: sliderRect.y + sliderRect.height / 2,
    };
  })()`, 30000);
  if (!info || info.moveX < 40) throw new Error('Native Chrome confirmation slider target missing');
  await dragSlider(client, { startX: info.startX, startY: info.startY, moveX: info.moveX });
  const deadline = Date.now() + 25000;
  let hiddenSince = 0;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => {
      const text = document.body?.innerText || '';
      const popup = document.querySelector('#secondPop_puzzle_check');
      const rect = popup?.getBoundingClientRect();
      const visible = !!(popup && rect.width > 0 && rect.height > 0 && getComputedStyle(popup).display !== 'none');
      return {
        sent: /验证码已下发|请注意查收/.test(text),
        failed: /服务繁忙|验证失败|操作失败|请稍后再试/.test(text),
        visible,
      };
    })()`);
    if (state?.sent) return info.naturalX;
    if (state?.failed) {
      await wait(500);
      console.log('Native Chrome confirmation network diagnostics', await client.recentNetworkDiagnostics());
      throw new Error('Native Chrome confirmation slider or SMS operation failed');
    }
    if (!state?.visible) {
      if (!hiddenSince) hiddenSince = Date.now();
      if (Date.now() - hiddenSince >= 5000) return info.naturalX;
    } else {
      hiddenSince = 0;
    }
    await wait(500);
  }
  throw new Error('Native Chrome confirmation slider validation timed out');
}

async function captureCdpScreenshot(client) {
  try {
    await client.send('Page.enable');
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!screenshot?.data) return;
    const artifactDir = path.join(root, 'artifacts', 'claim-debug');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, `${Date.now()}-native-chrome-preflight-failed.png`), Buffer.from(screenshot.data, 'base64'));
  } catch {}
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const chromeBin = resolveChromeBinary();
  if (!chromeBin || !fs.existsSync(chromeBin)) throw new Error(`System Google Chrome binary not found: ${chromeBin}`);
  const cdpPort = await getFreeTcpPort();
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-native-chrome-'));
  const chrome = spawn(chromeBin, [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    'about:blank',
  ], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    const version = await waitForCdp(cdpUrl);
    const target = await waitForPageTarget(cdpUrl);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      await wait(Number(process.env.TELECOM_NATIVE_CHROME_SETTLE_MS || 3000));
      await navigateToEntryPage(cdp);
      console.log(`Fresh headed system Chrome ready for delayed Playwright attachment (${version.Browser || 'Google Chrome'})`);
      const smsSince = Date.now() - 10000;
      await openSliderChallenge(cdp, phone);
      const sliderDistance = await solveSliderChallenge(cdp);
      console.log(`Native Chrome slider verified before Playwright attachment (${sliderDistance}px)`);
      const config = loadConfig();
      const sms = await new SmsInboxClient(config).waitForCode({
        stage: 'login',
        since: smsSince,
        timeoutMs: config.smsTimeoutMs,
        pollMs: config.smsPollMs,
      });
      if (!sms?.code) throw new Error('Native Chrome login SMS was not received');
      await submitLoginCode(cdp, sms.code);
      console.log('Native Chrome login completed before Playwright attachment');
      await selectTargetPackage(cdp, config.productName);
      await openConfirmationSlider(cdp);
      const confirmationDistance = await solveConfirmationSlider(cdp);
      console.log(`Native Chrome confirmation SMS sent before Playwright attachment (${confirmationDistance}px)`);
    } catch (error) {
      await captureCdpScreenshot(cdp);
      throw error;
    } finally {
      cdp.close();
    }
    const result = await runChild(process.execPath, [path.join(root, 'scripts', 'telecom-monthly-claim.js')], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        BROWSER_CDP_URL: cdpUrl,
        HEADLESS: 'false',
        TELECOM_BROWSER_PROFILE: 'desktop',
        TELECOM_CDP_PROFILE_MODE: 'native',
        TELECOM_CLEAR_BROWSER_DATA: 'false',
        TELECOM_REUSE_VALIDATED_PAGE: 'true',
        TELECOM_LOGIN_ALREADY_COMPLETE: 'true',
        TELECOM_CONFIRM_SMS_ALREADY_SENT: 'true',
      },
    });
    if (result.code !== 0) process.exitCode = result.code || 1;
  } finally {
    if (chrome.exitCode == null) {
      try {
        process.kill(-chrome.pid, 'SIGTERM');
      } catch {
        chrome.kill('SIGTERM');
      }
    }
    await wait(800);
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

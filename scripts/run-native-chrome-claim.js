#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { computeSliderImageMatchInPage } = require('../src/slider-local-match');
const {
  findFlatCanvasTarget,
  renderedPuzzleMoveX,
  isFlatPuzzleCandidateReliable,
  preferCanvasTransparentMatch,
} = require('../src/slider-canvas-match');
const {
  estimateSliderDistanceWithVision,
  visionProvidersConfigured,
  isVisionPuzzleLoading,
} = require('../src/slider-vision');
const { loadConfig } = require('../src/config');
const { SmsInboxClient } = require('../src/sms-inbox-client');
const { classifyPackageGate, summarizePackageGate, productMatchAliases } = require('../src/package-gate');
const {
  pageFamilyFromUrl,
  summarizeEntryFingerprint,
  extractOfferLabelsFromMeta,
  mergeOfferLabels,
  classifyActivityRoute,
} = require('../src/offer-inventory');

const root = path.resolve(__dirname, '..');
const entryUrl = process.env.TELECOM_ENTRY_URL;
const phone = process.env.TELECOM_PHONE;
const probeOnly = /^true$/i.test(process.env.TELECOM_PROBE_ONLY || '');
const nativePhoneSelector = [
  '#phoneNumber',
  '#phone',
  'input.phonenum',
  'input[type="tel"]',
  'input[placeholder*="手机号码"]',
  'input[placeholder*="手机号"]',
  'input.van-field__control',
].join(',');

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

function sanitizeDiagnosticMessage(value) {
  return String(value || '')
    .replace(/([?&](?:token|code|phone|accNo|wxopenid|campaignId)=)[^&\s]+/gi, '$1***')
    .replace(/\b[a-f0-9]{24,}\b/gi, '***')
    .replace(/1\d{10}/g, '***')
    .replace(/(验证码(?:是|为)?[:：]?)\d{4,8}/g, '$1***')
    .replace(/\b\d{4,11}\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function isTransientPageEvaluationError(error) {
  return /Runtime\.evaluate timed out|Execution context was destroyed|Cannot find (?:default )?(?:execution )?context/
    .test(String(error?.message || ''));
}

function safeDiagnosticPath(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname !== 'wapbj.189.cn') return '';
    return url.pathname.replace(/\d{4,}/g, '***').slice(0, 200);
  } catch {
    return '';
  }
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
    this.telecomApiRequests = new Map();
    this.telecomApiEvents = [];
    this.resourceRequests = new Map();
    this.resourceEvents = [];
    this.runtimeEvents = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data || '{}'));
      if (!message.id) {
        this.trackNetworkEvent(message.method, message.params || {});
        this.trackRuntimeEvent(message.method, message.params || {});
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
        if (url.hostname === 'wapbj.189.cn') {
          const request = {
            pathname: url.pathname.replace(/\d{4,}/g, '***').slice(0, 200),
            method: params.request?.method || '',
            type: params.type || '',
            at: Date.now(),
          };
          if (['Document', 'Script', 'XHR', 'Fetch'].includes(request.type)) {
            this.resourceRequests.set(params.requestId, request);
          }
          if (request.method !== 'GET' || params.type === 'XHR' || params.type === 'Fetch') {
            this.telecomApiRequests.set(params.requestId, request);
          }
          if (/getSliderChallenge|validSlider|sendRand|sendCode|SecondConfirmation/i.test(url.pathname)) {
            this.networkRequests.set(params.requestId, request);
          }
        }
      } catch {}
      return;
    }
    const resourceRequest = this.resourceRequests.get(params.requestId);
    if (resourceRequest) {
      if (method === 'Network.responseReceived') {
        this.resourceRequests.set(params.requestId, {
          ...resourceRequest,
          status: params.response?.status || 0,
        });
      } else if (method === 'Network.loadingFinished') {
        this.resourceEvents.push(resourceRequest);
      } else if (method === 'Network.loadingFailed') {
        this.resourceEvents.push({
          ...resourceRequest,
          failed: true,
          error: sanitizeDiagnosticMessage(params.errorText),
        });
      }
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        this.resourceRequests.delete(params.requestId);
      }
      if (this.resourceEvents.length > 60) this.resourceEvents.splice(0, this.resourceEvents.length - 60);
    }
    const telecomApiRequest = this.telecomApiRequests.get(params.requestId);
    if (telecomApiRequest) {
      if (method === 'Network.responseReceived') {
        this.telecomApiEvents.push({
          ...telecomApiRequest,
          status: params.response?.status || 0,
          requestId: params.requestId,
        });
      } else if (method === 'Network.loadingFailed') {
        this.telecomApiEvents.push({
          ...telecomApiRequest,
          failed: true,
          error: String(params.errorText || '').slice(0, 80),
        });
      }
      if (method === 'Network.responseReceived' || method === 'Network.loadingFailed') {
        this.telecomApiRequests.delete(params.requestId);
      }
      if (this.telecomApiEvents.length > 30) this.telecomApiEvents.splice(0, this.telecomApiEvents.length - 30);
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

  trackRuntimeEvent(method, params) {
    if (method !== 'Runtime.exceptionThrown') return;
    const details = params.exceptionDetails || {};
    const frames = (details.stackTrace?.callFrames || [])
      .map(frame => ({
        pathname: safeDiagnosticPath(frame.url),
        line: Number(frame.lineNumber || 0),
        column: Number(frame.columnNumber || 0),
      }))
      .filter(frame => frame.pathname)
      .slice(0, 3);
    this.runtimeEvents.push({
      at: Date.now(),
      message: sanitizeDiagnosticMessage(details.exception?.description || details.text || 'JavaScript exception'),
      frames,
    });
    if (this.runtimeEvents.length > 20) this.runtimeEvents.splice(0, this.runtimeEvents.length - 20);
  }

  recentRuntimeDiagnostics(since) {
    return this.runtimeEvents.filter(event => event.at >= since).slice(-10);
  }

  recentResourceDiagnostics(since) {
    return [
      ...this.resourceEvents.filter(event => event.at >= since),
      ...[...this.resourceRequests.values()]
        .filter(event => event.at >= since)
        .map(event => ({ ...event, pending: true })),
    ].sort((a, b) => a.at - b.at).slice(-20);
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

  async recentTelecomApiDiagnostics(since) {
    const events = this.telecomApiEvents.filter(event => event.at >= since).slice(-12);
    const diagnostics = [];
    for (const event of events) {
      const { requestId, ...diagnostic } = event;
      if (requestId && !event.failed) {
        try {
          const result = await this.send('Network.getResponseBody', { requestId }, 5000);
          const body = String(result?.body || '');
          diagnostic.bodyBytes = body.length;
          const payload = JSON.parse(body);
          const candidates = [payload, payload?.data, payload?.result]
            .filter(value => value && typeof value === 'object' && !Array.isArray(value));
          for (const candidate of candidates) {
            for (const key of ['status', 'resultCode', 'retCode', 'success']) {
              const value = candidate[key];
              if (diagnostic[key] == null
                && ['string', 'number', 'boolean'].includes(typeof value)
                && String(value).length <= 24) {
                diagnostic[key] = value;
              }
            }
            for (const key of ['message', 'msg', 'retMsg']) {
              const value = sanitizeDiagnosticMessage(candidate[key]);
              if (!diagnostic.message && value) diagnostic.message = value;
            }
          }
        } catch {}
      }
      diagnostics.push(diagnostic);
    }
    return diagnostics;
  }

  async collectMetaOfferLabels(since) {
    const events = this.telecomApiEvents
      .filter(event => event.at >= since && /preActiveMeta/i.test(event.pathname || ''))
      .slice(-4);
    const labels = [];
    for (const event of events) {
      if (!event.requestId || event.failed) continue;
      try {
        const result = await this.send('Network.getResponseBody', { requestId: event.requestId }, 5000);
        const payload = JSON.parse(String(result?.body || ''));
        labels.push(...extractOfferLabelsFromMeta(payload));
      } catch {}
    }
    return mergeOfferLabels(labels);
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

function nativePhoneInputExpression() {
  return `(() => {
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && !element.disabled;
    };
    const candidates = [...document.querySelectorAll(${JSON.stringify(nativePhoneSelector)})]
      .filter(visible)
      .filter(element => {
        const descriptor = [
          element.id,
          element.name,
          element.className,
          element.getAttribute('placeholder'),
          element.getAttribute('type'),
          element.getAttribute('inputmode'),
        ].join(' ');
        return !/验证码|校验码|动态码|checknum|(?:^|[^a-z])code(?:[^a-z]|$)/i.test(descriptor);
      });
    return candidates[0] || null;
  })()`;
}

async function readNativePhoneState(client, {
  clickSmsTab = false,
  allowOneClickLogin = false,
  phoneValue = null,
} = {}) {
  return client.evaluate(`(() => {
    const input = ${nativePhoneInputExpression()};
    if (input) {
      const expected = ${phoneValue == null ? 'null' : JSON.stringify(String(phoneValue))};
      if (expected !== null) {
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
        if (setter) setter.call(input, expected); else input.value = expected;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.blur();
        input.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      return {
        ready: true,
        phonePrimed: expected !== null && String(input.value || '') === expected,
        valueLength: String(input.value || '').length,
        hostname: location.hostname,
        path: location.pathname,
        title: document.title || '',
      };
    }
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const normalize = text => String(text || '').replace(/\\s+/g, '');
    const actions = [...(document.body?.querySelectorAll('*') || [])].filter(visible);
    const findAction = label => actions
      .filter(element => normalize(element.innerText || element.textContent) === label)
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return (a.width * a.height) - (b.width * b.height);
      })[0];
    const smsTab = findAction('短信验证码登录');
    const otherLogin = smsTab ? null : findAction('其他登录方式');
    const oneClickLogin = (smsTab || otherLogin) ? null : findAction('本机号码一键登录');
    const guardedOneClickLogin = ${allowOneClickLogin ? 'true' : 'false'}
      && !window.__telecomNativeOneClickAttempted ? oneClickLogin : null;
    const loginSwitch = smsTab || otherLogin || guardedOneClickLogin;
    if (loginSwitch && ${clickSmsTab ? 'true' : 'false'}) {
      if (loginSwitch === oneClickLogin) window.__telecomNativeOneClickAttempted = true;
      loginSwitch.click();
    }
    return {
      ready: false,
      clickedSmsTab: !!smsTab && ${clickSmsTab ? 'true' : 'false'},
      clickedLoginSwitch: !!loginSwitch && ${clickSmsTab ? 'true' : 'false'},
      loginSwitch: smsTab ? 'sms' : (otherLogin ? 'other' : (guardedOneClickLogin ? 'one-click' : '')),
      hasSmsTab: !!smsTab,
      hasOtherLogin: !!otherLogin,
      hasOneClickLogin: !!oneClickLogin,
      visibleActions: [...new Set(actions
        .map(element => String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim())
        .filter(text => text && text.length <= 40))].slice(0, 20),
      hostname: location.hostname,
      path: location.pathname,
      title: document.title || '',
      readyState: document.readyState,
      inputCount: document.querySelectorAll('input').length,
      iframeCount: document.querySelectorAll('iframe').length,
      scriptCount: document.scripts.length,
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      bodyTextLength: (document.body?.innerText || '').length,
      bodySummary: (document.body?.innerText || '')
        .replace(/\\b\\d{4,11}\\b/g, '***')
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 300),
      inputs: [...document.querySelectorAll('input')].slice(0, 8).map(element => ({
        type: element.type || '',
        id: element.id || '',
        name: element.name || '',
        className: String(element.className || '').slice(0, 120),
        placeholder: String(element.getAttribute('placeholder') || '').slice(0, 80),
        inputMode: element.inputMode || '',
        maxLength: Number(element.maxLength),
        visible: visible(element),
      })),
    };
  })()`);
}

async function fillNativePhoneInput(client, phoneValue, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await readNativePhoneState(client, {
      clickSmsTab: true,
      allowOneClickLogin: true,
      phoneValue,
    });
    if (lastState?.ready && lastState.phonePrimed && lastState.valueLength === 11) return lastState;
    await wait(lastState?.clickedLoginSwitch ? 1000 : 500);
  }
  throw new Error(`Native Chrome phone input did not commit before SMS send: ${JSON.stringify(lastState)}`);
}

async function navigateToEntryPage(client) {
  const entryFingerprint = summarizeEntryFingerprint(entryUrl);
  console.log('Native Chrome entry fingerprint', entryFingerprint);
  const entryActivity = classifyActivityRoute({
    url: entryUrl,
    phase: 'entry',
    targetPackage: process.env.TELECOM_TARGET_PACKAGE || 'voice200',
  });
  if (!entryActivity.ok) {
    throw new Error(`Native Chrome wrong entry activity page: ${entryActivity.reason}`);
  }
  let documentStatus = null;
  let lastState = null;
  const startedAt = Date.now();
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
  await client.send('Runtime.enable');
  const navigation = await client.send('Page.navigate', { url: entryUrl }, 30000);
  if (navigation.errorText) throw new Error(`Native Chrome entry navigation failed: ${navigation.errorText}`);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    lastState = await readNativePhoneState(client, { clickSmsTab: true });
    if (lastState?.hostname === 'wapbj.189.cn' && lastState?.ready) return;
    // HTTP 400/412 is also used by the site's JavaScript browser-check page.
    // Keep the real browser alive so that challenge can set its cookie and
    // navigate to the application instead of aborting on the intermediate URL.
    await wait(500);
  }
  const diagnostics = {
    documentStatus,
    state: lastState,
    runtime: client.recentRuntimeDiagnostics(startedAt),
    resources: client.recentResourceDiagnostics(startedAt),
  };
  throw new Error(`Native Chrome entry page did not render: ${JSON.stringify(diagnostics)}`);
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
  // Detect and fill in one runtime task: the Vue login component replaces its
  // input node immediately after the first input event.
  await fillNativePhoneInput(client, phone);

  const findAndClickSmsButton = `(() => {
    const selectors = [
      '.content_send_unlog',
      '#sendCode',
      '.slider-sms-btn',
      '.checknum-button.slider-sms-btn',
      '.checknum-button',
      '[onclick*="send"]',
      '[onclick*="Send"]',
    ];
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none'
        && Number(style.opacity || '1') > 0.05;
    };
    const normalize = text => String(text || '').replace(/\\s+/g, '');
    const labelOk = text => /^(获取验证码|点击获取|发送验证码|获取短信验证码|点击获取验证码)$/.test(normalize(text))
      || /获取验证码|发送验证码|点击获取/.test(normalize(text));
    const textButton = [...document.querySelectorAll('button,a,div,span,input[type="button"],input[type="submit"]')]
      .filter(element => visible(element) && !element.disabled && labelOk(element.innerText || element.value || element.textContent))
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return a.width * a.height - b.width * b.height;
      })[0];
    const button = textButton || selectors.map(selector => document.querySelector(selector)).find(element => visible(element) && !element.disabled);
    if (!button) {
      const candidates = [...document.querySelectorAll('button,a,div,span,input[type="button"],input[type="submit"],.content_send_unlog,#sendCode,.slider-sms-btn,.checknum-button')]
        .slice(0, 30)
        .map(element => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            id: element.id || '',
            className: String(element.className || '').slice(0, 120),
            text: normalize(element.innerText || element.value || element.textContent).slice(0, 40),
            disabled: !!element.disabled,
            visible: visible(element),
            rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
          };
        })
        .filter(item => item.text || item.id || /send|sms|code|checknum|验证码|获取/i.test(item.className + ' ' + item.text));
      return {
        clicked: false,
        href: location.href,
        title: document.title || '',
        bodySnippet: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 240),
        phoneValueLength: String((${nativePhoneInputExpression()})?.value || '').length,
        candidates,
      };
    }
    const rect = button.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    button.click();
    return {
      clicked: true,
      x,
      y,
      text: (button.innerText || button.value || button.textContent || '').trim(),
      disabled: !!button.disabled,
      hitInsideButton: hit === button || button.contains(hit),
      href: location.href,
      title: document.title || '',
    };
  })()`;

  let point = null;
  const smsButtonDeadline = Date.now() + 15000;
  while (Date.now() < smsButtonDeadline) {
    point = await client.evaluate(findAndClickSmsButton);
    if (point?.clicked) break;
    await wait(500);
  }
  if (!point?.clicked) {
    console.log('Native Chrome SMS button diagnostics', point);
    throw new Error(`Native Chrome SMS button missing: ${JSON.stringify({
      href: point?.href,
      title: point?.title,
      phoneValueLength: point?.phoneValueLength,
      candidateCount: Array.isArray(point?.candidates) ? point.candidates.length : 0,
      candidates: (point?.candidates || []).slice(0, 8),
      bodySnippet: point?.bodySnippet,
    })}`);
  }

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => {
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0
          && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      const popup = document.querySelector('.puzzle-verify-popup,.puzzle-verify-container,.captcha-wrapper');
      const root = popup || document;
      const canvas = [...root.querySelectorAll('canvas')]
        .find(element => visible(element) && element.width >= 100 && element.height >= 50);
      const slider = [
        '#slider_track_btn', '.slider-btn', '.slider', '[role="slider"]',
        'input[type="range"]', '[class*="slider" i]', '[class*="drag" i]', '[class*="handle" i]',
      ]
        .map(selector => root.querySelector(selector))
        .find(visible);
      const message = document.querySelector('#slider_check_msg,.slider-check-msg,.puzzle-msg')?.innerText?.trim() || '';
      const challengeVisible = visible(popup)
        && /请完成安全验证|向右滑动滑块|滑动滑块/.test(popup.innerText || '');
      return {
        ready: !!(
          (bg?.complete && bg.naturalWidth > 40 && block?.complete && block.naturalWidth > 10)
          || (canvas && slider)
        ),
        challengeVisible,
        busy: /服务繁忙|请稍后再试/.test(message),
      };
    })()`);
    if (state?.ready) return;
    if (state?.busy) throw new Error('Native Chrome getSliderChallenge was rejected before Playwright attachment');
    // Redesigned telecom login shows a visible puzzle popup after getSliderChallenge
    // succeeds, before legacy image IDs or canvas/handle nodes settle. Production
    // continues into the canvas solver from that point; probe-only stops afterward.
    if (state?.challengeVisible && networkEvents.some(event => (
      event.phase === 'response'
      && /getSliderChallenge/i.test(event.pathname)
      && event.status >= 200
      && event.status < 300
    ))) return;
    await wait(500);
  }
  const finalState = await client.evaluate(`(() => ({
    buttonText: (document.querySelector('.checknum-button.slider-sms-btn,.checknum-button,.slider-sms-btn,.content_send_unlog,#sendCode')?.innerText || '').trim(),
    sliderPresent: !!document.querySelector('#slider_bg_image,#slider_check,.slider-check-box,.puzzle-verify-popup,.puzzle-verify-container,.captcha-wrapper'),
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
  await client.evaluate(`(() => {
    const startX = ${JSON.stringify(startX)};
    const startY = ${JSON.stringify(startY)};
    const moveX = ${JSON.stringify(moveX)};
    const button = document.elementFromPoint(startX, startY);
    if (!button) return false;
    const event = (type, x, y, buttons) => new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      button: 0,
      buttons,
    });
    button.dispatchEvent(event('mousedown', startX, startY, 1));
    for (let step = 1; step <= 30; step += 1) {
      const t = step / 30;
      const ease = 1 - Math.pow(1 - t, 2.4);
      document.dispatchEvent(event(
        'mousemove',
        startX + moveX * ease,
        startY + Math.sin(t * Math.PI * 3) * 2,
        1,
      ));
    }
    document.dispatchEvent(event('mouseup', startX + moveX, startY, 0));
    return true;
  })()`, 30000);
}

async function dragSliderTrusted(client, { startX, startY, moveX }) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: startX, y: startY, button: 'left', buttons: 1, clickCount: 1,
  });
  for (let step = 1; step <= 24; step += 1) {
    const t = step / 24;
    const ease = 1 - Math.pow(1 - t, 2.4);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + moveX * ease,
      y: startY + Math.sin(t * Math.PI * 3) * 2,
      button: 'left',
      buttons: 1,
    });
    await wait(12);
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: startX + moveX, y: startY, button: 'left', buttons: 0, clickCount: 1,
  });
}

async function solveSliderChallenge(client) {
  const match = await client.evaluate(`(${computeSliderImageMatchInPage.toString()})({})`, 30000);
  if (match?.ok && match.btn && Number.isFinite(match.moveX) && match.moveX >= 40) {
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
  if (match?.reason === 'images-not-ready') {
    console.log('Native Chrome legacy login slider images unavailable; using vision-first puzzle solver.');
    return solveConfirmationSlider(client);
  }
  throw new Error(`Native Chrome slider match failed: ${match?.reason || 'invalid-result'}`);
}

async function clickPageElement(client, selectors, textPattern = '') {
  const clicked = await client.evaluate(`(() => {
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
    element.click();
    return true;
  })()`);
  if (!clicked) return false;
  return true;
}

async function schedulePageElementClick(client, selectors) {
  return !!await client.evaluate(`(() => {
    const selectors = ${JSON.stringify(selectors)};
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const element = selectors.map(selector => document.querySelector(selector)).find(visible);
    if (!element) return false;
    setTimeout(() => element.click(), 0);
    return true;
  })()`, 5000);
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
  const inputState = await client.evaluate(`(() => {
    const input = document.querySelector('#code,input[placeholder*="验证码"],input.checknum-input');
    input?.dispatchEvent(new Event('change', { bubbles: true }));
    input?.blur();
    const submit = document.querySelector('.know-box.button');
    return {
      hasInput: !!input,
      inputLength: String(input?.value || '').length,
      submitPresent: !!submit,
      submitDisabled: !!submit?.disabled,
    };
  })()`);
  console.log('Native Chrome login submit preflight', {
    ...inputState,
    expectedLength: String(code || '').length,
  });
  await wait(700);
  const submitStartedAt = Date.now();
  if (!await clickPageElement(client, ['.know-box.button'], '^(立即领取|立即办理)$')) {
    throw new Error('Native Chrome login submit button missing');
  }
  const deadline = Date.now() + 20000;
  let lastState = {};
  while (Date.now() < deadline) {
    const state = await client.evaluate(`(() => ({
      complete: /preDepositC\\w*_list/i.test(location.href) || /请选择档位|去办理/.test(document.body?.innerText || ''),
      failed: /短信输入错误|验证码.*错误|验证码.*过期|服务繁忙|操作失败|当日发送短信数量过多|无法继续发送/.test(document.body?.innerText || ''),
      path: location.pathname,
      hasCodeInput: !!document.querySelector('#code,input[placeholder*="验证码"],input.checknum-input'),
      inputLength: String(document.querySelector('#code,input[placeholder*="验证码"],input.checknum-input')?.value || '').length,
      submitDisabled: !!document.querySelector('.know-box.button')?.disabled,
      codeSentNotice: /验证码已下发|请注意查收/.test(document.body?.innerText || ''),
    }))()`);
    lastState = state || {};
    if (state?.complete) return;
    if (state?.failed) {
      const telecomApi = await client.recentTelecomApiDiagnostics(submitStartedAt);
      throw new Error(`Native Chrome login verification failed before Playwright attachment: ${JSON.stringify({ ...lastState, telecomApi })}`);
    }
    await wait(500);
  }
  const telecomApi = await client.recentTelecomApiDiagnostics(submitStartedAt);
  const diagnostic = { ...lastState, telecomApi };
  throw new Error(`Native Chrome login verification timed out before Playwright attachment: ${JSON.stringify(diagnostic)}`);
}

async function waitForPageState(client, expression, timeoutMs, errorMessage) {
  const deadline = Date.now() + timeoutMs;
  let evaluationTimeouts = 0;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression, 5000)) return;
    } catch (error) {
      if (!isTransientPageEvaluationError(error)) throw error;
      evaluationTimeouts += 1;
    }
    await wait(500);
  }
  throw new Error(`${errorMessage} (evaluationTimeouts=${evaluationTimeouts})`);
}

function logPostLoginRouteDiagnostics(client, since, entryUrl) {
  return client.evaluate(`(() => ({
    href: location.href,
    path: location.pathname,
    referrerPath: (() => {
      try { return new URL(document.referrer || '').pathname; } catch { return ''; }
    })(),
  }))()`).catch(() => null).then(async (state) => {
    const telecomApi = await client.recentTelecomApiDiagnostics(since).catch(() => []);
    const documents = client.recentResourceDiagnostics(since)
      .filter(event => event.type === 'Document')
      .map(event => ({
        pathname: event.pathname,
        status: event.status || 0,
        failed: !!event.failed,
      }))
      .slice(-12);
    const initTrail = (telecomApi || [])
      .filter(event => /validRand|preDepositInit|preActiveMeta|preCommonCheck|qryLoginAccno|channelCache|optConfirm/i.test(event.pathname || ''))
      .map(event => ({
        pathname: event.pathname,
        status: event.status || 0,
        retCode: event.retCode || event.resultCode || '',
        message: event.message || '',
      }));
    console.log('Native Chrome post-login route diagnostics', {
      entry: summarizeEntryFingerprint(entryUrl),
      pageFamily: pageFamilyFromUrl(state?.href || ''),
      path: String(state?.path || '').replace(/\d{4,}/g, '***').slice(0, 160),
      referrerPath: String(state?.referrerPath || '').replace(/\d{4,}/g, '***').slice(0, 160),
      documents,
      initTrail,
    });
  });
}

async function dismissBenignDialogs(client) {
  return !!await client.evaluate(`(() => {
    const pattern = /验证码已下发|请注意查收|服务繁忙|稍后|我知道了|温馨提示/;
    const confirmPattern = /确定|确认|我知道了|知道了/;
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const dialogSelectors = [
      '#wap-dialog', '.wap-dialog', '.diaog-popup', '#dialog-box',
      '[role="dialog"]', '.van-dialog', '[class*="dialog" i]', '[class*="modal" i]', '[class*="popup" i]',
    ];
    let closed = 0;
    for (const dialog of [...new Set(dialogSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))].filter(visible)) {
      if (dialog.id === 'secondPopCombo') continue;
      const text = dialog.innerText || '';
      if (!pattern.test(text)) continue;
      const button = [...dialog.querySelectorAll('button,div,span,a')]
        .reverse()
        .find(node => visible(node) && confirmPattern.test((node.innerText || '').replace(/\\s+/g, '')));
      if (button) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        closed += 1;
        continue;
      }
      dialog.style.display = 'none';
      closed += 1;
    }
    return closed > 0;
  })()`, 5000);
}

async function selectTargetPackage(client, productName) {
  const packageStartedAt = Date.now();
  const packageDiagnosticsStartedAt = packageStartedAt - 10000;
  const deadline = packageStartedAt + 60000;
  let gate = { state: 'waiting' };
  let evaluationTimeouts = 0;
  let metaOffers = [];
  while (Date.now() < deadline) {
    if (!metaOffers.length) {
      metaOffers = await client.collectMetaOfferLabels(packageDiagnosticsStartedAt);
    }
    let snapshot;
    try {
      snapshot = await client.evaluate(`(() => {
        const visible = element => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const dialogSelectors = [
          '[role="dialog"]', '.van-dialog', '.wap-dialog', '#wap-dialog', '#dialog-box',
          '[class*="dialog" i]', '[class*="modal" i]', '[class*="popup" i]',
        ];
        const dialogs = [...new Set(dialogSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
          .filter(visible)
          .map(element => element.innerText || '')
          .filter(Boolean);
        const packageLabels = [...document.querySelectorAll('li,button,[class*="card" i],[class*="package" i],[class*="plan" i]')]
          .filter(visible)
          .map(node => String(node.innerText || '').replace(/\\s+/g, ' ').trim())
          .filter(text => text && text.length <= 80)
          .slice(0, 30);
        return {
          url: location.href,
          bodyText: (document.body?.innerText || '').slice(0, 2000),
          dialogText: dialogs.join('\\n').slice(0, 1000),
          packageLabels,
        };
      })()`, 5000);
    } catch (error) {
      if (!isTransientPageEvaluationError(error)) {
        throw error;
      }
      evaluationTimeouts += 1;
      await wait(500);
      continue;
    }
    const pageFamily = pageFamilyFromUrl(snapshot?.url);
    gate = classifyPackageGate({
      ...snapshot,
      productName,
      metaOffers,
      pageFamily,
    });
    if (gate.state === 'ready') break;
    if (gate.state === 'already_claimed') {
      return { alreadyClaimed: true, diagnostic: summarizePackageGate(gate) };
    }
    if (gate.state === 'wrong_activity') {
      console.log('Native Chrome wrong activity page after login', summarizePackageGate(gate));
      return {
        wrongActivity: true,
        diagnostic: summarizePackageGate(gate),
        pageFamily,
        offerLabels: gate.packageLabels || [],
      };
    }
    if (gate.state === 'unavailable') {
      console.log('Native Chrome configured package unavailable', summarizePackageGate(gate));
      return {
        packageUnavailable: true,
        diagnostic: summarizePackageGate(gate),
        pageFamily,
        offerLabels: gate.packageLabels || [],
      };
    }
    if (gate.state === 'blocked') {
      const dismissed = await dismissBenignDialogs(client);
      if (dismissed) {
        console.log('Native Chrome dismissed package-page dialog', summarizePackageGate(gate));
        await wait(400);
        continue;
      }
    }
    await wait(500);
  }
  if (gate.state !== 'ready') {
    const telecomApi = await client.recentTelecomApiDiagnostics(packageDiagnosticsStartedAt);
    if (!metaOffers.length) metaOffers = await client.collectMetaOfferLabels(packageDiagnosticsStartedAt);
    gate = classifyPackageGate({
      ...gate,
      productName,
      metaOffers,
      pageFamily: pageFamilyFromUrl(gate.url),
    });
    if (gate.state === 'unavailable') {
      console.log('Native Chrome configured package unavailable after wait', summarizePackageGate(gate));
      return {
        packageUnavailable: true,
        diagnostic: summarizePackageGate(gate),
        pageFamily: gate.pageFamily,
        offerLabels: gate.packageLabels || [],
      };
    }
    if (gate.state === 'wrong_activity') {
      console.log('Native Chrome wrong activity page after wait', summarizePackageGate(gate));
      return {
        wrongActivity: true,
        diagnostic: summarizePackageGate(gate),
        pageFamily: gate.pageFamily,
        offerLabels: gate.packageLabels || [],
      };
    }
    const runtimeState = await client.evaluate(`(() => {
      const externalScriptPaths = [...document.scripts]
        .map(script => script.src)
        .filter(Boolean)
        .map(src => {
          try {
            const url = new URL(src, location.href);
            return url.hostname === location.hostname
              ? url.pathname.replace(/\\d{4,}/g, '***').slice(0, 200)
              : '';
          }
          catch { return ''; }
        })
        .filter(Boolean)
        .slice(-20);
      const visible = element => {
        const rect = element?.getBoundingClientRect();
        return !!(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none');
      };
      return {
        path: location.pathname.replace(/\\d{4,}/g, '***').slice(0, 200),
        readyState: document.readyState,
        hasSingleSignOnPhoneNo: typeof globalThis.singleSignOnPhoneNo === 'function',
        scriptCount: document.scripts.length,
        inlineScriptCount: [...document.scripts].filter(script => !script.src).length,
        externalScriptPaths,
        iframeCount: document.querySelectorAll('iframe').length,
        visibleLoadingCount: [...document.querySelectorAll('.loading,.mask_loading,[class*="loading" i]')]
          .filter(visible).length,
      };
    })()`, 5000).catch(error => ({ unavailable: sanitizeDiagnosticMessage(error.message) }));
    console.log('Native Chrome package page diagnostics', {
      evaluationTimeouts,
      runtimeState,
      runtime: client.recentRuntimeDiagnostics(packageDiagnosticsStartedAt),
      resources: client.recentResourceDiagnostics(packageDiagnosticsStartedAt),
      telecomApi,
      metaOffers,
    });
    throw new Error(`Native Chrome target package did not render: ${JSON.stringify(summarizePackageGate(gate))}`);
  }
  const pageFamily = pageFamilyFromUrl(gate.url);
  console.log('Native Chrome package page ready', {
    pageFamily,
    productName,
    offerLabels: gate.packageLabels || [],
  });
  const selected = await client.evaluate(`(() => {
    const aliases = ${JSON.stringify(productMatchAliases(productName))};
    const family = ${JSON.stringify(pageFamily)};
    const selectors = family === 'echnwap'
      ? ['li', 'button', '[class*="card" i]', '[class*="package" i]', '[class*="plan" i]']
      : ['li'];
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const item = selectors
      .flatMap(selector => [...document.querySelectorAll(selector)])
      .find(node => {
        if (!visible(node)) return false;
        const text = String(node.innerText || '').replace(/\\s+/g, '');
        return aliases.some(alias => text.includes(alias));
      });
    if (!item) return false;
    setTimeout(() => item.click(), 0);
    return true;
  })()`, 5000);
  if (!selected) throw new Error('Native Chrome target package missing');
  console.log('Native Chrome target package click scheduled');
  await waitForPageState(
    client,
    `(() => {
      const element = document.querySelector('#conduct')
        || [...document.querySelectorAll('button,a,div,span')].find(node => /去办理|立即办理/.test((node.innerText || '').replace(/\\s+/g, '')));
      const rect = element?.getBoundingClientRect();
      return !!(rect && rect.width > 0 && rect.height > 0 && getComputedStyle(element).display !== 'none');
    })()`,
    30000,
    'Native Chrome package submit button did not become ready',
  );
  if (!await schedulePageElementClick(client, ['#conduct'])
    && !await clickPageElement(client, [], '^(去办理|立即办理)$')) {
    throw new Error('Native Chrome package submit button missing');
  }
  console.log('Native Chrome package submit click scheduled');
  await waitForPageState(
    client,
    `(() => !!document.querySelector('#activeName') && !!document.querySelector('#payConfirm'))()`,
    30000,
    'Native Chrome confirm page did not become ready',
  );
  return { alreadyClaimed: false, pageFamily, offerLabels: gate.packageLabels || [] };
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

const puzzleRootSelector = '#secondPop_puzzle_check,.puzzle-verify-popup,.puzzle-verify-container,.captcha-wrapper,#slider_check,.slider-check-box';
const puzzleSliderSelectors = [
  '#slider_track_btn', '.slider-btn', '[role="slider"]',
  'input[type="range"]', '[class*="handle" i]', '[class*="drag" i]',
  '.slider', '[class*="slider" i]',
];

function visionConfigured() {
  return visionProvidersConfigured();
}

function chooseVisionMoveX({
  sourceX,
  naturalX,
  screenshotScaleX,
  sliderX,
  startX,
  canvasWidth,
  imageWidth,
  visionMoveX,
}) {
  const scale = Number(screenshotScaleX) > 0 ? Number(screenshotScaleX) : 1;
  const gapCssX = Number(sourceX) + Number(naturalX) / scale;
  const cssFromCrop = Number(naturalX) / scale;
  const width = Number(canvasWidth) || Number(imageWidth) / scale;
  const ratio = Number.isFinite(width) && width > 60 ? (width - 40) / (width - 60) : 1;
  const ranked = [
    Number(visionMoveX),
    gapCssX - Number(sliderX),
    gapCssX - Number(startX),
    cssFromCrop,
    renderedPuzzleMoveX(sourceX, naturalX, scale, sliderX, width),
    (gapCssX - Number(sliderX)) * ratio,
  ]
    .map(value => Math.round(Number(value)))
    .filter((value, index, all) => Number.isFinite(value) && value >= 40 && value <= 280 && all.indexOf(value) === index);

  if (!ranked.length) {
    return {
      moveX: null,
      candidates: [],
      gapCssX,
      cssFromCrop,
      reason: 'vision-move-out-of-range',
    };
  }
  return {
    moveX: ranked[0],
    candidates: ranked,
    gapCssX,
    cssFromCrop,
    reason: 'ok',
  };
}

/** Browser-side helper string: pick the smallest handle-like control. */
function findPuzzleSliderJs() {
  return `function findPuzzleSlider(root, selectors) {
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const candidates = [];
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        if (!visible(element)) continue;
        const rect = element.getBoundingClientRect();
        candidates.push({
          element,
          area: rect.width * rect.height,
          width: rect.width,
          height: rect.height,
          rect,
        });
      }
    }
    candidates.sort((left, right) => left.area - right.area);
    const handle = candidates.find(item => item.width >= 12 && item.width <= 96 && item.height >= 12 && item.height <= 96)
      || candidates.find(item => item.width <= 120 && item.height <= 80)
      || candidates[0];
    return handle?.element || null;
  }`;
}

async function readConfirmationSliderInfo(client) {
  return client.evaluate(`(() => {
    ${findPuzzleSliderJs()}
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const root = document.querySelector(${JSON.stringify(puzzleRootSelector)}) || document;
    const canvas = [...root.querySelectorAll('canvas:not(.block),canvas')]
      .find(item => visible(item) && item.width >= 100 && item.height >= 50);
    if (!canvas) return null;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const flat = (${findFlatCanvasTarget.toString()})(data, canvas.width, canvas.height);
    let minx = canvas.width; let count = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (data[(y * canvas.width + x) * 4 + 3] === 0) {
          count += 1;
          minx = Math.min(minx, x);
        }
      }
    }
    const slider = findPuzzleSlider(root, ${JSON.stringify(puzzleSliderSelectors)});
    const naturalX = flat.ok ? flat.x : minx;
    if (!slider || (!flat.ok && count < 500) || naturalX >= canvas.width) return null;
    const sliderRect = slider.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const canvasScaleX = canvas.width / canvasRect.width;
    const moveX = (${renderedPuzzleMoveX.toString()})(
      canvasRect.x,
      naturalX,
      canvasScaleX,
      sliderRect.x,
      canvasRect.width,
    );
    return {
      method: flat.ok ? 'flat-component' : 'transparent-fallback',
      naturalX,
      moveX,
      targetX: Math.round(canvasRect.x + naturalX / canvasScaleX),
      flat,
      startX: sliderRect.x + sliderRect.width / 2,
      startY: sliderRect.y + sliderRect.height / 2,
      slider: { tag: slider.tagName, id: slider.id, className: String(slider.className || '').slice(0, 80) },
    };
  })()`, 30000);
}

async function readRenderedConfirmationSliderInfo(client, rawInfo) {
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (!screenshot?.data) return null;
  const rendered = await client.evaluate(`new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const root = document.querySelector(${JSON.stringify(puzzleRootSelector)}) || document;
      const source = [...root.querySelectorAll('canvas:not(.block),canvas')]
        .find(item => visible(item) && item.width >= 100 && item.height >= 50)
        || (visible(root) && root !== document ? root : null);
      ${findPuzzleSliderJs()}
      const slider = findPuzzleSlider(root, ${JSON.stringify(puzzleSliderSelectors)});
      if (!source || !slider) return resolve(null);
      const sourceRect = source.getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      const screenshotScaleX = image.naturalWidth / Math.max(1, window.innerWidth);
      const screenshotScaleY = image.naturalHeight / Math.max(1, window.innerHeight);
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.round(Math.min(sourceRect.width, window.innerWidth - sourceRect.x) * screenshotScaleX));
      crop.height = Math.max(1, Math.round(Math.min(sourceRect.height, window.innerHeight - sourceRect.y) * screenshotScaleY));
      crop.getContext('2d').drawImage(
        image,
        Math.max(0, sourceRect.x * screenshotScaleX),
        Math.max(0, sourceRect.y * screenshotScaleY),
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );
      const pixels = crop.getContext('2d').getImageData(0, 0, crop.width, crop.height).data;
      const flat = (${findFlatCanvasTarget.toString()})(pixels, crop.width, crop.height);
      const canvasWidth = source.width || Math.round(sourceRect.width);
      const moveX = flat.ok
        ? (${renderedPuzzleMoveX.toString()})(sourceRect.x, flat.x, screenshotScaleX, sliderRect.x, canvasWidth)
        : 0;
      resolve({
        method: flat.ok ? 'rendered-flat-component' : 'rendered-crop-only',
        naturalX: moveX,
        moveX,
        targetX: flat.ok ? Math.round(sourceRect.x + flat.x / screenshotScaleX) : null,
        flat,
        cropPng: crop.toDataURL('image/png'),
        imageWidth: crop.width,
        sourceX: sourceRect.x,
        screenshotScaleX,
        sliderX: sliderRect.x,
        canvasWidth,
        raw: ${JSON.stringify(rawInfo)},
        startX: sliderRect.x + sliderRect.width / 2,
        startY: sliderRect.y + sliderRect.height / 2,
        slider: { tag: slider.tagName, id: slider.id, className: String(slider.className || '').slice(0, 80) },
      });
    };
    image.onerror = () => resolve(null);
    image.src = ${JSON.stringify(`data:image/png;base64,${screenshot.data}`)};
  })`, 30000);
  if (!rendered) return null;
  const {
    cropPng,
    imageWidth,
    sourceX,
    screenshotScaleX,
    sliderX,
    canvasWidth,
    ...local
  } = rendered;
  local.localReliable = isFlatPuzzleCandidateReliable(local.flat);
  if ((!local.localReliable || !(local.moveX >= 40)) && visionConfigured()) {
    const vision = await estimateSliderDistanceWithVision({ bgPngBase64: cropPng, imageWidth });
    if (vision.ok && vision.confidence >= 0.55) {
      const moveX = renderedPuzzleMoveX(sourceX, vision.naturalX, screenshotScaleX, sliderX, canvasWidth);
      return {
        ...local,
        method: 'vision-fallback',
        naturalX: moveX,
        moveX,
        targetX: Math.round(sourceX + vision.naturalX / screenshotScaleX),
        vision: { confidence: vision.confidence, reason: vision.reason },
      };
    }
    local.vision = { ok: false, reason: vision.reason || 'low-confidence', confidence: vision.confidence || 0 };
  }
  return preferCanvasTransparentMatch(local, rawInfo);
}

async function waitForPuzzleCanvasReady(client, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await client.evaluate(`(() => {
      ${findPuzzleSliderJs()}
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const root = document.querySelector(${JSON.stringify(puzzleRootSelector)}) || document;
      const text = String(root.innerText || '').replace(/\\s+/g, '');
      const loadingText = /加载中|请稍候|转圈/.test(text);
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      const legacyReady = !!(bg?.complete && bg.naturalWidth > 40 && block?.complete && block.naturalWidth > 10);
      const canvases = [...root.querySelectorAll('canvas:not(.block),canvas')]
        .filter(item => visible(item) && item.getBoundingClientRect().width >= 80 && item.getBoundingClientRect().height >= 40);
      let colorful = 0;
      for (const source of canvases) {
        try {
          const sample = source.getContext('2d').getImageData(0, 0, Math.min(source.width, 80), Math.min(source.height, 40)).data;
          for (let i = 0; i < sample.length; i += 16) {
            const r = sample[i]; const g = sample[i + 1]; const b = sample[i + 2];
            if (Math.max(r, g, b) - Math.min(r, g, b) > 12 || r < 245 || g < 245 || b < 245) colorful += 1;
          }
        } catch {}
      }
      const slider = findPuzzleSlider(root, ${JSON.stringify(puzzleSliderSelectors)});
      return {
        ready: legacyReady || (colorful >= 8 && !!slider),
        loadingText,
        colorful,
        canvasCount: canvases.length,
        hasSlider: !!slider,
      };
    })()`).catch(() => null);
    if (last?.ready) return last;
    await wait(400);
  }
  return last;
}

async function solvePuzzleWithVisionFallback(client) {
  if (!visionConfigured()) {
    return { ok: false, reason: 'vision-not-configured' };
  }
  const painted = await waitForPuzzleCanvasReady(client, 20000);
  if (!painted?.ready && (painted?.loadingText || !painted?.hasSlider)) {
    return {
      ok: false,
      reason: 'puzzle-still-loading',
      colorful: painted?.colorful || 0,
      canvasCount: painted?.canvasCount || 0,
      hasSlider: !!painted?.hasSlider,
      loadingText: !!painted?.loadingText,
    };
  }
  const screenshot = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (!screenshot?.data) return { ok: false, reason: 'screenshot-missing' };
  const crop = await client.evaluate(`new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      ${findPuzzleSliderJs()}
      const visible = element => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const root = document.querySelector(${JSON.stringify(puzzleRootSelector)}) || document;
      const loadingText = /加载中|请稍候|转圈/.test(String(root.innerText || '').replace(/\\s+/g, ''));
      const canvases = [...root.querySelectorAll('canvas:not(.block),canvas')]
        .filter(item => visible(item) && item.getBoundingClientRect().width >= 80 && item.getBoundingClientRect().height >= 40)
        .sort((left, right) => {
          const a = left.getBoundingClientRect();
          const b = right.getBoundingClientRect();
          return (b.width * b.height) - (a.width * a.height);
        });
      const source = canvases[0] || (visible(root) && root !== document ? root : null);
      const slider = findPuzzleSlider(root, ${JSON.stringify(puzzleSliderSelectors)});
      if (loadingText && !canvases.length) {
        return resolve({
          ok: false,
          reason: 'puzzle-still-loading',
          rootClass: root === document ? '' : String(root.className || '').slice(0, 120),
          hasSource: !!source,
          hasSlider: !!slider,
          canvasCount: 0,
        });
      }
      if (source && source.tagName === 'CANVAS') {
        try {
          const sample = source.getContext('2d').getImageData(0, 0, Math.min(source.width, 80), Math.min(source.height, 40)).data;
          let colorful = 0;
          for (let i = 0; i < sample.length; i += 16) {
            const r = sample[i]; const g = sample[i + 1]; const b = sample[i + 2];
            if (Math.max(r, g, b) - Math.min(r, g, b) > 12 || r < 245 || g < 245 || b < 245) colorful += 1;
          }
          if (colorful < 8) {
            return resolve({
              ok: false,
              reason: 'puzzle-still-loading',
              rootClass: root === document ? '' : String(root.className || '').slice(0, 120),
              hasSource: true,
              hasSlider: !!slider,
              canvasCount: canvases.length,
            });
          }
        } catch (error) {
          // tainted/empty canvas: keep going and let vision decide
        }
      }
      if (!source || !slider) {
        return resolve({
          ok: false,
          reason: 'puzzle-assets-missing',
          rootClass: root === document ? '' : String(root.className || '').slice(0, 120),
          hasSource: !!source,
          hasSlider: !!slider,
          canvasCount: canvases.length,
        });
      }
      const handle = (/icon/i.test(String(slider.className || '')) && slider.parentElement)
        ? slider.parentElement
        : slider;
      const sourceRect = source.getBoundingClientRect();
      const sliderRect = handle.getBoundingClientRect();
      const screenshotScaleX = image.naturalWidth / Math.max(1, window.innerWidth);
      const screenshotScaleY = image.naturalHeight / Math.max(1, window.innerHeight);
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = Math.max(1, Math.round(Math.min(sourceRect.width, window.innerWidth - sourceRect.x) * screenshotScaleX));
      cropCanvas.height = Math.max(1, Math.round(Math.min(sourceRect.height, window.innerHeight - sourceRect.y) * screenshotScaleY));
      cropCanvas.getContext('2d').drawImage(
        image,
        Math.max(0, sourceRect.x * screenshotScaleX),
        Math.max(0, sourceRect.y * screenshotScaleY),
        cropCanvas.width,
        cropCanvas.height,
        0,
        0,
        cropCanvas.width,
        cropCanvas.height,
      );
      resolve({
        ok: true,
        cropPng: cropCanvas.toDataURL('image/png'),
        imageWidth: cropCanvas.width,
        sourceX: sourceRect.x,
        sourceY: sourceRect.y,
        sourceWidth: sourceRect.width,
        sourceHeight: sourceRect.height,
        screenshotScaleX,
        sliderX: sliderRect.x,
        canvasWidth: source.width || Math.round(sourceRect.width),
        startX: sliderRect.x + sliderRect.width / 2,
        startY: sliderRect.y + sliderRect.height / 2,
        slider: {
          tag: handle.tagName,
          id: handle.id || '',
          className: String(handle.className || '').slice(0, 80),
          width: Math.round(sliderRect.width),
          height: Math.round(sliderRect.height),
        },
      });
    };
    image.onerror = () => resolve({ ok: false, reason: 'screenshot-decode-failed' });
    image.src = ${JSON.stringify(`data:image/png;base64,${screenshot.data}`)};
  })`, 30000);
  if (!crop?.ok) return crop || { ok: false, reason: 'crop-failed' };
  const vision = await estimateSliderDistanceWithVision({
    bgPngBase64: crop.cropPng,
    imageWidth: crop.imageWidth,
    cssWidth: crop.sourceWidth || crop.canvasWidth,
  });
  if (isVisionPuzzleLoading(vision) || vision.reason === 'puzzle-still-loading') {
    return {
      ok: false,
      reason: 'puzzle-still-loading',
      confidence: vision.confidence || 0,
      slider: crop.slider,
      imageWidth: crop.imageWidth,
      visionReason: vision.reason || '',
      visionBody: vision.body || '',
      visionParsed: vision.parsed || null,
    };
  }
  if (!vision.ok || vision.confidence < 0.55) {
    return {
      ok: false,
      reason: vision.reason || 'low-confidence',
      confidence: vision.confidence || 0,
      slider: crop.slider,
      imageWidth: crop.imageWidth,
      canvasWidth: crop.canvasWidth,
      sourceWidth: crop.sourceWidth,
      visionBody: vision.body || '',
      visionParsed: vision.parsed || null,
    };
  }
  const chosen = chooseVisionMoveX({
    sourceX: crop.sourceX,
    naturalX: vision.naturalX,
    screenshotScaleX: crop.screenshotScaleX,
    sliderX: crop.sliderX,
    startX: crop.startX,
    canvasWidth: crop.canvasWidth,
    imageWidth: crop.imageWidth,
    visionMoveX: vision.moveX,
  });
  if (!(chosen.moveX >= 40)) {
    return {
      ok: false,
      reason: chosen.reason || 'vision-move-too-small',
      moveX: chosen.moveX,
      candidates: chosen.candidates,
      gapCssX: chosen.gapCssX,
      cssFromCrop: chosen.cssFromCrop,
      raw: chosen.raw,
      vision,
      slider: crop.slider,
      sourceX: crop.sourceX,
      sliderX: crop.sliderX,
      startX: crop.startX,
      screenshotScaleX: crop.screenshotScaleX,
      imageWidth: crop.imageWidth,
      canvasWidth: crop.canvasWidth,
    };
  }
  const naturalDistance = Number.isFinite(crop.canvasWidth) && crop.imageWidth > 0
    ? Math.round(vision.naturalX * (crop.canvasWidth / crop.imageWidth))
    : Math.round(chosen.cssFromCrop);
  return {
    ok: true,
    method: 'vision-direct',
    naturalX: naturalDistance,
    moveX: chosen.moveX,
    moveCandidates: chosen.candidates,
    targetX: Math.round(chosen.gapCssX),
    cssFromCrop: chosen.cssFromCrop,
    startX: crop.startX,
    startY: crop.startY,
    slider: crop.slider,
    vision: { confidence: vision.confidence, reason: vision.reason, naturalX: vision.naturalX },
    sourceX: crop.sourceX,
    sliderX: crop.sliderX,
    screenshotScaleX: crop.screenshotScaleX,
    imageWidth: crop.imageWidth,
    canvasWidth: crop.canvasWidth,
  };
}

async function readPuzzleFailureText(client) {
  return client.evaluate(`(() => {
    const text = [
      document.body?.innerText || '',
      ...Array.from(document.querySelectorAll('#slider_check_msg,.slider-check-msg,.puzzle-msg,.puzzle-verify-popup'))
        .map(node => node.innerText || ''),
    ].join('\\n');
    return {
      text: text.replace(/\\s+/g, ' ').trim().slice(0, 240),
      sent: /验证码已下发|请注意查收/.test(text),
      failed: /服务繁忙|验证失败|操作失败|请稍后再试|当日发送短信数量过多|无法继续发送/.test(text),
      success: /验证成功/.test(text),
    };
  })()`);
}

async function solveConfirmationSlider(client) {
  let info = null;
  let visionAttempt = null;
  const drag = process.platform === 'linux' ? dragSliderTrusted : dragSlider;

  const tryVisionSolve = async () => {
    if (!visionConfigured()) return null;
    const visionDeadline = Date.now() + 45000;
    let rateLimitHits = 0;
    while (Date.now() < visionDeadline) {
      visionAttempt = await solvePuzzleWithVisionFallback(client);
      console.log('Native Chrome vision-first slider attempt', {
        ok: visionAttempt?.ok,
        reason: visionAttempt?.reason,
        confidence: visionAttempt?.confidence ?? visionAttempt?.vision?.confidence,
        method: visionAttempt?.method,
        moveX: visionAttempt?.moveX,
        moveCandidates: visionAttempt?.moveCandidates || visionAttempt?.candidates,
        cssFromCrop: visionAttempt?.cssFromCrop,
        visionNaturalX: visionAttempt?.vision?.naturalX,
        naturalX: visionAttempt?.naturalX,
        gapCssX: visionAttempt?.gapCssX,
        startX: visionAttempt?.startX,
        sliderX: visionAttempt?.sliderX,
        screenshotScaleX: visionAttempt?.screenshotScaleX,
        imageWidth: visionAttempt?.imageWidth,
        canvasWidth: visionAttempt?.canvasWidth,
        sourceWidth: visionAttempt?.sourceWidth,
        slider: visionAttempt?.slider,
        visionParsed: visionAttempt?.visionParsed,
        visionBody: visionAttempt?.visionBody,
      });
      if (visionAttempt?.ok && visionAttempt.moveX >= 40) return visionAttempt;
      if (visionAttempt?.reason === 'vision-http-429' || visionAttempt?.reason === 'vision-http-404') {
        rateLimitHits += 1;
        if (rateLimitHits >= 3) {
          console.log('Native Chrome vision unavailable; falling back to local match', {
            reason: visionAttempt.reason,
            rateLimitHits,
          });
          return null;
        }
        await wait(visionAttempt.reason === 'vision-http-404' ? 1500 : (10000 * rateLimitHits));
        continue;
      }
      if (
        visionAttempt?.reason === 'puzzle-assets-missing'
        || visionAttempt?.reason === 'puzzle-still-loading'
        || visionAttempt?.reason === 'vision-gateway-and-http-failed'
        || visionAttempt?.reason === 'vision-x-out-of-range'
        || visionAttempt?.reason === 'low-confidence'
        || /^vision-http-/.test(visionAttempt?.reason || '')
        || /^vision-finish-/.test(visionAttempt?.reason || '')
      ) {
        await wait(visionAttempt?.reason === 'puzzle-still-loading' ? 2000 : 1200);
        continue;
      }
      return null;
    }
    return null;
  };

  if (visionConfigured()) {
    info = await tryVisionSolve();
  } else {
    console.log('Native Chrome vision solver skipped: set CODEX_GATEWAY_SERVICE_URL (preferred) or CODEX_GATEWAY_COMMAND / GEMINI_API_KEY');
  }

  if (!info || info.moveX < 40) {
    const matchDeadline = Date.now() + 12000;
    let refreshed = false;
    while (Date.now() < matchDeadline) {
      const rawInfo = await readConfirmationSliderInfo(client);
      if (rawInfo?.moveX >= 40) {
        info = await readRenderedConfirmationSliderInfo(client, rawInfo).catch(() => null) || rawInfo;
        if (info?.moveX >= 40) break;
      }
      if (!refreshed && Date.now() >= matchDeadline - 6000) {
        refreshed = await clickPageElement(client, ['.refreshIcon', '#slider_refresh_icon', '.slider-refresh-icon']);
        console.log('Native Chrome confirmation slider assets still incomplete', { refreshed });
        await wait(refreshed ? 2000 : 500);
        continue;
      }
      await wait(500);
    }
  }

  if (!info || info.moveX < 40) {
    console.log('Native Chrome confirmation network diagnostics', await client.recentNetworkDiagnostics());
    throw new Error(
      visionConfigured()
        ? `Native Chrome confirmation slider target missing after vision-first solve (${visionAttempt?.reason || 'no-match'})`
        : 'Native Chrome confirmation slider target missing: vision not configured and local match failed',
    );
  }

  const maxAttempts = 5;
  let lastOutcome = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const refreshed = await clickPageElement(client, ['.refreshIcon', '#slider_refresh_icon', '.slider-refresh-icon', '[class*="refresh" i]']);
      await wait(refreshed ? 1800 : 1000);
      const next = await tryVisionSolve();
      if (!next?.ok || !(next.moveX >= 40)) {
        console.log('Native Chrome vision retry missing assets', { attempt: attempt + 1, next });
        continue;
      }
      info = next;
    }

    // Always drag the distance for THIS challenge. Prefer model-reported move.
    const moveX = Math.round(Number(info.moveX));
    console.log('Native Chrome confirmation slider match', {
      method: info.method,
      moveX,
      cssFromCrop: info.cssFromCrop,
      moveCandidates: info.moveCandidates,
      naturalX: info.naturalX,
      visionNaturalX: info.vision?.naturalX,
      startX: info.startX,
      sliderX: info.sliderX,
      screenshotScaleX: info.screenshotScaleX,
      imageWidth: info.imageWidth,
      canvasWidth: info.canvasWidth,
      slider: info.slider,
      attempt: attempt + 1,
      attemptCount: maxAttempts,
    });
    await drag(client, { startX: info.startX, startY: info.startY, moveX });
    const deadline = Date.now() + 12000;
    let hiddenSince = 0;
    while (Date.now() < deadline) {
      const state = await readPuzzleFailureText(client);
      lastOutcome = state;
      if (state?.sent || state?.success) return moveX;
      if (state?.failed) break;
      const visible = await client.evaluate(`(() => {
        const popup = document.querySelector(${JSON.stringify(puzzleRootSelector)});
        const rect = popup?.getBoundingClientRect();
        return !!(popup && rect.width > 0 && rect.height > 0 && getComputedStyle(popup).display !== 'none');
      })()`);
      if (!visible) {
        if (!hiddenSince) hiddenSince = Date.now();
        if (Date.now() - hiddenSince >= 4000) return moveX;
      } else {
        hiddenSince = 0;
      }
      await wait(400);
    }

    console.log('Native Chrome slider attempt rejected', {
      moveX,
      outcome: lastOutcome,
      network: await client.recentNetworkDiagnostics(),
    });
  }

  console.log('Native Chrome confirmation network diagnostics', await client.recentNetworkDiagnostics());
  throw new Error('Native Chrome confirmation slider or SMS operation failed');
}

async function redactSensitivePageFields(client) {
  return client.evaluate(`(() => {
    for (const element of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
      if ('value' in element) {
        element.value = '';
        element.setAttribute('value', '');
      }
      if (element.isContentEditable) element.textContent = '';
      element.setAttribute('data-debug-redacted', 'true');
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      walker.currentNode.data = walker.currentNode.data.replace(/[0-9]{4,11}/g, '***');
    }
    return true;
  })()`).catch(() => false);
}

async function captureCdpScreenshot(client, label = 'native-chrome-preflight-failed') {
  try {
    await client.send('Page.enable');
    const redacted = await redactSensitivePageFields(client);
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    if (!screenshot?.data) {
      console.log('Native Chrome screenshot missing', { label, redacted: !!redacted });
      return;
    }
    const artifactDir = path.join(root, 'artifacts', 'claim-debug');
    fs.mkdirSync(artifactDir, { recursive: true });
    const safeLabel = String(label || 'capture').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64);
    const file = path.join(artifactDir, `${Date.now()}-${safeLabel}.png`);
    fs.writeFileSync(file, Buffer.from(screenshot.data, 'base64'));
    console.log('Native Chrome saved debug screenshot', { label: safeLabel, redacted: !!redacted, bytes: screenshot.data.length });
  } catch (error) {
    console.log('Native Chrome screenshot failed', {
      label,
      message: sanitizeDiagnosticMessage(error?.message || error),
    });
  }
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
  const chromeArgs = [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    'about:blank',
  ];
  const proxyServer = process.env.OPENWRT_HTTP_PROXY || '';
  if (proxyServer) chromeArgs.splice(chromeArgs.length - 1, 0, `--proxy-server=${proxyServer}`);
  const chrome = spawn(chromeBin, chromeArgs, { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
  let alreadyClaimed = false;
  let packageUnavailable = false;
  let pageFamily = '';
  let offerLabels = [];

  try {
    const version = await waitForCdp(cdpUrl);
    const target = await waitForPageTarget(cdpUrl);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
      await wait(Number(process.env.TELECOM_NATIVE_CHROME_SETTLE_MS || 3000));
      await navigateToEntryPage(cdp);
      console.log(`Fresh headed system Chrome ready for delayed Playwright attachment (${version.Browser || 'Google Chrome'})`);
      if (probeOnly) {
        await cdp.send('Network.setBlockedURLs', {
          urls: ['*sendRandByUnlog*', '*sendRandProtocolV3*', '*sendCode*', '*SecondConfirmation*'],
        });
        await openSliderChallenge(cdp, phone);
        console.log('Native Chrome slider-load probe passed without submitting the slider or sending SMS', {
          networkEvents: cdp.recentNetworkEvents(),
        });
        return;
      }
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
      const loginSubmitStartedAt = Date.now();
      await submitLoginCode(cdp, sms.code);
      console.log('Native Chrome login completed before Playwright attachment');
      await dismissBenignDialogs(cdp);
      await logPostLoginRouteDiagnostics(cdp, loginSubmitStartedAt - 5000, entryUrl);
      const pageFamilyAfterLogin = await cdp.evaluate('location.href').then(pageFamilyFromUrl).catch(() => 'unknown');
      console.log('Native Chrome post-login page family', { pageFamily: pageFamilyAfterLogin });
      const packageResult = await selectTargetPackage(cdp, config.productName);
      alreadyClaimed = packageResult.alreadyClaimed;
      packageUnavailable = packageResult.packageUnavailable;
      pageFamily = packageResult.pageFamily || pageFamilyAfterLogin;
      offerLabels = packageResult.offerLabels || [];
      if (packageResult.wrongActivity) {
        await captureCdpScreenshot(cdp, 'wrong-activity');
        throw new Error(`Native Chrome landed on wrong activity page after login: ${JSON.stringify(packageResult.diagnostic)}`);
      }
      if (alreadyClaimed) {
        console.log('Native Chrome detected an already-claimed package response', packageResult.diagnostic);
        await captureCdpScreenshot(cdp, 'package-already-claimed');
      } else if (packageUnavailable) {
        console.log('Native Chrome skipping claim; configured package unavailable', packageResult.diagnostic);
        await captureCdpScreenshot(cdp, 'package-unavailable');
      } else {
        await openConfirmationSlider(cdp);
        const confirmationDistance = await solveConfirmationSlider(cdp);
        console.log(`Native Chrome confirmation SMS sent before Playwright attachment (${confirmationDistance}px)`);
      }
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
        TELECOM_CONFIRM_SMS_ALREADY_SENT: packageUnavailable || alreadyClaimed ? 'false' : 'true',
        TELECOM_ALREADY_CLAIMED: alreadyClaimed ? 'true' : 'false',
        TELECOM_PACKAGE_UNAVAILABLE: packageUnavailable ? 'true' : 'false',
        TELECOM_PAGE_FAMILY: pageFamily || '',
        TELECOM_OFFER_LABELS: (offerLabels || []).join('|'),
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
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (cleanupError) {
      console.log('Native Chrome profile cleanup failed', {
        message: sanitizeDiagnosticMessage(cleanupError?.message || cleanupError),
      });
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

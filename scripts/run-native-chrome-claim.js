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

async function waitForTelecomPage(cdpUrl, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`${cdpUrl}/json`).then(response => response.json());
      const target = targets.find(item => item.type === 'page' && item.url.startsWith('https://wapbj.189.cn/'));
      if (target) return target;
    } catch {}
    await wait(500);
  }
  throw new Error('Fresh system Chrome did not open the Telecom entry page');
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data || '{}'));
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject, timer } = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(timer);
      if (message.error) reject(new Error(message.error.message || 'CDP command failed'));
      else resolve(message.result || {});
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  send(method, params = {}, timeoutMs = 10000) {
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

async function openSliderChallenge(client, phone) {
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
    const selectors = ['.checknum-button.slider-sms-btn','.checknum-button','.slider-sms-btn','.content_send_unlog','#sendCode'];
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
  if (!point) throw new Error('Native Chrome SMS button missing');
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await wait(250);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await wait(120);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });

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
  throw new Error('Native Chrome slider challenge did not become ready before Playwright attachment');
}

async function solveSliderChallenge(client) {
  const match = await client.evaluate(`(${computeSliderImageMatchInPage.toString()})({})`, 30000);
  if (!match?.ok || !match.btn || !Number.isFinite(match.moveX) || match.moveX < 40) {
    throw new Error(`Native Chrome slider match failed: ${match?.reason || 'invalid-result'}`);
  }
  const startX = match.btn.cx;
  const startY = match.btn.cy;
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y: startY });
  await wait(250);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
  for (let step = 1; step <= 50; step += 1) {
    const t = step / 50;
    const ease = 1 - Math.pow(1 - t, 2.4);
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + match.moveX * ease,
      y: startY + Math.sin(t * Math.PI * 3) * 2,
      button: 'left',
    });
    await wait(24 + (step % 5) * 8);
  }
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: startX + match.moveX,
    y: startY,
    button: 'left',
    clickCount: 1,
  });

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
    entryUrl,
  ], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    const version = await waitForCdp(cdpUrl);
    const target = await waitForTelecomPage(cdpUrl);
    await wait(Number(process.env.TELECOM_NATIVE_CHROME_SETTLE_MS || 5000));
    console.log(`Fresh headed system Chrome ready for delayed Playwright attachment (${version.Browser || 'Google Chrome'})`);
    const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
    try {
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

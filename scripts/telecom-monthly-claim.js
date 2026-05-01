#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadConfig } = require('../src/config');
const { SmsInboxClient, sleep } = require('../src/sms-inbox-client');
const { stateMonth, isFinalRetryDay, beijingParts } = require('../src/retry-date');

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36';

function mask(s) {
  const phone = process.env.TELECOM_PHONE || '';
  let out = String(s || '').replace(/1\d{10}/g, m => `${m.slice(0, 3)}****${m.slice(7)}`);
  if (phone) out = out.replaceAll(phone, `${phone.slice(0, 3)}****${phone.slice(7)}`);
  return out.replace(/(code|smsCode|randCode|validCode)[:=]\s*\d{4,8}/ig, '$1=***');
}

function log(message, data) {
  if (data === undefined) console.log(message);
  else console.log(`${message} ${mask(JSON.stringify(data))}`);
}

async function applyAndroidEmulation(context, page) {
  const client = await context.newCDPSession(page);
  await client.send('Network.enable').catch(() => {});
  await client.send('Emulation.setUserAgentOverride', {
    userAgent: ANDROID_UA,
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    platform: 'Android',
    userAgentMetadata: {
      brands: [
        { brand: 'Google Chrome', version: '147' },
        { brand: 'Not.A/Brand', version: '8' },
        { brand: 'Chromium', version: '147' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '147.0.7727.138' },
        { brand: 'Not.A/Brand', version: '8.0.0.0' },
        { brand: 'Chromium', version: '147.0.7727.138' },
      ],
      fullVersion: '147.0.7727.138',
      platform: 'Android',
      platformVersion: '13.0.0',
      architecture: '',
      model: 'Pixel 7',
      mobile: true,
      bitness: '',
    },
  });
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 393, height: 873, deviceScaleFactor: 2.75, mobile: true, screenWidth: 393, screenHeight: 873,
  });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  return client;
}

async function launchBrowser(config) {
  const options = {
    headless: config.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  };
  if (config.openwrtProxy) options.proxy = buildProxyOptions(config.openwrtProxy);
  if (config.browserChannel) options.channel = config.browserChannel;
  try {
    return await chromium.launch(options);
  } catch (err) {
    if (!options.channel) throw err;
    log(`Browser channel ${options.channel} unavailable, falling back to bundled chromium`);
    delete options.channel;
    return chromium.launch(options);
  }
}

function buildProxyOptions(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const proxy = { server: `${parsed.protocol}//${parsed.host}` };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

async function newMobilePage(browser) {
  const context = await browser.newContext({
    viewport: { width: 393, height: 873 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: ANDROID_UA,
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l', configurable: true });
  });
  const page = await context.newPage();
  await applyAndroidEmulation(context, page);
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(45000);
  return { context, page };
}

async function visibleText(page) {
  return page.evaluate(() => document.body?.innerText || '');
}

async function closeDialogs(page, pattern = /验证码已下发|请注意查收|服务繁忙|稍后|我知道了/) {
  return page.evaluate(source => {
    const re = new RegExp(source);
    const visible = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    let closed = 0;
    for (const d of Array.from(document.querySelectorAll('#wap-dialog,.wap-dialog,.diaog-popup,#dialog-box')).filter(visible)) {
      if (d.id === 'secondPopCombo') continue;
      if (!re.test(d.innerText || '')) continue;
      const btn = Array.from(d.querySelectorAll('button,div,span,a')).reverse().find(e => /确定|我知道了|知道了/.test((e.innerText || '').trim()));
      if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      else d.style.display = 'none';
      closed += 1;
    }
    return closed;
  }, pattern.source);
}

async function getPageSummary(page) {
  return page.evaluate(() => {
    const visible = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    return {
      url: location.href,
      title: document.title,
      body: document.body?.innerText?.slice(0, 1000) || '',
      dialogs: Array.from(document.querySelectorAll('#wap-dialog,.wap-dialog,.diaog-popup,#popDetails')).filter(visible).map(e => (e.innerText || '').trim().slice(0, 300)),
    };
  });
}

async function sendLoginCode(page, config) {
  await page.locator('#phoneNumber').waitFor({ state: 'visible' });
  await page.locator('#phoneNumber').fill(config.phone);
  await sleep(1000);
  await page.locator('.content_send_unlog').click({ force: true });
  await sleep(3000);
  await closeDialogs(page);
}

async function submitLoginCode(page, code) {
  await page.locator('#code').fill(code);
  await sleep(1000);
  await page.locator('.know-box.button').click({ force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(7000);
  const text = await visibleText(page);
  if (/请选择档位|去办理/.test(text) && page.url().includes('preDepositCfg_list')) return true;
  if (/短信输入错误|验证码.*错误|验证码.*过期/.test(text)) return false;
  return page.url().includes('preDepositCfg_list');
}

async function loginWithRetry(page, smsInbox, config) {
  await page.goto(config.entryUrl, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  for (let attempt = 1; attempt <= config.sendCodeAttempts; attempt += 1) {
    log(`Sending login SMS attempt ${attempt}/${config.sendCodeAttempts}`);
    const since = Date.now() - 10000;
    await sendLoginCode(page, config);
    const sms = await smsInbox.waitForCode({ stage: 'login', since, timeoutMs: config.smsTimeoutMs, pollMs: config.smsPollMs });
    if (!sms) {
      log('Login SMS not received before timeout');
      continue;
    }
    const ok = await submitLoginCode(page, sms.code);
    if (ok) return;
    log('Login code rejected, retrying');
    await sleep(5000);
  }
  throw new Error('Login SMS verification failed after retries');
}

async function choosePackage(page, config) {
  await page.locator('li').filter({ hasText: config.productName }).waitFor({ state: 'visible' });
  await page.locator('li').filter({ hasText: config.productName }).click({ force: true });
  await sleep(1500);
  const checked = await page.locator('li.checked').innerText().catch(() => '');
  if (!checked.includes(config.productName)) throw new Error(`Target package not selected: ${checked}`);
  await sleep(1500);
  await page.locator('#conduct').click({ force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(8000);
  const activeName = await page.locator('#activeName').innerText().catch(() => '');
  if (!activeName.includes(config.productName)) throw new Error(`Confirm page package mismatch: ${activeName}`);
}

async function transparentPuzzleInfo(page) {
  return page.evaluate(() => {
    const visible = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    const canvas = document.querySelector('#secondPop_captcha canvas:not(.block)');
    let bbox = null;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let minx = 999; let miny = 999; let maxx = -1; let maxy = -1; let count = 0;
      for (let y = 0; y < canvas.height; y += 1) {
        for (let x = 0; x < canvas.width; x += 1) {
          if (data[(y * canvas.width + x) * 4 + 3] === 0) {
            count += 1; minx = Math.min(minx, x); miny = Math.min(miny, y); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y);
          }
        }
      }
      if (count > 500) bbox = { minx, miny, maxx, maxy, count };
    }
    const slider = document.querySelector('.slider')?.getBoundingClientRect();
    const container = document.querySelector('.sliderContainer')?.getBoundingClientRect();
    return {
      visible: visible(document.querySelector('#secondPop_puzzle_check')),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      bbox,
      slider: slider ? { x: slider.x, y: slider.y, w: slider.width, h: slider.height } : null,
      container: container ? { x: container.x, y: container.y, w: container.width, h: container.height } : null,
      message: document.querySelector('#secondPop_msg')?.innerText?.trim() || '',
    };
  });
}

async function solvePuzzle(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.locator('#secondPop_puzzle_check').waitFor({ state: 'visible' });
    await sleep(2500);
    const info = await transparentPuzzleInfo(page);
    if (!info.visible || !info.canvas || !info.bbox || !info.slider) {
      await page.locator('.refreshIcon').click({ force: true }).catch(() => {});
      await sleep(2000);
      continue;
    }
    const ratio = (info.canvas.width - 40 - 20) / (info.canvas.width - 40);
    const moveX = Math.round(info.bbox.minx / ratio);
    if (moveX < 55 || moveX > info.canvas.width - 35) {
      await page.locator('.refreshIcon').click({ force: true }).catch(() => {});
      await sleep(2000);
      continue;
    }

    log(`Solving slider attempt ${attempt}/3`, { targetX: info.bbox.minx, moveX });
    const responsePromise = page.waitForResponse(r => r.url().includes('/re/sms/sendRandProtocolV3'), { timeout: 20000 }).catch(() => null);
    const sx = info.slider.x + info.slider.w / 2;
    const sy = info.slider.y + info.slider.h / 2;
    await page.mouse.move(sx, sy);
    await sleep(650);
    await page.mouse.down();
    const steps = 58;
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 2.45);
      let x = sx + moveX * ease;
      if (i > steps - 8) x = sx + moveX - (steps - i) * 0.16;
      const y = sy + Math.sin(t * Math.PI * 3.4) * 2.1 + Math.sin(t * Math.PI * 9) * 0.7;
      await page.mouse.move(x, y);
      await sleep(39 + (i % 6) * 8);
    }
    await sleep(350);
    await page.mouse.move(sx + moveX + 0.1, sy + 0.2);
    await sleep(260);
    await page.mouse.up();

    const response = await responsePromise;
    if (response) {
      const text = await response.text().catch(() => '');
      if (response.ok() && /"retCode"\s*:\s*"000000"/.test(text)) return true;
      log('Second SMS send response was not successful', { status: response.status(), body: text.slice(0, 120) });
    }
    const body = await visibleText(page);
    if (/验证码已下发|请注意查收/.test(body)) return true;
    await page.locator('.refreshIcon').click({ force: true }).catch(() => {});
    await sleep(2500);
  }
  throw new Error('Slider verification failed');
}

async function openSecondPopup(page) {
  const activeName = await page.locator('#activeName').innerText().catch(() => '');
  if (!activeName) throw new Error('Not on confirm page');
  await page.locator('#payConfirm').click({ force: true });
  await page.locator('#secondPopCombo').waitFor({ state: 'visible' });
  await sleep(2500);
}

async function confirmWithRetry(page, smsInbox, config) {
  await openSecondPopup(page);
  for (let attempt = 1; attempt <= config.sendCodeAttempts; attempt += 1) {
    log(`Sending confirmation SMS attempt ${attempt}/${config.sendCodeAttempts}`);
    const since = Date.now() - 10000;
    await closeDialogs(page);
    await page.locator('#SecondConfirmationSms').click({ force: true });
    await solvePuzzle(page);
    await closeDialogs(page);
    const sms = await smsInbox.waitForCode({ stage: 'confirm', since, timeoutMs: config.smsTimeoutMs, pollMs: config.smsPollMs });
    if (!sms) {
      log('Confirmation SMS not received before timeout');
      continue;
    }
    if (config.dryRunBeforeFinalSubmit) {
      const summary = await getPageSummary(page);
      log('Dry run reached final submit step; confirmation SMS was received, final submit was not clicked.', summary);
      return 'dry-run';
    }
    await page.locator('#smsCodeProtocol').fill(sms.code);
    await sleep(1000);
    await page.locator('#secondConfirmation').click({ force: true });
    await sleep(12000);
    if (await waitForSuccess(page, 20000)) return;
    const text = await visibleText(page);
    if (/验证码.*错误|验证码.*过期|随机短信输入错误/.test(text)) {
      log('Confirmation code rejected, retrying');
      continue;
    }
    if (await clickFinalAgreementIfPresent(page)) {
      if (await waitForSuccess(page, 20000)) return;
    }
  }
  throw new Error('Confirmation SMS verification failed after retries');
}

async function clickFinalAgreementIfPresent(page) {
  const visible = await page.locator('#confirm2').evaluate(e => {
    const r = e.getBoundingClientRect();
    return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0;
  }).catch(() => false);
  if (!visible) return false;
  await page.locator('#confirm2').click({ force: true });
  await sleep(8000);
  return true;
}

async function waitForSuccess(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await visibleText(page);
    if (/已办理成功|支付成功|业务名称:.*5GB国内通用流量/.test(body) || page.url().includes('preDeposit_result')) return true;
    await sleep(2000);
  }
  return false;
}

function ensureStateDir() { fs.mkdirSync('state', { recursive: true }); }
function stateFile(month = stateMonth()) { return path.join('state', `${month}.json`); }

function alreadySucceeded(config) {
  if (config.forceRun) return false;
  const file = stateFile();
  if (!fs.existsSync(file)) return false;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).status === 'success'; } catch { return false; }
}

function writeState(status, details) {
  ensureStateDir();
  fs.writeFileSync(stateFile(), `${JSON.stringify({ status, month: stateMonth(), beijing: beijingParts(), ...details }, null, 2)}\n`);
}

async function runClaim(config) {
  if (alreadySucceeded(config)) {
    log(`State ${stateFile()} already records success; skip. Set FORCE_RUN=true to override.`);
    return;
  }
  const smsInbox = new SmsInboxClient(config);
  const browser = await launchBrowser(config);
  try {
    const { page } = await newMobilePage(browser);
    await loginWithRetry(page, smsInbox, config);
    await choosePackage(page, config);
    const result = await confirmWithRetry(page, smsInbox, config);
    if (result === 'dry-run') return;
    if (!await waitForSuccess(page, 5000)) throw new Error('No success page after final submit');
    const summary = await getPageSummary(page);
    log('Claim succeeded', summary);
    writeState('success', { summary });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const config = loadConfig();
  try {
    await runClaim(config);
  } catch (err) {
    log('Claim failed', { message: err.message, stack: err.stack?.split('\n').slice(0, 4).join('\n') });
    writeState('failed', { error: err.message, finalRetryDay: isFinalRetryDay(new Date(), config.finalRetryDay) });
    if (config.failOnlyFinalDay && !isFinalRetryDay(new Date(), config.finalRetryDay)) {
      log('Not final retry day yet; keeping workflow green so next scheduled day can retry.');
      return;
    }
    process.exitCode = 1;
  }
}

main();

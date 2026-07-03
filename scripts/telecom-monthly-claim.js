#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { loadConfig } = require('../src/config');
const { SmsInboxClient, sleep } = require('../src/sms-inbox-client');
const { stateMonth, isFinalRetryDay, beijingParts } = require('../src/retry-date');


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

function maskProxyUrl(proxyUrl) {
  if (!proxyUrl) return '';
  try {
    const parsed = new URL(proxyUrl);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return String(proxyUrl).replace(/\/\/[^/@]+@/, '//***:***@');
  }
}

function isProxyPathError(err) {
  const text = `${err?.message || ''}\n${err?.stack || ''}`;
  return [
    /ERR_PROXY_CONNECTION_FAILED/i,
    /ERR_TUNNEL_CONNECTION_FAILED/i,
    /ERR_CONNECTION_RESET/i,
    /ERR_CONNECTION_CLOSED/i,
    /ECONNREFUSED/i,
    /ECONNRESET/i,
    /ETIMEDOUT/i,
    /EHOSTUNREACH/i,
    /ERR_NAME_NOT_RESOLVED/i,
    /socket hang up/i,
    /getSliderChallenge HTTP 400/i,
    /proxy/i,
  ].some(pattern => pattern.test(text));
}

async function actionDelay(config) {
  const delayMs = Number(config?.actionDelayMs || 0);
  if (delayMs > 0) await sleep(delayMs);
}

function chromeVersionParts(browser) {
  const fullVersion = /\d+\.\d+\.\d+\.\d+/.exec(browser.version())?.[0] || '120.0.0.0';
  return { fullVersion, majorVersion: fullVersion.split('.')[0] };
}

function androidUserAgent(browser) {
  const { fullVersion } = chromeVersionParts(browser);
  return `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${fullVersion} Mobile Safari/537.36`;
}

function rememberPageDiagnostic(page, entry) {
  page.__telecomDiagnostics = page.__telecomDiagnostics || [];
  page.__telecomDiagnostics.push({ at: new Date().toISOString(), ...entry });
  page.__telecomDiagnostics = page.__telecomDiagnostics.slice(-20);
}

function sliderFailureHint(page) {
  const text = JSON.stringify(page.__telecomDiagnostics || []);
  const signals = [];
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(text)) signals.push('ERR_TUNNEL_CONNECTION_FAILED');
  if (/ERR_NAME_NOT_RESOLVED/i.test(text)) signals.push('ERR_NAME_NOT_RESOLVED');
  if (/getSliderChallenge/i.test(text) && /"status":400/.test(text)) signals.push('getSliderChallenge HTTP 400');
  return signals.length ? `; ${signals.join(', ')}` : '';
}

async function launchBrowser(config) {
  const options = {
    headless: config.headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
  };
  if (config.openwrtProxy) {
    log('Launching browser through home proxy', { proxy: maskProxyUrl(config.openwrtProxy) });
    options.proxy = buildProxyOptions(config.openwrtProxy);
  } else {
    log('Launching browser without OPENWRT_HTTP_PROXY');
  }
  if (config.browserChannel) options.channel = config.browserChannel;
  try {
    const browser = await chromium.launch(options);
    log('Browser launched', { version: browser.version(), channel: options.channel || 'bundled' });
    return browser;
  } catch (err) {
    if (!options.channel) throw err;
    log(`Browser channel ${options.channel} unavailable, falling back to bundled chromium`);
    delete options.channel;
    const browser = await chromium.launch(options);
    log('Browser launched', { version: browser.version(), channel: 'bundled' });
    return browser;
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
    userAgent: androidUserAgent(browser),
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) rememberPageDiagnostic(page, { type: `console:${msg.type()}`, text: msg.text().slice(0, 300) });
  });
  page.on('pageerror', err => rememberPageDiagnostic(page, { type: 'pageerror', text: err.message.slice(0, 300) }));
  page.on('requestfailed', request => {
    if (/wapbj\.189\.cn/i.test(request.url())) rememberPageDiagnostic(page, { type: 'requestfailed', url: request.url(), error: request.failure()?.errorText || '' });
  });
  page.on('response', response => {
    if (response.status() < 400 || !/wapbj\.189\.cn/i.test(response.url())) return;
    const entry = { type: 'response', url: response.url(), status: response.status() };
    rememberPageDiagnostic(page, entry);
    if (!/preActiveMeta|getSliderChallenge|sendRandProtocolV3/i.test(response.url())) return;
    response.text()
      .then(body => rememberPageDiagnostic(page, { ...entry, body: mask(body).slice(0, 300) }))
      .catch(() => {});
  });
  // Avoid CDP emulation and navigator overrides; those made Beijing Telecom's
  // WAF challenge collapse to an empty 400 page in CI.
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
  const summary = await page.evaluate(() => {
    const visible = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    const describe = e => ({
      tag: e.tagName,
      id: e.id || '',
      className: String(e.className || '').slice(0, 120),
      type: e.getAttribute('type') || '',
      text: String(e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    });
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      body: document.body?.innerText?.slice(0, 1000) || '',
      scripts: Array.from(document.scripts || []).slice(0, 12).map(e => (e.src || '').slice(0, 160)),
      dialogs: Array.from(document.querySelectorAll('#wap-dialog,.wap-dialog,.diaog-popup,#popDetails')).filter(visible).map(e => (e.innerText || '').trim().slice(0, 300)),
      controls: Array.from(document.querySelectorAll('button,a,span,div,input,canvas'))
        .filter(visible)
        .filter(e => /(验证码|短信|动态码|随机码|校验码|安全验证|滑块|send|sms|code|yzm|rand|slider|captcha|puzzle|checknum)/i.test([
          e.id,
          e.className,
          e.getAttribute('type'),
          e.value,
          e.innerText,
          e.getAttribute('aria-label'),
          e.getAttribute('title'),
          e.getAttribute('placeholder'),
        ].join(' ')))
        .slice(0, 20)
        .map(describe),
    };
  });
  return { ...summary, diagnostics: page.__telecomDiagnostics || [] };
}

const LOGIN_SMS_SEND_SELECTORS = [
  '.content_send_unlog',
  '.content_send_log',
  '.content_send',
  '[class*="content_send"]',
  '#sendCode',
  '#sendSms',
  '#getCode',
  'input[type="button"][value*="验证码"]',
  'input[type="button"][value*="短信"]',
  'input[type="button"][value*="动态码"]',
  'input[type="button"][value*="随机码"]',
  'input[type="submit"][value*="验证码"]',
  '[id*="send" i]',
  '[class*="send" i]',
  '[id*="sms" i]',
  '[class*="sms" i]',
  '[id*="rand" i]',
  '[class*="rand" i]',
  '[id*="yzm" i]',
  '[class*="yzm" i]',
  'button:has-text("获取验证码")',
  'button:has-text("发送验证码")',
  'button:has-text("验证码")',
  'button:has-text("点击获取")',
  'a:has-text("获取验证码")',
  'a:has-text("发送验证码")',
  'span:has-text("获取验证码")',
  'span:has-text("发送验证码")',
  'span:has-text("点击获取")',
  'div:has-text("获取验证码")',
  'div:has-text("发送验证码")',
  'div:has-text("点击获取")',
];

const LOGIN_PHONE_SELECTORS = ['#phoneNumber', 'input[placeholder*="手机号码"]', 'input[placeholder*="手机号"]'];
const LOGIN_CODE_SELECTORS = ['#code', 'input[placeholder*="短信验证码"]', 'input[placeholder*="验证码"]'];
const LOGIN_SUBMIT_SELECTORS = ['.know-box.button', 'button:has-text("立即办理")', 'div:has-text("立即办理")'];

async function isLocatorActuallyVisible(locator) {
  if (typeof locator.evaluate === 'function') {
    const domVisible = await locator.evaluate(e => {
      if (!e) return false;
      const style = getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none'
        && rect.width > 0
        && rect.height > 0;
    }).catch(() => null);
    if (domVisible !== null) return domVisible;
  }
  return locator.isVisible().catch(() => false);
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const matches = page.locator(selector);
    const count = Math.min(await matches.count().catch(() => 0), 20);
    for (let i = 0; i < count; i += 1) {
      const locator = matches.nth(i);
      if (await isLocatorActuallyVisible(locator)) return { locator, selector };
    }
  }
  return null;
}

async function waitForVisibleLocator(page, selectors, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = await firstVisibleLocator(page, selectors);
    if (match) return match;
    await sleep(300);
  }
  return firstVisibleLocator(page, selectors);
}

async function activateSmsLoginByDom(page) {
  return page.evaluate(() => {
    const visible = e => {
      if (!e) return false;
      const style = getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none'
        && rect.width > 0
        && rect.height > 0;
    };
    const eventInit = { bubbles: true, cancelable: true, view: window };
    const exact = text => String(text || '').replace(/\s+/g, '') === '短信验证码登录';
    const targets = Array.from(document.querySelectorAll('button,a,span,div'))
      .filter(e => visible(e) && exact(e.innerText || e.textContent));
    for (const target of targets) {
      for (let node = target; node && node !== document.body; node = node.parentElement) {
        if (!visible(node)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width >= window.innerWidth * 0.95 && rect.height >= window.innerHeight * 0.5) continue;
        node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true }));
        node.dispatchEvent(new MouseEvent('mousedown', eventInit));
        node.dispatchEvent(new MouseEvent('mouseup', eventInit));
        node.dispatchEvent(new MouseEvent('click', eventInit));
        return {
          tag: node.tagName,
          className: String(node.className || '').slice(0, 120),
          text: String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        };
      }
    }
    return null;
  });
}

async function hasLoginEntry(page) {
  return !!(await firstVisibleLocator(page, LOGIN_PHONE_SELECTORS))
    || await page.getByText('短信验证码登录', { exact: true }).isVisible().catch(() => false);
}

async function waitForLoginEntry(page, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasLoginEntry(page)) return true;
    await sleep(1000);
  }
  return false;
}

async function ensureSmsLoginForm(page, config) {
  let phoneField = await firstVisibleLocator(page, LOGIN_PHONE_SELECTORS);
  if (phoneField) return phoneField;
  const smsLogin = page.getByText('短信验证码登录', { exact: true });
  if (await smsLogin.isVisible().catch(() => false)) {
    await actionDelay(config);
    await smsLogin.click({ force: true });
    log('Clicked SMS login tab', { strategy: 'text' });
    phoneField = await waitForVisibleLocator(page, LOGIN_PHONE_SELECTORS, 5000);
    if (phoneField) return phoneField;
    const domTarget = await activateSmsLoginByDom(page).catch(() => null);
    if (domTarget) log('Clicked SMS login tab', { strategy: 'dom', target: domTarget });
    await sleep(500);
  }
  phoneField = await waitForVisibleLocator(page, LOGIN_PHONE_SELECTORS, 5000);
  if (phoneField) return phoneField;
  const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
  throw new Error(`Login phone field not found after opening SMS login form; page summary: ${mask(JSON.stringify(summary))}`);
}

async function markLoginSmsButtonCandidate(page) {
  return page.evaluate(() => {
    const visible = e => {
      if (!e) return false;
      const style = getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none'
        && rect.width > 0
        && rect.height > 0
        && rect.width <= window.innerWidth * 0.9
        && rect.height <= 120;
    };
    const textOf = e => [
      e.innerText,
      e.value,
      e.textContent,
      e.id,
      e.className,
      e.getAttribute('aria-label'),
      e.getAttribute('title'),
      e.getAttribute('placeholder'),
    ].join(' ').replace(/\s+/g, '');
    const clickable = e => {
      if (e.disabled) return false;
      if (['BUTTON', 'A', 'SPAN', 'DIV'].includes(e.tagName)) return true;
      if (e.tagName !== 'INPUT') return false;
      return /^(button|submit)$/i.test(e.getAttribute('type') || '');
    };
    const target = Array.from(document.querySelectorAll('button,a,span,div,input'))
      .filter(e => clickable(e) && visible(e))
      .find(e => /(获取|发送|点击)?(短信)?(验证|动态|随机|校验)码|send.*(sms|code)|sms.*send|get.*code|rand.*code|yzm/i.test(textOf(e)));
    if (!target) return '';
    target.setAttribute('data-telecom-login-sms-send', 'true');
    return '[data-telecom-login-sms-send="true"]';
  });
}

async function clickLoginSmsButton(page, config) {
  const tried = [];
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const selector of LOGIN_SMS_SEND_SELECTORS) {
      if (!tried.includes(selector)) tried.push(selector);
      const candidate = page.locator(selector).first();
      const count = await candidate.count().catch(() => 0);
      if (count < 1) continue;
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      await actionDelay(config);
      await candidate.click({ force: true });
      log('Clicked login SMS send button', { selector });
      return selector;
    }
    await sleep(500);
  }

  const fallbackSelector = await markLoginSmsButtonCandidate(page).catch(() => '');
  if (fallbackSelector) {
    await actionDelay(config);
    await page.locator(fallbackSelector).first().click({ force: true });
    log('Clicked login SMS send button', { selector: fallbackSelector });
    return fallbackSelector;
  }

  const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
  throw new Error(`Login SMS send button not found after trying selectors: ${tried.join(', ')}; page summary: ${mask(JSON.stringify(summary))}`);
}

async function hasSliderVerification(page) {
  return page.evaluate(() => {
    const visible = e => {
      if (!e) return false;
      const style = getComputedStyle(e);
      const rect = e.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const text = document.body?.innerText || '';
    return /安全验证|向右滑动滑块|滑动滑块/.test(text)
      && (
        visible(document.querySelector('#secondPop_puzzle_check'))
        || visible(document.querySelector('.puzzle-verify-popup'))
        || visible(document.querySelector('.captcha-wrapper'))
        || visible(document.querySelector('.slider-track'))
        || visible(document.querySelector('.slider-btn'))
        || visible(document.querySelector('.sliderContainer'))
        || visible(document.querySelector('.slider'))
        || visible(document.querySelector('[class*="slider" i]'))
        || visible(document.querySelector('[id*="slider" i]'))
      );
  }).catch(() => false);
}

async function waitForSliderVerification(page, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await hasSliderVerification(page)) return true;
    await sleep(300);
  }
  return hasSliderVerification(page);
}

async function sendLoginCode(page, config) {
  const phoneField = await ensureSmsLoginForm(page, config);
  await actionDelay(config);
  await phoneField.locator.fill(config.phone);
  await clickLoginSmsButton(page, config);
  if (await waitForSliderVerification(page)) {
    log('Login SMS send requires slider verification');
    await solvePuzzle(page);
  }
  await sleep(3000);
  const closedDialogs = await closeDialogs(page);
  const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
  log('Login SMS send page summary', { closedDialogs, summary });
}

async function submitLoginCode(page, code, config) {
  await closeDialogs(page);
  await sleep(500);
  await actionDelay(config);
  const codeField = await firstVisibleLocator(page, LOGIN_CODE_SELECTORS);
  if (!codeField) {
    const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
    throw new Error(`Login code field not found; page summary: ${mask(JSON.stringify(summary))}`);
  }
  await codeField.locator.fill(code);
  await actionDelay(config);
  await closeDialogs(page);
  await sleep(300);
  const submitButton = await firstVisibleLocator(page, LOGIN_SUBMIT_SELECTORS);
  if (!submitButton) {
    const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
    throw new Error(`Login submit button not found; page summary: ${mask(JSON.stringify(summary))}`);
  }
  await submitButton.locator.click({ force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(7000);
  let text = await visibleText(page);
  if (/验证码已下发|请注意查收/.test(text) && !/短信输入错误|验证码.*错误|验证码.*过期/.test(text)) {
    await closeDialogs(page);
    await sleep(500);
    await actionDelay(config);
    const retrySubmitButton = await firstVisibleLocator(page, LOGIN_SUBMIT_SELECTORS);
    if (retrySubmitButton) await retrySubmitButton.locator.click({ force: true });
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(7000);
    text = await visibleText(page);
  }
  if (/请选择档位|去办理/.test(text) && page.url().includes('preDepositCfg_list')) return true;
  if (/短信输入错误|验证码.*错误|验证码.*过期/.test(text)) return false;
  return page.url().includes('preDepositCfg_list');
}

function withCacheBuster(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('_claimRetry', `${Date.now()}`);
    return url.toString();
  } catch {
    return rawUrl;
  }
}

async function gotoLoginEntryPage(page, config, reason) {
  const candidates = [
    { label: 'entry', url: config.entryUrl },
    { label: 'entry-cache-bust', url: withCacheBuster(config.entryUrl) },
  ];
  for (const candidate of candidates) {
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
    const response = await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
      rememberPageDiagnostic(page, { type: 'goto-error', url: candidate.url, error: err.message });
      return null;
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (await waitForLoginEntry(page)) {
      log('Login entry ready', { reason, strategy: candidate.label, status: response?.status?.() || null, url: page.url() });
      return;
    }
    let summary = await getPageSummary(page).catch(err => ({ error: err.message }));
    log('Login entry phone field missing', { reason, strategy: candidate.label, status: response?.status?.() || null, summary });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
      rememberPageDiagnostic(page, { type: 'reload-error', url: page.url(), error: err.message });
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    if (await waitForLoginEntry(page)) {
      log('Login entry ready after reload', { reason, strategy: candidate.label, url: page.url() });
      return;
    }
    summary = await getPageSummary(page).catch(err => ({ error: err.message }));
    log('Login entry still missing after reload', { reason, strategy: candidate.label, summary });
  }
  const diagnosticsText = JSON.stringify(page.__telecomDiagnostics || []);
  const proxyHint = /ERR_TUNNEL_CONNECTION_FAILED/i.test(diagnosticsText)
    ? '; ERR_TUNNEL_CONNECTION_FAILED while loading login entry resources'
    : '';
  throw new Error(`Login entry phone field not visible after entry retries${proxyHint}`);
}

async function resetLoginEntryPage(page) {
  await page.locator('.slider-check-close').first().click({ force: true }).catch(() => {});
  await page.context().clearCookies().catch(() => {});
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  }).catch(() => {});
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => {});
}

function isRetryableLoginSendError(err) {
  if (isProxyPathError(err)) return false;
  return /Slider verification (failed|service busy)|#phoneNumber|Login phone field not found|element is not visible/.test(err?.message || '');
}

async function dragSlider(page, sx, sy, moveX) {
  const client = await page.context().newCDPSession(page).catch(() => null);
  const points = [];
  const steps = 62;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 2.35);
    const overshoot = i > steps - 7 ? (steps - i) * 0.22 : 0;
    points.push({
      x: sx + moveX * ease - overshoot,
      y: sy + Math.sin(t * Math.PI * 3.2) * 2.4 + Math.sin(t * Math.PI * 9.5) * 0.8,
      wait: 35 + (i % 7) * 9,
    });
  }
  if (client) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, radiusX: 5, radiusY: 5, force: 0.6 }] });
    for (const point of points.slice(1)) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y, radiusX: 5, radiusY: 5, force: 0.6 }] });
      await sleep(point.wait);
    }
    await sleep(260);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await page.mouse.move(sx, sy);
  await sleep(650);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    await page.mouse.move(point.x, point.y);
    await sleep(point.wait);
  }
  await sleep(260);
  await page.mouse.up();
}

async function loginWithRetry(page, smsInbox, config) {
  for (let attempt = 1; attempt <= config.sendCodeAttempts; attempt += 1) {
    log(`Sending login SMS attempt ${attempt}/${config.sendCodeAttempts}`);
    const since = Date.now() - 10000;
    try {
      await gotoLoginEntryPage(page, config, `attempt-${attempt}`);
      await sendLoginCode(page, config);
    } catch (err) {
      const summary = await getPageSummary(page).catch(summaryErr => ({ error: summaryErr.message }));
      log('Login SMS send failed before code wait', { error: err.message, summary });
      if (attempt < config.sendCodeAttempts && isRetryableLoginSendError(err)) {
        await sleep(60000);
        await resetLoginEntryPage(page);
        continue;
      }
      throw err;
    }
    const sms = await smsInbox.waitForCode({ stage: 'login', since, timeoutMs: config.smsTimeoutMs, pollMs: config.smsPollMs });
    if (!sms) {
      const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
      log('Login SMS not received before timeout', summary);
      continue;
    }
    const ok = await submitLoginCode(page, sms.code, config);
    if (ok) return;
    const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
    log('Login code rejected, retrying', summary);
    if (attempt < config.sendCodeAttempts) {
      await resetLoginEntryPage(page);
      await sleep(60000);
    }
  }
  throw new Error('Login SMS verification failed after retries');
}

async function choosePackage(page, config) {
  await page.locator('li').filter({ hasText: config.productName }).waitFor({ state: 'visible' });
  await actionDelay(config);
  await page.locator('li').filter({ hasText: config.productName }).click({ force: true });
  await sleep(1500);
  const checked = await page.locator('li.checked').innerText().catch(() => '');
  if (!checked.includes(config.productName)) throw new Error(`Target package not selected: ${checked}`);
  await actionDelay(config);
  await page.locator('#conduct').click({ force: true });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(8000);
  const activeName = await page.locator('#activeName').innerText().catch(() => '');
  if (!activeName.includes(config.productName)) throw new Error(`Confirm page package mismatch: ${activeName}`);
}

async function transparentPuzzleInfo(page) {
  return page.evaluate(() => {
    const visible = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    const describe = e => {
      const rect = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      return {
        tag: e.tagName,
        id: e.id || '',
        className: String(e.className || '').slice(0, 120),
        text: String(e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        bg: String(style.backgroundImage || '').slice(0, 160),
        src: String(e.getAttribute('src') || '').slice(0, 160),
      };
    };
    const canvas = Array.from(document.querySelectorAll('#secondPop_captcha canvas:not(.block), canvas'))
      .find(e => visible(e) && e.width >= 100 && e.height >= 50);
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
    const imageMatchInfo = () => {
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      if (!bg || !block || !visible(bg) || !visible(block) || !bg.complete || !block.complete) return null;
      const bgRect = bg.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      const bgCanvas = document.createElement('canvas');
      bgCanvas.width = bg.naturalWidth || Math.round(bgRect.width);
      bgCanvas.height = bg.naturalHeight || Math.round(bgRect.height);
      const blockCanvas = document.createElement('canvas');
      blockCanvas.width = block.naturalWidth || Math.round(blockRect.width);
      blockCanvas.height = block.naturalHeight || Math.round(blockRect.height);
      const bgCtx = bgCanvas.getContext('2d');
      const blockCtx = blockCanvas.getContext('2d');
      bgCtx.drawImage(bg, 0, 0, bgCanvas.width, bgCanvas.height);
      blockCtx.drawImage(block, 0, 0, blockCanvas.width, blockCanvas.height);
      const bgData = bgCtx.getImageData(0, 0, bgCanvas.width, bgCanvas.height).data;
      const blockData = blockCtx.getImageData(0, 0, blockCanvas.width, blockCanvas.height).data;
      const scaleY = bgCanvas.height / bgRect.height;
      const scaleX = bgCanvas.width / bgRect.width;
      const targetY = Math.max(0, Math.min(
        bgCanvas.height - blockCanvas.height,
        Math.round((blockRect.y - bgRect.y) * scaleY),
      ));
      const gray = data => {
        const out = new Uint16Array(data.length / 4);
        for (let i = 0; i < out.length; i += 1) out[i] = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
        return out;
      };
      const bgGray = gray(bgData);
      const edge = (data, width, height) => {
        const out = new Uint16Array(width * height);
        for (let y = 1; y < height - 1; y += 1) {
          for (let x = 1; x < width - 1; x += 1) {
            const i = y * width + x;
            out[i] = Math.abs(data[i + 1] - data[i - 1]) + Math.abs(data[i + width] - data[i - width]);
          }
        }
        return out;
      };
      const bgEdge = edge(bgGray, bgCanvas.width, bgCanvas.height);
      const alphaAt = (x, y) => blockData[(y * blockCanvas.width + x) * 4 + 3];
      const edgePoints = [];
      const innerPoints = [];
      for (let by = 1; by < blockCanvas.height - 1; by += 1) {
        for (let bx = 1; bx < blockCanvas.width - 1; bx += 1) {
          if (alphaAt(bx, by) < 80) continue;
          const boundary = alphaAt(bx - 1, by) < 80
            || alphaAt(bx + 1, by) < 80
            || alphaAt(bx, by - 1) < 80
            || alphaAt(bx, by + 1) < 80;
          if (boundary) edgePoints.push({ x: bx, y: by });
          else if (bx % 4 === 0 && by % 4 === 0) innerPoints.push({ x: bx, y: by });
        }
      }
      let textureX = 0;
      let textureScore = Number.POSITIVE_INFINITY;
      let edgeX = 0;
      let edgeScore = Number.NEGATIVE_INFINITY;
      for (let x = 0; x <= bgCanvas.width - blockCanvas.width; x += 1) {
        let texture = 0;
        let textureSamples = 0;
        for (let by = 4; by < blockCanvas.height - 4; by += 2) {
          for (let bx = 4; bx < blockCanvas.width - 4; bx += 2) {
            const bi = (by * blockCanvas.width + bx) * 4;
            const alpha = blockData[bi + 3];
            if (alpha < 80) continue;
            const gi = ((targetY + by) * bgCanvas.width + x + bx) * 4;
            texture += Math.abs(blockData[bi] - bgData[gi])
              + Math.abs(blockData[bi + 1] - bgData[gi + 1])
              + Math.abs(blockData[bi + 2] - bgData[gi + 2]);
            textureSamples += 1;
          }
        }
        if (textureSamples > 0) texture /= textureSamples;
        if (texture < textureScore) {
          textureScore = texture;
          textureX = x;
        }
        if (edgePoints.length > 0) {
          const boundary = edgePoints.reduce((sum, p) => sum + bgEdge[(targetY + p.y) * bgCanvas.width + x + p.x], 0) / edgePoints.length;
          const inner = innerPoints.length > 0
            ? innerPoints.reduce((sum, p) => sum + bgEdge[(targetY + p.y) * bgCanvas.width + x + p.x], 0) / innerPoints.length
            : 0;
          const score = boundary - inner * 0.35;
          if (score > edgeScore) {
            edgeScore = score;
            edgeX = x;
          }
        }
      }
      const useEdge = edgePoints.length >= 20
        && edgeX >= 45 * scaleX
        && edgeX <= bgCanvas.width - blockCanvas.width + 10 * scaleX;
      const bestX = useEdge ? edgeX : textureX;
      return {
        x: Math.round(bestX / scaleX),
        y: Math.round(targetY / scaleY),
        method: useEdge ? 'edge' : 'texture',
        score: Math.round(useEdge ? edgeScore : textureScore),
        texture: { x: Math.round(textureX / scaleX), score: Math.round(textureScore) },
        edge: edgePoints.length > 0 ? { x: Math.round(edgeX / scaleX), score: Math.round(edgeScore), points: edgePoints.length } : null,
        bg: { width: bgCanvas.width, height: bgCanvas.height },
        block: { width: blockCanvas.width, height: blockCanvas.height },
      };
    };
    const imageMatch = imageMatchInfo();
    const sliderEl = document.querySelector('#slider_track_btn')
      || document.querySelector('.slider-btn')
      || document.querySelector('.slider')
      || Array.from(document.querySelectorAll('[class*="slider" i],[id*="slider" i]'))
      .filter(visible)
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0];
    const containerEl = document.querySelector('#slider_track')
      || document.querySelector('.slider-track')
      || document.querySelector('.captcha-wrapper')
      || document.querySelector('.sliderContainer')
      || sliderEl?.closest('[class*="container" i]')
      || sliderEl?.closest('[class*="wrapper" i]')
      || Array.from(document.querySelectorAll('[class*="slider" i],[id*="slider" i]'))
        .filter(visible)
        .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    const slider = sliderEl?.getBoundingClientRect();
    const container = containerEl?.getBoundingClientRect();
    return {
      visible: visible(document.querySelector('#secondPop_puzzle_check')) || /安全验证|向右滑动滑块|滑动滑块/.test(document.body?.innerText || ''),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      bbox,
      imageMatch,
      slider: slider ? { x: slider.x, y: slider.y, w: slider.width, h: slider.height } : null,
      container: container ? { x: container.x, y: container.y, w: container.width, h: container.height } : null,
      message: document.querySelector('#secondPop_msg')?.innerText?.trim()
        || document.querySelector('.puzzle-msg')?.innerText?.trim()
        || '',
      elements: Array.from(document.querySelectorAll('canvas,img,button,a,span,div,input'))
        .filter(e => visible(e) && /(slider|captcha|puzzle|checknum|verify|drag|block|滑块|验证)/i.test([
          e.id,
          e.className,
          e.innerText,
          e.value,
          e.getAttribute('aria-label'),
          e.getAttribute('title'),
        ].join(' ')))
        .slice(0, 30)
        .map(describe),
    };
  });
}

async function solvePuzzle(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForFunction(() => {
      const visible = e => {
        if (!e) return false;
        const style = getComputedStyle(e);
        const rect = e.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      return /安全验证|向右滑动滑块|滑动滑块/.test(document.body?.innerText || '')
        && (
          visible(document.querySelector('#secondPop_puzzle_check'))
          || visible(document.querySelector('.puzzle-verify-popup'))
          || visible(document.querySelector('.captcha-wrapper'))
          || visible(document.querySelector('.slider-track'))
          || visible(document.querySelector('.slider-btn'))
          || visible(document.querySelector('.sliderContainer'))
          || visible(document.querySelector('.slider'))
          || visible(document.querySelector('[class*="slider" i]'))
          || visible(document.querySelector('[id*="slider" i]'))
        );
    }, { timeout: 15000 });
    await sleep(2500);
    const info = await transparentPuzzleInfo(page);
    const hasCanvasTarget = info.canvas && info.bbox;
    const hasImageTarget = info.imageMatch;
    const hasTrackFallback = info.slider && info.container && info.container.w > info.slider.w + 45;
    if (!info.visible || !info.slider || (!hasCanvasTarget && !hasImageTarget && !hasTrackFallback)) {
      log('Slider puzzle info incomplete', { attempt, info });
      await page.locator('.refreshIcon,#slider_refresh_icon,.slider-refresh-icon').first().click({ force: true }).catch(() => {});
      await sleep(2000);
      continue;
    }
    const moveX = info.imageMatch
      ? info.imageMatch.x
      : hasCanvasTarget
        ? Math.round(info.bbox.minx / ((info.canvas.width - 40 - 20) / (info.canvas.width - 40)))
        : Math.round(info.container.w - info.slider.w - 4);
    const maxMoveX = info.imageMatch
      ? (info.imageMatch.bg.width - info.imageMatch.block.width + 10)
      : hasCanvasTarget
        ? info.canvas.width - 35
        : info.container.w - 4;
    if (moveX < 45 || moveX > maxMoveX) {
      log('Slider puzzle target out of range', { attempt, info, moveX });
      await page.locator('.refreshIcon,#slider_refresh_icon,.slider-refresh-icon').first().click({ force: true }).catch(() => {});
      await sleep(2000);
      continue;
    }

    log(`Solving slider attempt ${attempt}/3`, {
      targetX: info.imageMatch?.x ?? info.bbox.minx,
      moveX,
      match: info.imageMatch ? {
        method: info.imageMatch.method,
        score: info.imageMatch.score,
        texture: info.imageMatch.texture,
        edge: info.imageMatch.edge,
      } : hasCanvasTarget ? null : { method: 'track-end' },
    });
    const responsePromise = page.waitForResponse(r => r.url().includes('/re/sms/sendRandProtocolV3'), { timeout: 20000 }).catch(() => null);
    const sx = info.slider.x + info.slider.w / 2;
    const sy = info.slider.y + info.slider.h / 2;
    await dragSlider(page, sx, sy, moveX);

    const response = await responsePromise;
    if (response) {
      const text = await response.text().catch(() => '');
      if (response.ok() && /"retCode"\s*:\s*"000000"/.test(text)) return true;
      log('Second SMS send response was not successful', { status: response.status(), body: text.slice(0, 120) });
    }
    const body = await visibleText(page);
    if (/验证码已下发|请注意查收/.test(body)) return true;
    if (/服务繁忙/.test(body)) throw new Error('Slider verification service busy');
    await page.locator('.refreshIcon,#slider_refresh_icon,.slider-refresh-icon').first().click({ force: true }).catch(() => {});
    await sleep(2500);
  }
  throw new Error(`Slider verification failed${sliderFailureHint(page)}`);
}

async function openSecondPopup(page, config) {
  const activeName = await page.locator('#activeName').innerText().catch(() => '');
  if (!activeName) throw new Error('Not on confirm page');
  await actionDelay(config);
  await page.locator('#payConfirm').click({ force: true });
  await page.locator('#secondPopCombo').waitFor({ state: 'visible' });
  await sleep(2500);
}

async function confirmWithRetry(page, smsInbox, config) {
  await openSecondPopup(page, config);
  for (let attempt = 1; attempt <= config.sendCodeAttempts; attempt += 1) {
    log(`Sending confirmation SMS attempt ${attempt}/${config.sendCodeAttempts}`);
    const since = Date.now() - 10000;
    await closeDialogs(page);
    await actionDelay(config);
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
    await actionDelay(config);
    await page.locator('#smsCodeProtocol').fill(sms.code);
    await actionDelay(config);
    await page.locator('#secondConfirmation').click({ force: true });
    await sleep(12000);
    if (await waitForSuccess(page, 20000, config)) return;
    const text = await visibleText(page);
    if (/验证码.*错误|验证码.*过期|随机短信输入错误/.test(text)) {
      log('Confirmation code rejected, retrying');
      continue;
    }
    if (await clickFinalAgreementIfPresent(page, config)) {
      if (await waitForSuccess(page, 20000, config)) return;
    }
  }
  throw new Error('Confirmation SMS verification failed after retries');
}

async function clickFinalAgreementIfPresent(page, config) {
  const visible = await page.locator('#confirm2').evaluate(e => {
    const r = e.getBoundingClientRect();
    return getComputedStyle(e).display !== 'none' && r.width > 0 && r.height > 0;
  }).catch(() => false);
  if (!visible) return false;
  await actionDelay(config);
  await page.locator('#confirm2').click({ force: true });
  await sleep(8000);
  return true;
}

async function waitForSuccess(page, timeoutMs, config) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await visibleText(page);
    if (
      /已办理成功|支付成功/.test(body)
      || (config?.productName && body.includes('业务名称') && body.includes(config.productName))
      || page.url().includes('preDeposit_result')
    ) return true;
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
  const payload = { status, month: stateMonth(), beijing: beijingParts(), ...details };
  fs.writeFileSync(stateFile(), `${mask(JSON.stringify(payload, null, 2))}\n`);
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
    if (!await waitForSuccess(page, 5000, config)) throw new Error('No success page after final submit');
    const summary = await getPageSummary(page);
    log('Claim succeeded', summary);
    writeState('success', {
      targetPackage: config.targetPackage,
      productName: config.productName,
      expectedPlanId: config.expectedPlanId,
    });
    if (config.postSuccessWaitMs > 0) {
      log('Keeping success page open before closing browser', { waitMs: config.postSuccessWaitMs });
      await sleep(config.postSuccessWaitMs);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runClaimWithOptionalDirectFallback(config) {
  try {
    await runClaim(config);
  } catch (err) {
    if (config.allowDirectProxyFallback && config.openwrtProxy && isProxyPathError(err)) {
      log('Home proxy path failed; retrying this run without OPENWRT_HTTP_PROXY', {
        proxy: maskProxyUrl(config.openwrtProxy),
        error: err.message,
      });
      await runClaim({ ...config, openwrtProxy: '' });
      return;
    }
    throw err;
  }
}

async function main() {
  const config = loadConfig();
  try {
    await runClaimWithOptionalDirectFallback(config);
  } catch (err) {
    log('Claim failed', { message: err.message, stack: err.stack?.split('\n').slice(0, 4).join('\n') });
    if (config.dryRunBeforeFinalSubmit) {
      log('Dry run failed; state file was not updated.');
      process.exitCode = 1;
      return;
    }
    writeState('failed', { error: err.message, finalRetryDay: isFinalRetryDay(new Date(), config.finalRetryDay) });
    if (config.failOnlyFinalDay && !isFinalRetryDay(new Date(), config.finalRetryDay)) {
      log('Not final retry day yet; keeping workflow green so next scheduled day can retry.');
      return;
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  LOGIN_SMS_SEND_SELECTORS,
  clickLoginSmsButton,
  firstVisibleLocator,
};

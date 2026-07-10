#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { getStealthChromium, chromeLaunchArgs, mobileContextOptions, playwrightLaunchExtras } = require('../src/browser-stealth');
const { loadConfig } = require('../src/config');
const { SmsInboxClient, sleep } = require('../src/sms-inbox-client');
const { stateMonth, isFinalRetryDay, beijingParts } = require('../src/retry-date');
const { estimateSliderDistanceWithVision } = require('../src/slider-vision');
const { evaluateSliderImageMatch } = require('../src/slider-local-match');

function loadChromium() {
  const { chromium } = require('playwright');
  return { chromium, driver: 'playwright' };
}


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

function screenshotDir() {
  return process.env.CLAIM_SCREENSHOT_DIR || 'artifacts/claim-debug';
}

function ensureScreenshotDir() {
  const dir = screenshotDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function captureDebugScreenshot(page, label) {
  if (!page) return null;
  try {
    const dir = ensureScreenshotDir();
    const safe = String(label).replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').slice(0, 80);
    const file = path.join(dir, `${Date.now()}-${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log('Saved failure screenshot', { path: file });
    return file;
  } catch (err) {
    log('Failed to save screenshot', { label, error: err.message });
    return null;
  }
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
  if (/getSliderChallenge HTTP 400/i.test(text)) return false;
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
    /proxy/i,
  ].some(pattern => pattern.test(text));
}

function isTelecomWafRejection(err) {
  return /Telecom slider challenge rejected|getSliderChallenge HTTP 400/i.test(err?.message || '');
}

async function actionDelay(config) {
  const delayMs = Number(config?.actionDelayMs || 0);
  if (delayMs > 0) await sleep(delayMs);
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

function hasProxyTunnelFailures(page) {
  return /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/i.test(JSON.stringify(page.__telecomDiagnostics || []));
}

function isBlankSliderChallengeRejection(info, page) {
  return /获取验证码失败，请重试/.test(info?.message || '')
    && /getSliderChallenge/i.test(JSON.stringify(page.__telecomDiagnostics || []))
    && /"status":400/.test(JSON.stringify(page.__telecomDiagnostics || []));
}

async function launchBrowser(config) {
  const { chromium: playwrightChromium, driver } = loadChromium();
  if (config.browserCdpUrl) {
    const browser = await playwrightChromium.connectOverCDP(config.browserCdpUrl);
    log('Browser connected over CDP (real Chrome)', {
      url: config.browserCdpUrl,
      contexts: browser.contexts().length,
      version: browser.version(),
      driver,
    });
    return browser;
  }
  if (config.requireRealChrome) {
    throw new Error(
      'TELECOM_REQUIRE_REAL_CHROME is set but BROWSER_CDP_URL is empty. '
      + 'Start real Chrome first: bash scripts/start-chrome-cdp.sh (Mac) '
      + 'or bash scripts/start-chrome-cdp-linux.sh (Linux/CI), then export BROWSER_CDP_URL=http://127.0.0.1:9222',
    );
  }
  const chromium = config.stealthMode && driver === 'playwright'
    ? getStealthChromium(true)
    : playwrightChromium;
  const options = {
    headless: config.headless,
    args: chromeLaunchArgs(),
    ...playwrightLaunchExtras(),
  };
  if (config.openwrtProxy) {
    const label = config.proxyPoolProxy && config.openwrtProxy === config.proxyPoolProxy ? 'proxy pool' : 'configured proxy';
    log(`Launching browser through ${label}`, { proxy: maskProxyUrl(config.openwrtProxy), driver });
    await verifyProxyPath(config.openwrtProxy, process.env.PROXY_HEALTH_URL || 'https://wapbj.189.cn/');
    options.proxy = buildProxyOptions(config.openwrtProxy);
  } else {
    log('Launching browser without OPENWRT_HTTP_PROXY', { driver });
  }
  if (config.browserChannel && config.browserChannel !== 'bundled') options.channel = config.browserChannel;
  try {
    const browser = await chromium.launch(options);
    log('Browser launched', {
      version: browser.version(),
      channel: options.channel || 'bundled',
      stealth: config.stealthMode,
      driver,
    });
    return browser;
  } catch (err) {
    if (!options.channel) throw err;
    log(`Browser channel ${options.channel} unavailable, falling back to bundled chromium`, { driver });
    delete options.channel;
    const browser = await chromium.launch(options);
    log('Browser launched', { version: browser.version(), channel: 'bundled', stealth: config.stealthMode, driver });
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

async function verifyProxyPath(proxyUrl, healthUrl = 'https://wapbj.189.cn/') {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFileAsync = promisify(execFile);
  const probes = await Promise.all(Array.from({ length: 5 }, async () => {
    try {
      const { stdout } = await execFileAsync('curl', [
        '-sS', '--connect-timeout', '8', '--max-time', '20',
        '--proxy', proxyUrl, '-o', '/dev/null', '-w', '%{http_code}', healthUrl,
      ]);
      return stdout.trim();
    } catch {
      return 'fail';
    }
  }));
  const ok = probes.filter(code => code && code !== 'fail' && code !== '000').length;
  log('Proxy preflight probes', { ok, total: probes.length, codes: probes });
  if (ok < 3) throw new Error(`Proxy preflight failed (${ok}/5 probes succeeded)`);
}

async function installTelecomPagePatches(context) {
  await context.addInitScript(() => {
    const patchUni = () => {
      const uni = window.uni || {};
      const noop = () => {};
      uni.postMessage = uni.postMessage || noop;
      uni.navigateTo = uni.navigateTo || noop;
      uni.redirectTo = uni.redirectTo || noop;
      uni.getEnv = uni.getEnv || (callback => {
        if (typeof callback === 'function') callback({ plus: false, h5: true });
      });
      uni.webView = uni.webView || { postMessage: noop, navigateTo: noop };
      window.uni = uni;
    };
    patchUni();
    document.addEventListener('DOMContentLoaded', patchUni);
    window.addEventListener('load', patchUni);
  });
}

function attachBrokenUniRouteGuard(page) {
  return page.route('**/*', route => {
    const url = route.request().url();
    if (/wapbj\.189\.cnundefined|\/undefined(?:\?|$)/i.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
}

function attachSliderApiCapture(page) {
  page.on('response', response => {
    if (!/getSliderChallenge|validSlider|sendRandByUnlog|sendRandProtocolV3/i.test(response.url())) return;
    response.text().then(body => {
      let data = null;
      try { data = JSON.parse(body); } catch {}
      if (/getSliderChallenge/i.test(response.url()) && data?.object?.token) {
        page.__sliderChallenge = {
          token: data.object.token,
          imageWidth: data.object.imageWidth,
          imageHeight: data.object.imageHeight,
          blockWidth: data.object.blockWidth,
          blockHeight: data.object.blockHeight,
          correctY: data.object.correctY,
          status: response.status(),
          at: new Date().toISOString(),
        };
      }
      if (/validSlider/i.test(response.url())) {
        page.__sliderValid = {
          status: response.status(),
          retCode: data?.retCode,
          retMsg: data?.retMsg,
          at: new Date().toISOString(),
        };
      }
    }).catch(() => {});
  });
}

function attachPageDiagnostics(page) {
  attachSliderApiCapture(page);
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) rememberPageDiagnostic(page, { type: `console:${msg.type()}`, text: msg.text().slice(0, 300) });
  });
  page.on('pageerror', err => rememberPageDiagnostic(page, { type: 'pageerror', text: err.message.slice(0, 300) }));
  page.on('requestfailed', request => {
    if (/wapbj\.189\.cn/i.test(request.url())) rememberPageDiagnostic(page, { type: 'requestfailed', url: request.url(), error: request.failure()?.errorText || '' });
  });
  page.on('response', response => {
    if (!/wapbj\.189\.cn/i.test(response.url())) return;
    if (response.status() < 400 && !/preActiveMeta|getSliderChallenge|validSlider|sendRandProtocolV3|sendRandByUnlog/i.test(response.url())) return;
    const entry = { type: 'response', url: response.url(), status: response.status() };
    rememberPageDiagnostic(page, entry);
    if (!/preActiveMeta|getSliderChallenge|validSlider|sendRandProtocolV3|sendRandByUnlog/i.test(response.url())) return;
    response.text()
      .then(body => rememberPageDiagnostic(page, { ...entry, body: mask(body).slice(0, 300) }))
      .catch(() => {});
  });
}

async function attachSliderSubmitHook(page) {
  // Patch telecom slider_check.js so we can call the same submitVerify() path as a real
  // drag-end (ajaxUtil + closed-over challenge/scale), without injecting mouse events.
  await page.route(/\/apps\/serviceapps\/slider_check\/js\/index\.js/i, async route => {
    try {
      const response = await route.fetch();
      let body = await response.text();
      if (!body.includes('window.__telecomSubmitSlider') && body.includes('function submitVerify')) {
        body = body.replace(
          /window\.sliderVerify\s*=\s*sliderVerify\s*;/,
          [
            'window.sliderVerify = sliderVerify;',
            'window.__telecomSubmitSlider = function (naturalDistance) {',
            '  if (!challenge) return { ok: false, reason: "no-challenge" };',
            '  var dist = Math.round(Number(naturalDistance) || 0);',
            '  if (!(dist > 0)) return { ok: false, reason: "bad-distance" };',
            '  sliderLeft = Math.max(0, Math.min(maxSliderMove, dist * scale));',
            '  updateSliderUI();',
            '  submitVerify();',
            '  return { ok: true, sliderLeft: sliderLeft, scale: scale, natural: dist };',
            '};',
          ].join('\n'),
        );
        log('Patched slider_check.js with __telecomSubmitSlider hook');
      }
      await route.fulfill({
        status: response.status(),
        headers: {
          ...response.headers(),
          'content-type': response.headers()['content-type'] || 'application/javascript; charset=utf-8',
        },
        body,
      });
    } catch (err) {
      log('slider_check.js patch failed; continuing original', { error: err.message });
      await route.continue().catch(() => {});
    }
  });
}

async function openCdpClaimPage(browser, config = {}) {
  const context = browser.contexts()?.[0];
  if (!context) throw new Error('CDP browser has no default context');
  // Minimal CDP path: no initScript / uni patches / forced mobile viewport.
  // Still: capture slider tokens + patch slider_check.js for native submitVerify.
  if (!config.minimalLogin) {
    await installTelecomPagePatches(context);
  }
  const page = await context.newPage();
  await attachSliderSubmitHook(page);
  if (!config.minimalLogin) {
    await page.setViewportSize({ width: 390, height: 844 }).catch(() => {});
    await attachBrokenUniRouteGuard(page);
    attachPageDiagnostics(page);
  } else {
    attachSliderApiCapture(page);
  }
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(45000);
  log('Opened CDP page on default Chrome context', {
    contexts: browser.contexts().length,
    viewport: page.viewportSize(),
    minimalLogin: !!config.minimalLogin,
    patches: !config.minimalLogin,
  });
  return { context, page };
}

async function newMobilePage(browser, config = {}) {
  if (config.browserCdpUrl) return openCdpClaimPage(browser, config);

  const context = await browser.newContext(mobileContextOptions(browser.version()));
  await installTelecomPagePatches(context);
  const page = await context.newPage();
  await attachBrokenUniRouteGuard(page);
  if (config.blockHeavyAssets) {
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      const url = route.request().url();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      if (/dcs_new\.gif|selfwapimage\/|\.(?:png|jpe?g|gif|webp|svg)(?:\?|$)/i.test(url)) return route.abort();
      return route.continue();
    });
  }
  attachPageDiagnostics(page);
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
  '.checknum-button.slider-sms-btn',
  '.checknum-button',
  '.slider-sms-btn',
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

const LOGIN_PHONE_SELECTORS = [
  '#phoneNumber',
  'input.phonenum',
  'input[type="tel"]',
  'input[placeholder*="手机号码"]',
  'input[placeholder*="手机号"]',
  'input.van-field__control',
];
const LOGIN_CODE_SELECTORS = [
  '#code',
  'input.checknum-input',
  'input[placeholder*="短信验证码"]',
  'input[placeholder*="验证码"]',
];
const LOGIN_SUBMIT_SELECTORS = [
  '.know-box.button',
  'button:has-text("立即领取")',
  'div:has-text("立即领取")',
  'button:has-text("立即办理")',
  'div:has-text("立即办理")',
];

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

async function detectLoginFormState(page) {
  return page.evaluate(({ phoneSelectors, codeSelectors, sendSelectors }) => {
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.width > 0
        && rect.height > 0;
    };
    const firstVisible = selectors => {
      for (const selector of selectors) {
        const match = Array.from(document.querySelectorAll(selector)).find(visible);
        if (match) {
          return {
            selector,
            placeholder: match.getAttribute('placeholder') || '',
            type: match.getAttribute('type') || '',
          };
        }
      }
      return null;
    };
    const phone = firstVisible(phoneSelectors);
    const code = firstVisible(codeSelectors);
    const send = firstVisible(sendSelectors);
    return {
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      bodyLength: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
      title: document.title || '',
      formReady: !!phone,
      hasPhone: !!phone,
      hasCode: !!code,
      hasSendBtn: !!send,
      phone,
      code,
      send,
    };
  }, {
    phoneSelectors: LOGIN_PHONE_SELECTORS,
    codeSelectors: LOGIN_CODE_SELECTORS,
    sendSelectors: LOGIN_SMS_SEND_SELECTORS,
  }).catch(() => ({
    htmlLength: 0,
    bodyLength: 0,
    title: '',
    formReady: false,
    hasPhone: false,
    hasCode: false,
    hasSendBtn: false,
    phone: null,
    code: null,
    send: null,
  }));
}

async function ensureSmsLoginForm(page, config) {
  const smsFormWaitMs = Math.max(Number(config?.actionDelayMs || 0) * 2, 12000);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let phoneField = await firstVisibleLocator(page, LOGIN_PHONE_SELECTORS);
    if (phoneField) return phoneField;

    const smsLogin = page.getByText('短信验证码登录', { exact: true });
    if (await smsLogin.isVisible().catch(() => false)) {
      await actionDelay(config);
      await smsLogin.click({ force: true });
      log('Clicked SMS login tab', { strategy: 'text', attempt });
      phoneField = await waitForVisibleLocator(page, LOGIN_PHONE_SELECTORS, smsFormWaitMs);
      if (phoneField) return phoneField;
      const domTarget = await activateSmsLoginByDom(page).catch(() => null);
      if (domTarget) log('Clicked SMS login tab', { strategy: 'dom', attempt, target: domTarget });
      await sleep(800);
    }

    phoneField = await waitForVisibleLocator(page, LOGIN_PHONE_SELECTORS, smsFormWaitMs);
    if (phoneField) return phoneField;

    if (hasProxyTunnelFailures(page) && attempt < 3) {
      log('SMS login form not ready after proxy tunnel failures; reloading login entry', { attempt });
      await gotoLoginEntryPage(page, config, `sms-form-proxy-retry-${attempt}`);
      continue;
    }
  }

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


async function humanType(locator, value) {
  await locator.click({ timeout: 8000 }).catch(() => {});
  await locator.fill('').catch(() => {});
  for (const ch of String(value)) {
    await locator.type(ch, { delay: 60 + Math.floor(Math.random() * 90) });
  }
}

async function fillInputField(locator, value) {
  try {
    await humanType(locator, value);
  } catch (err) {
    if (!/not visible|Timeout/i.test(err?.message || '')) throw err;
    await locator.evaluate((el, nextValue) => {
      el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
}

async function humanPause(minMs = 800, maxMs = 1800) {
  await sleep(minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs)));
}

function isSliderBusyMessage(info, page) {
  const text = `${info?.message || ''}\n${JSON.stringify(page.__telecomDiagnostics || [])}`;
  return /服务繁忙|请稍后再试/i.test(text);
}

async function waitForSliderPuzzleAssets(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const visible = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
      const msg = document.querySelector('#slider_check_msg,.slider-check-msg,.puzzle-msg')?.innerText?.trim() || '';
      const bg = document.querySelector('#slider_bg_image');
      const block = document.querySelector('#slider_block_image');
      const canvas = Array.from(document.querySelectorAll('canvas')).find(e => visible(e) && e.width >= 100 && e.height >= 50);
      const track = document.querySelector('#slider_track_btn,.slider-btn');
      const hasBg = !!(bg && visible(bg) && bg.complete && (bg.naturalWidth || 0) > 40);
      const hasBlock = !!(block && visible(block) && block.complete && (block.naturalWidth || 0) > 10);
      const hasCanvas = !!canvas;
      const imagesReady = (hasBg && hasBlock) || hasCanvas;
      // "服务繁忙" on the msg node is also shown after a failed validSlider while images
      // are still on screen — only treat as challenge-busy when images are missing.
      const busyText = /服务繁忙|请稍后再试/.test(msg);
      return {
        busy: busyText && !imagesReady,
        message: msg,
        hasBg,
        hasBlock,
        hasCanvas,
        hasTrack: !!(track && visible(track)),
        imagesReady,
        busyText,
      };
    }).catch(() => ({ busy: false, hasBg: false, hasBlock: false, hasCanvas: false, hasTrack: false, imagesReady: false }));
    if (state.busy) return { ready: false, busy: true, ...state };
    if (state.imagesReady || (state.hasBg && state.hasBlock) || state.hasCanvas) {
      return { ready: true, busy: false, ...state };
    }
    await sleep(400);
  }
  return { ready: false, busy: false };
}

async function sendLoginSmsViaBackend(page, config) {
  const result = await page.evaluate(async phone => {
    const response = await fetch('/wap2017/re/sms/sendRandByUnlog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ accNo: phone, validType: 'SLIDER' }),
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, ok: response.ok, data, body: text.slice(0, 300) };
  }, config.phone);
  log('Direct login SMS backend response', result);
  const retCode = String(result.data?.retCode ?? '');
  const apiResult = String(result.data?.result ?? '');
  if (result.ok && (apiResult === '0' || retCode === '000000' || retCode === '0001')) return true;
  return false;
}

async function warmupTelecomBehavior(page, config) {
  await page.waitForFunction(() => {
    const scripts = Array.from(document.scripts || []).map(s => s.src || '');
    return scripts.some(src => /chinatelecom\.min\.js|autotrack\.js|setview|logget/i.test(src));
  }, { timeout: 20000 }).catch(() => {});
  await page.evaluate(() => {
    window.scrollTo(0, Math.min(240, document.body?.scrollHeight || 240));
  }).catch(() => {});
  await humanPause(600, 1200);
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await actionDelay(config);
}

async function warmTelecomOrigin(page, config) {
  const originWarmUrl = process.env.TELECOM_WARMUP_URL || 'https://wapbj.189.cn/';
  log('Warming telecom origin before claim entry', { url: originWarmUrl });
  await page.goto(originWarmUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
    log('Telecom origin warmup navigation failed', { error: err.message });
  });
  await humanPause(1500, 3000);
  await page.mouse.move(120 + Math.random() * 80, 180 + Math.random() * 60).catch(() => {});
  await humanPause(400, 900);
}

async function sendLoginCode(page, config) {
  if (config.minimalLogin) {
    // Bare path proven by scripts/verify-minimal-login-slider.js (getSliderChallenge 200 + images).
    const phone = page.locator('#phoneNumber, input.phonenum').first();
    await phone.waitFor({ state: 'visible', timeout: 15000 });
    await phone.click({ timeout: 8000 }).catch(() => {});
    await phone.fill(config.phone);
    await sleep(800);
    const sendBtn = page.locator('.checknum-button.slider-sms-btn, .checknum-button, .content_send_unlog').first();
    await sendBtn.click({ force: true });
    log('Clicked login SMS send button', { selector: 'minimal-login-direct' });
    if (await waitForSliderVerification(page, 10000)) {
      log('Login SMS send requires slider verification');
      const assets = await waitForSliderPuzzleAssets(page, 15000);
      log('Slider puzzle asset wait', assets);
      if (assets.busy) {
        throw new Error('Telecom slider challenge busy (服务繁忙); getSliderChallenge rejected before puzzle image');
      }
      if (!assets.ready) {
        throw new Error(`Telecom slider puzzle image missing after challenge${sliderFailureHint(page)}`);
      }
      await solvePuzzle(page, config, {
        async onChallengeRejected() { return false; },
      });
    }
    await sleep(3000);
    const closedDialogs = await closeDialogs(page);
    const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
    log('Login SMS send page summary', { closedDialogs, summary });
    return;
  }

  const phoneField = await ensureSmsLoginForm(page, config);
  await warmupTelecomBehavior(page, config);
  await humanPause(1800, 3200);
  await fillInputField(phoneField.locator, config.phone);
  await humanPause(1500, 2800);
  await page.mouse.move(200 + Math.random() * 40, 520 + Math.random() * 20).catch(() => {});
  await humanPause(400, 900);
  await clickLoginSmsButton(page, config);
  // Do not block on preActiveMeta before the click path has already fired; only observe after.
  await waitForTelecomApiReady(page, config, [/preActiveMeta/], 15000).catch(() => false);
  if (await waitForSliderVerification(page)) {
    log('Login SMS send requires slider verification');
    const challenge = await waitForSliderChallengeLoad(page, 15000);
    if (!challenge.ok) log('Slider challenge prefetch not ready', challenge);
    const assets = await waitForSliderPuzzleAssets(page, 20000);
    log('Slider puzzle asset wait', assets);
    if (assets.busy) {
      throw new Error('Telecom slider challenge busy (服务繁忙); getSliderChallenge rejected before puzzle image');
    }
    if (!assets.ready) {
      throw new Error(`Telecom slider puzzle image missing after challenge${sliderFailureHint(page)}`);
    }
    try {
      await solvePuzzle(page, config, {
        // Minimal path: never retrigger send on 400 — that burns rate limits and never yields images.
        async onChallengeRejected() {
          await dismissSliderPopup(page);
          await humanPause(4000, 7000);
          if (config.openwrtProxy) {
            await verifyProxyPath(config.openwrtProxy, process.env.PROXY_HEALTH_URL || 'https://wapbj.189.cn/');
          }
          await clickLoginSmsButton(page, config);
          const ready = await waitForSliderVerification(page, 10000);
          if (!ready) return false;
          const nextAssets = await waitForSliderPuzzleAssets(page, 15000);
          log('Slider puzzle asset wait after retrigger', nextAssets);
          return !!(nextAssets.ready && !nextAssets.busy);
        },
      });
    } catch (err) {
      if (!/getSliderChallenge HTTP 400|Telecom slider challenge rejected|slider puzzle image missing|slider challenge busy/i.test(err?.message || '')) throw err;
      log('Slider challenge API failed; trying direct login SMS backend call');
      if (!await sendLoginSmsViaBackend(page, config)) throw err;
    }
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
  // June baseline: go straight to entry. Origin warmup / cache-bust reloads look more automated
  // and can burn WAF sessions before the slider challenge is even requested.
  if (!config.skipOriginWarmup && !config.minimalLogin && (/attempt-1$/i.test(reason) || reason === 'entry')) {
    await warmTelecomOrigin(page, config);
  }
  const candidates = [{ label: 'entry', url: config.entryUrl }];
  if (!config.minimalLogin && /retry|attempt-[2-9]|cache-bust/i.test(reason)) {
    candidates.push({ label: 'entry-cache-bust', url: withCacheBuster(config.entryUrl) });
  }
  for (const candidate of candidates) {
    if (config.minimalLogin) {
      // Exact timing from scripts/verify-minimal-login-slider.js (proven getSliderChallenge 200).
      const response = await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(err => {
        rememberPageDiagnostic(page, { type: 'goto-error', url: candidate.url, error: err.message });
        return null;
      });
      const status = response?.status?.() || null;
      // 412 is normal for telecom WAF challenge pages that then rewrite to the form.
      // Extra settle after 412 avoids clicking send before the challenge session is ready.
      await sleep(status === 412 ? 12000 : 5000);
      const minimalDeadline = Date.now() + (status === 412 ? 25000 : 15000);
      let form = await detectLoginFormState(page);
      while (!form.hasPhone && Date.now() < minimalDeadline) {
        await sleep(500);
        form = await detectLoginFormState(page);
      }
      if (form.hasPhone) {
        log('Login entry ready', {
          reason,
          strategy: candidate.label,
          status,
          url: page.url(),
          minimalLogin: true,
          htmlLength: form.htmlLength,
          phone: form.phone,
          code: form.code,
          send: form.send,
        });
        return;
      }
      log('Minimal login entry still missing after settle', {
        reason,
        strategy: candidate.label,
        status,
        url: page.url(),
        htmlLength: form.htmlLength,
        bodyLength: form.bodyLength,
        phone: form.phone,
        code: form.code,
        send: form.send,
      });
      continue;
    }
    let entryTimeoutMs = hasProxyTunnelFailures(page) ? 8000 : 25000;
    const response = await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(err => {
      rememberPageDiagnostic(page, { type: 'goto-error', url: candidate.url, error: err.message });
      return null;
    });
    const waf = await waitForWafPageReady(page, 35000);
    if (!waf.ready) {
      log('WAF page still blank after initial wait', { reason, strategy: candidate.label, status: response?.status?.() || null, ...waf });
      await waitForWafPageReady(page, 20000);
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (await waitForLoginEntry(page, entryTimeoutMs)) {
      log('Login entry ready', { reason, strategy: candidate.label, status: response?.status?.() || null, url: page.url() });
      return;
    }
    const summary = await getPageSummary(page).catch(err => ({ error: err.message }));
    log('Login entry phone field missing; waiting without reload', { reason, strategy: candidate.label, status: response?.status?.() || null, summary });
    await waitForWafPageReady(page, 20000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (await waitForLoginEntry(page, 20000)) {
      log('Login entry ready after WAF wait', { reason, strategy: candidate.label, url: page.url() });
      return;
    }
  }
  const diagnosticsText = JSON.stringify(page.__telecomDiagnostics || []);
  const proxyHint = /ERR_TUNNEL_CONNECTION_FAILED/i.test(diagnosticsText)
    ? '; ERR_TUNNEL_CONNECTION_FAILED while loading login entry resources'
    : '';
  throw new Error(`Login entry phone field not visible after entry retries${proxyHint}`);
}

async function resetLoginEntryPage(page) {
  await page.locator('.slider-check-close,.puzzle-close').first().click({ force: true }).catch(() => {});
}

function isRetryableLoginSendError(err) {
  const message = err?.message || '';
  if (/Proxy tunnel failed during slider challenge/i.test(message)) return true;
  if (/getSliderChallenge HTTP 400|Telecom slider challenge rejected|slider puzzle image missing|slider challenge busy/i.test(message)) return true;
  if (/preActiveMeta warmup failed|Proxy tunnel failed during telecom API warmup/i.test(message)) return true;
  if (/Login phone field not found|Login entry phone field not visible|#phoneNumber|element is not visible/.test(message)) return true;
  if (isProxyPathError(err)) return false;
  return /Slider verification (failed|service busy)/.test(message);
}

async function dismissSliderPopup(page) {
  await page.locator('.puzzle-close,.slider-check-close,#secondPop_puzzle_check .close').first().click({ force: true }).catch(() => {});
  await sleep(800);
}

async function waitForSliderChallengeLoad(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.__sliderChallenge?.token) {
      return { ok: true, status: page.__sliderChallenge.status || 200, challenge: page.__sliderChallenge };
    }
    const challenge = (page.__telecomDiagnostics || []).filter(d => /getSliderChallenge/i.test(d.url || '')).pop();
    if (challenge) {
      return challenge.status < 400
        ? { ok: true, status: challenge.status }
        : { ok: false, status: challenge.status, body: challenge.body || '' };
    }
    await sleep(300);
  }
  return { ok: false, reason: 'timeout' };
}

async function waitForSliderChallengeToken(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (page.__sliderChallenge?.token) return page.__sliderChallenge;
    await sleep(200);
  }
  return null;
}

/**
 * Pass slider via the page's own submitVerify path (same as drag-end).
 * Falls back to ajaxUtil.postJson only if the hook was not installed.
 * No mouse injection.
 */
async function submitSliderViaApi(page, config, sliderDistance) {
  const challenge = await waitForSliderChallengeToken(page, 5000);
  const token = challenge?.token;
  if (!token) {
    return { ok: false, reason: 'missing-challenge-token' };
  }
  const distance = String(Math.round(Number(sliderDistance)));
  log('Submitting slider via native submitVerify / validSlider', {
    tokenPrefix: `${token.slice(0, 6)}…`,
    sliderDistance: distance,
    imageWidth: challenge.imageWidth,
    blockWidth: challenge.blockWidth,
  });

  const validResponsePromise = page.waitForResponse(
    r => /\/wapFree\/rand\/validSlider/i.test(r.url()),
    { timeout: 15000 },
  ).catch(() => null);
  const smsResponsePromise = page.waitForResponse(
    r => /\/re\/sms\/sendRand|sendRandByUnlog|sendRandProtocolV3/i.test(r.url()),
    { timeout: 20000 },
  ).catch(() => null);

  const hookResult = await page.evaluate(async ({ naturalDistance, phone }) => {
    const isApiSuccess = res => !!res && (
      res.retCode === '0' || res.retCode === '000000'
      || res.result === 0 || res.result === '0'
    );

    // Preferred: patched slider_check.js hook → same submitVerify as human drag-end.
    if (typeof window.__telecomSubmitSlider === 'function') {
      const started = window.__telecomSubmitSlider(naturalDistance);
      if (!started?.ok) return { transport: 'hook', hook: started, validOk: false };

      const validRes = await new Promise(resolve => {
        const deadline = Date.now() + 12000;
        const tick = () => {
          const msg = document.querySelector('#slider_check_msg,.slider-check-msg')?.innerText?.trim() || '';
          const sliderEl = document.querySelector('#slider_check,.slider-check-box');
          const visible = (() => {
            if (!sliderEl) return false;
            const s = getComputedStyle(sliderEl);
            const r = sliderEl.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          })();
          if (/验证成功/.test(msg) || (!visible && Date.now() > deadline - 10000)) {
            resolve({ retCode: '000000', retMsg: msg || '验证成功' });
            return;
          }
          if (/验证失败|服务繁忙|请稍后再试|获取验证码失败/.test(msg)) {
            resolve({ retCode: 'fail', retMsg: msg });
            return;
          }
          if (Date.now() > deadline) {
            resolve({ retCode: 'timeout', retMsg: msg || 'validSlider wait timeout' });
            return;
          }
          setTimeout(tick, 200);
        };
        setTimeout(tick, 300);
      });

      if (!isApiSuccess(validRes) && !/验证成功/.test(validRes?.retMsg || '')) {
        return { transport: 'hook', hook: started, validOk: false, validRes, smsRes: null };
      }

      // submitVerify success already schedules sendSmsWithSlider via sliderVerify.show callback.
      // Wait briefly for SMS API / dialog.
      const smsRes = await new Promise(resolve => {
        const deadline = Date.now() + 15000;
        const tick = () => {
          const text = document.body?.innerText || '';
          if (/验证码已下发|请注意查收/.test(text)) {
            resolve({ ok: true, data: { retMsg: '验证码已下发' } });
            return;
          }
          if (Date.now() > deadline) {
            resolve({ ok: false, timeout: true });
            return;
          }
          setTimeout(tick, 300);
        };
        setTimeout(tick, 500);
      });
      return { transport: 'hook', hook: started, validOk: true, validRes, smsRes };
    }

    // Fallback: ajaxUtil directly (may be WAF-sensitive vs native submitVerify).
    if (typeof window.require !== 'function') {
      return { transport: 'none', validOk: false, validRes: { retMsg: 'no hook and no require' } };
    }
    const ajaxUtil = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ajaxutil load timeout')), 10000);
      try {
        window.require(['ajaxutil'], u => { clearTimeout(t); resolve(u); }, e => { clearTimeout(t); reject(e); });
      } catch (err) {
        clearTimeout(t);
        reject(err);
      }
    });
    const validRes = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('validSlider timeout')), 15000);
      ajaxUtil.postJson('/wap2017/re/wapFree/rand/validSlider', res => {
        clearTimeout(t);
        resolve(res);
      }, { token: window.__sliderTokenUnused, sliderDistance: String(naturalDistance) });
    }).catch(err => ({ retCode: 'err', retMsg: String(err?.message || err) }));

    // Note: fallback without token from closure is incomplete — hook path is required.
    return { transport: 'ajaxutil-fallback-incomplete', validOk: false, validRes, phone };
  }, { naturalDistance: Number(distance), phone: config.phone }).catch(err => ({
    transport: 'evaluate-error',
    validOk: false,
    validRes: { retMsg: err.message },
  }));

  // If hook missing (script already cached before route), fall back to ajaxUtil with token.
  let result = hookResult;
  if (!result?.validOk && result?.transport !== 'hook') {
    result = await page.evaluate(async ({ token: tok, sliderDistance: dist, phone }) => {
      const isApiSuccess = res => !!res && (
        res.retCode === '0' || res.retCode === '000000'
        || res.result === 0 || res.result === '0'
      );
      if (typeof window.require !== 'function') {
        return { transport: 'none', validOk: false, validRes: { retMsg: 'AMD require unavailable' } };
      }
      const ajaxUtil = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('ajaxutil load timeout')), 10000);
        window.require(['ajaxutil'], u => { clearTimeout(t); resolve(u); }, e => { clearTimeout(t); reject(e); });
      });
      const validRes = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('validSlider timeout')), 15000);
        try {
          ajaxUtil.postJson('/wap2017/re/wapFree/rand/validSlider', res => {
            clearTimeout(t);
            resolve(res);
          }, { token: tok, sliderDistance: dist });
        } catch (err) {
          clearTimeout(t);
          reject(err);
        }
      }).catch(err => ({ retCode: 'err', retMsg: String(err?.message || err) }));
      if (!isApiSuccess(validRes)) return { transport: 'ajaxutil', validOk: false, validRes, smsRes: null };
      if (typeof window.sliderVerify?.hide === 'function') {
        try { window.sliderVerify.hide(); } catch {}
      }
      const smsRes = await new Promise(resolve => {
        if (typeof window.sendSmsWithSlider === 'function') {
          window.sendSmsWithSlider(phone, {
            onSuccess: data => resolve({ ok: true, data }),
            onFail: data => resolve({ ok: false, data }),
          });
          setTimeout(() => resolve({ ok: false, timeout: true }), 18000);
          return;
        }
        resolve({ ok: false, error: 'sendSmsWithSlider missing' });
      });
      return { transport: 'ajaxutil', validOk: true, validRes, smsRes };
    }, { token, sliderDistance: distance, phone: config.phone });
  }

  const validResponse = await validResponsePromise;
  let validNetBody = '';
  if (validResponse) {
    const vUrl = validResponse.url();
    validNetBody = await validResponse.text().catch(() => '');
    log('validSlider network response', {
      status: validResponse.status(),
      hasWafQuery: /[?&]fQbHda09=/i.test(vUrl),
      urlTail: vUrl.slice(-80),
      body: validNetBody.slice(0, 160),
    });
  } else {
    log('validSlider network response missing', {
      transport: result?.transport,
      hook: result?.hook,
    });
  }

  const smsResponse = await smsResponsePromise;
  let smsBody = '';
  if (smsResponse) {
    smsBody = await smsResponse.text().catch(() => '');
    log('SMS send after validSlider', { status: smsResponse.status(), body: smsBody.slice(0, 160) });
  }

  // Prefer network truth over DOM polling.
  let validOk = !!result?.validOk;
  if (validResponse) {
    if (validResponse.ok() && /"retCode"\s*:\s*"000000"|验证成功/.test(validNetBody)) validOk = true;
    if (validResponse.status() >= 400) validOk = false;
  }

  log('validSlider API result', {
    validOk,
    validMsg: result?.validRes?.retMsg,
    smsOk: result?.smsRes?.ok,
    transport: result?.transport,
    hook: result?.hook,
  });

  if (!validOk) {
    return {
      ok: false,
      reason: result?.transport === 'none' ? 'ajaxutil-unavailable' : 'validSlider-failed',
      retMsg: result?.validRes?.retMsg || page.__sliderValid?.retMsg || '',
      result,
    };
  }

  const smsOk = !!(
    result?.smsRes?.ok
    || (smsResponse?.ok() && /"retCode"\s*:\s*"000000"|"result"\s*:\s*0/.test(smsBody))
  );
  return { ok: smsOk || validOk, validOk: true, smsOk, result, smsBody };
}

async function dragSliderByMouse(page, sliderDistance) {
  const dragInfo = await page.evaluate((naturalX) => {
    const visible = e => !!e && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    const bg = document.querySelector('#slider_bg_image');
    const block = document.querySelector('#slider_block_image');
    const btn = document.querySelector('#slider_track_btn, .slider-btn, .slider');
    if (!bg || !block || !btn || !visible(bg) || !visible(block) || !visible(btn)) return null;
    const bgRect = bg.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const scale = bgRect.width / (bg.naturalWidth || bgRect.width);
    const moveX = Math.max(0, Math.round(Number(naturalX) * scale));
    return {
      moveX,
      sx: btnRect.x + btnRect.width / 2,
      sy: btnRect.y + btnRect.height / 2,
      scale,
    };
  }, Number(sliderDistance)).catch(() => null);
  if (!dragInfo || !Number.isFinite(dragInfo.moveX) || dragInfo.moveX <= 0) {
    return { ok: false, reason: 'drag-info-missing' };
  }

  log('Dragging slider with mouse fallback', dragInfo);
  const smsPromise = page.waitForResponse(r => /sendRand/i.test(r.url()), { timeout: 20000 }).catch(() => null);
  await page.mouse.move(dragInfo.sx, dragInfo.sy).catch(() => {});
  await page.waitForTimeout(300);
  await page.mouse.down().catch(() => {});
  const steps = 50;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ease = 1 - Math.pow(1 - t, 2.4);
    await page.mouse.move(dragInfo.sx + dragInfo.moveX * ease, dragInfo.sy + Math.sin(t * Math.PI * 3) * 2).catch(() => {});
    await page.waitForTimeout(24 + (i % 5) * 8).catch(() => {});
  }
  await page.mouse.up().catch(() => {});
  const smsResp = await smsPromise;
  const smsBody = smsResp ? await smsResp.text().catch(() => '') : '';
  const body = await visibleText(page).catch(() => '');
  const ok = !!(smsResp && smsResp.ok() && /000000|验证码已下发|请注意查收/.test(`${smsBody}${body}`));
  return { ok, smsStatus: smsResp?.status?.() ?? null, smsBody: smsBody.slice(0, 160), body: body.slice(0, 160) };
}

function latestTelecomApiResponse(page, pattern) {
  return (page.__telecomDiagnostics || [])
    .filter(d => d.type === 'response' && pattern.test(d.url || ''))
    .pop();
}

async function readPageRenderState(page) {
  try {
    return await detectLoginFormState(page);
  } catch {
    return { htmlLength: 0, bodyLength: 0, title: '', formReady: false, navigating: true };
  }
}

async function waitForWafPageReady(page, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  let last = { htmlLength: 0, bodyLength: 0, title: '', formReady: false };
  while (Date.now() < deadline) {
    last = await readPageRenderState(page);
    if (last.navigating) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await sleep(800);
      continue;
    }
    if (last.formReady || (last.htmlLength > 3000 && last.bodyLength > 20)) {
      return { ready: true, ...last };
    }
    if (last.htmlLength < 500) {
      await sleep(1500);
      continue;
    }
    await sleep(800);
  }
  return { ready: false, ...last };
}

async function isBlankWafPage(page) {
  const htmlLength = await page.evaluate(() => document.documentElement?.outerHTML?.length || 0).catch(() => 0);
  return htmlLength < 500;
}

async function waitForTelecomApiReady(page, config, patterns = [/preActiveMeta/], timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasProxyTunnelFailures(page)) {
      throw new Error('Proxy tunnel failed during telecom API warmup');
    }
    if (await isBlankWafPage(page)) {
      log('Telecom login page is blank during API warmup');
      return false;
    }
    const results = patterns.map(pattern => latestTelecomApiResponse(page, pattern));
    if (results.some(hit => hit && hit.status >= 400)) {
      log('Telecom API warmup rejected', {
        apis: results.map(hit => ({ url: hit?.url, status: hit?.status })),
      });
      return false;
    }
    if (results.every(hit => hit && hit.status < 400)) return true;
    await sleep(500);
  }
  if (hasProxyTunnelFailures(page)) {
    throw new Error('Proxy tunnel failed during telecom API warmup');
  }
  if (await isBlankWafPage(page)) {
    log('Telecom login page is blank after API warmup wait');
    return false;
  }
  log('Telecom API warmup timed out without API responses; continuing cautiously');
  return false;
}

async function loginWithRetry(browser, page, smsInbox, config) {
  let activePage = page;
  for (let attempt = 1; attempt <= config.sendCodeAttempts; attempt += 1) {
    log(`Sending login SMS attempt ${attempt}/${config.sendCodeAttempts}`);
    const since = Date.now() - 10000;
    try {
      await gotoLoginEntryPage(activePage, config, `attempt-${attempt}`);
      await sendLoginCode(activePage, config);
    } catch (err) {
      const summary = await getPageSummary(activePage).catch(summaryErr => ({ error: summaryErr.message }));
      log('Login SMS send failed before code wait', { error: err.message, summary });
      await captureDebugScreenshot(activePage, `login-send-failed-attempt-${attempt}`);
      // Minimal/CDP path: slider 400 means WAF rejected this session — retrying immediately
      // almost never yields puzzle images and worsens 服务繁忙. Fail fast instead.
      if (config.minimalLogin && /getSliderChallenge HTTP 400|Telecom slider challenge rejected|slider puzzle image missing|slider challenge busy/i.test(err.message)) {
        throw err;
      }
      if (attempt < config.sendCodeAttempts && isRetryableLoginSendError(err)) {
        const waitMs = /Proxy tunnel failed|preActiveMeta warmup failed|Login phone field not found|Telecom slider challenge rejected|getSliderChallenge HTTP 400|slider puzzle image missing|slider challenge busy/i.test(err.message)
          ? 15000 + (attempt - 1) * 10000
          : 60000;
        await sleep(waitMs);
        if (config.browserCdpUrl) {
          await activePage.close().catch(() => {});
        } else {
          await activePage.context().close().catch(() => {});
        }
        ({ page: activePage } = await newMobilePage(browser, config));
        continue;
      }
      throw err;
    }
    const sms = await smsInbox.waitForCode({ stage: 'login', since, timeoutMs: config.smsTimeoutMs, pollMs: config.smsPollMs });
    if (!sms) {
      const summary = await getPageSummary(activePage).catch(err => ({ error: err.message }));
      log('Login SMS not received before timeout', summary);
      await captureDebugScreenshot(activePage, `login-sms-timeout-attempt-${attempt}`);
      continue;
    }
    const ok = await submitLoginCode(activePage, sms.code, config);
    if (ok) return activePage;
    const summary = await getPageSummary(activePage).catch(err => ({ error: err.message }));
    log('Login code rejected, retrying', summary);
    if (attempt < config.sendCodeAttempts) {
      await resetLoginEntryPage(activePage);
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
  const imageMatchResult = await evaluateSliderImageMatch(page).catch(() => ({ ok: false, reason: 'image-match-evaluate-failed' }));
  const imageMatch = imageMatchResult?.ok ? imageMatchResult : null;
  return page.evaluate((match) => {
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
      visible: visible(document.querySelector('#secondPop_puzzle_check'))
        || visible(document.querySelector('#slider_check,.slider-check-box'))
        || /安全验证|向右滑动滑块|滑动滑块/.test(document.body?.innerText || ''),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
      bbox,
      imageMatch: match,
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
  }, imageMatch);
}

async function solvePuzzle(page, config, options = {}) {
  if (config?.openwrtProxy) {
    await verifyProxyPath(config.openwrtProxy, process.env.PROXY_HEALTH_URL || 'https://wapbj.189.cn/');
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForFunction(() => {
      const visible = e => {
        if (!e) return false;
        const style = getComputedStyle(e);
        const rect = e.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      return /安全验证|向右滑动滑块|滑动滑块|服务繁忙/.test(document.body?.innerText || '')
        && (
          visible(document.querySelector('#secondPop_puzzle_check'))
          || visible(document.querySelector('#slider_check'))
          || visible(document.querySelector('.puzzle-verify-popup'))
          || visible(document.querySelector('.slider-check-box'))
          || visible(document.querySelector('.captcha-wrapper'))
          || visible(document.querySelector('.slider-track'))
          || visible(document.querySelector('.slider-btn'))
          || visible(document.querySelector('.sliderContainer'))
          || visible(document.querySelector('.slider'))
          || visible(document.querySelector('[class*="slider" i]'))
          || visible(document.querySelector('[id*="slider" i]'))
        );
    }, { timeout: 15000 });
    const assets = await waitForSliderPuzzleAssets(page, 12000);
    if (assets.busy || isSliderBusyMessage({ message: assets.message }, page)) {
      log('Slider challenge returned busy message', { attempt, assets });
      if (options.onChallengeRejected && attempt < 3) {
        const ready = await options.onChallengeRejected();
        if (ready) continue;
      }
      throw new Error('Telecom slider challenge busy (服务繁忙); getSliderChallenge rejected before puzzle image');
    }
    // Give the puzzle DOM a beat to paint before reading pixels.
    await sleep(config?.minimalLogin ? 2500 : 1200);
    const info = await transparentPuzzleInfo(page);
    const hasCanvasTarget = info.canvas && info.bbox;
    const hasImageTarget = info.imageMatch;
    const hasTrackFallback = info.slider && info.container && info.container.w > info.slider.w + 45;
    if (!info.visible || (!hasCanvasTarget && !hasImageTarget && !hasTrackFallback)) {
      log('Slider puzzle info incomplete', { attempt, info });
      if (isBlankSliderChallengeRejection(info, page)) {
        if (options.onChallengeRejected && attempt < 3) {
          log('Slider challenge rejected; retriggering SMS send', { attempt });
          const ready = await options.onChallengeRejected();
          if (ready) {
            await waitForSliderChallengeLoad(page);
            continue;
          }
        }
        if (hasProxyTunnelFailures(page)) {
          await captureDebugScreenshot(page, `slider-proxy-tunnel-attempt-${attempt}`);
          throw new Error(`Proxy tunnel failed during slider challenge${sliderFailureHint(page)}`);
        }
        await captureDebugScreenshot(page, `slider-telecom-400-attempt-${attempt}`);
        throw new Error(`Telecom slider challenge rejected with blank HTTP 400${sliderFailureHint(page)}`);
      }
      await page.locator('.refreshIcon,#slider_refresh_icon,.slider-refresh-icon').first().click({ force: true }).catch(() => {});
      await sleep(2000);
      continue;
    }

    const sliderMode = (config?.sliderMode || process.env.TELECOM_SLIDER_MODE || 'api').toLowerCase();
    if (!['api', 'mouse'].includes(sliderMode)) {
      log('Unsupported slider mode; forcing api (native submitVerify)', { sliderMode });
    }

    const maxNatural = info.imageMatch
      ? (info.imageMatch.bg.width - info.imageMatch.block.width + 10)
      : hasCanvasTarget
        ? info.canvas.width - 35
        : 240;
    const inRangeNatural = d => d != null && d >= 45 && d <= maxNatural;

    let naturalX = null;
    let matchSource = info.imageMatch?.method || (hasCanvasTarget ? 'canvas' : 'track');
    if (info.imageMatch?.naturalX != null) {
      naturalX = info.imageMatch.naturalX;
    } else if (hasCanvasTarget) {
      naturalX = Math.round(info.bbox.minx);
    } else if (hasTrackFallback) {
      naturalX = Math.round(info.container.w - info.slider.w - 4);
    }

    // Optional vision AI backup when local CV is weak / missing and TELECOM_VISION_URL is set.
    // Important: local hole methods are named "cream-edge" / "green-cream-edge";
    // they are primary signals, not weak fallbacks. Only plain "edge" / "texture" /
    // "fallback" should trigger vision backup by default.
    const localMethod = String(info.imageMatch?.method || '');
    const holeStrong = !!info.imageMatch?.hole?.ok;
    const edgeStrong = localMethod === 'edge'
      && Number(info.imageMatch?.edge?.score || 0) >= 80
      && Number(info.imageMatch?.edge?.points || 0) >= 20;
    const localMatchStrong = holeStrong || edgeStrong;
    const holeWeak = !localMatchStrong
      && (
        !info.imageMatch?.naturalX
        || /fallback|texture/i.test(localMethod)
        || localMethod === 'edge'
      );
    const forceVision = process.env.TELECOM_FORCE_VISION === 'true';
    if ((forceVision || holeWeak || !inRangeNatural(naturalX)) && process.env.TELECOM_VISION_URL) {
      const pngs = await page.evaluate(() => {
        const bg = document.querySelector('#slider_bg_image');
        const block = document.querySelector('#slider_block_image');
        if (!bg?.complete || !block?.complete) return null;
        const c1 = document.createElement('canvas');
        c1.width = bg.naturalWidth; c1.height = bg.naturalHeight;
        c1.getContext('2d').drawImage(bg, 0, 0);
        const c2 = document.createElement('canvas');
        c2.width = block.naturalWidth; c2.height = block.naturalHeight;
        c2.getContext('2d').drawImage(block, 0, 0);
        return { bg: c1.toDataURL('image/png'), block: c2.toDataURL('image/png') };
      }).catch(() => null);
      if (pngs?.bg) {
        const vision = await estimateSliderDistanceWithVision({
          bgPngBase64: pngs.bg,
          blockPngBase64: pngs.block,
          imageWidth: info.imageMatch?.bg?.width || 280,
          correctY: page.__sliderChallenge?.correctY ?? info.imageMatch?.hole?.y ?? null,
        });
        log('Vision slider estimate', vision);
        if (vision.ok && inRangeNatural(vision.naturalX)) {
          if (forceVision || !localMatchStrong || !inRangeNatural(naturalX)) {
            naturalX = vision.naturalX;
            matchSource = 'vision';
          } else {
            log('Keeping strong local slider match; vision stored as fallback only', {
              localMethod,
              localNaturalX: naturalX,
              visionNaturalX: vision.naturalX,
              holeOk: holeStrong,
              edgeScore: info.imageMatch?.edge?.score,
            });
          }
        }
      }
    }

    if (!inRangeNatural(naturalX)) {
      log('Slider puzzle target out of range', { attempt, naturalX, info: { imageMatch: info.imageMatch } });
      await page.locator('.refreshIcon,#slider_refresh_icon,.slider-refresh-icon').first().click({ force: true }).catch(() => {});
      await sleep(2000);
      continue;
    }

    const sliderAttemptSummary = {
      naturalX,
      matchSource,
      match: info.imageMatch ? {
        method: info.imageMatch.method,
        score: info.imageMatch.score,
        naturalX: info.imageMatch.naturalX,
        hole: info.imageMatch.hole,
        texture: info.imageMatch.texture,
        edge: info.imageMatch.edge,
      } : hasCanvasTarget ? { method: 'canvas-bbox' } : { method: 'track-end' },
    };

    if (sliderMode === 'mouse') {
      log(`Solving slider attempt ${attempt}/3`, { mode: 'mouse', ...sliderAttemptSummary });
      const mouseResult = await dragSliderByMouse(page, naturalX);
      if (mouseResult.ok) {
        log('Slider passed via mouse drag', { naturalX, ...mouseResult });
        return true;
      }
      log('Mouse slider solve failed', { naturalX, ...mouseResult });
    } else {
      log(`Solving slider attempt ${attempt}/3`, { mode: 'api', ...sliderAttemptSummary });

      const apiResult = await submitSliderViaApi(page, config, naturalX);
      if (apiResult.ok) {
        log('Slider passed via native submitVerify', {
          naturalX,
          smsOk: apiResult.smsOk,
        });
        return true;
      }
      log('validSlider rejected', { ...apiResult, naturalX });

      const mouseResult = await dragSliderByMouse(page, naturalX);
      if (mouseResult.ok) {
        log('Slider passed via mouse fallback', { naturalX, ...mouseResult });
        return true;
      }
      log('Mouse slider fallback failed', { naturalX, ...mouseResult });

      const outcome = await page.evaluate(() => {
        const text = [
          document.body?.innerText || '',
          ...Array.from(document.querySelectorAll('#wap-dialog,.wap-dialog,.diaog-popup,#dialog-box,.slider-check-msg'))
            .map(e => e.innerText || ''),
        ].join('\n');
        return {
          text: text.replace(/\s+/g, ' ').trim().slice(0, 300),
          smsSent: /验证码已下发|请注意查收/.test(text),
          busy: /服务繁忙|请稍后再试/.test(text),
          successMsg: /验证成功/.test(text),
        };
      }).catch(() => ({ text: '', smsSent: false, busy: false, successMsg: false }));
      log('Slider post-submit outcome', outcome);
      if (outcome.smsSent || outcome.successMsg) return true;
      if (outcome.busy || /服务繁忙|请稍后再试/.test(String(apiResult?.retMsg || ''))) {
        throw new Error('Telecom slider challenge busy (服务繁忙) after submit');
      }
      page.__sliderChallenge = null;
      await page.locator('.refreshIcon,#slider_refresh_icon,.slider-refresh-icon').first().click({ force: true }).catch(() => {});
      await sleep(2000);
    }
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
    await solvePuzzle(page, config);
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
  log('Slider mode', { sliderMode: config.sliderMode || 'api' });
  const smsInbox = new SmsInboxClient(config);
  const browser = await launchBrowser(config);
  let activePage = null;
  try {
    const { page } = await newMobilePage(browser, config);
    activePage = page;
    activePage = await loginWithRetry(browser, page, smsInbox, config);
    await choosePackage(activePage, config);
    const result = await confirmWithRetry(activePage, smsInbox, config);
    if (result === 'dry-run') return;
    if (!await waitForSuccess(activePage, 5000, config)) throw new Error('No success page after final submit');
    const summary = await getPageSummary(activePage);
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
  } catch (err) {
    await captureDebugScreenshot(activePage, 'claim-failed');
    throw err;
  } finally {
    if (config.browserCdpUrl) {
      // Keep the real Chrome process alive; only drop the Playwright connection.
      await activePage?.close().catch(() => {});
      await browser.close().catch(() => {});
    } else {
      await browser.close().catch(() => {});
    }
  }
}

async function runClaimWithOptionalDirectFallback(config) {
  try {
    await runClaim(config);
  } catch (err) {
    if (config.proxyPoolProxy && config.openwrtProxy && config.openwrtProxy !== config.proxyPoolProxy && isTelecomWafRejection(err)) {
      log('Telecom WAF rejected configured proxy path; retrying once through proxy pool', {
        configuredProxy: maskProxyUrl(config.openwrtProxy),
        proxyPool: maskProxyUrl(config.proxyPoolProxy),
        error: err.message,
      });
      await runClaim({ ...config, openwrtProxy: config.proxyPoolProxy });
      return;
    }
    if (config.allowDirectProxyFallback && config.openwrtProxy && isProxyPathError(err)) {
      log('Configured proxy path failed; retrying this run without OPENWRT_HTTP_PROXY', {
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
  LOGIN_PHONE_SELECTORS,
  LOGIN_SMS_SEND_SELECTORS,
  clickLoginSmsButton,
  detectLoginFormState,
  firstVisibleLocator,
  hasProxyTunnelFailures,
  isRetryableLoginSendError,
  isTelecomWafRejection,
  waitForTelecomApiReady,
};

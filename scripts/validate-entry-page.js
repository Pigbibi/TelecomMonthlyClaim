#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  applyCdpBrowserProfile,
  browserProfileContextOptions,
  chromeLaunchArgs,
  playwrightLaunchExtras,
} = require('../src/browser-stealth');

const entryUrl = process.env.TELECOM_ENTRY_URL;
if (!entryUrl) {
  console.error('Missing TELECOM_ENTRY_URL');
  process.exit(2);
}

const browserProfile = (process.env.TELECOM_BROWSER_PROFILE || 'wechat').toLowerCase();
const browserCdpUrl = process.env.BROWSER_CDP_URL || '';
const cdpProfileMode = (process.env.TELECOM_CDP_PROFILE_MODE || 'auto').toLowerCase();
const minimalLogin = process.env.TELECOM_MINIMAL_LOGIN === 'true';

async function readPageRenderState(page) {
  try {
    return await page.evaluate(() => ({
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      bodyLength: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
      title: document.title || '',
      navigating: false,
    }));
  } catch {
    return { htmlLength: 0, bodyLength: 0, title: '', navigating: true };
  }
}

async function waitForWafPageReady(page, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last = { htmlLength: 0, bodyLength: 0, title: '' };
  while (Date.now() < deadline) {
    last = await readPageRenderState(page);
    if (last.navigating) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      continue;
    }
    if (last.htmlLength > 3000 && last.bodyLength > 20) return { ready: true, ...last };
    await page.waitForTimeout(last.htmlLength < 500 ? 1500 : 800);
  }
  return { ready: false, ...last };
}

async function openClaimPage({ label, proxyServer }) {
  if (browserCdpUrl) {
    const browser = await chromium.connectOverCDP(browserCdpUrl);
    const context = browser.contexts()?.[0];
    if (!context) throw new Error('CDP browser has no default context');
    const page = await context.newPage();
    await applyCdpBrowserProfile(page, browser.version(), browserProfile, {
      mode: cdpProfileMode,
      minimalLogin,
    });
    return { browser, context, page, mode: 'cdp' };
  }

  const launchOptions = {
    headless: process.env.HEADLESS !== 'false',
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    args: chromeLaunchArgs({ mobile: browserProfile !== 'desktop' }),
    ...playwrightLaunchExtras(),
  };
  if (proxyServer) launchOptions.proxy = { server: proxyServer };

  const userDataDir = path.join(os.tmpdir(), `telecom-validate-${label}-${process.pid}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOptions,
    ...browserProfileContextOptions(browserProfile),
  });
  const page = context.pages()[0] || await context.newPage();
  return { browser: context, context, page, mode: 'persistent' };
}

async function validateEntry({ label, proxyServer }) {
  const { browser, context, page, mode } = await openClaimPage({ label, proxyServer });

  const response = await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const waf = await waitForWafPageReady(page, 45000);
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const html = await page.content();
  const body = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim());
  const phoneInputs = await page.locator(
    'input[type="tel"], input[placeholder*="手机"], #phone, input.van-field__control, input.checknum-input, #code',
  ).count();
  const screenshot = path.join('artifacts', 'claim-debug', `validate-entry-${label}.png`);
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });

  const whiteScreen = html.length < 500;
  const pass = !whiteScreen && html.length > 3000 && (body.length > 20 || phoneInputs > 0 || waf.ready);
  const result = {
    label,
    mode,
    browserProfile,
    proxy: proxyServer || 'direct',
    status: response?.status(),
    htmlLength: html.length,
    bodyPreview: body.slice(0, 120),
    phoneInputs,
    whiteScreen,
    wafReady: waf.ready,
    pass,
    screenshot,
  };
  console.log(JSON.stringify(result));
  await page.close().catch(() => {});
  if (mode !== 'cdp') await context.close();
  return pass;
}

(async () => {
  const cases = [{ label: 'direct', proxy: '' }];
  if (process.env.OPENWRT_HTTP_PROXY) {
    cases.push({ label: 'proxy', proxy: process.env.OPENWRT_HTTP_PROXY });
  } else if (process.env.VALIDATE_BWG_PROXY === 'true') {
    cases.push({ label: 'bwg', proxy: 'http://127.0.0.1:13128' });
  }

  let ok = true;
  for (const item of cases) {
    try {
      if (!(await validateEntry(item))) ok = false;
    } catch (err) {
      ok = false;
      console.log(JSON.stringify({ label: item.label, pass: false, error: err.message }));
    }
  }
  process.exit(ok ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(1);
});

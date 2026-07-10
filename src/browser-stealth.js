const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

let stealthInstalled = false;

function ensureStealthPlugin() {
  if (stealthInstalled) return;
  chromium.use(StealthPlugin());
  stealthInstalled = true;
}

function getStealthChromium(enabled = true) {
  if (enabled) ensureStealthPlugin();
  return chromium;
}

function chromeLaunchArgs() {
  return [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--window-size=393,873',
  ];
}

function playwrightLaunchExtras() {
  return { ignoreDefaultArgs: ['--enable-automation'] };
}

function browserProfileContextOptions(profile = 'wechat') {
  if (profile === 'desktop') {
    return {
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    };
  }
  return mobileContextOptions('');
}

async function installAntiAutomationScripts(target) {
  if (!target?.addInitScript) return;
  await target.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {}
    try {
      window.chrome = window.chrome || { runtime: {} };
    } catch {}
  });
}

async function applyBrowserProfileEmulation(page, profile = 'wechat') {
  if (!page?.setViewportSize) return;
  const size = profile === 'desktop'
    ? { width: 1280, height: 900 }
    : { width: 393, height: 873 };
  await page.setViewportSize(size).catch(() => {});
}

async function applyCdpBrowserProfile(page, browserVersion = '', profile = 'wechat') {
  if (!page) return;
  const desktop = profile === 'desktop';
  const viewport = desktop
    ? { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }
    : { width: 393, height: 873, deviceScaleFactor: 2.75, mobile: true };
  if (page.setViewportSize) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height }).catch(() => {});
  }
  const context = typeof page.context === 'function' ? page.context() : null;
  const cdp = await context?.newCDPSession?.(page).catch(() => null);
  if (!cdp) return;
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    mobile: viewport.mobile,
  }).catch(() => {});
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: viewport.mobile,
    maxTouchPoints: viewport.mobile ? 5 : 0,
  }).catch(() => {});
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: desktop
      ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${(/Chrome(?:\/|\s)([\d.]+)/.exec(browserVersion)?.[1] || '149.0.0.0')} Safari/537.36`
      : mobileUserAgent(browserVersion),
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    platform: desktop ? 'macOS' : 'Android',
  }).catch(() => {});
}

function mobileUserAgent(browserVersion = '') {
  const match = /Chrome(?:\/|\s)([\d.]+)/.exec(browserVersion);
  const chrome = match ? match[1] : '131.0.0.0';
  return `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`;
}

function mobileContextOptions(browserVersion) {
  return {
    viewport: { width: 393, height: 873 },
    deviceScaleFactor: 2.75,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: mobileUserAgent(browserVersion),
    ignoreHTTPSErrors: true,
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
}

module.exports = {
  applyCdpBrowserProfile,
  applyBrowserProfileEmulation,
  browserProfileContextOptions,
  chromeLaunchArgs,
  getStealthChromium,
  installAntiAutomationScripts,
  mobileContextOptions,
  mobileUserAgent,
  playwrightLaunchExtras,
};

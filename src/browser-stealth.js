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

function chromeVersion(browserVersion = '', fallback = '131.0.0.0') {
  const text = String(browserVersion || '').trim();
  return /Chrome(?:\/|\s)([\d.]+)/.exec(text)?.[1]
    || (/^\d[\d.]*$/.test(text) ? text : '')
    || fallback;
}

function browserProfileContextOptions(profile = 'wechat') {
  if (profile === 'desktop') {
    return {
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: {
        'Accept-Language': 'zh-CN,zh,en',
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

function resolveCdpProfileMode(mode = 'auto', { minimalLogin = false } = {}) {
  const normalized = String(mode || 'auto').toLowerCase();
  if (normalized === 'native' || normalized === 'off' || normalized === 'none') return 'native';
  if (normalized === 'emulated' || normalized === 'full' || normalized === 'force') return 'emulated';
  return minimalLogin ? 'native' : 'emulated';
}

async function applyCdpBrowserProfile(page, browserVersion = '', profile = 'wechat', options = {}) {
  if (!page) return;
  const mode = resolveCdpProfileMode(options.mode, { minimalLogin: !!options.minimalLogin });
  if (mode === 'native') {
    return { applied: false, mode };
  }
  const desktop = profile === 'desktop';
  const chrome = chromeVersion(browserVersion, desktop ? '149.0.0.0' : '131.0.0.0');
  const major = chrome.split('.')[0] || (desktop ? '149' : '131');
  const greaseBrand = 'Not)A;Brand';
  const greaseVersion = '24';
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
  const userAgent = desktop
    ? `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
    : mobileUserAgent(browserVersion);
  const userAgentMetadata = desktop
    ? {
        brands: [
          { brand: 'Google Chrome', version: major },
          { brand: 'Chromium', version: major },
          { brand: greaseBrand, version: greaseVersion },
        ],
        fullVersionList: [
          { brand: 'Google Chrome', version: chrome },
          { brand: 'Chromium', version: chrome },
          { brand: greaseBrand, version: `${greaseVersion}.0.0.0` },
        ],
        platform: 'macOS',
        platformVersion: '10.15.7',
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
        formFactors: ['Desktop'],
      }
    : {
        brands: [
          { brand: 'Google Chrome', version: major },
          { brand: 'Chromium', version: major },
          { brand: greaseBrand, version: greaseVersion },
        ],
        fullVersionList: [
          { brand: 'Google Chrome', version: chrome },
          { brand: 'Chromium', version: chrome },
          { brand: greaseBrand, version: `${greaseVersion}.0.0.0` },
        ],
        platform: 'Android',
        platformVersion: '13.0.0',
        architecture: 'arm',
        model: 'Pixel 7',
        mobile: true,
        bitness: '64',
        wow64: false,
        formFactors: ['Mobile'],
      };
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent,
    acceptLanguage: 'zh-CN,zh,en',
    platform: desktop ? 'macOS' : 'Android',
    userAgentMetadata,
  }).catch(() => {});
  return {
    applied: true,
    mode,
    viewport,
    userAgent,
    userAgentMetadata,
  };
}

function mobileUserAgent(browserVersion = '') {
  const chrome = chromeVersion(browserVersion);
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
      'Accept-Language': 'zh-CN,zh,en',
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
  resolveCdpProfileMode,
};

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
    geolocation: { latitude: 39.9042, longitude: 116.4074 },
    permissions: ['geolocation'],
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
}

module.exports = {
  chromeLaunchArgs,
  getStealthChromium,
  mobileContextOptions,
  mobileUserAgent,
};

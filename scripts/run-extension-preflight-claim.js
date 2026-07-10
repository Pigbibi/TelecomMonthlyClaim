#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
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
const timeoutMs = Number(process.env.TELECOM_EXTENSION_PREFLIGHT_TIMEOUT_MS || 90000);

if (!entryUrl) throw new Error('Missing TELECOM_ENTRY_URL');
if (!phone) throw new Error('Missing TELECOM_PHONE');
function resolveChromeBinary() {
  if (process.env.TELECOM_CHROME_BIN) return process.env.TELECOM_CHROME_BIN;
  const output = execFileSync('bash', [path.join(root, 'scripts', 'install-chrome-for-testing.sh')], {
    encoding: 'utf8',
  }).trim();
  return output.split(/\r?\n/).filter(Boolean).pop() || '';
}

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

async function waitForCdp(url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/json/version`);
      if (response.ok) return;
    } catch {}
    await wait(300);
  }
  throw new Error('Chrome CDP did not become ready');
}

async function waitForTelecomPage(url, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`${url}/json`).then(response => response.json());
      if (targets.some(target => target.type === 'page' && target.url.startsWith('https://wapbj.189.cn/'))) return;
    } catch {}
    await wait(500);
  }
  throw new Error('Chrome extension did not open the Telecom page');
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function diagnosticSuffix(status) {
  return status?.diagnostic ? ` diagnostics=${JSON.stringify(status.diagnostic)}` : '';
}

async function captureCdpFailureScreenshot(cdpUrl) {
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10000 });
    const pages = browser.contexts().flatMap(context => context.pages());
    const page = pages.find(candidate => candidate.url().startsWith('https://wapbj.189.cn/'));
    if (!page) return false;
    const artifactDir = path.join(root, 'artifacts', 'claim-debug');
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({
      path: path.join(artifactDir, `${Date.now()}-chrome-session-failed.png`),
      fullPage: false,
    });
    return true;
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function main() {
  const chromeBin = resolveChromeBinary();
  if (!fs.existsSync(chromeBin)) throw new Error(`Chrome for Testing binary not found: ${chromeBin}`);
  const requestedCdpPort = Number(process.env.TELECOM_CDP_PORT || 0);
  if (!Number.isInteger(requestedCdpPort) || requestedCdpPort < 0 || requestedCdpPort > 65535) {
    throw new Error('TELECOM_CDP_PORT must be an integer between 0 and 65535');
  }
  const cdpPort = requestedCdpPort || await getFreeTcpPort();
  const token = crypto.randomBytes(24).toString('hex');
  let status = { stage: 'starting' };
  let loginCode = '';
  const smsSince = Date.now() - 10000;
  const server = http.createServer((request, response) => {
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const base = `/${token}`;
    if (request.method === 'GET' && request.url === `${base}/config`) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ entryUrl, phone }));
      return;
    }
    if (request.method === 'POST' && request.url === `${base}/status`) {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        try { status = JSON.parse(body); } catch { status = { stage: 'error', message: 'invalid-status' }; }
        response.writeHead(204).end();
      });
      return;
    }
    if (request.method === 'POST' && request.url === `${base}/screenshot`) {
      let body = '';
      request.on('data', chunk => {
        body += chunk;
        if (body.length > 12 * 1024 * 1024) request.destroy();
      });
      request.on('end', () => {
        const artifactDir = path.join(root, 'artifacts', 'claim-debug');
        fs.mkdirSync(artifactDir, { recursive: true });
        fs.writeFileSync(path.join(artifactDir, `${Date.now()}-extension-preflight-failed.png`), Buffer.from(body, 'base64'));
        response.writeHead(204).end();
      });
      return;
    }
    if (request.method === 'GET' && request.url === `${base}/login-code`) {
      if (!loginCode) {
        response.writeHead(204).end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ code: loginCode }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const preflightUrl = `http://127.0.0.1:${address.port}/${token}`;
  const extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-slider-extension-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telecom-slider-profile-'));
  const extensionSource = path.join(root, 'chrome-extension', 'slider-preflight');
  fs.copyFileSync(path.join(extensionSource, 'manifest.json'), path.join(extensionDir, 'manifest.json'));
  const background = fs.readFileSync(path.join(extensionSource, 'background.js'), 'utf8')
    .replace("'__PREFLIGHT_URL__'", JSON.stringify(preflightUrl))
    .replace("'__MATCH_FUNCTION_SOURCE__'", JSON.stringify(computeSliderImageMatchInPage.toString()));
  fs.writeFileSync(path.join(extensionDir, 'background.js'), background);

  const chrome = spawn(chromeBin, [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
  ], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });

  const cleanup = async () => {
    if (chrome.exitCode == null) {
      try {
        process.kill(-chrome.pid, 'SIGTERM');
      } catch {
        chrome.kill('SIGTERM');
      }
    }
    await wait(500);
    fs.rmSync(extensionDir, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  };

  try {
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    await waitForCdp(cdpUrl);
    console.log(`Fresh headed Chrome session ready on an isolated CDP port (${cdpPort})`);
    await waitForTelecomPage(cdpUrl, timeoutMs);
    const settleMs = Number(process.env.TELECOM_EXTENSION_PREFLIGHT_SETTLE_MS || 60000);
    const deadline = Date.now() + settleMs;
    const pendingStages = new Set([
      'starting',
      'tab-opened',
      'debugger-attached',
      'network-ready',
      'phone-ready',
      'sms-clicked',
    ]);
    while (pendingStages.has(status.stage) && Date.now() < deadline) await wait(500);
    if (status.stage !== 'sms-sent') {
      await captureCdpFailureScreenshot(cdpUrl);
      throw new Error(`Chrome extension slider preflight failed: ${status.stage}${status.message ? ` (${status.message})` : ''}${diagnosticSuffix(status)}`);
    }
    const config = loadConfig();
    const sms = await new SmsInboxClient(config).waitForCode({
      stage: 'login',
      since: smsSince,
      timeoutMs: config.smsTimeoutMs,
      pollMs: config.smsPollMs,
    });
    if (!sms?.code) throw new Error('Login SMS was not received after extension preflight');
    loginCode = sms.code;
    const loginDeadline = Date.now() + 45000;
    while (status.stage === 'sms-sent' && Date.now() < loginDeadline) await wait(500);
    if (status.stage !== 'login-complete') {
      throw new Error(`Chrome extension login failed: ${status.stage}${status.message ? ` (${status.message})` : ''}${diagnosticSuffix(status)}`);
    }
    console.log('Chrome extension login completed; handing the package page to the claim runner');
    const result = await runChild(process.execPath, [path.join(root, 'scripts', 'telecom-monthly-claim.js')], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        BROWSER_CDP_URL: cdpUrl,
        TELECOM_REUSE_VALIDATED_PAGE: 'true',
        TELECOM_CDP_PROFILE_MODE: 'native',
        TELECOM_LOGIN_ALREADY_COMPLETE: 'true',
      },
    });
    if (result.code !== 0) process.exitCode = result.code || 1;
  } finally {
    await cleanup();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

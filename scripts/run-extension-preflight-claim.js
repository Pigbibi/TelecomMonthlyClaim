#!/usr/bin/env node
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cdpPort = Number(process.env.TELECOM_CDP_PORT || 9222);
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

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const chromeBin = resolveChromeBinary();
  if (!fs.existsSync(chromeBin)) throw new Error(`Chrome for Testing binary not found: ${chromeBin}`);
  const token = crypto.randomBytes(24).toString('hex');
  let status = { stage: 'starting' };
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
    .replace("'__PREFLIGHT_URL__'", JSON.stringify(preflightUrl));
  fs.writeFileSync(path.join(extensionDir, 'background.js'), background);

  const chrome = spawn(chromeBin, [
    `--remote-debugging-port=${cdpPort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  const cleanup = async () => {
    if (chrome.exitCode == null) chrome.kill('SIGTERM');
    await wait(500);
    fs.rmSync(extensionDir, { recursive: true, force: true });
    fs.rmSync(profileDir, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
  };

  try {
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    await waitForCdp(cdpUrl);
    const deadline = Date.now() + timeoutMs;
    while (status.stage === 'starting' && Date.now() < deadline) await wait(500);
    if (status.stage !== 'slider-ready') {
      throw new Error(`Chrome extension slider preflight failed: ${status.stage}${status.message ? ` (${status.message})` : ''}`);
    }
    console.log('Chrome extension obtained the Telecom slider challenge; handing off to claim runner');
    const result = await runChild(process.execPath, [path.join(root, 'scripts', 'telecom-monthly-claim.js')], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        BROWSER_CDP_URL: cdpUrl,
        TELECOM_REUSE_VALIDATED_PAGE: 'true',
        TELECOM_CDP_PROFILE_MODE: 'native',
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

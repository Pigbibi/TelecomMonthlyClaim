#!/usr/bin/env node
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const HOST = process.env.HOME_CLAIM_RUNNER_HOST || '127.0.0.1';
const PORT = Number(process.env.HOME_CLAIM_RUNNER_PORT || 19090);
const MAX_BODY_BYTES = Number(process.env.HOME_CLAIM_RUNNER_MAX_BODY_BYTES || 128 * 1024);
const OUTPUT_LIMIT = Number(process.env.HOME_CLAIM_RUNNER_OUTPUT_LIMIT || 160 * 1024);
const REPO_ROOT = path.resolve(__dirname, '..');

let running = false;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function maskOutput(text, env) {
  let out = String(text || '');
  for (const [key, value] of Object.entries(env)) {
    if (!value || String(value).length < 6) continue;
    if (!/(TOKEN|SECRET|KEY|PASSWORD|PHONE|CODE)/i.test(key)) continue;
    const raw = String(value);
    const replacement = /PHONE/i.test(key) && /^1\d{10}$/.test(raw)
      ? `${raw.slice(0, 3)}****${raw.slice(7)}`
      : '***';
    out = out.split(raw).join(replacement);
  }
  return out.replace(/1\d{10}/g, m => `${m.slice(0, 3)}****${m.slice(7)}`);
}

function runClaim(env) {
  return new Promise(resolve => {
    const childEnv = {
      ...process.env,
      ...env,
      OPENWRT_HTTP_PROXY: '',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      TELECOM_CONNECTIVITY_MODE: 'local-home',
      HEADLESS: env.HEADLESS || 'true',
      BROWSER_CHANNEL: env.BROWSER_CHANNEL || 'chrome',
    };
    const child = spawn(process.execPath, ['scripts/telecom-monthly-claim.js'], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = data => {
      output += data.toString();
      if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_LIMIT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', err => resolve({ exitCode: 1, signal: null, output: err.stack || err.message }));
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, output: maskOutput(output, childEnv) }));
  });
}

const server = http.createServer(async (req, res) => {
  if (!isLoopback(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, running });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/run') {
    sendJson(res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (running) {
    sendJson(res, 409, { ok: false, error: 'claim already running' });
    return;
  }
  running = true;
  try {
    const body = await collectBody(req);
    const payload = body ? JSON.parse(body) : {};
    const result = await runClaim(payload.env || {});
    sendJson(res, result.exitCode === 0 ? 200 : 500, { ok: result.exitCode === 0, ...result });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  } finally {
    running = false;
  }
});

server.listen(PORT, HOST, () => console.log(`home claim runner listening on ${HOST}:${PORT}`));

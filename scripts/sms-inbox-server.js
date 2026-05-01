#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PORT = Number(process.env.SMS_INBOX_PORT || 8787);
const TOKEN = process.env.SMS_INBOX_TOKEN || '';
const FILE = process.env.SMS_INBOX_FILE || path.join(process.cwd(), '.sms-inbox.jsonl');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function authorized(req, url) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${TOKEN}` || url.searchParams.get('token') === TOKEN;
}

function parseIncoming(body, contentType) {
  let data = body;
  if (/json/i.test(contentType || '')) {
    try { data = JSON.parse(body || '{}'); } catch { data = { text: body }; }
  }
  if (typeof data === 'string') data = { text: data };
  return {
    id: data.id || data.messageId || randomUUID(),
    sender: data.sender || data.from || data.address || data.phone || data.origin || '',
    text: data.text || data.content || data.body || data.message || data.sms || '',
    receivedAt: Number(data.receivedAt || data.timestamp || data.time || Date.now()),
    raw: data,
  };
}

function readMessages({ since = 0, sender = '', limit = 30 }) {
  if (!fs.existsSync(FILE)) return [];
  const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean)
    .filter(m => Number(m.receivedAt || 0) >= since)
    .filter(m => !sender || String(m.sender || '').includes(sender))
    .slice(-limit);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!authorized(req, url)) {
    res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.end(JSON.stringify({ ok: true })); return;
  }
  if (req.method === 'POST' && url.pathname === '/sms') {
    const body = await readBody(req);
    const msg = parseIncoming(body, req.headers['content-type']);
    fs.appendFileSync(FILE, `${JSON.stringify(msg)}\n`, { mode: 0o600 });
    res.end(JSON.stringify({ ok: true, id: msg.id })); return;
  }
  if (req.method === 'GET' && (url.pathname === '/messages' || url.pathname === '/sms')) {
    const since = Number(url.searchParams.get('since') || 0);
    const sender = url.searchParams.get('sender') || '';
    const limit = Number(url.searchParams.get('limit') || 30);
    res.end(JSON.stringify({ ok: true, messages: readMessages({ since, sender, limit }) })); return;
  }
  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(PORT, () => console.log(`SMS inbox listening on :${PORT}, file=${FILE}`));

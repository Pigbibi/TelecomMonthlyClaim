const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { parseTelecomSms } = require('./sms-parser');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function maybeUnwrapForwarderPayload(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function normalizeMessage(raw) {
  if (typeof raw === 'string') return { text: raw };
  const wrapped = maybeUnwrapForwarderPayload(raw.text || raw.content || raw.body || raw.message || raw.sms || '');
  return {
    id: raw.id || raw.messageId || raw.uuid,
    sender: wrapped?.sender || wrapped?.from || wrapped?.address || raw.sender || raw.from || raw.address || raw.phone || '',
    text: wrapped?.text || wrapped?.content || wrapped?.body || wrapped?.message || raw.text || raw.content || raw.body || raw.message || raw.sms || '',
    receivedAt: raw.receivedAt || raw.timestamp || raw.time || raw.date || Date.now(),
  };
}

function describeMessage(msg) {
  return {
    id: msg.id,
    sender: msg.sender,
    receivedAt: msg.receivedAt,
  };
}

class SmsInboxClient {
  constructor(config) {
    this.config = config;
    this.seen = new Set();
  }

  async fetchMessages(since) {
    if (!this.config.smsInboxUrl) return [];
    const url = new URL(this.config.smsInboxUrl);
    url.searchParams.set('since', String(since));
    url.searchParams.set('sender', this.config.smsSender);
    url.searchParams.set('limit', '30');
    const headers = { accept: 'application/json' };
    if (this.config.smsInboxToken) headers.authorization = `Bearer ${this.config.smsInboxToken}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`SMS inbox HTTP ${res.status}`);
    const data = await res.json();
    const items = Array.isArray(data) ? data : data.messages || data.items || [];
    return items.map(normalizeMessage).sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0));
  }

  async waitForCode({ stage, since, timeoutMs, pollMs }) {
    const envName = stage === 'login' ? 'TELECOM_LOGIN_CODE' : 'TELECOM_CONFIRM_CODE';
    if (process.env[envName]) return { code: process.env[envName], stage, source: 'env' };

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const messages = await this.fetchMessages(since);
      for (const msg of messages) {
        const key = msg.id || `${msg.sender}:${msg.receivedAt}:${msg.text}`;
        if (this.seen.has(key)) continue;
        const parsed = parseTelecomSms(msg, {
          stage,
          expectedPhone: this.config.phone,
          product: this.config.productName,
          planId: this.config.expectedPlanId,
        });
        if (parsed) {
          this.seen.add(key);
          console.log(`Matched ${stage} SMS ${JSON.stringify(describeMessage(msg))}`);
          return { ...parsed, source: 'inbox' };
        }
      }
      await sleep(pollMs);
    }

    if (process.env.ALLOW_MANUAL_CODE === 'true' && process.stdin.isTTY) {
      const rl = readline.createInterface({ input, output });
      const answer = await rl.question(`请输入 ${stage} 验证码：`);
      rl.close();
      const code = String(answer || '').trim();
      if (/^\d{4,8}$/.test(code)) return { code, stage, source: 'manual' };
    }
    return null;
  }
}

module.exports = { SmsInboxClient, normalizeMessage, sleep };

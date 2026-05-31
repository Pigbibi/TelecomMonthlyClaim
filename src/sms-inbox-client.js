const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { parseTelecomSms } = require('./sms-parser');

const DEFAULT_PUSHPLUS_BASE_URL = 'https://www.pushplus.plus';

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

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, '&');
}

function htmlToText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function parsePushPlusUpdateTime(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) {
    const timestamp = Number(text);
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }
  if (/([zZ]|[+-]\d\d:?\d\d)$/.test(text)) {
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [, year, month, day, hour, minute, second = '0'] = m;
    // PushPlus updateTime is rendered as China local time in the console/API examples.
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second));
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function pushPlusUrl(baseUrl, pathname) {
  const base = baseUrl || DEFAULT_PUSHPLUS_BASE_URL;
  return new URL(pathname, base.endsWith('/') ? base : `${base}/`);
}

function summarizePushPlusDetail(text) {
  const normalized = String(text || '').replace(/\s+/g, '');
  return {
    detailLength: String(text || '').length,
    hasTelecomSender: normalized.includes('10001'),
    hasCodeHint: /验证码[:：]?\d{4,8}/.test(normalized),
    hasBeijingTelecomLoginText: normalized.includes('感谢使用北京电信掌上营业厅'),
    hasConfirmHint: normalized.includes('办理提醒'),
  };
}

class SmsInboxClient {
  constructor(config) {
    this.config = config;
    this.seen = new Set();
    this.pushPlusAccessKey = config.pushPlusAccessKey || '';
    this.pushPlusAccessKeyExpiresAt = this.pushPlusAccessKey ? Number.MAX_SAFE_INTEGER : 0;
    this.pushPlusDetailCache = new Map();
  }

  get provider() {
    return String(this.config.smsInboxProvider || 'http').toLowerCase();
  }

  async fetchMessages(since) {
    if (this.provider === 'pushplus') return this.fetchPushPlusMessages(since);
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

  async getPushPlusAccessKey() {
    if (this.pushPlusAccessKey && Date.now() < this.pushPlusAccessKeyExpiresAt - 60000) {
      return this.pushPlusAccessKey;
    }
    const token = this.config.pushPlusToken;
    const secretKey = this.config.pushPlusSecretKey;
    if (!token || !secretKey) {
      throw new Error('Missing PUSHPLUS_TOKEN or PUSHPLUS_SECRET_KEY for SMS_INBOX_PROVIDER=pushplus');
    }
    const res = await fetch(pushPlusUrl(this.config.pushPlusBaseUrl, '/api/common/openApi/getAccessKey'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, secretKey }),
    });
    if (!res.ok) throw new Error(`PushPlus access key HTTP ${res.status}`);
    const data = await res.json();
    const accessKey = data?.data?.accessKey;
    if (data?.code !== 200 || !accessKey) {
      throw new Error(`PushPlus access key request failed: ${data?.msg || 'unknown error'}`);
    }
    this.pushPlusAccessKey = accessKey;
    this.pushPlusAccessKeyExpiresAt = Date.now() + Number(data.data.expiresIn || 7200) * 1000;
    return accessKey;
  }

  async fetchPushPlusDetail(shortCode) {
    if (this.pushPlusDetailCache.has(shortCode)) return this.pushPlusDetailCache.get(shortCode);
    const res = await fetch(pushPlusUrl(this.config.pushPlusBaseUrl, `/shortMessage/${encodeURIComponent(shortCode)}`), {
      headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.8' },
    });
    if (!res.ok) throw new Error(`PushPlus message detail HTTP ${res.status}`);
    const text = htmlToText(await res.text());
    this.pushPlusDetailCache.set(shortCode, text);
    return text;
  }

  async fetchPushPlusMessages(since) {
    const accessKey = await this.getPushPlusAccessKey();
    const pageSize = Math.max(1, Math.min(Number(this.config.pushPlusPageSize || 10), 50));
    const res = await fetch(pushPlusUrl(this.config.pushPlusBaseUrl, '/api/open/message/list'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'access-key': accessKey,
      },
      body: JSON.stringify({ current: 1, pageSize }),
    });
    if (!res.ok) throw new Error(`PushPlus message list HTTP ${res.status}`);
    const data = await res.json();
    if (data?.code !== 200) throw new Error(`PushPlus message list failed: ${data?.msg || 'unknown error'}`);
    const titleKeyword = this.config.pushPlusTitleKeyword || '';
    const list = data?.data?.list || [];
    if (this.config.pushPlusDebug) {
      console.log(`PushPlus message list fetched ${JSON.stringify({ count: list.length, titleKeyword })}`);
    }
    const messages = [];
    for (const item of list) {
      if (!item?.shortCode) continue;
      if (titleKeyword && !String(item.title || '').includes(titleKeyword)) continue;
      const receivedAt = parsePushPlusUpdateTime(item.updateTime);
      if (this.config.pushPlusDebug) {
        console.log(`PushPlus message candidate ${JSON.stringify({
          shortCode: item.shortCode,
          title: item.title || '',
          updateTime: item.updateTime || '',
          receivedAt,
          ignoredBySince: Boolean(since && receivedAt && receivedAt < since),
        })}`);
      }
      if (since && receivedAt && receivedAt < since) continue;
      const detail = await this.fetchPushPlusDetail(item.shortCode);
      if (this.config.pushPlusDebug) {
        console.log(`PushPlus message detail summary ${JSON.stringify({
          shortCode: item.shortCode,
          ...summarizePushPlusDetail(detail),
        })}`);
      }
      messages.push({
        id: item.shortCode,
        sender: '',
        text: [item.title || '', detail].filter(Boolean).join('\n'),
        receivedAt,
      });
    }
    return messages.sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0));
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
          return { ...parsed, source: this.provider === 'pushplus' ? 'pushplus' : 'inbox' };
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

module.exports = {
  SmsInboxClient,
  normalizeMessage,
  sleep,
  htmlToText,
  parsePushPlusUpdateTime,
  summarizePushPlusDetail,
};

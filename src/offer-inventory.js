function compactText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function pageFamilyFromUrl(url) {
  const value = String(url || '');
  if (/\/echnwap\//i.test(value)) return 'echnwap';
  if (/\/wap2017\//i.test(value)) return 'wap2017';
  return 'unknown';
}

/**
 * voice200 (and default) expect the orange HighPic entry and wap2017 Cfg
 * confirm/list after SMS login. The Sep cold divert into echnwap Cfq is the
 * wrong activity shell and must fail closed instead of soft-skipping.
 *
 * Query-shape pins (required params / exact channelId) stay out of this
 * recipe — forks configure them via TELECOM_ENTRY_* env (see assertEntrySecretShape).
 */
function expectedActivityForTarget(targetPackage = 'voice200') {
  void targetPackage;
  return {
    id: 'wap2017_cfg',
    pageFamily: 'wap2017',
    entryPathPattern: /preDepositHighPic_check\.html/i,
    postLoginPathPattern: /preDepositCfg_/i,
    forbiddenPostLoginPathPattern: /preDepositCfq_/i,
  };
}

function parseCsvList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map(part => part.trim())
    .filter(Boolean);
}

/**
 * Resolve entry-URL shape policy from env (open-source friendly).
 * - TELECOM_ENTRY_REQUIRED_PARAMS: comma list of query keys that must be present
 *   (default: campaignId,channelId,wxopenid — values never compared)
 * - TELECOM_EXPECTED_CHANNEL_ID: optional exact channelId pin (unset = no pin)
 * Set TELECOM_ENTRY_REQUIRED_PARAMS="" to disable presence checks.
 */
function resolveEntrySecretPolicy(env = process.env) {
  const requiredRaw = env.TELECOM_ENTRY_REQUIRED_PARAMS;
  const requiredParams = requiredRaw === undefined
    ? ['campaignId', 'channelId', 'wxopenid']
    : parseCsvList(requiredRaw);
  return {
    requiredParams,
    expectedChannelId: String(env.TELECOM_EXPECTED_CHANNEL_ID || '').trim(),
  };
}

/**
 * Fail closed when TELECOM_ENTRY_URL drifts from configured query shape.
 * Never compares secret values (campaignId / wxopenid contents).
 */
function assertEntrySecretShape(fingerprint = {}, policy = resolveEntrySecretPolicy()) {
  const issues = [];
  const keys = new Set(
    Array.isArray(fingerprint.queryKeys)
      ? fingerprint.queryKeys.map(key => String(key || ''))
      : [],
  );
  // Fingerprint booleans cover common keys even if queryKeys is incomplete.
  if (fingerprint.hasCampaignId) keys.add('campaignId');
  if (fingerprint.hasWxopenid) keys.add('wxopenid');
  if (fingerprint.channelId) keys.add('channelId');

  for (const name of policy.requiredParams || []) {
    if (!keys.has(name)) issues.push(`missing ${name}`);
  }
  if (policy.expectedChannelId
    && String(fingerprint.channelId || '') !== policy.expectedChannelId) {
    issues.push(
      `channelId=${fingerprint.channelId || '(empty)'} expected ${policy.expectedChannelId}`,
    );
  }
  if (issues.length === 0) {
    return { ok: true, state: 'ok', issues: [], policy };
  }
  return {
    ok: false,
    state: 'wrong_entry_secret',
    issues,
    policy,
    reason: `TELECOM_ENTRY_URL shape invalid: ${issues.join('; ')}`,
  };
}

/**
 * Shared pre-navigation gate used by native / Playwright / validate scripts.
 * Checks query-key shape + HighPic entry path. Never compares secret values.
 */
function assertConfiguredEntryUrl(url, options = {}) {
  const env = options.env || process.env;
  const targetPackage = options.targetPackage || env.TELECOM_TARGET_PACKAGE || 'voice200';
  const policy = options.policy || resolveEntrySecretPolicy(env);
  const fingerprint = summarizeEntryFingerprint(url);
  const secret = assertEntrySecretShape(fingerprint, policy);
  if (!secret.ok) {
    return {
      ok: false,
      state: secret.state,
      fingerprint,
      secret,
      activity: null,
      reason: secret.reason,
    };
  }
  const activity = classifyActivityRoute({
    url,
    phase: 'entry',
    targetPackage,
  });
  if (!activity.ok) {
    return {
      ok: false,
      state: activity.state,
      fingerprint,
      secret,
      activity,
      reason: activity.reason,
    };
  }
  return {
    ok: true,
    state: 'ok',
    fingerprint,
    secret,
    activity,
    reason: '',
  };
}

function safePathname(url) {
  try {
    return new URL(String(url || '')).pathname;
  } catch {
    const value = String(url || '');
    const match = value.match(/https?:\/\/[^/]+(\/[^?#]*)/i);
    return match ? match[1] : value;
  }
}

function classifyActivityRoute(input = {}) {
  const phase = input.phase === 'entry' ? 'entry' : 'post_login';
  const expected = input.expected || expectedActivityForTarget(input.targetPackage);
  const url = String(input.url || '');
  const path = safePathname(url);
  const pageFamily = pageFamilyFromUrl(url);

  if (phase === 'entry') {
    if (pageFamily === expected.pageFamily && expected.entryPathPattern.test(path)) {
      return { ok: true, state: 'ok', phase, pageFamily, path, expectedId: expected.id };
    }
    return {
      ok: false,
      state: 'wrong_activity',
      phase,
      pageFamily,
      path,
      expectedId: expected.id,
      reason: `expected ${expected.pageFamily} HighPic entry, got ${pageFamily} ${path}`,
    };
  }

  if (expected.forbiddenPostLoginPathPattern.test(path) || pageFamily === 'echnwap') {
    return {
      ok: false,
      state: 'wrong_activity',
      phase,
      pageFamily,
      path,
      expectedId: expected.id,
      reason: `expected ${expected.pageFamily} Cfg activity after login, got ${pageFamily} ${path}`,
    };
  }

  // Stay on wap2017 (HighPic → Cfg/confirm) while the package UI settles.
  if (pageFamily === expected.pageFamily) {
    return { ok: true, state: 'ok', phase, pageFamily, path, expectedId: expected.id };
  }

  return {
    ok: false,
    state: 'wrong_activity',
    phase,
    pageFamily,
    path,
    expectedId: expected.id,
    reason: `expected ${expected.pageFamily} activity after login, got ${pageFamily} ${path}`,
  };
}

function summarizeEntryFingerprint(url) {
  try {
    const parsed = new URL(String(url || ''));
    const params = parsed.searchParams;
    const channelId = String(params.get('channelId') || '').slice(0, 32);
    const version = String(params.get('version') || '').slice(0, 16);
    const campaignId = String(params.get('campaignId') || '');
    return {
      pageFamily: pageFamilyFromUrl(parsed.href),
      path: parsed.pathname.replace(/\d{4,}/g, '***').slice(0, 120),
      channelId,
      version,
      hasCampaignId: !!campaignId,
      campaignIdHint: campaignId
        ? `${campaignId.slice(0, 4)}***${campaignId.slice(-4)}`
        : '',
      hasWxopenid: !!params.get('wxopenid'),
      queryKeys: [...params.keys()].sort().slice(0, 12),
    };
  } catch {
    return {
      pageFamily: 'unknown',
      path: '',
      channelId: '',
      version: '',
      hasCampaignId: false,
      campaignIdHint: '',
      hasWxopenid: false,
      queryKeys: [],
    };
  }
}

function looksLikeOfferLabel(text) {
  const value = compactText(text);
  if (!value || value.length < 4 || value.length > 80) return false;
  if (/^(提交订单|确认|确定|取消|加载中|温馨提示|去办理|操作成功|请选择档位)$/.test(value)) return false;
  if (/验证码已下发|请注意查收|请稍后/.test(value)) return false;
  return /分钟|GB|流量|语音|网龄|专用|国内/.test(value);
}

function collectOfferLabelsFromNode(node, out, depth = 0) {
  if (depth > 8 || out.length >= 40) return;
  if (typeof node === 'string') {
    if (looksLikeOfferLabel(node)) out.push(compactText(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectOfferLabelsFromNode(item, out, depth + 1);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (/name|title|label|desc|product|offer|meal|package|plan/i.test(key) && typeof value === 'string') {
      if (looksLikeOfferLabel(value)) out.push(compactText(value));
    }
    collectOfferLabelsFromNode(value, out, depth + 1);
  }
}

function extractOfferLabelsFromMeta(payload) {
  const out = [];
  collectOfferLabelsFromNode(payload, out);
  return [...new Set(out)];
}

function mergeOfferLabels(...lists) {
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const value = compactText(item);
      if (value && !out.includes(value)) out.push(value);
    }
  }
  return out.slice(0, 20);
}

module.exports = {
  pageFamilyFromUrl,
  expectedActivityForTarget,
  classifyActivityRoute,
  summarizeEntryFingerprint,
  resolveEntrySecretPolicy,
  assertEntrySecretShape,
  assertConfiguredEntryUrl,
  looksLikeOfferLabel,
  extractOfferLabelsFromMeta,
  mergeOfferLabels,
};

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
  looksLikeOfferLabel,
  extractOfferLabelsFromMeta,
  mergeOfferLabels,
};

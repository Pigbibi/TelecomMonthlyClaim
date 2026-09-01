const { mergeOfferLabels, pageFamilyFromUrl } = require('./offer-inventory');

function compactText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function productMatchAliases(productName) {
  const raw = String(productName || '').trim();
  const compact = compactText(raw);
  if (!compact) return [];
  const aliases = new Set([compact]);
  const withoutPrefix = compactText(raw.replace(/^互联网卡网龄享/, ''));
  if (withoutPrefix) aliases.add(withoutPrefix);
  if (/200分钟/.test(raw)) {
    aliases.add(compactText('200分钟国内语音'));
    aliases.add(compactText('网龄享200分钟'));
  }
  if (/5GB|5G/.test(raw)) {
    aliases.add(compactText('5GB国内通用流量'));
    aliases.add(compactText('网龄享5GB'));
  }
  return [...aliases].filter(Boolean);
}

function textContainsProduct(text, productName) {
  const haystack = compactText(text);
  return productMatchAliases(productName).some(alias => alias && haystack.includes(alias));
}

function classifyPackageGate(input = {}) {
  const url = String(input.url || '');
  const bodyText = String(input.bodyText || '');
  const dialogText = String(input.dialogText || '');
  const packageLabels = mergeOfferLabels(input.packageLabels, input.metaOffers);
  const productName = String(input.productName || '');
  const combined = `${dialogText}\n${bodyText}\n${packageLabels.join('\n')}`;
  const productReady = /preDepositC\w*_list/i.test(url)
    && productName
    && textContainsProduct(combined, productName);
  if (productReady) return { ...input, packageLabels, state: 'ready' };
  if (/(?:已(?:经|成功)?办理|已经办理|重复办理|无需重复(?:办理|领取)|本月已(?:办理|领取)|已领取)/.test(compactText(combined))) {
    return { ...input, packageLabels, state: 'already_claimed' };
  }
  const offerLabels = packageLabels
    .map(label => String(label || '').replace(/\s+/g, ' ').trim())
    .filter(label => label
      && !/^(提交订单|确认|确定|取消|加载中|温馨提示|去办理)$/.test(label)
      && !/验证码已下发|请注意查收/.test(label));
  if (/preDepositC\w*_list/i.test(url) && offerLabels.length > 0 && productName && !textContainsProduct(combined, productName)) {
    return { ...input, packageLabels: offerLabels, state: 'unavailable' };
  }
  return { ...input, packageLabels, state: compactText(dialogText) ? 'blocked' : 'waiting' };
}

function sanitizeDiagnosticText(text) {
  return String(text || '')
    .replace(/1\d{10}/g, '***')
    .replace(/(验证码(?:是|为)?[:：]?)\d{4,8}/g, '$1***')
    .replace(/\b\d{4,8}\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function safeUrlPath(value) {
  try {
    return new URL(String(value || '')).pathname;
  } catch {
    return '';
  }
}

function summarizePackageGate(gate = {}) {
  const labels = Array.isArray(gate.packageLabels)
    ? gate.packageLabels.map(sanitizeDiagnosticText).filter(Boolean).slice(0, 8)
    : [];
  return {
    state: gate.state || 'waiting',
    pageFamily: gate.pageFamily || pageFamilyFromUrl(gate.url),
    urlPath: safeUrlPath(gate.url),
    dialog: sanitizeDiagnosticText(gate.dialogText),
    packageLabels: labels,
    bodyPreview: sanitizeDiagnosticText(gate.bodyText).slice(0, 160),
  };
}

module.exports = {
  classifyPackageGate,
  summarizePackageGate,
  productMatchAliases,
  textContainsProduct,
};

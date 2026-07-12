function compactText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function classifyPackageGate(input = {}) {
  const url = String(input.url || '');
  const bodyText = String(input.bodyText || '');
  const dialogText = String(input.dialogText || '');
  const productName = String(input.productName || '');
  const combined = compactText(`${dialogText}\n${bodyText}`);
  const productReady = url.includes('preDepositCfg_list')
    && productName
    && combined.includes(compactText(productName));
  if (productReady) return { ...input, state: 'ready' };
  if (/(?:已(?:经|成功)?办理|已经办理|重复办理|无需重复(?:办理|领取)|本月已(?:办理|领取)|已领取)/.test(combined)) {
    return { ...input, state: 'already_claimed' };
  }
  return { ...input, state: compactText(dialogText) ? 'blocked' : 'waiting' };
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
  return {
    state: gate.state || 'waiting',
    urlPath: safeUrlPath(gate.url),
    dialog: sanitizeDiagnosticText(gate.dialogText),
  };
}

module.exports = { classifyPackageGate, summarizePackageGate };

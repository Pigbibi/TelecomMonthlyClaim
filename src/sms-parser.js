function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function includesAll(text, parts) {
  const normalized = normalizeText(text);
  return parts.every(part => normalized.includes(normalizeText(part)));
}

function extractVerificationCode(text) {
  return text.match(/验证码(?:是|为)?[:：]?(\d{6})/)?.[1] || null;
}

function extractConfirmPhone(text) {
  return text.match(/号码(\d{11})/)?.[1] || '';
}

function extractConfirmProduct(text) {
  return text.match(/办理([^，。]+?)(?:（|\(|,|，|。|立即生效|当月有效)/)?.[1] || '';
}

function extractReceiptProduct(text) {
  return text.match(/成功办理([^，。]+?)(?:（|\(|,|，|。|立即生效|当月有效)/)?.[1] || '';
}

function extractPlanId(text) {
  return text.match(/方案编号[:：]?([A-Za-z0-9_-]+)/)?.[1] || '';
}

function parseTelecomSms(input, options = {}) {
  const text = normalizeText(typeof input === 'string' ? input : input?.text || input?.content || input?.body || '');
  const sender = String(input?.sender || input?.from || input?.address || '');
  const stage = options.stage;
  const expectedPhone = options.expectedPhone ? String(options.expectedPhone) : '';
  const product = options.product || '';
  const planId = options.planId || '';

  if (stage === 'receipt') {
    const expectedSender = String(options.sender || '10000');
    if (sender && expectedSender && !sender.includes(expectedSender)) return null;
    if (!includesAll(text, ['【办理提醒】', '成功办理'])) return null;
    const parsedProduct = extractReceiptProduct(text);
    const parsedPlanId = extractPlanId(text);
    if (product && !text.includes(normalizeText(product))) return null;
    if (planId && !text.includes(normalizeText(planId))) return null;
    if (!product && !parsedProduct) return null;
    if (!planId && !parsedPlanId) return null;
    return {
      stage: 'receipt',
      product: product || parsedProduct,
      planId: planId || parsedPlanId,
    };
  }

  if (sender && !/10001/.test(sender)) return null;

  if (stage === 'login') {
    if (!includesAll(text, ['验证码', '感谢使用北京电信掌上营业厅'])) return null;
    const code = extractVerificationCode(text);
    return code ? { code, stage: 'login' } : null;
  }

  if (stage === 'confirm') {
    if (!includesAll(text, ['【办理提醒】', '验证码', '办理'])) return null;
    const code = extractVerificationCode(text);
    const phone = extractConfirmPhone(text);
    const parsedProduct = extractConfirmProduct(text);
    if (!code || !phone) return null;
    if (expectedPhone && phone !== expectedPhone) return null;
    if (product && !text.includes(product)) return null;
    if (planId && !text.includes(planId)) return null;
    return { code, stage: 'confirm', phone, product: product || parsedProduct };
  }

  return null;
}

module.exports = { parseTelecomSms, normalizeText };

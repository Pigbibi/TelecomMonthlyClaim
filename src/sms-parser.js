function normalizeText(text) {
  return String(text || '').replace(/\s+/g, '');
}

function parseTelecomSms(input, options = {}) {
  const text = normalizeText(typeof input === 'string' ? input : input?.text || input?.content || input?.body || '');
  const sender = String(input?.sender || input?.from || input?.address || '');
  const stage = options.stage;
  const expectedPhone = options.expectedPhone ? String(options.expectedPhone) : '';
  const product = options.product || '';
  const planId = options.planId || '';

  if (sender && !/10001/.test(sender)) return null;

  if (stage === 'login') {
    const m = text.match(/验证码[:：](\d{6})。?尊敬的用户，感谢使用北京电信掌上营业厅/);
    return m ? { code: m[1], stage: 'login' } : null;
  }

  if (stage === 'confirm') {
    const m = text.match(/【办理提醒】.*?验证码是[:：](\d{6})，号码(\d{11}).*?办理([^，。]+?)(?:（|,|，)/);
    if (!m) return null;
    if (expectedPhone && m[2] !== expectedPhone) return null;
    if (product && !text.includes(product)) return null;
    if (planId && !text.includes(planId)) return null;
    return { code: m[1], stage: 'confirm', phone: m[2], product };
  }

  return null;
}

module.exports = { parseTelecomSms, normalizeText };

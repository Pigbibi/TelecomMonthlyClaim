function normalizeText(value, limit = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function joinTexts(values, limit = 4000) {
  if (!Array.isArray(values)) return '';
  return normalizeText(values.filter(Boolean).join(' '), limit);
}

function classifyTelecomPageObservation(observation = {}) {
  const url = String(observation.url || '');
  const title = normalizeText(observation.title || '');
  const bodyText = normalizeText(observation.bodyText || observation.body || '', 6000);
  const dialogText = joinTexts(observation.dialogs, 2000);
  const actionText = joinTexts(observation.actionTexts, 2000);
  const sliderMessage = normalizeText(observation.slider?.message || '', 500);
  const text = normalizeText([title, bodyText, dialogText, actionText, sliderMessage].join(' '), 8000);

  const oneClickLogin = /本机号码一键登录/.test(text);
  const smsLogin = /短信验证码登录/.test(text);
  const sliderVisible = !!(observation.slider?.popup || observation.slider?.track || observation.slider?.canvas);
  const hasPhone = !!observation.hasPhone;
  const hasCode = !!observation.hasCode;
  const hasSendBtn = !!observation.hasSendBtn;
  const finalConfirmSignals = !!(
    observation.activeNameText
    || observation.hasPayConfirmBtn
    || observation.hasSecondSmsBtn
    || observation.hasSecondCodeInput
    || observation.hasSecondConfirmBtn
    || observation.hasFinalAgreementBtn
  );

  if (/获取验证码失败|请重试/.test(text) && (sliderVisible || /安全验证/.test(text))) {
    return {
      state: 'slider_error',
      confidence: 0.98,
      reason: 'slider popup visible with retry/failure message',
    };
  }

  if ((/服务繁忙|请稍后再试/.test(text) || observation.htmlLength < 800) && !hasPhone && !hasCode && !hasSendBtn) {
    return {
      state: 'waf_or_busy_page',
      confidence: 0.9,
      reason: 'busy or degraded page text without usable login controls',
    };
  }

  if (sliderVisible || /请完成安全验证|向右滑动滑块|滑动滑块/.test(text)) {
    return {
      state: 'slider_popup',
      confidence: 0.94,
      reason: 'slider verification controls detected',
    };
  }

  if (/办理成功|领取成功|办理完成|领取完成|成功办理/.test(text) || url.includes('preDeposit_result')) {
    return {
      state: 'success_page',
      confidence: 0.95,
      reason: 'success text detected',
    };
  }

  if (url.includes('preDepositCfg_list') || observation.hasConductBtn || /请选择档位|去办理/.test(text)) {
    return {
      state: 'package_list',
      confidence: 0.95,
      reason: 'package selection hints detected',
    };
  }

  if (finalConfirmSignals || (/确认办理|办理提醒/.test(text) && /验证码/.test(text))) {
    return {
      state: 'final_confirm',
      confidence: finalConfirmSignals ? 0.94 : 0.88,
      reason: finalConfirmSignals ? 'confirm page controls detected' : 'final confirmation wording detected',
    };
  }

  if (oneClickLogin && smsLogin) {
    return {
      state: 'entry_shell',
      confidence: 0.98,
      reason: 'one-click login shell with SMS fallback detected',
    };
  }

  if (hasPhone || hasCode || hasSendBtn || smsLogin || /获取验证码|点击获取/.test(text)) {
    return {
      state: 'sms_login_form',
      confidence: hasPhone ? 0.95 : 0.82,
      reason: hasPhone
        ? 'SMS login form fields detected'
        : 'SMS login wording detected',
    };
  }

  return {
    state: 'unknown',
    confidence: 0.35,
    reason: 'no stable telecom page pattern matched',
  };
}

module.exports = {
  classifyTelecomPageObservation,
  normalizeText,
};

const { classifyTelecomPageObservation } = require('./page-classifier');

async function observeTelecomPage(page, {
  phoneSelectors = [],
  codeSelectors = [],
  sendSelectors = [],
} = {}) {
  const observation = await page.evaluate(({ phoneSelectors: phoneList, codeSelectors: codeList, sendSelectors: sendList }) => {
    const visible = element => {
      if (!element) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && style.pointerEvents !== 'none'
        && rect.width > 0
        && rect.height > 0;
    };
    const textOf = element => String(
      element?.innerText
      || element?.textContent
      || element?.value
      || element?.getAttribute?.('placeholder')
      || element?.getAttribute?.('aria-label')
      || element?.getAttribute?.('title')
      || '',
    ).replace(/\s+/g, ' ').trim();
    const safeQueryAll = selector => {
      if (!selector) return [];
      try {
        return Array.from(document.querySelectorAll(selector));
      } catch {
        return [];
      }
    };
    const describeElement = (element, selector) => {
      const rawValue = String(element?.value || '').replace(/\s+/g, '');
      return {
        selector,
        placeholder: element.getAttribute('placeholder') || '',
        type: element.getAttribute('type') || '',
        inputMode: element.getAttribute('inputmode') || '',
        text: textOf(element).slice(0, 120),
        filled: rawValue.length > 0,
        valueLength: rawValue.length,
      };
    };
    const findByTextPattern = (selector, pattern) => safeQueryAll(selector)
      .filter(visible)
      .find(element => pattern.test(textOf(element)));
    const firstVisible = (selectors, fallback = null) => {
      for (const selector of selectors) {
        const match = safeQueryAll(selector).find(visible);
        if (match) {
          return describeElement(match, selector);
        }
      }
      if (fallback?.selector && fallback?.pattern) {
        const match = findByTextPattern(fallback.selector, fallback.pattern);
        if (match) return describeElement(match, fallback.label || '__text_fallback__');
      }
      return null;
    };
    const collectTexts = (selector, pattern, limit = 12) => safeQueryAll(selector)
      .filter(visible)
      .map(textOf)
      .filter(Boolean)
      .filter(text => pattern.test(text))
      .slice(0, limit);
    const phone = firstVisible(phoneList);
    const code = firstVisible(codeList);
    const send = firstVisible(sendList, {
      selector: 'button,a,span,div,input',
      pattern: /(获取|发送|点击获取).*(验证码|校验码|动态码|随机码)|获取验证码|发送验证码|点击获取/i,
      label: '__send_text_fallback__',
    });
    const activeNameText = textOf(document.querySelector('#activeName')).slice(0, 160);
    const packageTexts = Array.from(document.querySelectorAll('li'))
      .filter(visible)
      .map(textOf)
      .filter(Boolean)
      .filter(text => /网龄享|语音|流量|办理/.test(text))
      .slice(0, 8);
    const sliderMessage = collectTexts('.puzzle-msg,.slider-check-msg,.puzzle-title,.puzzle-verify-popup,.captcha-wrapper', /./, 6).join(' ');
    const sliderCanvas = Array.from(document.querySelectorAll('canvas')).some(element => visible(element) && element.width >= 100 && element.height >= 40);
    const sliderTrack = Array.from(document.querySelectorAll('#slider_track_btn,.slider-btn,.slider-track,.sliderContainer,.slider')).some(visible);
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState || '',
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      bodyLength: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().length,
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
      dialogs: collectTexts('#wap-dialog,.wap-dialog,.diaog-popup,#dialog-box,.puzzle-verify-popup,.van-popup', /./, 8),
      actionTexts: collectTexts('button,a,span,div,input', /登录|验证码|一键|获取|办理|确认|提交|滑块|验证|安全|规则/, 20),
      packageTexts,
      activeNameText,
      phone,
      code,
      send,
      hasPhone: !!phone,
      hasCode: !!code,
      hasSendBtn: !!send,
      hasConductBtn: !!(document.querySelector('#conduct') && visible(document.querySelector('#conduct'))),
      hasPayConfirmBtn: !!(document.querySelector('#payConfirm') && visible(document.querySelector('#payConfirm'))),
      hasSecondSmsBtn: !!(document.querySelector('#SecondConfirmationSms') && visible(document.querySelector('#SecondConfirmationSms'))),
      hasSecondCodeInput: !!(document.querySelector('#smsCodeProtocol') && visible(document.querySelector('#smsCodeProtocol'))),
      hasSecondConfirmBtn: !!(document.querySelector('#secondConfirmation') && visible(document.querySelector('#secondConfirmation'))),
      hasFinalAgreementBtn: !!(document.querySelector('#confirm2') && visible(document.querySelector('#confirm2'))),
      slider: {
        popup: Array.from(document.querySelectorAll('#secondPop_puzzle_check,.puzzle-verify-popup,.captcha-wrapper')).some(visible),
        track: sliderTrack,
        canvas: sliderCanvas,
        message: sliderMessage.slice(0, 500),
      },
    };
  }, {
    phoneSelectors,
    codeSelectors,
    sendSelectors,
  });

  const classification = classifyTelecomPageObservation(observation);
  return {
    ...observation,
    formReady: !!observation.hasPhone,
    pageState: classification.state,
    pageStateConfidence: classification.confidence,
    pageStateReason: classification.reason,
  };
}

module.exports = {
  observeTelecomPage,
};

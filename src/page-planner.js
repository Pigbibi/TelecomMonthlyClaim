function planTelecomPageAction({ goal, observation = {}, phoneFilled = false } = {}) {
  const state = observation.pageState || 'unknown';

  if (goal === 'ensure_sms_login_form') {
    if (state === 'sms_login_form' && observation.hasPhone) {
      return {
        action: 'done',
        reason: 'sms login form already ready',
      };
    }
    if (state === 'entry_shell') {
      return {
        action: 'click_sms_login_tab',
        reason: 'entry shell requires switching from one-click login to sms login',
      };
    }
    if (state === 'slider_popup' || state === 'slider_error') {
      return {
        action: 'handoff_slider',
        reason: 'slider is already blocking the login flow',
      };
    }
    if (state === 'waf_or_busy_page') {
      return {
        action: 'stop',
        reason: 'page is busy or blocked before sms login form became usable',
      };
    }
    return {
      action: 'wait',
      reason: 'wait for sms login form signals to stabilize',
      waitMs: 800,
    };
  }

  if (goal === 'trigger_login_sms_send') {
    if (state === 'entry_shell') {
      return {
        action: 'click_sms_login_tab',
        reason: 'sms send can only happen from sms login form',
      };
    }
    if (state === 'slider_popup' || state === 'slider_error') {
      return {
        action: 'handoff_slider',
        reason: 'slider verification already opened',
      };
    }
    if (state === 'waf_or_busy_page') {
      return {
        action: 'stop',
        reason: 'page is busy or blocked before sms send',
      };
    }
    if (state === 'sms_login_form' && observation.hasSendBtn) {
      return {
        action: phoneFilled ? 'click_login_sms_send' : 'fill_phone_first',
        reason: phoneFilled ? 'sms send button is ready' : 'phone must be filled before requesting code',
      };
    }
    if (state === 'sms_login_form') {
      return {
        action: 'wait',
        reason: 'sms login form visible but send control not ready yet',
        waitMs: 800,
      };
    }
    return {
      action: 'wait',
      reason: 'wait for a clearer login page state before triggering sms send',
      waitMs: 800,
    };
  }

  if (goal === 'reach_confirm_page_after_package_select') {
    if (state === 'final_confirm') {
      return {
        action: 'done',
        reason: 'confirm page already reached',
      };
    }
    if (state === 'package_list') {
      return {
        action: 'select_target_package',
        reason: 'package selection page is ready',
      };
    }
    if (state === 'waf_or_busy_page') {
      return {
        action: 'stop',
        reason: 'page is busy or blocked before package selection completed',
      };
    }
    return {
      action: 'wait',
      reason: 'wait for package page or confirm page to stabilize',
      waitMs: 1000,
    };
  }

  if (goal === 'complete_final_submit') {
    if (state === 'success_page') {
      return {
        action: 'done',
        reason: 'success page already reached',
      };
    }
    if (state !== 'final_confirm') {
      return {
        action: 'wait',
        reason: 'wait for final confirm page state',
        waitMs: 1000,
      };
    }
    if (observation.hasFinalAgreementBtn && !observation.hasSecondConfirmBtn) {
      return {
        action: 'click_final_agreement',
        reason: 'final agreement button is blocking success completion',
      };
    }
    if (observation.dryRunReady) {
      return {
        action: 'stop_before_final_submit',
        reason: 'dry run reached final submit boundary',
      };
    }
    if (observation.confirmCodeFilled && observation.hasSecondConfirmBtn) {
      return {
        action: 'click_second_confirmation',
        reason: 'confirmation code is filled and final submit button is ready',
      };
    }
    if (observation.hasSecondCodeInput && !observation.confirmCodeFilled) {
      return {
        action: 'fill_confirm_code_first',
        reason: 'confirmation code input is visible before final submit',
      };
    }
    if (observation.afterSecondConfirmation) {
      return {
        action: 'wait_for_success',
        reason: 'waiting for success page after final submit click',
        waitMs: 1500,
      };
    }
    return {
      action: 'wait',
      reason: 'wait for final confirm controls to stabilize',
      waitMs: 1000,
    };
  }

  return {
    action: 'stop',
    reason: `unsupported goal: ${goal}`,
  };
}

module.exports = {
  planTelecomPageAction,
};

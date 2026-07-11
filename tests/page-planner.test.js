const test = require('node:test');
const assert = require('node:assert/strict');
const { planTelecomPageAction } = require('../src/page-planner');

test('planner switches entry shell to sms login form', () => {
  const plan = planTelecomPageAction({
    goal: 'ensure_sms_login_form',
    observation: { pageState: 'entry_shell' },
  });

  assert.equal(plan.action, 'click_sms_login_tab');
});

test('planner marks sms login form ready when phone input is visible', () => {
  const plan = planTelecomPageAction({
    goal: 'ensure_sms_login_form',
    observation: { pageState: 'sms_login_form', hasPhone: true },
  });

  assert.equal(plan.action, 'done');
});

test('planner asks to fill phone before sms send', () => {
  const plan = planTelecomPageAction({
    goal: 'trigger_login_sms_send',
    observation: { pageState: 'sms_login_form', hasSendBtn: true },
    phoneFilled: false,
  });

  assert.equal(plan.action, 'fill_phone_first');
});

test('planner clicks send when sms form is ready and phone is filled', () => {
  const plan = planTelecomPageAction({
    goal: 'trigger_login_sms_send',
    observation: { pageState: 'sms_login_form', hasSendBtn: true },
    phoneFilled: true,
  });

  assert.equal(plan.action, 'click_login_sms_send');
});

test('planner hands off when slider is already visible', () => {
  const plan = planTelecomPageAction({
    goal: 'trigger_login_sms_send',
    observation: { pageState: 'slider_popup' },
    phoneFilled: true,
  });

  assert.equal(plan.action, 'handoff_slider');
});

test('planner selects package from package list page', () => {
  const plan = planTelecomPageAction({
    goal: 'reach_confirm_page_after_package_select',
    observation: { pageState: 'package_list' },
  });

  assert.equal(plan.action, 'select_target_package');
});

test('planner stops at dry-run boundary before final submit', () => {
  const plan = planTelecomPageAction({
    goal: 'complete_final_submit',
    observation: { pageState: 'final_confirm', dryRunReady: true, hasSecondConfirmBtn: true },
  });

  assert.equal(plan.action, 'stop_before_final_submit');
});

test('planner clicks second confirmation when code is filled', () => {
  const plan = planTelecomPageAction({
    goal: 'complete_final_submit',
    observation: { pageState: 'final_confirm', confirmCodeFilled: true, hasSecondConfirmBtn: true },
  });

  assert.equal(plan.action, 'click_second_confirmation');
});

test('planner clicks final agreement when it is blocking success', () => {
  const plan = planTelecomPageAction({
    goal: 'complete_final_submit',
    observation: { pageState: 'final_confirm', hasFinalAgreementBtn: true, hasSecondConfirmBtn: false },
  });

  assert.equal(plan.action, 'click_final_agreement');
});

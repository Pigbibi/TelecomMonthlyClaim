const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForSuccess } = require('../scripts/telecom-monthly-claim');

function successfulPage() {
  return {
    evaluate: async () => ({
      url: 'https://wapbj.189.cn/wap2017/index/preDeposit_result.html',
      title: '',
      htmlLength: 1200,
      bodyLength: 4,
      bodyText: '办理成功',
      dialogs: [],
      actionTexts: [],
      packageTexts: [],
      activeNameText: '',
      slider: { popup: false, track: false, canvas: false, message: '' },
      hasPhone: false,
      hasCode: false,
      hasSendBtn: false,
    }),
    url: () => 'https://wapbj.189.cn/wap2017/index/preDeposit_result.html',
  };
}

test('records the success receipt even when the browser page is already successful', async () => {
  const receipt = { stage: 'receipt', source: 'pushplus' };
  let calls = 0;
  const receiptContext = {
    since: 123,
    matched: null,
    smsInbox: {
      async waitForReceipt(options) {
        calls += 1;
        assert.deepEqual(options, { since: 123, timeoutMs: 30000, pollMs: 5000 });
        return receipt;
      },
    },
  };

  assert.equal(await waitForSuccess(successfulPage(), 10, {
    successSmsTimeoutMs: 30000,
    smsPollMs: 5000,
  }, receiptContext), true);
  assert.equal(calls, 1);
  assert.equal(receiptContext.matched, receipt);
});

test('keeps browser success when the success receipt is unavailable', async () => {
  const receiptContext = {
    since: 123,
    matched: null,
    smsInbox: { waitForReceipt: async () => null },
  };

  assert.equal(await waitForSuccess(successfulPage(), 10, {
    successSmsTimeoutMs: 30000,
    smsPollMs: 5000,
  }, receiptContext), true);
  assert.equal(receiptContext.matched, null);
});

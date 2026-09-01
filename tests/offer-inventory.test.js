const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pageFamilyFromUrl,
  extractOfferLabelsFromMeta,
  mergeOfferLabels,
} = require('../src/offer-inventory');

test('classifies page families from telecom urls', () => {
  assert.equal(pageFamilyFromUrl('https://wapbj.189.cn/echnwap/preDepositCfq_list'), 'echnwap');
  assert.equal(pageFamilyFromUrl('https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html'), 'wap2017');
  assert.equal(pageFamilyFromUrl('https://example.test/other'), 'unknown');
});

test('extracts offer labels from preActiveMeta-like payloads', () => {
  const labels = extractOfferLabelsFromMeta({
    retCode: '000000',
    data: {
      list: [
        { productName: '互联网卡网龄享200分钟国内语音' },
        { title: '3GB通用流量-网龄活动专用' },
        { name: '提交订单' },
      ],
    },
  });
  assert.deepEqual(labels.sort(), [
    '3GB通用流量-网龄活动专用',
    '互联网卡网龄享200分钟国内语音',
  ].sort());
});

test('merges unique offer labels', () => {
  assert.deepEqual(
    mergeOfferLabels(['A语音套餐'], ['A语音套餐', 'B流量套餐'], null),
    ['A语音套餐', 'B流量套餐'],
  );
});

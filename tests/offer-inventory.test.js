const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pageFamilyFromUrl,
  summarizeEntryFingerprint,
  resolveEntrySecretPolicy,
  assertEntrySecretShape,
  extractOfferLabelsFromMeta,
  mergeOfferLabels,
  classifyActivityRoute,
} = require('../src/offer-inventory');

test('classifies page families from telecom urls', () => {
  assert.equal(pageFamilyFromUrl('https://wapbj.189.cn/echnwap/preDepositCfq_list'), 'echnwap');
  assert.equal(pageFamilyFromUrl('https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html'), 'wap2017');
  assert.equal(pageFamilyFromUrl('https://example.test/other'), 'unknown');
});

test('accepts HighPic entry and rejects echnwap login entry', () => {
  assert.equal(classifyActivityRoute({
    phase: 'entry',
    url: 'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=1&version=V1',
  }).ok, true);
  assert.equal(classifyActivityRoute({
    phase: 'entry',
    url: 'https://wapbj.189.cn/echnwap/preDepositHigh_login?campaignId=1&channelId=dxts',
  }).state, 'wrong_activity');
});

test('rejects Cfq post-login divert as wrong activity', () => {
  assert.equal(classifyActivityRoute({
    phase: 'post_login',
    url: 'https://wapbj.189.cn/echnwap/preDepositCfq_list',
  }).state, 'wrong_activity');
  assert.equal(classifyActivityRoute({
    phase: 'post_login',
    url: 'https://wapbj.189.cn/wap2017/preDepositCfg_list',
  }).ok, true);
});

test('summarizes entry fingerprint without raw secrets', () => {
  const fingerprint = summarizeEntryFingerprint(
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=16239231179147085&version=V1&channelId=dx531&wxopenid=abcdef1234567890deadbeef',
  );
  assert.equal(fingerprint.pageFamily, 'wap2017');
  assert.equal(fingerprint.channelId, 'dx531');
  assert.equal(fingerprint.version, 'V1');
  assert.equal(fingerprint.hasWxopenid, true);
  assert.equal(fingerprint.hasCampaignId, true);
  assert.equal(fingerprint.campaignIdHint, '1623***7085');
  assert.deepEqual(fingerprint.queryKeys, ['campaignId', 'channelId', 'version', 'wxopenid']);
  assert.doesNotMatch(JSON.stringify(fingerprint), /abcdef1234567890deadbeef/);
});

test('entry secret shape defaults require campaignId channelId wxopenid presence only', () => {
  const policy = resolveEntrySecretPolicy({});
  assert.deepEqual(policy.requiredParams, ['campaignId', 'channelId', 'wxopenid']);
  assert.equal(policy.expectedChannelId, '');

  const good = summarizeEntryFingerprint(
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=1&channelId=other&wxopenid=x',
  );
  assert.equal(assertEntrySecretShape(good, policy).ok, true);

  const missingOpenid = summarizeEntryFingerprint(
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=1&channelId=dx531',
  );
  assert.equal(assertEntrySecretShape(missingOpenid, policy).ok, false);
});

test('entry secret shape pins channelId only when TELECOM_EXPECTED_CHANNEL_ID is set', () => {
  const policy = resolveEntrySecretPolicy({
    TELECOM_ENTRY_REQUIRED_PARAMS: 'campaignId,channelId,wxopenid',
    TELECOM_EXPECTED_CHANNEL_ID: 'dx531',
  });
  const ok = summarizeEntryFingerprint(
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=1&channelId=dx531&wxopenid=x',
  );
  const bad = summarizeEntryFingerprint(
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=1&channelId=other&wxopenid=x',
  );
  assert.equal(assertEntrySecretShape(ok, policy).ok, true);
  assert.match(assertEntrySecretShape(bad, policy).reason, /channelId=other expected dx531/);
});

test('entry secret shape can disable required params via empty env', () => {
  const policy = resolveEntrySecretPolicy({ TELECOM_ENTRY_REQUIRED_PARAMS: '' });
  const bare = summarizeEntryFingerprint(
    'https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html',
  );
  assert.equal(assertEntrySecretShape(bare, policy).ok, true);
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

# Development and troubleshooting

## Local checks

Use Node.js 20 or newer:

```bash
npm ci
npm run lint
npm test
```

The full test suite uses local fixtures and must not contact the carrier,
PushPlus, Telegram, a visual provider, or a real SMS inbox.

## Local configuration

Copy the safe placeholder file outside version control and fill only a test
account or disposable environment:

```bash
cp .env.example .env.local
```

Do not commit `.env.local`. The repository script reads environment variables;
load the file with your preferred local shell tooling.

## Chrome CDP dry-run

The helper starts a real Chrome process and stops before final submission by
default:

```bash
TELECOM_PHONE='test-number' \
TELECOM_ENTRY_URL='https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=replace&version=V1&channelId=replace&wxopenid=replace' \
TELECOM_TARGET_PACKAGE=voice200 \
TELECOM_ENTRY_REQUIRED_PARAMS='campaignId,channelId,wxopenid' \
SMS_INBOX_PROVIDER=pushplus \
PUSHPLUS_TOKEN='replace-me' \
PUSHPLUS_SECRET_KEY='replace-me' \
npm run claim:cdp
```

This can still request real SMS messages. Vision fallback stays off unless you
set `TELECOM_VISION_FALLBACK=true`. Use workflow probe mode when the goal is
only to verify page loading without submitting the login challenge.

## Common failures

### Entry URL shape / activity rejected

- Confirm `TELECOM_ENTRY_URL` is HTTPS (or `http://wapbj.189.cn`, which is
  normalized) and includes the keys in `TELECOM_ENTRY_REQUIRED_PARAMS`.
- If you set `TELECOM_EXPECTED_CHANNEL_ID`, the entry `channelId` must match.
- Stock `voice200` expects HighPic entry and post-login `wap2017` Cfg pages;
  `echnwap/preDepositCfq_*` is a hard `wrong_activity` failure.
- Run probe mode and inspect the redacted entry fingerprint / route diagnostics.
- Refresh the official share link when the campaign rotates; do not claim
  unconfigured alternate packs.

### Slider challenge fails

- Confirm the workflow started real Chrome and connected to the expected CDP
  page.
- Prefer local canvas match logs (`flat-component` / `canvas-transparent-*`)
  before enabling vision fallback.
- Compare the current challenge with local fixtures before changing matching
  thresholds.
- Keep retry counts bounded to avoid repeated challenge or SMS requests.
- Do not log screenshots that contain account data or one-time codes.

### SMS timeout

- Confirm the selected provider and sender filters.
- Check PushPlus token type and Open API secret key.
- Check relay or HTTP inbox authorization and network reachability.
- Temporarily enable `PUSHPLUS_DEBUG=true` only after confirming logs remain
  redacted.
- Avoid increasing `SEND_CODE_ATTEMPTS` until message delivery is understood.

### Product or plan mismatch

Do not bypass the check. Reconfirm the campaign, package preset, exact product
name, and plan ID. Update configuration and tests together when the carrier
legitimately changes a supported package.

### Duplicate month state

Inspect `state/YYYY-MM.json`. Use `force_run=true` only when an operator has
verified that a rerun is safe. A successful carrier page may mean the benefit is
already claimed even if earlier automation metadata is incomplete.

## Test contributions

Add sanitized fixtures for parser, planner, page classifier, slider, SMS, or
workflow-policy changes. Fixtures must not contain real phone numbers, OTPs,
entry URLs with account identifiers, order IDs, private proxies, or provider
credentials.

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
TELECOM_ENTRY_URL='https://wapbj.189.cn/current-entry' \
TELECOM_TARGET_PACKAGE=voice200 \
SMS_INBOX_PROVIDER=pushplus \
PUSHPLUS_TOKEN='replace-me' \
PUSHPLUS_SECRET_KEY='replace-me' \
npm run claim:cdp
```

This can still request real SMS messages and send challenge data to a configured
visual provider. Use workflow probe mode when the goal is only to verify page
loading without submitting the login challenge.

## Common failures

### Entry page cannot be classified

- Confirm `TELECOM_ENTRY_URL` is current and uses HTTPS.
- Run probe mode and inspect the redacted page classification.
- Check the effective connectivity mode and proxy health.
- Treat an unknown page or popup as a failure; do not add a broad selector that
  clicks through unrecognized content.

### Slider challenge fails

- Confirm the workflow started real Chrome and connected to the expected CDP
  page.
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

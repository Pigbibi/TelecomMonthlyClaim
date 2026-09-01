# Configuration

Use GitHub Actions secrets for credentials and account data. Use repository
variables only for non-secret behavior. A private deployment repository is
recommended because campaign URLs and workflow metadata may still reveal
account-specific context.

The local [`.env.example`](../.env.example) uses placeholders and safe dry-run
defaults.

## Workflow inputs

The monthly and manual workflows expose these controls:

| Input | Default | Purpose |
| --- | --- | --- |
| `probe_only` | `false` | Load the entry and login challenge without submitting it or sending SMS |
| `dry_run` | `false` in monthly workflow | Stop before the final carrier submit action |
| `force_run` | `false` in monthly workflow | Ignore successful month state and run again |
| `connectivity_mode` | `auto` in monthly workflow | Select `auto`, `direct`, `http_proxy`, `ssh_tunnel`, or `proxy_pool` |

The self-hosted diagnostic workflow defaults to `dry_run=true` and
`force_run=true`. It is not part of the monthly schedule.

Probe mode is the safest first check. Dry-run may still request and process SMS
verification codes.

## Required account settings

| Name | Storage | Purpose |
| --- | --- | --- |
| `TELECOM_PHONE` | secret | Authorized Beijing Telecom phone number |
| `TELECOM_ENTRY_URL` | secret preferred; variable fallback | Current HTTPS campaign entry URL |
| `TELECOM_TARGET_PACKAGE` | variable | `voice200` or `5g`; defaults to `voice200` |

Package presets:

| Preset | Product | Plan ID |
| --- | --- | --- |
| `voice200` | 互联网卡网龄享200分钟国内语音 | `24BJ102053` |
| `5g` | 互联网卡网龄享5GB国内通用流量 | `24BJ100433` |

To use another package, set all of:

```text
TELECOM_TARGET_PACKAGE=custom
TELECOM_PRODUCT_NAME=exact product name shown by the carrier
TELECOM_EXPECTED_PLAN_ID=exact plan identifier
```

The script validates the selected product and confirmation SMS against these
values before final submission.

## Timing and retry settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELECOM_ACTION_DELAY_MS` | `800` | Delay between important page actions |
| `TELECOM_POST_SUCCESS_WAIT_MS` | `8000` | Keep the success page open before closing Chrome |
| `SEND_CODE_ATTEMPTS` | workflow sets `1` | Maximum send-code attempts |
| `SMS_TIMEOUT_MS` | `90000` | Wait for a verification SMS |
| `SMS_POLL_MS` | `5000` | SMS polling interval |
| `TELECOM_SUCCESS_SMS_TIMEOUT_MS` | `30000` | Wait for a success receipt after submit |
| `FAIL_ONLY_FINAL_DAY` | scheduled runs set `true` | Suppress scheduled failure before the final retry day |
| `FINAL_RETRY_DAY` | `3` | Day of month considered the final retry |

Increasing attempts or shortening polling intervals can request more OTPs or
increase provider traffic. Change them only after reviewing the failure mode.

## Browser settings

The included workflows start a real Chrome process and connect through CDP.
Common operator-facing settings:

| Variable | Workflow value | Purpose |
| --- | --- | --- |
| `HEADLESS` | `false` | Run Chrome with a visible display through Xvfb or a local desktop |
| `BROWSER_CHANNEL` | `chrome` | Browser channel |
| `BROWSER_CDP_URL` | `http://127.0.0.1:9222` | CDP endpoint created by the workflow |
| `TELECOM_REQUIRE_REAL_CHROME` | `true` | Refuse a non-Chrome fallback |
| `TELECOM_MINIMAL_LOGIN` | `true` | Use the bounded login path |
| `TELECOM_SKIP_ORIGIN_WARMUP` | `true` | Open the configured entry directly |
| `TELECOM_SLIDER_MODE` | `api` | Use the supported current slider submission path |

These settings describe the browser harness, not a promise that a carrier
challenge will remain compatible.

## Optional visual service

The script can ask a configured visual API for a second opinion on the current
slider challenge.

| Setting | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | unset | Credential for the default visual provider |
| `TELECOM_VISION_URL` | Gemini generate-content endpoint | API endpoint |
| `TELECOM_VISION_MODE` | `gemini` | `gemini`, `openai`, or `anthropic` request format |
| `TELECOM_VISION_MODEL` | `gemini-3.5-flash` | Provider model name |

Using an external visual service sends challenge image data to that provider.
Review its data policy and do not assume it will improve every challenge.

## State behavior

The monthly workflow writes `state/YYYY-MM.json` to `main`.

| Status | Meaning | Schedule / Issue |
| --- | --- | --- |
| `success` | Claimed or already claimed | Skip later ordinary runs |
| `skipped_unavailable` | Logged in, but configured SKU not in cold-session offers | Soft skip; not an engineering failure issue |
| `failed` | Login / slider / proxy / submit error | Retry; issue only on final retry day |

A later engineering failure does not overwrite an existing `success` or
`skipped_unavailable` state.
`force_run=true` bypasses the success skip but does not erase earlier success.

If the carrier page clearly reports an already-completed claim, the run records
that page as success evidence instead of requesting another confirmation SMS.

### Warm browser vs cold automation

Your personal browser often keeps WAF cookies and may stay on the `wap2017`
entry UI with a fuller offer list and no slider. GitHub Actions uses a fresh
Chrome profile (`TELECOM_CLEAR_BROWSER_DATA=true`) and the SMS unlog path, which
commonly lands on `echnwap` and can show a different offer set. Do not treat a
warm local session as proof that CI will see the same packages. Change
`TELECOM_PRODUCT_NAME` / plan id only when you intentionally want to claim a
different SKU; otherwise leave `skipped_unavailable` alone.

## Additional guides

- [Connectivity](connectivity.md)
- [SMS providers](sms-providers.md)
- [Development and troubleshooting](development.md)

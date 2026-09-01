# Configuration

Use GitHub Actions **secrets** for credentials and account-bound data. Use
repository **variables** only for non-secret behavior.

This repository is open-source. Do **not** commit personal campaign links,
`wxopenid` values, phone numbers, or provider tokens. Prefer a private
deployment fork/repo for live secrets, or keep secrets only in GitHub Actions /
local `.env` files that stay untracked.

The local [`.env.example`](../.env.example) uses placeholders and safe dry-run
defaults.

## Workflow inputs

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

## Account and package settings

| Name | Storage | Purpose |
| --- | --- | --- |
| `TELECOM_PHONE` | secret | Authorized Beijing Telecom phone number |
| `TELECOM_ENTRY_URL` | **secret** (variable fallback only if non-sensitive) | Current HTTPS campaign entry URL |
| `TELECOM_TARGET_PACKAGE` | variable | `voice200` or `5g`; defaults to `voice200` |
| `TELECOM_PRODUCT_NAME` | variable | Override product label; otherwise taken from package preset |
| `TELECOM_EXPECTED_PLAN_ID` | variable | Override plan id; otherwise taken from package preset |

Package presets:

| Preset | Product | Plan ID |
| --- | --- | --- |
| `voice200` | 互联网卡网龄享200分钟国内语音 | `24BJ102053` |
| `5g` | 互联网卡网龄享5GB国内通用流量 | `24BJ100433` |

Custom package:

```text
TELECOM_TARGET_PACKAGE=custom
TELECOM_PRODUCT_NAME=exact product name shown by the carrier
TELECOM_EXPECTED_PLAN_ID=exact plan identifier
```

## Entry URL: open-source vs deployment

Open-source code ships **gates and recipes**, not personal campaign values.

### What belongs in code

For the stock `voice200` recipe the runner expects:

1. Entry path family `wap2017` + `preDepositHighPic_check.html`
2. After SMS login, stay on `wap2017` (typically `preDepositCfg_*`)
3. Treat `echnwap/preDepositCfq_*` (and other echnwap package shells) as
   `wrong_activity` hard failure — never soft-skip into unconfigured data packs

### What belongs in each deployment

| Name | Storage | Default | Purpose |
| --- | --- | --- | --- |
| `TELECOM_ENTRY_URL` | secret | required | Full share link for **your** eligible account |
| `TELECOM_ENTRY_REQUIRED_PARAMS` | variable | `campaignId,channelId,wxopenid` | Query **keys** that must be present. Values are never compared. Set empty to disable. |
| `TELECOM_EXPECTED_CHANNEL_ID` | variable | unset | Optional exact `channelId` pin for **your** fork |

Before navigation the runner:

1. Logs a redacted entry fingerprint (`hasWxopenid`, `channelId`, `campaignIdHint`, …)
2. Asserts required query keys from `TELECOM_ENTRY_REQUIRED_PARAMS`
3. Optionally pins `channelId` when `TELECOM_EXPECTED_CHANNEL_ID` is set
4. Asserts the HighPic path/family hard gate

Placeholder shape (safe to document; **do not** commit real openids):

```text
https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=<id>&version=V1&channelId=<channel>&wxopenid=<openid>
```

Notes:

- `http://wapbj.189.cn/...` is normalized to `https://` automatically.
- Put the real share link only in `TELECOM_ENTRY_URL`.
- Forks that always use one channel (for example `dx531`) should set
  `TELECOM_EXPECTED_CHANNEL_ID` as a repository variable — not in source.

### Monthly operator checklist

1. Confirm `TELECOM_ENTRY_URL` still matches the placeholder shape and required keys.
2. Prefer a private-window check of the **same** URL before relying on a warm browser.
3. Run `dry_run=true` once near month start if the campaign may have rotated.
4. On `wrong_activity` or missing keys: refresh the WeChat/official share link and
   update the secret — do not claim unconfigured alternate packs.

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

## Browser settings

| Variable | Workflow value | Purpose |
| --- | --- | --- |
| `HEADLESS` | `false` | Run Chrome with a visible display through Xvfb or a local desktop |
| `BROWSER_CHANNEL` | `chrome` | Browser channel |
| `BROWSER_CDP_URL` | `http://127.0.0.1:9222` | CDP endpoint created by the workflow |
| `TELECOM_REQUIRE_REAL_CHROME` | `true` | Refuse a non-Chrome fallback |
| `TELECOM_MINIMAL_LOGIN` | `true` | Use the bounded login path |
| `TELECOM_SKIP_ORIGIN_WARMUP` | `true` | Open the configured entry directly |
| `TELECOM_SLIDER_MODE` | `api` | Use the supported current slider submission path |

## Slider matching

Slider geometry defaults to **local canvas matching** (`flat-component` /
rendered crop). Vision AI is off unless `TELECOM_VISION_FALLBACK=true`.
CodexGateway is not injected by the monthly claim workflow.

| Setting | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | unset | Only used when vision fallback is explicitly enabled |
| `TELECOM_VISION_FALLBACK` | unset/`false` | Set `true` to allow Gemini/HTTP after local match fails |
| `TELECOM_VISION_URL` | Gemini generate-content endpoint | API endpoint for optional fallback |
| `TELECOM_VISION_MODE` | `gemini` | `gemini`, `openai`, or `anthropic` request format |
| `TELECOM_VISION_MODEL` | provider default | Provider model name |

Using an external visual service sends challenge image data to that provider.
Review its data policy and do not assume it will improve every challenge.

## State behavior

The monthly workflow writes `state/YYYY-MM.json` to `main`.

| Status | Meaning | Schedule / Issue |
| --- | --- | --- |
| `success` | Claimed or already claimed | Skip later ordinary runs |
| `skipped_unavailable` | Logged in on the **expected** Cfg activity, but configured SKU not in offers | Soft skip; not an engineering failure issue |
| `failed` | Login / slider / proxy / submit error, wrong entry shape, or **wrong activity page** | Retry; issue only on final retry day |

A later engineering failure does not overwrite an existing `success` or
`skipped_unavailable` state.
`force_run=true` bypasses the success skip but does not erase earlier success.

If the carrier page clearly reports an already-completed claim, the run records
that page as success evidence instead of requesting another confirmation SMS.

## Warm browser vs cold automation

A personal browser often keeps WAF cookies and may show a fuller offer list
without a slider. GitHub Actions uses a fresh Chrome profile
(`TELECOM_CLEAR_BROWSER_DATA=true`) and the SMS unlog path.

Observed cold divert (2026-09) with an incomplete or wrong entry landed on
`/echnwap/preDepositCfq_list` (data-only). With a complete HighPic share link
(`campaignId` + `channelId` + `wxopenid`), cold CI reached `wap2017`
`preDepositCfg_*` with `voice200`.

Recovery order:

1. Private-window check of the same entry. Data-only there means the cold
   catalog likely has no voice for that link.
2. Refresh the official/WeChat share entry and update `TELECOM_ENTRY_URL`.
3. Leave `wrong_activity` failed; do not claim unconfigured 3GB packs.

Do not treat a warm local session as proof that CI will see the same packages.

## Additional guides

- [Connectivity](connectivity.md)
- [SMS providers](sms-providers.md)
- [Development and troubleshooting](development.md)

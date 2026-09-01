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
| `TELECOM_ENTRY_URL` | secret preferred; variable fallback | Current HTTPS campaign entry URL (keep full share link out of git) |
| `TELECOM_ENTRY_REQUIRED_PARAMS` | `campaignId,channelId,wxopenid` | Query keys that must be present on the entry URL; empty disables presence checks. Values are never compared. |
| `TELECOM_EXPECTED_CHANNEL_ID` | unset | Optional exact `channelId` pin for your deployment (example: `dx531`). Unset = any channelId allowed. |
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
Slider geometry defaults to **local canvas matching** (`flat-component` /
rendered crop). Vision AI is off unless `TELECOM_VISION_FALLBACK=true`.
CodexGateway is not injected by the monthly claim workflow.

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
| `failed` | Login / slider / proxy / submit error, or **wrong activity page** (for example echnwap `preDepositCfq_*`) | Retry; issue only on final retry day |

A later engineering failure does not overwrite an existing `success` or
`skipped_unavailable` state.
`force_run=true` bypasses the success skip but does not erase earlier success.

If the carrier page clearly reports an already-completed claim, the run records
that page as success evidence instead of requesting another confirmation SMS.

### Expected activity hard gate (`voice200`)

Only continue when both are true:

1. Entry URL is `wap2017` `preDepositHighPic_check.html` (orange 成长礼 shell).
2. After SMS login the session stays on `wap2017` (typically `preDepositCfg_*`).

Landing on `echnwap/preDepositCfq_*` (or any other echnwap package shell) is a
**hard failure** (`wrong_activity`), not a soft skip. Do not claim alternate
data packs from the diverted catalog.

### Entry URL shape (open-source deployments)

Code never ships a personal `campaignId` / `wxopenid` / channel pin. Before
navigation it only checks:

1. Path/family hard gate above.
2. Presence of keys listed in `TELECOM_ENTRY_REQUIRED_PARAMS` (default
   `campaignId,channelId,wxopenid`).
3. Exact `channelId` **only if** you set `TELECOM_EXPECTED_CHANNEL_ID` (repo
   variable for your fork — not required for every consumer).

Example placeholder (do not commit real openids):

`https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=<id>&version=V1&channelId=<channel>&wxopenid=<openid>`

Store the real share link only in `TELECOM_ENTRY_URL` (GitHub secret / local env).

### Warm browser vs cold automation

Your personal browser often keeps WAF cookies and may stay on the `wap2017`
entry UI with a fuller offer list and no slider. GitHub Actions uses a fresh
Chrome profile (`TELECOM_CLEAR_BROWSER_DATA=true`) and the SMS unlog path.

Observed cold-login route (2026-09): after `validRandUnlog` succeeds the site
calls `preDepositInitNew` / `preActiveMeta` and lands on
`/echnwap/preDepositCfq_list` with data-only offers (1GB/2GB/3GB). August cold
CI still reached `wap2017` `preDepositCfg_*` with `voice200`, so this is a
carrier post-login catalog/routing change, not missing SSH tunnel.

Recovery options, in order:
1. Private-window check of the same entry (no existing cookies). If you also
   only see data packs, the campaign cold catalog no longer includes voice.
2. Fresh WeChat / official share entry for the September voice entitlement, then
   update `TELECOM_ENTRY_URL` (keep secrets out of git).
3. Do not claim unconfigured 3GB; leave the run failed on `wrong_activity` until
   a correct Cfg entry/session is available.

Do not treat a warm local session as proof that CI will see the same packages.

## Additional guides

- [Connectivity](connectivity.md)
- [SMS providers](sms-providers.md)
- [Development and troubleshooting](development.md)

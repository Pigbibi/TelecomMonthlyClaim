# Beijing Telecom monthly 5GB / 200-minute setup

This guide helps open-source users map the public **Beijing Telecom**
“网龄 / 成长” style monthly benefit (5GB data **or** 200 minutes voice) onto
this repository’s configuration.

It is **not** an official China Telecom document. Campaign pages, short links,
WeChat keywords, product names, and eligibility rules change without notice.
Always confirm what **your** account sees on the live page before enabling
final submit.

## What the public campaign usually is

Community write-ups commonly describe a Beijing-only monthly perk for eligible
internet-card / 无忧卡 style lines (examples: 星卡、京粉卡、米粉卡、无忧卡):

| Topic | Typical public description |
| --- | --- |
| Benefit | **5GB** domestic general data **or** **200 minutes** domestic voice (choose one) |
| Cadence | Once per month; many posts say you can claim again next month |
| Tenure | Often “in-network ≥ 1 year” for the 5GB / 200-minute tier; shorter tenure may only see smaller data packs |
| Region | Beijing Telecom numbers only |
| Manual entry | WeChat official account **北京电信** → reply **`533`**; China Telecom App search **网龄礼**; short links such as `bb.bj.cn/bjdx` / `wapbj.189.cn/xkwlhd?channelId=dx533` |

Public posts disagree on **当月生效 vs 次月生效** depending on which portal you
use (App “网龄礼” vs some WAP share links). Trust the rule text on the page you
actually open.

Reference examples (third-party roundups; links rot):

- [爱吾线报 · 北京电信用户专享福利](https://25xianbao.com/archives/16287)
- [爱吾线报 · 网龄与成长权益入口汇总](https://25xianbao.com/archives/18286)
- [线报酷 · App/客服分享入口讨论](https://new.ixbk.net/douban-maizu/6194874.html)

## What this repository automates

Stock automation targets the **成长礼 / HighPic** WAP shell that cold CI has
successfully used for package selection on `wap2017`:

| Stage | Expected page family |
| --- | --- |
| Entry | `wap2017` + `preDepositHighPic_check.html` |
| After SMS login | stay on `wap2017`, typically `preDepositCfg_list` / `preDepositCfg_confirm` |
| Reject | `echnwap/preDepositCfq_*` and other echnwap package shells → `wrong_activity` |

Public roundups often list a **成长礼** base path like:

```text
https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=16239231179147085&version=V1
```

That `campaignId` appears repeatedly in community posts for **成长礼**. It is a
**public path hint**, not a guarantee for every account or month. Your live
share link may add `channelId` and `wxopenid`; cold GitHub runners usually need
those query keys present.

### Campaigns this stock recipe does **not** claim

Do not point `TELECOM_ENTRY_URL` at unrelated or alternate shells unless you
intentionally change gates and product validation:

| Public label (examples) | Typical host path | Stock recipe |
| --- | --- | --- |
| 成长礼 / HighPic monthly choose | `wap2017/.../preDepositHighPic_check.html` | Supported target |
| 网龄礼包 login | `echnwap/preDepositHigh_login?...` | Not the stock entry gate |
| Cfq data-only list | `echnwap/preDepositCfq_*` | Hard-fail (`wrong_activity`) |
| 签到送流量 / 充值礼 / 见面礼 / 福袋 | other HighPic `campaignId`s | Different campaigns — do not reuse blindly |

## Built-in package presets

Set **one** target with `TELECOM_TARGET_PACKAGE`:

| Preset | Carrier product name used by the runner | Plan ID |
| --- | --- | --- |
| `voice200` (default) | `互联网卡网龄享200分钟国内语音` | `24BJ102053` |
| `5g` | `互联网卡网龄享5GB国内通用流量` | `24BJ100433` |

Only claim the SKU you configured. If the page shows both offers, the runner
still clicks / validates the selected preset only.

Override only when the live page wording or plan id really changed:

```text
TELECOM_TARGET_PACKAGE=custom
TELECOM_PRODUCT_NAME=<exact on-page product name>
TELECOM_EXPECTED_PLAN_ID=<exact plan id>
```

## Step-by-step: obtain your entry URL

1. Prefer an official path you control:
   - WeChat **北京电信** → reply the current keyword (community posts often cite `533`), **or**
   - China Telecom App → search **网龄礼 / 成长礼**, **or**
   - Customer-service shared WAP link for your number.
2. Open the link on your phone, then copy the **final** browser/WAP URL after
   redirects (not only a short link like `bb.bj.cn/...`).
3. Prefer a URL that already looks like HighPic:

```text
https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=...&version=V1&channelId=...&wxopenid=...
```

4. In a **private window** (no existing telecom cookies), open the same URL and
   confirm you can reach an offer list that includes the SKU you want
   (`200分钟` and/or `5GB`). Warm WeChat sessions can look healthier than cold CI.
5. Put the full URL into the GitHub secret `TELECOM_ENTRY_URL` (never commit it).
   `http://wapbj.189.cn/...` is accepted and normalized to `https://`.

### Query parameters explained

| Query key | Role | Open-source policy |
| --- | --- | --- |
| `campaignId` | Which activity shell | Required by default (presence only) |
| `version` | Activity version string (often `V1`) | Optional; keep if your share link has it |
| `channelId` | Channel /投放 id (examples in the wild: `dx531`, `dx533`, …) | Presence required by default; optionally pin with `TELECOM_EXPECTED_CHANNEL_ID` |
| `wxopenid` | Account-bound WeChat open id on many share links | Presence required by default; **never** commit the value |

Env knobs:

| Name | Storage | Default | Meaning |
| --- | --- | --- | --- |
| `TELECOM_ENTRY_URL` | secret | required | Full personal share link |
| `TELECOM_ENTRY_REQUIRED_PARAMS` | variable | `campaignId,channelId,wxopenid` | Keys that must exist |
| `TELECOM_EXPECTED_CHANNEL_ID` | variable | unset | Exact `channelId` pin for **your** fork only |

## Example deployment settings

### Claim 200 minutes (`voice200`)

Repository secrets:

```text
TELECOM_PHONE=<your Beijing number>
TELECOM_ENTRY_URL=<your full HighPic share URL including wxopenid>
```

Repository variables:

```text
TELECOM_TARGET_PACKAGE=voice200
TELECOM_ENTRY_REQUIRED_PARAMS=campaignId,channelId,wxopenid
# Optional if your channel is stable, e.g. dx531:
# TELECOM_EXPECTED_CHANNEL_ID=dx531
```

SMS / proxy secrets stay as in [configuration.md](configuration.md) and
[sms-providers.md](sms-providers.md).

### Claim 5GB instead (`5g`)

Same entry URL shape if your HighPic / Cfg list still offers both SKUs. Only
change the package preset:

```text
TELECOM_TARGET_PACKAGE=5g
```

Product name / plan id then come from the built-in `5g` preset unless you
override them.

## Verify before a real submit

1. `probe_only=true` — loads entry + login slider, no SMS.
2. Inspect Actions logs for:
   - entry fingerprint: `hasCampaignId`, `hasWxopenid`, `channelId`
   - post-login path under `wap2017` / `preDepositCfg_*`
   - offer labels containing your target product
3. `dry_run=true` — may consume login/confirm SMS, stops before final submit.
4. Only then `dry_run=false`.

If cold CI lands on `echnwap/preDepositCfq_*` or only small data packs:

1. Refresh the official share link for **this month** and update the secret.
2. Do not “fix” it by claiming an unconfigured 1GB/2GB/3GB pack.
3. Re-check eligibility on the live page (tenure / card type / already claimed).

## Security notes for forks

- Keep account-bound URLs and openids in **secrets**, not git.
- Prefer a private deployment repository for live runs.
- Redacted logs intentionally hide phone numbers, OTPs, and openid values;
  rely on fingerprint fields (`campaignIdHint`, `hasWxopenid`, …) when debugging.

## Related docs

- [Configuration](configuration.md) — all env knobs and state behavior
- [Connectivity](connectivity.md) — direct / proxy / SSH tunnel
- [SMS providers](sms-providers.md) — PushPlus / HTTP inbox
- [Development and troubleshooting](development.md) — local dry-run and failures

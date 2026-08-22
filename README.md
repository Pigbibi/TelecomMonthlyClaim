# TelecomMonthlyClaim

[简体中文](README_CN.md)

[![Monthly workflow](https://github.com/Pigbibi/TelecomMonthlyClaim/actions/workflows/monthly-claim.yml/badge.svg)](https://github.com/Pigbibi/TelecomMonthlyClaim/actions/workflows/monthly-claim.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](package.json)

Automate the Beijing Telecom monthly benefit claim flow with a real Chrome
session, SMS verification, explicit package validation, and month-scoped state.
The included workflow can select either the supported voice or data package.

## Important notice

This is an independent, unofficial automation project. It is not affiliated
with or endorsed by China Telecom. Carrier pages, campaigns, eligibility,
verification challenges, package names, and terms can change without notice.

Start with `probe_only=true` and `dry_run=true`. Confirm every selected product,
plan ID, phone number, and page before allowing a final submit. Use the project
only for an account you are authorized to manage and follow the carrier's
applicable terms. The software cannot guarantee a successful claim or prevent
account, billing, or service impact.

## Workflow

```text
GitHub Actions or an operator
        │
        ▼
real Chrome opens the configured campaign entry
        │
        ├── connectivity: direct or an operator-provided proxy
        │
        ├── SMS: PushPlus, protected relay inbox, or HTTP inbox
        │
        ▼
login verification → package selection → confirmation verification
        │
        ▼
validate phone, product, and plan → optional final submit
        │
        ▼
month state on main + redacted run metadata on logs branch
```

The scheduled workflow starts at 08:00 Asia/Shanghai on days 1–3 of each month
(`00:00 UTC`). Scheduled failures before the final retry day are recorded
without raising a failure issue. A final-day failure may create a GitHub issue.

## Features

- GitHub-hosted Chrome workflow and a separate manual self-hosted macOS workflow
  for diagnostics.
- Package presets for `voice200` and `5g`, with explicit product and plan
  validation before submission.
- `probe_only`, dry-run, and force-run controls for staged verification.
- Direct, HTTP proxy, SSH tunnel, and proxy-pool connectivity modes.
- PushPlus Open API, protected relay inbox, and generic HTTP SMS inbox support.
- Login and confirmation SMS parsing with sender, phone, product, and plan
  checks.
- Optional visual second opinion for the current slider challenge.
- Month-scoped success state that prevents an ordinary duplicate run.
- Redacted run logs that exclude phone numbers, OTPs, tokens, private keys, and
  page bodies.

## Requirements

- Node.js 20 or newer
- A current Beijing Telecom campaign entry URL for an eligible account
- Chrome or Chrome for Testing
- One supported SMS source
- Network access from the selected runner to the campaign and SMS provider
- A private deployment repository for account-specific configuration

## Quick start

### 1. Validate the checkout

```bash
npm ci
npm run lint
npm test
```

### 2. Configure the minimum settings

Repository secrets:

| Secret | Purpose |
| --- | --- |
| `TELECOM_PHONE` | Authorized Beijing Telecom phone number |
| `TELECOM_ENTRY_URL` | Current campaign entry; recommended because URLs may contain account identifiers |
| `PUSHPLUS_TOKEN` | PushPlus user token when direct Open API access is used |
| `PUSHPLUS_SECRET_KEY` | PushPlus Open API secret key |

Repository variables:

| Variable | Example | Purpose |
| --- | --- | --- |
| `TELECOM_TARGET_PACKAGE` | `voice200` | `voice200` or `5g` preset |
| `SMS_INBOX_PROVIDER` | `pushplus` | `pushplus` or `http` |
| `TELECOM_CONNECTIVITY_MODE` | `direct` | Network entry mode |

An activity URL may contain account or campaign identifiers. Use a private
deployment and store it as a secret. The workflows accept a repository variable
as a fallback only for URLs that contain no sensitive values.

### 3. Run a probe

Open **Actions → Monthly Beijing Telecom Claim → Run workflow**:

```text
probe_only=true
dry_run=true
force_run=false
connectivity_mode=direct
```

Probe mode loads the entry and login challenge without submitting the slider or
requesting an SMS. Inspect the action output before proceeding.

### 4. Run a dry-run

Set `probe_only=false` and keep `dry_run=true`. A dry-run may request and read
verification SMS messages, but stops before the final carrier submit action.

Verify the selected product name and plan ID. Then trigger an operator-approved
run with `dry_run=false`.

## State and logs

Successful month state is stored as `state/YYYY-MM.json` on `main`. It contains
the month, selected package, product name, plan ID, status, and bounded success
evidence. It does not store OTP bodies or account credentials.

Run metadata is written to the `logs` branch:

```bash
git fetch origin logs
git show origin/logs:latest.json
```

`force_run=true` bypasses the normal successful-month skip. Use it only for a
reviewed diagnostic or operator-requested rerun.

## Documentation

- [Configuration](docs/configuration.md)
- [Connectivity](docs/connectivity.md)
- [SMS providers](docs/sms-providers.md)
- [Development and troubleshooting](docs/development.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)

## Security

The workflow handles a phone number, one-time codes, carrier page content,
PushPlus credentials, proxy credentials, and optionally SSH keys. Keep the
account-specific deployment private, restrict Actions permissions, and never
print secrets or SMS bodies. Review workflow changes before they run with
credentials.

Follow [SECURITY.md](SECURITY.md) for vulnerability reports.

## License

TelecomMonthlyClaim is available under the [MIT License](LICENSE).

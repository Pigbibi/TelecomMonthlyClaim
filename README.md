# TelecomMonthlyClaim

[简体中文](README_CN.md)

Automate an authorized Beijing Telecom monthly benefit claim through Chrome, SMS verification and explicit package checks. Includes GitHub Actions workflows and a local diagnostic path.

This is an unofficial project. Campaign availability, eligibility and terms depend on the carrier. The built-in `voice200` and `5g` presets must match the actual offer shown for your account.

## Requirements

- Node.js 20+, Chrome or Chrome for Testing.
- A valid campaign entry URL and an account you are authorized to manage.
- A supported SMS source and access to the carrier's site.
- A private deployment repository for account-specific settings.

## Quick start

Install and validate the checkout:

```bash
npm ci
npm run lint
npm test
```

Configure **Actions secrets and variables**:

| Setting | Store as | Purpose |
| --- | --- | --- |
| `TELECOM_PHONE` | Secret | Authorized phone number |
| `TELECOM_ENTRY_URL` | Secret | Complete campaign link, including required account parameters |
| `PUSHPLUS_TOKEN`, `PUSHPLUS_SECRET_KEY` | Secrets | PushPlus credentials when using its Open API |
| `TELECOM_TARGET_PACKAGE` | Variable | `voice200` or `5g` |
| `SMS_INBOX_PROVIDER` | Variable | `pushplus` or `http` |
| `TELECOM_CONNECTIVITY_MODE` | Variable | For example, `direct` |

See [Configuration](docs/configuration.md) for required URL parameters and package validation, and [SMS providers](docs/sms-providers.md) for alternative inboxes.

## Run in stages

In **Actions → Monthly Beijing Telecom Claim → Run workflow**:

| Stage | Inputs | Effect |
| --- | --- | --- |
| Probe | `probe_only=true`, `dry_run=true`, `force_run=false` | Loads the entry and login challenge; does not submit the slider or request SMS |
| Dry-run | `probe_only=false`, `dry_run=true` | May request and read verification SMS; stops before final carrier submission |
| Claim | `probe_only=false`, `dry_run=false` | Can submit the selected package after validation |

Start with a probe. Confirm the phone, product and plan ID before allowing a real claim. Set `connectivity_mode=direct` when no proxy is required.

## Schedule, state and troubleshooting

The monthly workflow is scheduled for 08:00 Asia/Shanghai on days 1–3. Runs are serialized. Successful state in `state/YYYY-MM.json` prevents an ordinary duplicate run; `force_run=true` bypasses that skip and should be used deliberately.

Run metadata is stored on the `logs` branch. Success evidence must pass sender and timestamp checks. Workflow status alone does not prove that a benefit reached the account.

If the carrier rejects a verification request or returns an empty response, inspect the recorded failure and allow for carrier cooldowns. Repeated retries can add risk. Never publish phone numbers, SMS bodies, OTPs, session data or full campaign links in a bug report.

## Documentation

- [Campaign setup](docs/beijing-campaign-setup.md) · [中文配置指南](docs/beijing-campaign-setup.zh-CN.md)
- [Configuration](docs/configuration.md) · [Connectivity](docs/connectivity.md)
- [SMS providers](docs/sms-providers.md) · [Development and troubleshooting](docs/development.md)

## Support and contributing

[Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE).

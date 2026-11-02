# TelecomMonthlyClaim

[简体中文](README.zh-CN.md)

This project previously automated authorized Beijing Telecom monthly benefit claims through Chrome, SMS verification and explicit package checks.

## Campaign ended — automatic claims stopped

The previously configured Beijing campaign has ended. The carrier page returned
an ended-activity message, and the owner confirmed on 2026-11-02 that this
repository will no longer run claims. Do not expect successful claims against
the old entry URL; retrying it cannot restore the campaign.

[PR #117](https://github.com/Pigbibi/TelecomMonthlyClaim/pull/117) added
`telecom-campaign-ended`: the runner stops before login or submission when the
carrier page explicitly says the activity has ended.

The owner disabled these workflows from the Mac (`disabled_manually`):

- Monthly Beijing Telecom Claim
- Local Self-Hosted Telecom Claim
- Repository Log Heartbeat
- Gemini synthetic provider check
- Weekly all-branch secret scan

PR hygiene, risk and Gitleaks checks, Dependabot, offline regression and
engineering governance remain active. They maintain the repository; they do
not run business claims.

Keep the disabled workflows off. Resuming claims requires a **new eligible
campaign URL** and the **owner's explicit re-enablement of the claim workflows**.
The setup and run instructions below are historical reference, not steps to
restart the ended campaign.

This is an unofficial project. Campaign availability, eligibility and terms depend on the carrier. The built-in `voice200` and `5g` presets must match the actual offer shown for your account.

## Historical requirements

- Node.js 20+, Chrome or Chrome for Testing.
- A valid campaign entry URL and an account you are authorized to manage.
- A supported SMS source and access to the carrier's site.
- A private deployment repository for account-specific settings.

## Offline checks and historical configuration

Install and validate the checkout:

```bash
npm ci
npm run lint
npm test
```

The former deployment used these **Actions secrets and variables**:

| Setting | Store as | Purpose |
| --- | --- | --- |
| `TELECOM_PHONE` | Secret | Authorized phone number |
| `TELECOM_ENTRY_URL` | Secret | Complete campaign link, including required account parameters |
| `PUSHPLUS_TOKEN`, `PUSHPLUS_SECRET_KEY` | Secrets | PushPlus credentials when using its Open API |
| `TELECOM_TARGET_PACKAGE` | Variable | `voice200` or `5g` |
| `SMS_INBOX_PROVIDER` | Variable | `pushplus` or `http` |
| `TELECOM_CONNECTIVITY_MODE` | Variable | For example, `direct` |

See [Configuration](docs/configuration.md) for required URL parameters and package validation, and [SMS providers](docs/sms-providers.md) for alternative inboxes.

> **Upgrading from an older checkout?** The AIGateway v1 service and the local Gateway CLI are no longer called. Leaving a legacy `CODEX_GATEWAY_SERVICE_URL` in place makes the run stop with `vision-gateway-service-retired` instead of silently falling back. Legacy `CODEX_GATEWAY_COMMAND` / `CAPTCHA_CODEX_GATEWAY_COMMAND` stop with `vision-gateway-cli-retired`. Vision now needs an explicit HTTP URL and key.

## Historical run stages

After a new eligible campaign and explicit owner re-enablement, the workflow
would support these stages in **Actions → Monthly Beijing Telecom Claim**:

| Stage | Inputs | Effect |
| --- | --- | --- |
| Probe | `probe_only=true`, `dry_run=true`, `force_run=false` | Loads the entry and login challenge; does not submit the slider or request SMS |
| Dry-run | `probe_only=false`, `dry_run=true` | May request and read verification SMS; stops before final carrier submission |
| Claim | `probe_only=false`, `dry_run=false` | Can submit the selected package after validation |

Start with a probe. Confirm the phone, product and plan ID before allowing a real claim. Set `connectivity_mode=direct` when no proxy is required.

## Former schedule, state and troubleshooting

The disabled monthly workflow retains its former schedule of 08:00 Asia/Shanghai
on days 1–3; it no longer runs claims. Runs were serialized, with monthly state
stored in `state/YYYY-MM.json` on the `logs` branch and restored before claiming.

Successful state prevents an ordinary duplicate run. Legacy success state on `main` is retained for migration. State read errors stop the claim; `force_run=true` bypasses the success skip and should be used deliberately.

Run metadata is also stored on the `logs` branch. State persistence failures and carrier claim failures raise separate alerts — inspect the carrier result before retrying after a persistence failure.

Success evidence must pass sender and timestamp checks. Workflow status alone does not prove that a benefit reached the account.

`telecom-campaign-ended` is an early stop, not a successful claim. A replacement
`TELECOM_ENTRY_URL` alone does not authorize resuming runs; the owner must also
explicitly re-enable the claim workflows.

If the carrier rejects a verification request or returns an empty response, inspect the recorded failure and allow for carrier cooldowns. Repeated retries can add risk. Never publish phone numbers, SMS bodies, OTPs, session data or full campaign links in a bug report.

## Documentation

- [Campaign setup](docs/beijing-campaign-setup.md) · [中文配置指南](docs/beijing-campaign-setup.zh-CN.md)
- [Configuration](docs/configuration.md) · [Connectivity](docs/connectivity.md)
- [SMS providers](docs/sms-providers.md) · [Development and troubleshooting](docs/development.md)

## Support and contributing

[Support](SUPPORT.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE).

## Weekly secret scan

`Weekly all-branch secret scan` is manually disabled. Its YAML retains the former
Monday schedule of 04:23 UTC (12:23 Asia/Shanghai), but no scheduled scan is
expected while it is disabled. Keep it disabled; PR Gitleaks checks remain active.

A successful `Secret scan / Gitleaks` job verifies the scanner completed. It
does not run the application's account workflow. Findings retain paths and
rule names only; never copy secret values into logs, issues or documentation.

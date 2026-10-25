# Changelog

Behaviour changes that affect an existing deployment. Day-to-day commits are in the history.

## Vision gateway removal

The AIGateway v1 service and the local Gateway CLI are no longer called. Vision now requires an explicit HTTP URL and key.

**If you upgraded an existing deployment, check your settings.** A leftover legacy value no longer fails silently — the run stops:

| Leftover setting | Exit reason |
| --- | --- |
| `CODEX_GATEWAY_SERVICE_URL` | `vision-gateway-service-retired` |
| `CODEX_GATEWAY_COMMAND` | `vision-gateway-cli-retired` |
| `CAPTCHA_CODEX_GATEWAY_COMMAND` | `vision-gateway-cli-retired` |

The stop happens before any OIDC credential request, and it does not fall back to another provider.

What did **not** change:

- The monthly schedule (08:00 Asia/Shanghai, days 1–3).
- Claim staging, state handling, and SMS verification.
- Nothing here enables a replacement vision service — configure one explicitly or leave vision disabled.

## 2026-10 — documentation pass

README rewritten for length and structure. No behaviour change.

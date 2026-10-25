# Security policy

Security fixes target the latest release and `main` branch.

## Reporting a vulnerability

Report security vulnerabilities through [GitHub private vulnerability reporting](https://github.com/Pigbibi/TelecomMonthlyClaim/security/advisories/new). Do not post exploit details, credentials, private sessions or personal data in public issues or PRs. Include the affected version, impact and minimal redacted reproduction. The maintainer handles reports on a best-effort basis; no bounty or response-time guarantee is implied.

## Relevant issues

- secrets or OTPs exposed through logs, state, fixtures, issues, or artifacts;
- workflow changes that exfiltrate GitHub Actions secrets;
- submitting a claim for the wrong phone, product, plan, or month;
- bypassing probe, dry-run, or package-validation boundaries;
- unsafe handling of campaign URLs, proxy URLs, SSH keys, or browser profiles;
- unauthenticated SMS inbox access;
- unbounded retries that repeatedly request OTPs or submit carrier actions;
- failure state overwriting confirmed success evidence.

Carrier eligibility, page changes, and account decisions are operational risks,
not security vulnerabilities by themselves. If a credential may be exposed,
revoke or rotate it immediately.

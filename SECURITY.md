# Security policy

Security fixes target the latest release and `main` branch.

## Reporting

Do not open a public issue containing phone numbers, OTPs, activity URLs with
account identifiers, PushPlus or visual-provider credentials, SMS inbox tokens,
proxy credentials, SSH keys, browser profiles, private screenshots, or exploit
details. Use GitHub's
[private vulnerability reporting](https://github.com/Pigbibi/TelecomMonthlyClaim/security/advisories/new).
If that form is unavailable, ask for a private contact through information on
the repository owner's GitHub profile without sharing technical details
publicly.

Include the affected commit and workflow, required attacker access,
reproduction steps, possible carrier action, exposed data, and mitigation in
the private report.

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

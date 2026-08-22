# Contributing

Focused bug fixes, sanitized fixtures, documentation improvements, and security
hardening are welcome.

## Development

Requirements: Node.js 20 or newer, npm, and Bash for shell-script checks.

```bash
npm ci
npm run lint
npm test
```

Routine tests must not contact China Telecom, PushPlus, Telegram, a visual API,
an SMS inbox, a proxy, or a real browser profile.

## Safety invariants

- probe mode does not submit the login challenge or request SMS;
- dry-run stops before final carrier submission;
- phone, product, and plan checks remain mandatory before submission;
- ordinary runs respect successful month state;
- failures never overwrite an existing success state;
- retries, page scans, SMS polls, and waits remain bounded;
- logs, state, fixtures, and errors contain no OTPs, account data, credentials,
  private URLs, proxy endpoints, or page bodies;
- unknown pages and dialogs fail closed.

## Pull requests

- Work from the latest `main` on a separate branch.
- Keep one pull request focused on one behavior.
- Add sanitized tests for parser, planner, classifier, browser, SMS, state, and
  workflow-policy changes.
- Run the full lint and test commands.
- Update both READMEs and the relevant guide for user-facing changes.
- Explain carrier submission, SMS, proxy, credential, state, and workflow
  permission risks.
- Never use a real account to validate a contributor pull request.

Use [SECURITY.md](SECURITY.md) for vulnerabilities and follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Contributions use the repository's
[MIT License](LICENSE).

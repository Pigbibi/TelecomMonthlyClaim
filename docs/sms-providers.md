# SMS providers

The workflow needs the login and confirmation SMS generated for the authorized
phone number. It supports PushPlus and a generic HTTP inbox.

## PushPlus Open API

The monthly workflow sets `SMS_INBOX_PROVIDER=pushplus` unless overridden.

Secrets:

```text
PUSHPLUS_TOKEN=<user token>
PUSHPLUS_SECRET_KEY=<Open API secretKey>
```

Variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUSHPLUS_BASE_URL` | `https://www.pushplus.plus` | API origin |
| `PUSHPLUS_PAGE_SIZE` | `10` | Recent messages read per poll; maximum 50 |
| `PUSHPLUS_KEYWORD` | empty | Match title or detailed body |
| `PUSHPLUS_TITLE_KEYWORD` | empty | Pre-filter titles before detail requests |
| `PUSHPLUS_DEBUG` | `false` | Print IDs, senders, times, and match results without OTP text |
| `SMS_SENDER` | `10001` | Verification sender filter |
| `TELECOM_SUCCESS_SMS_SENDER` | `10000` | Success-receipt sender filter |

Use the PushPlus user token, not a message token. If the account enables an IP
allowlist, a GitHub-hosted runner needs a permitted egress path.

Diagnostic command:

```bash
npm run debug:pushplus
```

The diagnostic output is designed to omit SMS bodies and codes. Review changes
before running it with real credentials.

## Protected relay inbox

When [PushPlusSmsToTelegram](https://github.com/Pigbibi/PushPlusSmsToTelegram)
stores selected telecom messages in its protected inbox, configure:

```text
PUSHPLUS_RELAY_INBOX_URL=https://your-worker.example.com/messages
PUSHPLUS_RELAY_INBOX_TOKEN=<shared inbox bearer token>
```

The relay inbox is preferred over direct PushPlus Open API access when both are
configured. The included workflows acquire a bounded `telecom-claim-silent`
lease immediately before the claim step and release it afterward. Do not keep
that preset enabled statically on the relay: static interception would continue
silencing verification messages after the claim workflow ends.

The workflow run ID and attempt form a unique lease ID. A one-hour KV TTL is a
fallback for cancellation or runner loss when the always-run release step does
not execute.

## HTTP inbox

Set:

```text
SMS_INBOX_PROVIDER=http
SMS_INBOX_URL=https://sms-inbox.example.com/messages
SMS_INBOX_HEALTH_URL=https://sms-inbox.example.com/health
SMS_INBOX_TOKEN=<bearer token>
```

Expected interfaces:

```text
POST /sms
GET /messages?since=<epoch-ms>&sender=10001
GET /health
```

Authenticate with `Authorization: Bearer <token>`. The bundled local server can
be used for development:

```bash
SMS_INBOX_TOKEN='local-test-token' npm run sms-server
```

A loopback URL on a GitHub-hosted runner points to that runner, not a phone,
home computer, router, or VPS. Operators are responsible for an authenticated,
encrypted, runner-reachable network path.

## Matching and privacy

The parser distinguishes login and confirmation messages and additionally
checks configured senders, phone number, product name, and plan ID where those
fields are expected. A post-submit success receipt is treated as extra evidence;
its absence does not erase an already confirmed success page.

OTPs and SMS bodies must not be committed, persisted in month state, attached
as workflow artifacts, or pasted into issues. PushPlus, relay, HTTP inbox, and
visual-service operators remain responsible for their providers' retention and
access policies.

# Connectivity

The configured Beijing campaign has ended and automatic claims are stopped.
Keep the claim workflows disabled; resuming requires a new eligible campaign
URL and explicit owner re-enablement. The network setup and probe instructions
below are historical reference. See the [repository status](../README.md#campaign-ended--automatic-claims-stopped).

The runner must reach the carrier campaign and the selected SMS provider. This
repository accepts explicit network entry points but does not deploy a VPN,
router tunnel, proxy server, or private network.

SSH local-forward egress is retired. Prefer a public HTTP(S) proxy such as the
home WAN mixed inbound published through frp (`OPENWRT_HTTP_PROXY` /
`HOME_HTTP_PROXY`).

## Modes

| Mode | Behavior |
| --- | --- |
| `auto` | Select configured `http_proxy`, then `proxy_pool`; use direct when none is configured |
| `direct` | Connect from the runner without a proxy |
| `http_proxy` | Use an HTTP or SOCKS proxy already reachable from the runner |
| `proxy_pool` | Use one configured proxy-pool endpoint |

Keep `ALLOW_DIRECT_PROXY_FALLBACK=false` when a proxy is required for policy or
routing. Otherwise a proxy failure may change the network path.

## Direct

```text
TELECOM_CONNECTIVITY_MODE=direct
```

The runner connects to the carrier and SMS provider without creating tunnels or
using proxy variables.

## HTTP proxy

```text
TELECOM_CONNECTIVITY_MODE=http_proxy
```

Add one supported proxy secret, such as:

```text
OPENWRT_HTTP_PROXY=http://user:password@proxy.example:8080
```

The address must be reachable from the runner. `127.0.0.1` and `localhost`
refer to the runner itself. Do not use a loopback URL on a GitHub-hosted runner.

## Proxy pool

```text
TELECOM_CONNECTIVITY_MODE=proxy_pool
PROXY_POOL_HTTP_PROXY=http://user:password@pool.example:8080
```

The workflow fails before opening the carrier page when this mode is selected
without `PROXY_POOL_HTTP_PROXY`.

## Validation

Run `probe_only=true` after every network change. A successful health URL does
not prove that the campaign entry, Chrome, SMS provider, and later requests use
the expected path. Inspect redacted workflow output and verify the effective
mode printed by the connectivity step.

Never paste proxy URLs with credentials, private keys, host fingerprints, or
private addresses into issues or public logs.

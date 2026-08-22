# Connectivity

The runner must reach the carrier campaign and the selected SMS provider. This
repository accepts explicit network entry points but does not deploy a VPN,
router tunnel, proxy server, or private network.

## Modes

| Mode | Behavior |
| --- | --- |
| `auto` | Select configured `proxy_pool`, then `ssh_tunnel`, then `http_proxy`; use direct when none is configured |
| `direct` | Connect from the runner without a proxy |
| `http_proxy` | Use an HTTP or SOCKS proxy already reachable from the runner |
| `ssh_tunnel` | Create an SSH local forward from the runner to a remote proxy endpoint |
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
refer to the runner itself. Do not use a loopback URL on a GitHub-hosted runner
unless another workflow step creates the listener.

## SSH tunnel

Variables:

```text
TELECOM_CONNECTIVITY_MODE=ssh_tunnel
PROXY_SSH_USER=runner
PROXY_SSH_PORT=22
PROXY_TUNNEL_LOCAL_PORT=13128
PROXY_TUNNEL_REMOTE_ENDPOINT=127.0.0.1:13128
PROXY_TUNNEL_PROXY_SCHEME=http
PROXY_HEALTH_URL=https://wapbj.189.cn/
```

Secrets:

```text
PROXY_SSH_HOST=jump.example.com
PROXY_SSH_PRIVATE_KEY=<dedicated private key>
PROXY_SSH_KNOWN_HOSTS=<pinned known_hosts entry>
```

Traffic path:

```text
runner:127.0.0.1:local-port → SSH host → configured remote proxy endpoint
```

Use a dedicated key with restricted server-side permissions. Configure
`PROXY_SSH_KNOWN_HOSTS`; relying on a dynamic scan weakens host verification.

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

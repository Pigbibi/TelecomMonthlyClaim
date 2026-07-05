# TelecomMonthlyClaim

每月自动办理北京电信网龄权益，支持通过 GitHub Variables 在 5GB 国内通用流量和 200 分钟国内语音之间切换。

默认流程：

1. GitHub Actions 在北京时间每月 1-3 日 08:00 运行。
2. GitHub-hosted runner 使用 `direct` 或你自行配置的可靠代理；本仓库不会创建内网代理隧道。
3. Playwright 以移动 Chrome 环境打开 189 活动页，并按配置选择直连或代理访问。
4. 北京电信手机号收到的 `10001` 短信默认进入 PushPlus；如果同时部署 `PushPlusSmsToTelegram`，脚本优先从其受保护 relay inbox 拉取被拦截的验证码，未配置 relay 时回退到 PushPlus OpenAPI；原 OpenWrt / 家里电脑 SMS inbox 方案仍保留为兼容选项。
5. 脚本读取第一步登录验证码，根据 `TELECOM_TARGET_PACKAGE` 选中目标套餐。
6. 通过二次确认滑块后读取第二步办理验证码。
7. 校验手机号、产品名和方案编号后提交，避免误填其他业务验证码。
8. 成功写入 `state/YYYY-MM.json`，后续同月自动跳过。
9. 1/2 日失败不报警，3 日仍失败时 workflow 失败并创建 GitHub issue。

## 网络与代理配置

本仓库是开源业务自动化，不内置 Pigbibi 内网代理、BWG 跳板或路由器隧道实现。运行时只读取你配置好的网络入口：

| 模式 | 适用场景 | 配置 |
| --- | --- | --- |
| `direct` | 本机运行，或接受 GitHub-hosted runner 直接访问活动页 | 默认模式，不使用代理 |
| `http_proxy` | 你已经有一个 runner 可访问的 HTTP/SOCKS 代理 | 设置 `TELECOM_CONNECTIVITY_MODE=http_proxy`，并配置 `OPENWRT_HTTP_PROXY` / `HOME_HTTP_PROXY` / `PUBLIC_HTTP_PROXY` 等任一 secret |
| `ssh_tunnel` | 你有一台 runner 可 SSH 登录的跳板机，跳板机能访问你的代理 | 设置 `TELECOM_CONNECTIVITY_MODE=ssh_tunnel`，并配置通用 `PROXY_SSH_*` / `PROXY_TUNNEL_*` |
| `proxy_pool` | 需要使用你自己的可靠代理池出口 | 设置 `TELECOM_CONNECTIVITY_MODE=proxy_pool` 和 `PROXY_POOL_HTTP_PROXY` |

注意：`http://127.0.0.1:13128` 只代表 runner 自己。普通 `http_proxy` 模式不要填 loopback；如果需要先 SSH 到跳板机再转发本地端口，请使用 `ssh_tunnel`。本仓库只提供通用 SSH 端口转发，不内置任何 Pigbibi 专属 action 或私有仓库依赖。

### direct 模式

```text
# Variable
TELECOM_CONNECTIVITY_MODE=direct

# Secrets，可选；仅 SMS_INBOX_PROVIDER=http 时需要
SMS_INBOX_URL=https://your-public-inbox.example.com/messages
SMS_INBOX_HEALTH_URL=https://your-public-inbox.example.com/health
```

`direct` 模式不会创建任何 SSH/WireGuard/内网穿透，也不会使用代理。runner 会直接访问活动页。

### http_proxy 模式

```text
# Variable
TELECOM_CONNECTIVITY_MODE=http_proxy

# Secret，任选一个名称
OPENWRT_HTTP_PROXY=http://user:password@proxy.example:port
# 或 HOME_HTTP_PROXY / PUBLIC_HTTP_PROXY / SCHWAB_PROXY_URL / BROWSER_PROXY_SERVER
```

`http_proxy` 模式要求代理地址能被当前 runner 直接访问。不要在这个模式里填 `127.0.0.1` 或 `localhost`，除非你使用的是 self-hosted runner 且代理就在同一台机器上。

### ssh_tunnel 模式

```text
# Variables
TELECOM_CONNECTIVITY_MODE=ssh_tunnel
PROXY_SSH_USER=root                  # 可选，默认 root
PROXY_SSH_PORT=22                    # 可选，默认 22
PROXY_TUNNEL_LOCAL_PORT=13128        # 可选，默认 13128
PROXY_TUNNEL_REMOTE_ENDPOINT=127.0.0.1:13128
PROXY_HEALTH_URL=https://wapbj.189.cn/  # 可选

# Secrets
PROXY_SSH_HOST=your-vps.example.com
PROXY_SSH_PRIVATE_KEY=<private key>
PROXY_SSH_KNOWN_HOSTS=<known_hosts line>  # 推荐；不填时 workflow 会 ssh-keyscan
```

`ssh_tunnel` 模式会在 GitHub runner 上执行通用 SSH 本地端口转发：

```text
runner:127.0.0.1:PROXY_TUNNEL_LOCAL_PORT -> PROXY_SSH_HOST -> PROXY_TUNNEL_REMOTE_ENDPOINT
```

这个模式适合用户自己的 VPS、Zero Trust 入口、家里反向隧道或其他跳板结构。仓库不会假设你使用哪种路由器、VPS 或内网穿透方案。

### proxy_pool 模式

```text
# Variable
TELECOM_CONNECTIVITY_MODE=proxy_pool
SEND_CODE_ATTEMPTS=1

# Secret
PROXY_POOL_HTTP_PROXY=http://user:password@proxy-pool.example:port
```

`proxy_pool` 模式只使用 `PROXY_POOL_HTTP_PROXY` 访问 189 页面；如果缺少该 secret，workflow 会在访问电信前失败。

### 默认：PushPlus 短信源

当前实际 workflow 默认从 PushPlus 拉取北京电信 `10001` 验证码，再复用现有的验证码解析逻辑。这个模式适合手机号已经配置成 PushPlus 收短信、且不再使用 SmsForwarder / 自建 SMS inbox 的部署。

如果同时部署了 `PushPlusSmsToTelegram`，建议在那个仓库配置 `SMS_INTERCEPT_PRESETS=telecom-claim-silent`。这样 PushPlus webhook 仍会接收所有短信，但北京电信月度领取相关的登录/确认验证码会被通用拦截规则静默处理，不再通知到 Telegram，并临时写入受保护 relay inbox；本仓库配置 `PUSHPLUS_RELAY_INBOX_URL` 后会优先从该 inbox 获取验证码。

PushPlus 后台需要先做这些设置：

1. 开启开放接口能力；
2. 设置 `secretKey`，建议用随机长字符串；
3. 安全 IP 白名单如果保持关闭，则 GitHub-hosted runner 可以直接调用；如果你开启白名单，就需要固定出口 IP，否则可能返回 `403`。

GitHub 配置示例：

```text
# Variables
SMS_INBOX_PROVIDER=pushplus   # workflow 默认值；显式配置便于审计
PUSHPLUS_PAGE_SIZE=10
PUSHPLUS_BASE_URL=https://www.pushplus.plus  # 可选；通常不用改
PUSHPLUS_TITLE_KEYWORD=短信        # 可选；硬件推送标题固定时再填写
PUSHPLUS_DEBUG=false               # 临时排障时可设 true；不会打印验证码正文
SEND_CODE_ATTEMPTS=3               # 临时排障时可设 1，减少重复发码
PUSHPLUS_RELAY_INBOX_URL=https://pushplus-sms-to-telegram.pigbibi.workers.dev/messages  # 可选；配置后优先使用 relay inbox

# Secrets
PUSHPLUS_TOKEN=你的 PushPlus 用户 token，不能用消息 token
PUSHPLUS_SECRET_KEY=你的 PushPlus OpenAPI secretKey
PUSHPLUS_RELAY_INBOX_TOKEN=与 PushPlusSmsToTelegram 的 INBOX_TOKEN 保持一致；仅配置 relay inbox 时需要
```

PushPlus 模式不需要 `SMS_INBOX_URL` / `SMS_INBOX_HEALTH_URL` / `SMS_INBOX_TOKEN`。如果配置了 `PUSHPLUS_RELAY_INBOX_URL`，本仓库优先使用 relay inbox；未配置时才使用 PushPlus OpenAPI。网络出口由 `TELECOM_CONNECTIVITY_MODE` 和代理相关 secret 决定。

注意：PushPlus OpenAPI 会先用用户 token 和 secretKey 换取短期 `accessKey`。脚本只会读取消息列表和消息详情，不会把验证码写入运行日志；但验证码会短暂停留在 PushPlus 平台，安全性低于直接投递到自己的 SMS inbox。

## 快速部署

推荐按“PushPlus 收短信 + direct/http_proxy/ssh_tunnel/proxy_pool 网络配置”部署：

1. Fork 或新建仓库，先在私有仓库里完成配置和 dry-run 验证。
2. 确认北京电信手机号收到的 `10001` 短信会进入 PushPlus。
3. 在 GitHub Secrets / Variables 填好 PushPlus、电信活动和可选代理配置。
4. 先手动触发 `Monthly Beijing Telecom Claim` workflow，`dry_run=true` 跑到最终提交前。
5. 确认产品名、方案编号、PushPlus 短信读取都正常后，再手动触发一次 `dry_run=false`。
6. 成功后检查 `state/YYYY-MM.json` 和 `logs` 分支。

最小部署清单：

```bash
npm ci
npm test
```

然后在 GitHub 仓库配置：

```text
# Variables
TELECOM_CONNECTIVITY_MODE=direct
SMS_INBOX_PROVIDER=pushplus
TELECOM_TARGET_PACKAGE=voice200

# Secrets
TELECOM_PHONE=北京电信手机号
TELECOM_ENTRY_URL=活动入口 URL
PUSHPLUS_TOKEN=你的 PushPlus 用户 token
PUSHPLUS_SECRET_KEY=你的 PushPlus OpenAPI secretKey
```

如果你需要代理出口，选择一种模式：

```text
# runner 可直接访问的代理
TELECOM_CONNECTIVITY_MODE=http_proxy
OPENWRT_HTTP_PROXY=http://user:password@proxy.example:port

# SSH 跳板转发到你的代理
TELECOM_CONNECTIVITY_MODE=ssh_tunnel
PROXY_SSH_HOST=your-vps.example.com
PROXY_TUNNEL_REMOTE_ENDPOINT=127.0.0.1:13128

# 可靠代理池
TELECOM_CONNECTIVITY_MODE=proxy_pool
PROXY_POOL_HTTP_PROXY=http://user:password@proxy-pool.example:port
```

不要把私钥、手机号、短信 token、PushPlus token 或 secretKey 写进仓库文件。

## 运行日志

workflow 每次运行都会把脱敏后的运行元数据写到 `logs` 分支：

```bash
git fetch origin logs
git show origin/logs:latest.json
```

日志只记录仓库、workflow、run id、状态、是否 dry-run、目标套餐等信息；不会记录手机号、短信验证码、token、私钥或电信页面正文。

如果是本机临时跑通真实办理，也可以在 `logs` 分支追加一条 `manual-local-claim` 日志，用于标记这次月份已经通过本机验证成功。`state/YYYY-MM.json` 只记录月份、目标套餐、产品名和方案编号，不保存订单号或页面 URL。

## GitHub Secrets / Variables 配置

必填 secrets：

| Secret | 说明 |
| --- | --- |
| `TELECOM_PHONE` | 办理手机号 |
| `TELECOM_ENTRY_URL` | 189 活动入口 URL |
| `PUSHPLUS_TOKEN` | PushPlus 用户 token，不能用消息 token；默认 PushPlus 模式未配置 relay inbox 时需要 |
| `PUSHPLUS_SECRET_KEY` | PushPlus OpenAPI secretKey；默认 PushPlus 模式未配置 relay inbox 时需要 |

可选 secrets：

| Secret | 默认值 | 说明 |
| --- | --- | --- |
| `OPENWRT_HTTP_PROXY` / `HOME_HTTP_PROXY` / `PUBLIC_HTTP_PROXY` / `SCHWAB_PROXY_URL` / `BROWSER_PROXY_SERVER` | 空 | `http_proxy` 模式下的代理地址；必须能从 runner 访问。 |
| `PROXY_POOL_HTTP_PROXY` | 空 | `TELECOM_CONNECTIVITY_MODE=proxy_pool` 时必填。 |
| `PROXY_SSH_HOST` | 空 | `TELECOM_CONNECTIVITY_MODE=ssh_tunnel` 时必填，SSH 跳板机地址。 |
| `PROXY_SSH_PRIVATE_KEY` | 空 | `ssh_tunnel` 时必填，登录跳板机的私钥。 |
| `PROXY_SSH_KNOWN_HOSTS` | 空 | `ssh_tunnel` 推荐配置，跳板机 known_hosts。 |
| `PROXY_TUNNEL_REMOTE_ENDPOINT` | `127.0.0.1:13128` | `ssh_tunnel` 可放 secret 或 variable，跳板机侧可访问的代理 `host:port`。 |
| `SMS_INBOX_TOKEN` | 空 | 仅 `SMS_INBOX_PROVIDER=http` 时需要，手机转发器、runner、SMS inbox 共享的 Bearer token。 |
| `SMS_INBOX_URL` | 空 | 仅 `SMS_INBOX_PROVIDER=http` 时使用，必须能从 runner 访问。 |
| `SMS_INBOX_HEALTH_URL` | 空 | 仅 `SMS_INBOX_PROVIDER=http` 时使用，必须能从 runner 访问。 |
| `PUSHPLUS_RELAY_INBOX_TOKEN` | 空 | 仅配置 `PUSHPLUS_RELAY_INBOX_URL` 时需要；与 `PushPlusSmsToTelegram` 仓库的 `INBOX_TOKEN` 保持一致。 |

Variables：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `TELECOM_TARGET_PACKAGE` | `voice200` | 目标套餐 preset。可选 `voice200` 或 `5g`。 |
| `TELECOM_PRODUCT_NAME` | 空 | 可选覆盖项。为空时由 `TELECOM_TARGET_PACKAGE` 对应 preset 自动填充。 |
| `TELECOM_EXPECTED_PLAN_ID` | 空 | 可选覆盖项。为空时由 `TELECOM_TARGET_PACKAGE` 对应 preset 自动填充。 |
| `TELECOM_ACTION_DELAY_MS` | `800` | 关键填表、点击动作之间的固定等待，降低页面状态未稳定导致的误点。 |
| `TELECOM_POST_SUCCESS_WAIT_MS` | `8000` | 办理成功后保留成功页多久再关闭浏览器。 |
| `TELECOM_CONNECTIVITY_MODE` | `direct` | 网络连接模式。可选 `direct` / `http_proxy` / `ssh_tunnel` / `proxy_pool`。 |
| `ALLOW_DIRECT_PROXY_FALLBACK` | `false` | 代理不可用时是否允许 runner 直接访问活动页；通常保持关闭。 |
| `SMS_INBOX_PROVIDER` | `pushplus` | 短信来源。默认 `pushplus` 从 PushPlus 拉取消息；设为 `http` 可使用你自建的 SMS inbox。 |
| `PUSHPLUS_BASE_URL` | `https://www.pushplus.plus` | PushPlus OpenAPI 地址，通常不用改。 |
| `PUSHPLUS_PAGE_SIZE` | `10` | PushPlus 模式每次拉取最近消息数量，最大 50。 |
| `PUSHPLUS_TITLE_KEYWORD` | 空 | PushPlus 模式可选标题过滤词；硬件推送标题固定时可填写，减少无关消息详情请求。 |
| `PUSHPLUS_DEBUG` | `false` | PushPlus 模式临时诊断日志；只打印标题、时间、关键字命中情况，不打印短信正文或验证码。 |
| `PUSHPLUS_RELAY_INBOX_URL` | 空 | 可选；配置后优先从 `PushPlusSmsToTelegram` 的受保护 `/messages` inbox 拉取被拦截短信。 |
| `PROXY_SSH_USER` | `root` | `ssh_tunnel` 可选，SSH 用户。 |
| `PROXY_SSH_PORT` | `22` | `ssh_tunnel` 可选，SSH 端口。 |
| `PROXY_TUNNEL_LOCAL_PORT` | `13128` | `ssh_tunnel` 可选，runner 本地监听端口。 |
| `PROXY_HEALTH_URL` | `https://wapbj.189.cn/` | 代理健康检查 URL。 |

脚本会用产品名选中页面套餐，并在二次确认短信里校验手机号、产品名和方案编号。`TELECOM_ACTION_DELAY_MS` 和 `TELECOM_POST_SUCCESS_WAIT_MS` 只是稳定性等待，不用于绕过验证码或风控。

不要把私钥、手机号、短信 token、PushPlus token 或 secretKey 写进仓库文件。

## 兼容：自建 HTTP SMS inbox

默认 PushPlus 模式不需要自建 SMS inbox。只有当你把 `SMS_INBOX_PROVIDER=http` 时，才需要提供 runner 可访问的 `SMS_INBOX_URL`、`SMS_INBOX_HEALTH_URL` 和 `SMS_INBOX_TOKEN`。

本仓库保留 HTTP SMS inbox 的客户端协议和本地调试服务，但不负责部署你的内网穿透、路由器代理或公网入口。你可以用自己的 WireGuard、Zero Trust、反向代理、VPS 转发或其他可靠方式暴露以下接口：

```text
POST /sms?token=<SMS_INBOX_TOKEN>
GET  /messages?sender=10001
GET  /health
```

本机临时调试可以运行：

```bash
SMS_INBOX_TOKEN=change-me npm run sms-server
```

然后配置：

```text
SMS_INBOX_PROVIDER=http
SMS_INBOX_URL=http://127.0.0.1:8787/messages
SMS_INBOX_HEALTH_URL=http://127.0.0.1:8787/health
```

如果是在 GitHub-hosted runner 上运行，`127.0.0.1` 指的是 GitHub runner，不是你的家里电脑或路由器。

## 手机短信转发器 App 配置

默认 PushPlus 模式不需要配置 HTTP POST 短信转发 App。以下内容仅用于兼容的 `SMS_INBOX_PROVIDER=http` 方案。

手机端使用支持 HTTP POST 的短信转发 App。本文默认使用的 App 名称写作“短信转发器 / SmsForwarder”；如果你使用其他同类 App，只要能把短信正文、发送方和接收时间以 JSON POST 到 webhook，也可以复用同一套接口。

如果使用家里电脑模式，把 `10001` 短信转发到家里电脑：

```text
POST http://<HOME_COMPUTER_LAN_IP>:8787/sms
Authorization: Bearer <SMS_INBOX_TOKEN>
Content-Type: application/json

{
  "sender": "10001",
  "text": "短信正文",
  "receivedAt": 1770000000000
}
```

如果 App 不能设置 HTTP header，也可以把 token 放 query：

```text
POST http://<HOME_COMPUTER_LAN_IP>:8787/sms?token=<SMS_INBOX_TOKEN>
```

手机系统需要给短信转发器 App：

- 读取短信、接收短信、通知权限；
- 自启动允许；
- 省电策略设为无限制；
- 锁定后台任务，避免被系统杀掉。

查询接口：

```bash
curl -H "Authorization: Bearer $SMS_INBOX_TOKEN" \
  "http://127.0.0.1:8787/messages?since=1770000000000&sender=10001"
```

## 本地调试

```bash
npm ci
npm run lint
npm test

TELECOM_PHONE=18500000000 \
TELECOM_ENTRY_URL='https://wapbj.189.cn/...' \
TELECOM_TARGET_PACKAGE=voice200 \
TELECOM_ACTION_DELAY_MS=800 \
TELECOM_POST_SUCCESS_WAIT_MS=8000 \
SMS_INBOX_PROVIDER=pushplus \
PUSHPLUS_TOKEN='token' \
PUSHPLUS_SECRET_KEY='secret' \
HEADLESS=false \
npm run claim
```

临时手动验证码调试：

```bash
TELECOM_LOGIN_CODE=123456 TELECOM_CONFIRM_CODE=654321 npm run claim
```

## 备用方案

如果你需要固定出口 IP，可以自行准备 WireGuard、Zero Trust、私有 runner 或可靠代理池，然后把 runner 可访问的代理地址填入 `OPENWRT_HTTP_PROXY` / `HOME_HTTP_PROXY` / `PUBLIC_HTTP_PROXY`，或使用 `TELECOM_CONNECTIVITY_MODE=proxy_pool`。本仓库不提供内网穿透实现。

## 验证码匹配规则

第一步：

```text
验证码：123456。尊敬的用户，感谢使用北京电信掌上营业厅。
```

第二步：

```text
【办理提醒】尊敬的客户，您的验证码是：654321，号码...办理互联网卡网龄享200分钟国内语音（方案编号：24BJ102053）...
```

第二步会额外校验手机号、产品名和方案编号。产品名和方案编号来自 preset，或来自 GitHub Variables 覆盖值。

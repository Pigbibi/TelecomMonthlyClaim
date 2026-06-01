# TelecomMonthlyClaim

每月自动办理北京电信网龄权益，支持通过 GitHub Variables 在 5GB 国内通用流量和 200 分钟国内语音之间切换。

默认流程：

1. GitHub Actions 在北京时间每月 1-3 日 08:00 运行。
2. Hosted runner 先 SSH 到 BWG，建立家里出口代理转发；只有 `SMS_INBOX_PROVIDER=http` 时才需要本地 SMS inbox 转发。
3. Playwright 以移动 Chrome 环境打开 189 活动页，并通过家里出口访问。
4. 北京电信手机号收到的 `10001` 短信默认进入 PushPlus，脚本通过 PushPlus OpenAPI 拉取验证码；原 OpenWrt / 家里电脑 SMS inbox 方案仍保留为兼容选项。
5. 脚本读取第一步登录验证码，根据 `TELECOM_TARGET_PACKAGE` 选中目标套餐。
6. 通过二次确认滑块后读取第二步办理验证码。
7. 校验手机号、产品名和方案编号后提交，避免误填其他业务验证码。
8. 成功写入 `state/YYYY-MM.json`，后续同月自动跳过。
9. 1/2 日失败不报警，3 日仍失败时 workflow 失败并创建 GitHub issue。

## 内网穿透架构

本仓库支持两种部署方式：

| 方案 | 适用场景 | runner 如何访问短信和家里出口 | 说明 |
| --- | --- | --- | --- |
| 方案一：直连模式 | 本机调试，或你已经有 WireGuard / 内网穿透 / 公网 HTTPS，把家里的 SMS inbox 和代理安全暴露给 runner | `SMS_INBOX_URL`、`SMS_INBOX_HEALTH_URL`、`OPENWRT_HTTP_PROXY` 直接填可访问地址 | 配置少，但需要你自己保证网络和鉴权安全。不建议把家里代理直接暴露到公网。 |
| 方案二：BWG 跳板反向隧道 | 推荐的无人值守部署 | 默认从 PushPlus OpenAPI 拉短信；家里 OpenWrt 或家里电脑主动 SSH 到 BWG 建代理反向端口，GitHub hosted runner 再 SSH 到 BWG 建本地转发 | GitHub 不需要直连家里 IP；如切回 `SMS_INBOX_PROVIDER=http`，仍可继续使用 BWG 上只绑定 `127.0.0.1` 的 SMS inbox 上游。 |

现在实际 workflow 默认用 `SMS_INBOX_PROVIDER=pushplus` 读取短信，同时保留方案二的 BWG 跳板作为家里出口代理。需要回退到原 SMS inbox 时，把 GitHub Variable `SMS_INBOX_PROVIDER` 设为 `http` 并继续使用 `SMS_INBOX_URL` / `SMS_INBOX_HEALTH_URL` / `SMS_INBOX_TOKEN`。

```text
10001 短信 -> PushPlus -> GitHub runner 通过 PushPlus OpenAPI 拉取验证码
GitHub runner -> SSH -L -> BWG:127.0.0.1:13128 -> SSH -R -> OpenWrt 代理端口 或 家里电脑:13128
OpenWrt/家里网络 -> 189 页面

兼容 SMS_INBOX_PROVIDER=http 时：
短信转发器 App -> OpenWrt:80/cgi-bin/telecom-sms 或 家里电脑:8787/sms
GitHub runner -> SSH -L -> BWG:127.0.0.1:18787 -> SSH -R -> OpenWrt:80 或 家里电脑:8787
```

这样 GitHub 不需要直连家里 IP，也不用把代理暴露到公网；BWG 上的代理端口只绑定 `127.0.0.1`，必须 SSH 登录后才能访问。若使用兼容的 HTTP SMS inbox，短信端口也按同样方式只在 SSH 隧道内访问。

### 兼容可选：direct 模式

如果你已经有安全的公网 HTTPS、内网穿透、专线或其他方式，让 GitHub-hosted runner 能直接访问 SMS inbox 和可选的家里出口代理，可以把 GitHub Variables / Secrets 设置为：

```text
# Variable
TELECOM_CONNECTIVITY_MODE=direct

# Secrets
SMS_INBOX_URL=https://your-public-inbox.example.com/messages
SMS_INBOX_HEALTH_URL=https://your-public-inbox.example.com/health
OPENWRT_HTTP_PROXY=
```

`direct` 模式会跳过 BWG SSH 隧道步骤，直接使用你提供的 `SMS_INBOX_URL` 和 `SMS_INBOX_HEALTH_URL`。如果你还提供了 `OPENWRT_HTTP_PROXY`，workflow 会先检查该代理是否能访问 189 页面；如果不提供，就让 runner 直接访问活动页。

本仓库默认不设置 `TELECOM_CONNECTIVITY_MODE=direct`，仍使用方案二的 `bwg` 模式。不要为了省事把未鉴权的短信收件箱或代理端口直接暴露到公网。

### 默认：PushPlus 短信源

当前实际 workflow 默认从 PushPlus 拉取北京电信 `10001` 验证码，再复用现有的验证码解析逻辑。这个模式适合手机号已经配置成 PushPlus 收短信、且不再使用 SmsForwarder / 自建 SMS inbox 的部署。

如果同时部署了 `PushPlusSmsToTelegram`，建议在那个仓库配置 `SMS_INTERCEPT_PRESETS=telecom-claim-silent`。这样 PushPlus webhook 仍会接收所有短信，但北京电信月度领取相关的登录/确认验证码只会被通用拦截规则静默标记为已处理，不会再通知到 Telegram；本仓库仍通过 PushPlus OpenAPI 拉取同一条短信并用于办理流程。

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

# Secrets
PUSHPLUS_TOKEN=你的 PushPlus 用户 token，不能用消息 token
PUSHPLUS_SECRET_KEY=你的 PushPlus OpenAPI secretKey
```

PushPlus 模式不需要 `SMS_INBOX_URL` / `SMS_INBOX_HEALTH_URL` / `SMS_INBOX_TOKEN`。如果 `TELECOM_CONNECTIVITY_MODE=bwg`，BWG 隧道仍可继续用于家里出口代理，只是不再检查本地 SMS inbox。

注意：PushPlus OpenAPI 会先用用户 token 和 secretKey 换取短期 `accessKey`。脚本只会读取消息列表和消息详情，不会把验证码写入运行日志；但验证码会短暂停留在 PushPlus 平台，安全性低于直接投递到自己的 SMS inbox。

## 快速部署

推荐按“PushPlus 收短信 + BWG 家里出口代理”部署，整体顺序如下：

1. Fork 或新建私有仓库，暂时不要公开。
2. 准备一台 BWG/VPS，并确认 GitHub Actions 可以 SSH 登录。
3. 在 OpenWrt 或家里电脑上部署家里出口代理和到 BWG 的反向隧道；只有回退到 `SMS_INBOX_PROVIDER=http` 时才需要部署 SMS inbox。
4. 确认北京电信手机号收到的 `10001` 短信会进入 PushPlus。
5. 在 GitHub Secrets / Variables 填好 PushPlus、BWG 和电信活动配置。
6. 先手动触发 `Monthly Beijing Telecom Claim` workflow，`dry_run=true` 跑到最终提交前。
7. 确认产品名、方案编号、PushPlus 短信读取都正常后，再手动触发一次 `dry_run=false`。
8. 成功后检查 `state/YYYY-MM.json` 和 `logs` 分支。

最小部署清单：

```bash
npm ci
cp .env.example .env.local
chmod 600 .env.local

# 家里出口代理二选一；PushPlus 模式不需要安装 SMS inbox
./scripts/install-openwrt-router.sh        # 推荐：OpenWrt 常驻
./scripts/install-local-services-macos.sh  # 备选：家里电脑常驻服务脚本

# 只有回退到 HTTP SMS inbox 且手机需要走公网 webhook 投递短信时才需要：
./scripts/install-bwg-public-webhook.sh
```

首次验证建议：

```bash
npm run lint
npm test

# 本机 dry-run，只走到最终提交前
FORCE_RUN=true DRY_RUN_BEFORE_FINAL_SUBMIT=true npm run claim
```

本机命令不会自动读取 `.env.local`；运行前需要先把里面的值导出为环境变量。`TELECOM_ENTRY_URL` 这类 URL 如果包含 `&`，请加引号，避免 shell 截断。

GitHub Actions 手动运行时，建议第一轮设置：

```text
force_run=true
dry_run=true
```

确认没问题后第二轮再设置：

```text
force_run=true
dry_run=false
```

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
| `PUSHPLUS_TOKEN` | PushPlus 用户 token，不能用消息 token；默认 PushPlus 模式需要 |
| `PUSHPLUS_SECRET_KEY` | PushPlus OpenAPI secretKey；默认 PushPlus 模式需要 |
| `BWG_SSH_HOST` | BWG/VPS IP 或域名 |
| `BWG_SSH_PRIVATE_KEY` | GitHub runner 登录 BWG 用的私钥 |

推荐 secrets：

| Secret | 默认值 | 说明 |
| --- | --- | --- |
| `BWG_SSH_USER` | `root` | BWG 登录用户 |
| `BWG_SSH_PORT` | `22` | BWG SSH 端口 |
| `BWG_KNOWN_HOSTS` | 自动 `ssh-keyscan` | BWG host key，推荐固定下来 |
| `OPENWRT_HTTP_PROXY` | `http://127.0.0.1:13128` | runner 经 SSH 转发后的家里出口代理 |
| `SMS_INBOX_TOKEN` | 空 | 仅 `SMS_INBOX_PROVIDER=http` 时需要，手机转发器、GitHub runner、SMS inbox 共享的 Bearer token |
| `SMS_INBOX_URL` | `http://127.0.0.1:18787/messages` | 仅 `SMS_INBOX_PROVIDER=http` 时使用，runner 经 SSH 转发后的 inbox 查询地址；OpenWrt 用 `/cgi-bin/telecom-messages` |
| `SMS_INBOX_HEALTH_URL` | `http://127.0.0.1:18787/health` | 仅 `SMS_INBOX_PROVIDER=http` 时使用，inbox 健康检查地址；OpenWrt 用 `/cgi-bin/telecom-sms-health` |

Variables：

| Variable | 默认值 | 说明 |
| --- | --- | --- |
| `TELECOM_TARGET_PACKAGE` | `voice200` | 目标套餐 preset。可选 `voice200` 或 `5g`。 |
| `TELECOM_PRODUCT_NAME` | 空 | 可选覆盖项。为空时由 `TELECOM_TARGET_PACKAGE` 对应 preset 自动填充。 |
| `TELECOM_EXPECTED_PLAN_ID` | 空 | 可选覆盖项。为空时由 `TELECOM_TARGET_PACKAGE` 对应 preset 自动填充。 |
| `TELECOM_ACTION_DELAY_MS` | `800` | 关键填表、点击动作之间的固定等待，降低页面状态未稳定导致的误点。 |
| `TELECOM_POST_SUCCESS_WAIT_MS` | `8000` | 办理成功后保留成功页多久再关闭浏览器。 |
| `TELECOM_CONNECTIVITY_MODE` | `bwg` | 网络连接模式。默认 `bwg`；兼容可选 `direct`，但本仓库不设置该方式。 |
| `ALLOW_DIRECT_PROXY_FALLBACK` | `true` | 家里代理不可用时是否允许 runner 直接访问活动页。 |
| `SMS_INBOX_PROVIDER` | `pushplus` | 短信来源。默认 `pushplus` 从 PushPlus 拉取消息；设为 `http` 可回退到原 SMS inbox。 |
| `PUSHPLUS_BASE_URL` | `https://www.pushplus.plus` | PushPlus OpenAPI 地址，通常不用改。 |
| `PUSHPLUS_PAGE_SIZE` | `10` | PushPlus 模式每次拉取最近消息数量，最大 50。 |
| `PUSHPLUS_TITLE_KEYWORD` | 空 | PushPlus 模式可选标题过滤词；硬件推送标题固定时可填写，减少无关消息详情请求。 |
| `PUSHPLUS_DEBUG` | `false` | PushPlus 模式临时诊断日志；只打印标题、时间、关键字命中情况，不打印短信正文或验证码。 |
| `SEND_CODE_ATTEMPTS` | `3` | 验证码发送重试次数；临时排障时可设为 `1`，减少重复发码。 |
| `SMS_TIMEOUT_MS` | `90000` | 每次等待短信的超时时间。 |
| `SMS_POLL_MS` | `5000` | 短信轮询间隔。 |

内置 preset：

| `TELECOM_TARGET_PACKAGE` | 产品名 | 方案编号 |
| --- | --- | --- |
| `voice200` | `互联网卡网龄享200分钟国内语音` | `24BJ102053` |
| `5g` | `互联网卡网龄享5GB国内通用流量` | `24BJ100433` |

常用选择：

```text
# 领取 200 分钟国内语音
TELECOM_TARGET_PACKAGE=voice200
TELECOM_PRODUCT_NAME=
TELECOM_EXPECTED_PLAN_ID=

# 领取 5GB 国内通用流量
TELECOM_TARGET_PACKAGE=5g
TELECOM_PRODUCT_NAME=
TELECOM_EXPECTED_PLAN_ID=
```

如果活动页或短信文案变了，可以不改代码，直接在 GitHub Variables 里覆盖。使用 `custom` 时必须填写 `TELECOM_PRODUCT_NAME`，`TELECOM_EXPECTED_PLAN_ID` 建议填写：

```text
TELECOM_TARGET_PACKAGE=custom
TELECOM_PRODUCT_NAME=短信和确认页里出现的完整产品名
TELECOM_EXPECTED_PLAN_ID=短信里的方案编号
```

脚本会用产品名选中页面套餐，并在二次确认短信里校验手机号、产品名和方案编号。`TELECOM_ACTION_DELAY_MS` 和 `TELECOM_POST_SUCCESS_WAIT_MS` 只是稳定性等待，不用于绕过验证码或风控。

不要把私钥、手机号、短信 token、PushPlus token 或 secretKey 写进仓库文件。

## 兼容：OpenWrt 路由器收件箱与常驻服务

默认 PushPlus 模式只需要家里出口代理和 BWG 反向隧道；本节的短信收件箱用于回退到 `SMS_INBOX_PROVIDER=http`。如果路由器 SSH 可用，把代理、可选短信收件箱和反向隧道放到 OpenWrt 上，可以避免家里电脑关机或休眠影响每月任务。

先在 `.env.local` 填好这些值：

```bash
ROUTER_SSH_TARGET=root@192.168.5.1
ROUTER_SSH_KEY=/Users/you/.ssh/openwrt_router_key   # 如果用密码登录可不填
ROUTER_PROXY_PORT=8888                              # tinyproxy；如要复用 OpenClash/Passwall 可改 7893/7897
ROUTER_UHTTPD_PORT=80
BWG_SSH_HOST=your-bwg-host
BWG_SSH_KEY=/Users/you/.ssh/bwg_20260501
SMS_INBOX_TOKEN=change-me                         # 仅 SMS_INBOX_PROVIDER=http 时需要
```

安装到 OpenWrt：

```bash
./scripts/install-openwrt-router.sh
```

安装脚本会做这些事：

- 生成一把专用 `telecom_openwrt_bwg` key，并加入 BWG `authorized_keys`；
- 在 OpenWrt 安装 CGI 短信 inbox：
  - `POST /cgi-bin/telecom-sms`
  - `GET /cgi-bin/telecom-messages`
  - `GET /cgi-bin/telecom-sms-health`
- 安装 `/etc/init.d/telecom-bwg-tunnel`，让 OpenWrt 开机后自动连 BWG，并反向转发短信 inbox 与路由器代理端口；
- 安装 `/usr/bin/telecom-bwg-tunnel-watchdog`，通过 cron 定期检查 BWG 反向端口和 home proxy，不通时重启隧道。

如果回退到 `SMS_INBOX_PROVIDER=http`，OpenWrt 模式下 GitHub secrets 需要这样设置：

```text
SMS_INBOX_URL=http://127.0.0.1:18787/cgi-bin/telecom-messages
SMS_INBOX_HEALTH_URL=http://127.0.0.1:18787/cgi-bin/telecom-sms-health
OPENWRT_HTTP_PROXY=http://127.0.0.1:13128
ALLOW_DIRECT_PROXY_FALLBACK=true
```

如果路由器 tinyproxy 配了 BasicAuth，`OPENWRT_HTTP_PROXY` 需要写成 `http://user:password@127.0.0.1:13128`，脚本会自动拆出代理用户名密码给 Playwright。

`SMS_INBOX_PROVIDER=http` 时，短信转发器 App 如果只在家里 Wi-Fi 使用，目标可以是：

```text
POST http://192.168.5.1/cgi-bin/telecom-sms?token=<SMS_INBOX_TOKEN>
```

如果手机不一定连家里 Wi-Fi，改用 BWG 公网入口：

```text
POST http://<BWG_PUBLIC_IP>:18789/telecom-sms?token=<SMS_INBOX_TOKEN>
```

BWG 公网入口由 `scripts/install-bwg-public-webhook.sh` 安装，systemd 服务名是 `telecom-public-webhook`。它只把下面三个路径转发到反向隧道，不暴露路由器代理端口：

| 公网路径 | OpenWrt 上游路径 | 说明 |
| --- | --- | --- |
| `/telecom-sms` | `/cgi-bin/telecom-sms` | 接收短信转发器 POST |
| `/telecom-messages` | `/cgi-bin/telecom-messages` | GitHub runner 查询短信 |
| `/telecom-sms-health` | `/cgi-bin/telecom-sms-health` | 健康检查 |

验证命令：

```bash
curl "http://<BWG_PUBLIC_IP>:18789/telecom-sms-health?token=<SMS_INBOX_TOKEN>"
curl "http://<BWG_PUBLIC_IP>:18789/telecom-messages?token=<SMS_INBOX_TOKEN>&sender=10001"
```

## 兼容：家里电脑收件箱与常驻服务

默认 PushPlus 模式不需要本机 SMS inbox；本节用于回退到 `SMS_INBOX_PROVIDER=http`，或复用家里电脑提供 HTTP CONNECT 代理。

先准备 `.env.local`，至少包含：

```bash
cp .env.example .env.local
# 填好 TELECOM_*、PushPlus 或 SMS_INBOX_*、BWG_SSH_HOST、BWG_SSH_KEY 等
chmod 600 .env.local
```

安装并启动本机常驻服务：

```bash
npm ci
./scripts/install-local-services-macos.sh
```

这个脚本用于支持 launchd 的家里电脑环境；如果你的家里电脑不是这类环境，可以直接参考 `scripts/run-local-service.sh` 自行接入 systemd、supervisor 或其他常驻方式。

会启动三个用户级服务：

| launchd label | 作用 |
| --- | --- |
| `com.lisiyi.telecom-sms-inbox` | 本机 SMS inbox，默认端口 `8787` |
| `com.lisiyi.telecom-home-proxy` | 本机 HTTP CONNECT 代理，默认只监听 `127.0.0.1:13128` |
| `com.lisiyi.telecom-bwg-tunnel` | 到 BWG 的反向 SSH 隧道 |

日志在：

```text
~/Library/Logs/TelecomMonthlyClaim/
```

快速检查：

```bash
curl -H "Authorization: Bearer $SMS_INBOX_TOKEN" http://127.0.0.1:8787/health
curl -I --proxy http://127.0.0.1:13128 https://wapbj.189.cn/
```

本机收件箱支持两组路径，方便和 OpenWrt/BWG webhook 共用配置：

| 作用 | 标准路径 | 兼容路径 |
| --- | --- | --- |
| 接收短信 | `POST /sms` | `POST /cgi-bin/telecom-sms`、`POST /telecom-sms` |
| 查询短信 | `GET /messages` | `GET /cgi-bin/telecom-messages`、`GET /telecom-messages` |
| 健康检查 | `GET /health` | `GET /cgi-bin/telecom-sms-health`、`GET /telecom-sms-health` |

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

仓库保留了 WireGuard 脚本：

- `scripts/setup-wireguard.sh`
- `scripts/run-with-wireguard.sh`

如果以后改成 GitHub runner 直接 WireGuard 回家，可以再设置 `WG_CONFIG_BASE64` 和内网 `OPENWRT_HTTP_PROXY`。当前默认不走这条路。

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

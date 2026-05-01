# TelecomMonthlyClaim

每月自动办理北京电信“互联网卡网龄享 5GB 国内通用流量”。

默认流程：

1. GitHub Actions 在北京时间每月 1-3 日 08:00 运行。
2. Hosted runner 先 SSH 到 BWG，建立两个本地转发：短信 inbox 和家里出口代理。
3. Playwright 以 Android Chrome 移动环境打开 189 活动页，并通过家里出口访问。
4. 手机短信转发器把 `10001` 短信投递到 OpenWrt 或 Mac 上的 SMS inbox。
5. 脚本读取第一步登录验证码，选中 5GB 套餐。
6. 通过二次确认滑块后读取第二步办理验证码。
7. 校验手机号、产品名和方案编号后提交。
8. 成功写入 `state/YYYY-MM.json`，后续同月自动跳过。
9. 1/2 日失败不报警，3 日仍失败时 workflow 失败并创建 GitHub issue。

## 内网穿透架构

现在默认用“方案二”：GitHub hosted runner + BWG 跳板 + 本机反向 SSH 隧道。

```text
小米短信转发器 -> OpenWrt:80/cgi-bin/telecom-sms 或 Mac:8787/sms
GitHub runner -> SSH -L -> BWG:127.0.0.1:18787 -> SSH -R -> OpenWrt:80 或 Mac:8787
GitHub runner -> SSH -L -> BWG:127.0.0.1:13128 -> SSH -R -> OpenWrt 代理端口 或 Mac:13128
OpenWrt/家里网络 -> 189 页面
```

这样 GitHub 不需要直连家里 IP，也不用把代理暴露到公网；BWG 上的两个端口只绑定 `127.0.0.1`，必须 SSH 登录后才能访问。

## GitHub Secrets / Variables

必填 secrets：

| Secret | 说明 |
| --- | --- |
| `TELECOM_PHONE` | 办理手机号 |
| `TELECOM_ENTRY_URL` | 189 活动入口 URL |
| `SMS_INBOX_TOKEN` | 手机转发器、GitHub runner、SMS inbox 共享的 Bearer token |
| `BWG_SSH_HOST` | BWG/VPS IP 或域名 |
| `BWG_SSH_PRIVATE_KEY` | GitHub runner 登录 BWG 用的私钥 |

推荐 secrets：

| Secret | 默认值 | 说明 |
| --- | --- | --- |
| `BWG_SSH_USER` | `root` | BWG 登录用户 |
| `BWG_SSH_PORT` | `22` | BWG SSH 端口 |
| `BWG_KNOWN_HOSTS` | 自动 `ssh-keyscan` | BWG host key，推荐固定下来 |
| `SMS_INBOX_URL` | `http://127.0.0.1:18787/messages` | runner 经 SSH 转发后的 inbox 查询地址；OpenWrt 用 `/cgi-bin/telecom-messages` |
| `SMS_INBOX_HEALTH_URL` | `http://127.0.0.1:18787/health` | inbox 健康检查地址；OpenWrt 用 `/cgi-bin/telecom-sms-health` |
| `OPENWRT_HTTP_PROXY` | `http://127.0.0.1:13128` | runner 经 SSH 转发后的家里出口代理 |

Variables：

| Variable | 默认值 |
| --- | --- |
| `TELECOM_TARGET_PACKAGE` | `5g` |
| `TELECOM_PRODUCT_NAME` | `互联网卡网龄享5GB国内通用流量` |
| `TELECOM_EXPECTED_PLAN_ID` | `24BJ100433` |

不要把私钥、手机号、短信 token 写进仓库文件。

## OpenWrt 路由器常驻服务

如果路由器 SSH 可用，推荐把常驻端放到 OpenWrt 上；这样 MacBook 休眠也不影响每月任务。

先在 `.env.local` 填好这些值：

```bash
ROUTER_SSH_TARGET=root@192.168.5.1
ROUTER_SSH_KEY=/Users/you/.ssh/openwrt_router_key   # 如果用密码登录可不填
ROUTER_PROXY_PORT=8888                              # tinyproxy；如要复用 OpenClash/Passwall 可改 7893/7897
ROUTER_UHTTPD_PORT=80
BWG_SSH_HOST=your-bwg-host
BWG_SSH_KEY=/Users/you/.ssh/bwg_20260501
SMS_INBOX_TOKEN=change-me
```

安装到 OpenWrt：

```bash
./scripts/install-openwrt-router.sh
```

脚本会做这些事：

- 生成一把专用 `telecom_openwrt_bwg` key，并加入 BWG `authorized_keys`；
- 在 OpenWrt 安装 CGI 短信 inbox：
  - `POST /cgi-bin/telecom-sms`
  - `GET /cgi-bin/telecom-messages`
  - `GET /cgi-bin/telecom-sms-health`
- 安装 `/etc/init.d/telecom-bwg-tunnel`，让 OpenWrt 开机后自动连 BWG，并反向转发短信 inbox 与路由器代理端口。

OpenWrt 模式下 GitHub secrets 需要这样设置：

```text
SMS_INBOX_URL=http://127.0.0.1:18787/cgi-bin/telecom-messages
SMS_INBOX_HEALTH_URL=http://127.0.0.1:18787/cgi-bin/telecom-sms-health
OPENWRT_HTTP_PROXY=http://127.0.0.1:13128
```

如果路由器 tinyproxy 配了 BasicAuth，`OPENWRT_HTTP_PROXY` 需要写成 `http://user:password@127.0.0.1:13128`，脚本会自动拆出代理用户名密码给 Playwright。

短信转发器如果只在家里 Wi-Fi 使用，目标可以是：

```text
POST http://192.168.5.1/cgi-bin/telecom-sms?token=<SMS_INBOX_TOKEN>
```

如果手机不一定连家里 Wi-Fi，改用 BWG 公网入口：

```text
POST http://67.209.184.240:18789/telecom-sms?token=<SMS_INBOX_TOKEN>
```

BWG 公网入口由 `scripts/install-bwg-public-webhook.sh` 安装，systemd 服务名是 `telecom-public-webhook`。它只把 `/telecom-sms`、`/telecom-messages`、`/telecom-sms-health` 转发到 OpenWrt 反向隧道，不暴露路由器代理端口。

## MacBook 常驻服务


先准备 `.env.local`，至少包含：

```bash
cp .env.example .env.local
# 填好 TELECOM_*、SMS_INBOX_TOKEN、BWG_SSH_HOST、BWG_SSH_KEY 等
chmod 600 .env.local
```

安装并启动 launchd 服务：

```bash
npm ci
./scripts/install-local-services-macos.sh
```

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

## 小米 14T 短信转发

如果使用 MacBook 模式，把 `10001` 短信转发到家里 Mac：

```text
POST http://<Mac-LAN-IP>:8787/sms
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
POST http://<Mac-LAN-IP>:8787/sms?token=<SMS_INBOX_TOKEN>
```

小米/HyperOS 需要给短信转发器：

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
SMS_INBOX_URL='http://127.0.0.1:8787/messages' \
SMS_INBOX_TOKEN='token' \
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
【办理提醒】尊敬的客户，您的验证码是：654321，号码...办理互联网卡网龄享5GB国内通用流量（方案编号：24BJ100433）...
```

第二步会额外校验手机号、产品名和方案编号，避免误填其他验证码。

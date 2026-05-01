# TelecomMonthlyClaim

每月自动办理北京电信“互联网卡网龄享 5GB 国内通用流量”。

默认流程：

1. GitHub Actions 在北京时间每月 1-3 日 08:00 运行。
2. Playwright 以 Android Chrome 移动环境打开 189 活动页。
3. 手机短信转发器把 `10001` 短信投递到 SMS inbox webhook。
4. 脚本读取第一步登录验证码，选中 5GB 套餐。
5. 通过二次确认滑块后读取第二步办理验证码。
6. 校验手机号、产品名和方案编号后提交。
7. 成功写入 `state/YYYY-MM.json`，后续同月自动跳过。
8. 1/2 日失败不报警，3 日仍失败时 workflow 失败并创建 GitHub issue。

## GitHub Secrets

必填：

| Secret | 说明 |
| --- | --- |
| `TELECOM_PHONE` | 办理手机号 |
| `TELECOM_ENTRY_URL` | 189 活动入口 URL |
| `SMS_INBOX_URL` | 可被 GitHub Action 访问的短信 inbox `/messages` URL |
| `SMS_INBOX_TOKEN` | 短信 inbox token |

可选：

| Secret / Variable | 说明 |
| --- | --- |
| `OPENWRT_HTTP_PROXY` | OpenWrt HTTP/SOCKS 代理，例如 `http://10.0.0.1:7890` |
| `WG_CONFIG_BASE64` | WireGuard 配置文件的 base64，用于让 GitHub runner 连回家里网络 |
| `TELECOM_PRODUCT_NAME` | 默认 `互联网卡网龄享5GB国内通用流量` |
| `TELECOM_EXPECTED_PLAN_ID` | 默认 `24BJ100433` |

不要把 WireGuard 私钥、OpenWrt 密码、短信 token 写进仓库文件。

## 小米 14T 短信转发

推荐用 Android 短信转发器 App，把 `10001` 短信转发到 HTTP webhook：

```text
POST https://your-inbox.example.com/sms
Authorization: Bearer <SMS_INBOX_TOKEN>
Content-Type: application/json

{
  "sender": "10001",
  "text": "短信正文",
  "receivedAt": 1770000000000
}
```

小米/HyperOS 需要给短信转发器：

- 读取短信、接收短信、通知权限；
- 自启动允许；
- 省电策略设为无限制；
- 锁定后台任务，避免被系统杀掉。

本仓库也带了一个简单 inbox 服务，可放在 Mac、VPS、NAS 或家里内网机器：

```bash
cp .env.example .env
SMS_INBOX_TOKEN=your-token SMS_INBOX_PORT=8787 npm run sms-server
```

查询接口：

```bash
curl -H "Authorization: Bearer $SMS_INBOX_TOKEN" \
  "http://host:8787/messages?since=1770000000000&sender=10001"
```

如果 GitHub Action 要访问家里 inbox，请用 Tailscale / WireGuard / Cloudflare Tunnel，不要把无鉴权服务暴露公网。

## OpenWrt / 内网穿透

推荐两种方式：

### 方案 A：GitHub hosted runner + WireGuard 到 OpenWrt

把 WireGuard 客户端配置 base64 后写入 secret：

```bash
base64 -i wg-github.conf | gh secret set WG_CONFIG_BASE64 --repo Pigbibi/TelecomMonthlyClaim
```

再设置 OpenWrt 代理：

```bash
gh secret set OPENWRT_HTTP_PROXY --repo Pigbibi/TelecomMonthlyClaim --body 'http://10.0.0.1:7890'
```

### 方案 B：家里 Mac/小主机跑 self-hosted runner

如果 runner 在家里内网，通常不需要 WireGuard，只要设置 `OPENWRT_HTTP_PROXY` 或直接走本地网络即可。

## 本地调试

```bash
npm ci
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

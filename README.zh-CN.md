# TelecomMonthlyClaim

[English](README.md)

通过 Chrome、短信验证和明确的套餐校验，自动办理已授权账户的北京电信每月权益。提供 GitHub Actions 工作流和本地诊断入口。

这是非官方项目。活动是否开放、账户资格和条款以运营商页面为准；内置 `voice200` 和 `5g` 配置必须与账户实际展示的权益一致。

## 运行要求

- Node.js 20+，Chrome 或 Chrome for Testing。
- 有效活动入口，以及你有权管理的电信账户。
- 支持的短信来源，以及到运营商网站的网络连接。
- 用于存放个人配置的私有部署仓库。

## 快速开始

安装依赖并检查源码：

```bash
npm ci
npm run lint
npm test
```

配置 **Actions secrets 和 variables**：

| 配置 | 存储位置 | 用途 |
| --- | --- | --- |
| `TELECOM_PHONE` | Secret | 已授权手机号 |
| `TELECOM_ENTRY_URL` | Secret | 带必要账户参数的完整活动链接 |
| `PUSHPLUS_TOKEN`、`PUSHPLUS_SECRET_KEY` | Secrets | 使用 PushPlus Open API 时的凭据 |
| `TELECOM_TARGET_PACKAGE` | Variable | `voice200` 或 `5g` |
| `SMS_INBOX_PROVIDER` | Variable | `pushplus` 或 `http` |
| `TELECOM_CONNECTIVITY_MODE` | Variable | 例如 `direct` |

必需 URL 参数和套餐校验见[配置说明](docs/configuration.md)，其他短信接入方式见[短信来源](docs/sms-providers.md)。

## 分阶段运行

打开 **Actions → Monthly Beijing Telecom Claim → Run workflow**：

| 阶段 | 参数 | 实际操作 |
| --- | --- | --- |
| 探测 | `probe_only=true`、`dry_run=true`、`force_run=false` | 加载入口和登录挑战，不提交滑块、不请求短信 |
| 演练 | `probe_only=false`、`dry_run=true` | 可能请求和读取验证短信，停在最终办理提交之前 |
| 办理 | `probe_only=false`、`dry_run=false` | 校验通过后可以提交所选套餐 |

先运行探测，核对手机号、产品名称和 plan ID 后再允许真实办理。不需要代理时选择 `connectivity_mode=direct`。

## 调度、状态与排障

月度工作流默认在每月 1–3 日北京时间 08:00 执行，运行互斥。`state/YYYY-MM.json` 中的成功状态可避免普通重复执行；`force_run=true` 会绕过该检查，请明确需要后再使用。

运行摘要保存在 `logs` 分支。成功证据需要通过发送方和时间校验；工作流成功本身不等于权益已到账。

运营商拒绝验证请求或返回空响应时，先检查失败记录并考虑冷却时间，不要连续重试。问题报告中不要包含手机号、短信正文、验证码、会话信息或完整活动链接。

## 文档

- [中文活动配置指南](docs/beijing-campaign-setup.zh-CN.md) · [English setup](docs/beijing-campaign-setup.md)
- [配置](docs/configuration.md) · [网络接入](docs/connectivity.md)
- [短信来源](docs/sms-providers.md) · [开发与排障](docs/development.md)

## 支持与贡献

[问题与支持](SUPPORT.md) · [贡献指南](CONTRIBUTING.md) · [安全问题](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)

## 许可证

[MIT](LICENSE)。

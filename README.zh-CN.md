# TelecomMonthlyClaim

[English](README.md)

本项目此前通过 Chrome、短信验证和明确的套餐校验，自动办理已授权账户的北京电信每月权益。

## 活动已结束，自动领取已停止

此前配置的北京电信活动已结束。运营商页面返回了活动结束提示，仓库所有者于 2026-11-02 确认活动结束，本仓库今后不再运行领取任务。不要期待旧入口 URL 能成功领取，重复运行也不能恢复活动。

[PR #117](https://github.com/Pigbibi/TelecomMonthlyClaim/pull/117) 增加了 `telecom-campaign-ended`：页面明确显示活动结束时，流程在登录和提交前停止。

仓库所有者已从 Mac 手动停用以下工作流，状态为 `disabled_manually`：

- Monthly Beijing Telecom Claim
- Local Self-Hosted Telecom Claim
- Repository Log Heartbeat
- Gemini synthetic provider check
- Weekly all-branch secret scan

PR hygiene、risk、Gitleaks 检查、Dependabot、离线回归和工程治理仍保持启用，用于维护仓库，不执行业务领取。

保持上述工作流停用。恢复领取必须取得**新的、账户有资格参与的活动 URL**，并由**仓库所有者明确重新启用领取工作流**。下文的配置和运行步骤仅供历史参考，不用于重新运行已结束的活动。

这是非官方项目。活动是否开放、账户资格和条款以运营商页面为准；内置 `voice200` 和 `5g` 配置必须与账户实际展示的权益一致。

## 原运行要求

- Node.js 20+，Chrome 或 Chrome for Testing。
- 有效活动入口，以及你有权管理的电信账户。
- 支持的短信来源，以及到运营商网站的网络连接。
- 用于存放个人配置的私有部署仓库。

## 离线检查与原配置

安装依赖并检查源码：

```bash
npm ci
npm run lint
npm test
```

原部署使用以下 **Actions secrets 和 variables**：

| 配置 | 存储位置 | 用途 |
| --- | --- | --- |
| `TELECOM_PHONE` | Secret | 已授权手机号 |
| `TELECOM_ENTRY_URL` | Secret | 带必要账户参数的完整活动链接 |
| `PUSHPLUS_TOKEN`、`PUSHPLUS_SECRET_KEY` | Secrets | 使用 PushPlus Open API 时的凭据 |
| `TELECOM_TARGET_PACKAGE` | Variable | `voice200` 或 `5g` |
| `SMS_INBOX_PROVIDER` | Variable | `pushplus` 或 `http` |
| `TELECOM_CONNECTIVITY_MODE` | Variable | 例如 `direct` |

必需 URL 参数和套餐校验见[配置说明](docs/configuration.md)，其他短信接入方式见[短信来源](docs/sms-providers.md)。

源码不再调用已退役的 AIGateway v1 服务或本机 Gateway CLI。显式设置旧 `CODEX_GATEWAY_SERVICE_URL`
时会以 `vision-gateway-service-retired` 停止，不申请 OIDC 凭据、不自动转交其他 provider。
旧 `CODEX_GATEWAY_COMMAND` / `CAPTCHA_CODEX_GATEWAY_COMMAND` 配置会以
`vision-gateway-cli-retired` 停止。视觉服务需要显式配置 HTTP URL 和 key。

## 原分阶段运行方式

只有取得新活动入口、且仓库所有者明确重新启用后，才能使用 **Actions → Monthly Beijing Telecom Claim** 的以下阶段：

| 阶段 | 参数 | 实际操作 |
| --- | --- | --- |
| 探测 | `probe_only=true`、`dry_run=true`、`force_run=false` | 加载入口和登录挑战，不提交滑块、不请求短信 |
| 演练 | `probe_only=false`、`dry_run=true` | 可能请求和读取验证短信，停在最终办理提交之前 |
| 办理 | `probe_only=false`、`dry_run=false` | 校验通过后可以提交所选套餐 |

先运行探测，核对手机号、产品名称和 plan ID 后再允许真实办理。不需要代理时选择 `connectivity_mode=direct`。

## 原调度、状态与排障

已停用的月度工作流仍保留每月 1–3 日北京时间 08:00 的原调度配置，但不再执行领取。原流程互斥运行，月度状态保存在 `logs` 分支的 `state/YYYY-MM.json`，领取前恢复到工作目录；成功状态可避免普通重复执行。

旧 `main` 分支中的成功状态仍可用于迁移。状态读取异常时停止领取；`force_run=true` 会绕过成功状态检查，但不授权恢复领取。

运行摘要也保存在 `logs` 分支。状态保存失败与领取失败分别告警；状态保存失败时先核对办理结果，不要直接重跑领取。成功证据需要通过发送方和时间校验；工作流成功本身不等于权益已到账。

运营商拒绝验证请求或返回空响应时，先检查失败记录并考虑冷却时间，不要连续重试。问题报告中不要包含手机号、短信正文、验证码、会话信息或完整活动链接。

`telecom-campaign-ended` 表示提前停止，不代表领取成功。仅更换 `TELECOM_ENTRY_URL` 不授权恢复运行，还必须由仓库所有者明确重新启用领取工作流。

## 文档

- [中文活动配置指南](docs/beijing-campaign-setup.zh-CN.md) · [English setup](docs/beijing-campaign-setup.md)
- [配置](docs/configuration.md) · [网络接入](docs/connectivity.md)
- [短信来源](docs/sms-providers.md) · [开发与排障](docs/development.md)

## 支持与贡献

[问题与支持](SUPPORT.md) · [贡献指南](CONTRIBUTING.md) · [安全问题](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)

## 许可证

[MIT](LICENSE)。

## 每周密钥扫描

`Weekly all-branch secret scan` 已手动停用。YAML 仍保留每周一 04:23 UTC（北京时间 12:23）的原调度，但停用期间不会定时扫描。保持停用；PR 的 Gitleaks 检查仍然启用。

`Secret scan / Gitleaks` 成功表示扫描器完成，不会执行应用的真实账户流程。发现问题时只保留路径和规则名，不把密钥值复制到日志、Issue 或文档。

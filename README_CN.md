# TelecomMonthlyClaim

[English](README.md)

[![Monthly workflow](https://github.com/Pigbibi/TelecomMonthlyClaim/actions/workflows/monthly-claim.yml/badge.svg)](https://github.com/Pigbibi/TelecomMonthlyClaim/actions/workflows/monthly-claim.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](package.json)

使用真实 Chrome、短信验证、明确的套餐校验和按月状态，自动执行北京电信网龄权益
办理流程。内置 workflow 支持在语音和流量套餐之间选择。

## 重要说明

这是独立的非官方自动化项目，与中国电信没有隶属或背书关系。运营商页面、活动、
资格、验证方式、套餐名称和条款都可能随时变化。

第一次使用必须先运行 `probe_only=true` 和 `dry_run=true`。允许最终提交前，逐项确认
手机号、产品名、方案编号和页面内容。只能操作你有权管理的账号，并遵守运营商适用
条款。本项目不能保证领取成功，也不能避免账号、账单或服务受到影响。

## 工作流程

```text
GitHub Actions 或操作员
        │
        ▼
真实 Chrome 打开配置的活动入口
        │
        ├── 网络：直连或用户提供的代理
        │
        ├── 短信：PushPlus、受保护 relay inbox 或 HTTP inbox
        │
        ▼
登录验证 → 选择套餐 → 二次确认验证
        │
        ▼
校验手机号、产品和方案 → 可选最终提交
        │
        ▼
main 保存月份状态 + logs 分支保存脱敏运行元数据
```

定时 workflow 在每月 1–3 日北京时间 08:00（`00:00 UTC`）启动。最终重试日之前的
定时失败只记录结果；最终日仍失败时可能创建 GitHub issue。

每月申领任务会串行执行，避免延迟的定时任务与手动任务并发提交同一次申领。独立的日志
心跳任务也会串行执行，并限制为最长 10 分钟。

## 主要功能

- GitHub-hosted Chrome workflow，以及单独用于诊断的手动 macOS
  self-hosted workflow。
- `voice200` 和 `5g` 套餐 preset，提交前校验产品名和方案编号。
- `probe_only`、dry-run 和 force-run 分阶段控制。
- 直连、HTTP proxy、SSH tunnel 和 proxy pool 网络模式。
- PushPlus Open API、受保护 relay inbox 和通用 HTTP SMS inbox。
- 按发件人、手机号、产品和方案匹配登录及确认短信。
- 可选对当前滑块 challenge 使用视觉二次判定（默认关闭；本地 canvas 优先）。
- 通过 env 校验入口 URL 形状（必填 query 键 + 可选 channel 钉扎），不把个人活动参数写进源码。
- 按月成功状态，普通运行不会重复办理。
- 脱敏运行日志，不记录手机号、验证码、token、私钥或页面正文。

## 运行要求

- Node.js 20 或更高版本
- 当前有效、且账号符合资格的北京电信活动入口 URL
- Chrome 或 Chrome for Testing
- 一种受支持的短信来源
- runner 能访问活动页面和短信服务
- 用于保存账号配置的私有部署仓库

## 快速开始

### 1. 检查代码

```bash
npm ci
npm run lint
npm test
```

### 2. 配置最小参数

Repository secrets：

| Secret | 用途 |
| --- | --- |
| `TELECOM_PHONE` | 你有权管理的北京电信手机号 |
| `TELECOM_ENTRY_URL` | 完整活动分享链接（可能含 `wxopenid`）；勿写入 git |
| `PUSHPLUS_TOKEN` | 直接读取 PushPlus Open API 时使用的用户 token |
| `PUSHPLUS_SECRET_KEY` | PushPlus Open API secretKey |

Repository variables：

| Variable | 示例 | 用途 |
| --- | --- | --- |
| `TELECOM_TARGET_PACKAGE` | `voice200` | `voice200` 或 `5g` preset |
| `TELECOM_ENTRY_REQUIRED_PARAMS` | `campaignId,channelId,wxopenid` | 入口 URL 必须带有的 query **键名** |
| `TELECOM_EXPECTED_CHANNEL_ID` | `dx531` | 可选：你的部署固定 `channelId` |
| `SMS_INBOX_PROVIDER` | `pushplus` | `pushplus` 或 `http` |
| `TELECOM_CONNECTIVITY_MODE` | `direct` | 网络入口模式 |

开源仓只校验路径族、必填 query **键名**，以及你在 fork 上可选配置的 channel
钉扎；不会内置个人的 `campaignId` / `wxopenid` / channel。详见
[Configuration](docs/configuration.md#entry-url-open-source-vs-deployment)。

真实分享链接请只放在 secret。仅当 URL 不含账号标识时，才用 repository variable
作为 `TELECOM_ENTRY_URL` 的 fallback。

### 3. 运行 probe

打开 **Actions → Monthly Beijing Telecom Claim → Run workflow**：

```text
probe_only=true
dry_run=true
force_run=false
connectivity_mode=direct
```

Probe 只加载入口和登录 challenge，不提交滑块，也不请求短信。检查 Actions 输出后再
进入下一步。

### 4. 运行 dry-run

设置 `probe_only=false`，继续保持 `dry_run=true`。Dry-run 可能请求和读取验证码，
但会停在运营商最终提交前。

核对产品名和方案编号后，再由操作员确认并运行 `dry_run=false`。

## 状态与日志

成功月份状态保存在 `main` 的 `state/YYYY-MM.json`，包含月份、目标套餐、产品名、
方案编号、状态和有界成功证据，不保存验证码正文或账号凭据。

脱敏运行元数据写入 `logs` 分支：

```bash
git fetch origin logs
git show origin/logs:latest.json
```

`force_run=true` 会绕过当月成功跳过逻辑，只能用于经过确认的诊断或补跑。

## 文档

- [配置说明](docs/configuration.md)
- [北京电信 5GB/200 分钟配置指南](docs/beijing-campaign-setup.zh-CN.md)
- [Beijing campaign setup (English)](docs/beijing-campaign-setup.md)
- [网络连接](docs/connectivity.md)
- [短信来源](docs/sms-providers.md)
- [开发与排错](docs/development.md)
- [贡献指南](CONTRIBUTING.md)
- [安全政策](SECURITY.md)
- [支持](SUPPORT.md)

## 安全

workflow 会处理手机号、验证码、运营商页面、PushPlus 凭据、代理凭据，以及可选 SSH
私钥。账号专属部署应使用私有仓库，限制 Actions 权限，不得打印 secret 或短信正文。
带凭据运行 workflow 前，必须先审查代码差异。

安全问题请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

本项目使用 [MIT License](LICENSE)。

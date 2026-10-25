# AGENTS.md

## 项目是什么

自动完成一次已授权的北京电信月度权益领取，走 Chrome、短信验证和显式的套餐核对。

## 技术栈

Node.js（`package.json`），Playwright / Chrome，Node.js 内置测试运行器 `node --test`。

## 目录

- `src/` — 领取流程。
- `chrome-extension/` — 浏览器扩展。
- `scripts/` — 运行与日志脚本。
- `state/` — 状态。
- `tests/` — 测试。
- `docs/` — `configuration.md` 配置，`development.md` 开发说明。

## 本地验证

按改动选择相关离线检查，命令以仓库当前 CI 为准。先区分代码问题与环境条件，不为通过检查降低保护。

**依赖**

```bash
npm ci
```

**Lint**

```bash
npm run lint
```

**测试**

```bash
npm test
```

## 命名与文档

- 新增文档文件名小写、`-` 连接，中文版后缀 `.zh-CN.md`；`README.md`、`AGENTS.md` 等工具约定文件保留固定名称。源码沿用现有语言命名。
- 不提交审计报告、复盘、交接单、进度快照、升级计划。要追溯看 commit 历史。
- 改文件名时同一次提交改完所有引用。
- 提交前跑 `python scripts/check_hygiene.py`。

## 不要做

- 不要跳过套餐核对直接领取。核对不上就停下来。
- 不要在代码或日志里放手机号、短信验证码或账号密码。
- 不要在无人值守路径里放宽验证要求。验证失败就报告失败。

## 提交与 PR

Conventional Commits，标题中文，不超过 50 字。类型只用 `feat` `fix` `docs` `refactor` `test` `chore` `perf` `ci`。

分支名 `<type>/<主题>`，例如 `docs/normalize-filenames`。不直接推默认分支，不 force push 已 review 的分支。

提交、推送、合并及生产动作按用户已明确授权的范围执行；同范围已有授权不重复确认。

PR 描述写改了什么、为什么改、怎么验证。

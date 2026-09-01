# 北京电信每月 5GB / 200 分钟：开源用户配置指南

帮助开源用户把公开的北京电信「网龄 / 成长」类月度权益（**5GB 流量或 200 分钟语音，二选一**）映射到本仓库的配置项。

**非官方文档。** 活动页、短链、公众号口令、产品名和资格规则都会变。最终以你账号在页面上看到的规则为准；未确认前不要开最终提交。

## 公开活动通常长什么样

第三方线报常见描述（北京号、互联网卡 / 无忧卡一类）：

| 项 | 常见公开说法 |
| --- | --- |
| 权益 | **5GB** 国内通用流量 **或** **200 分钟** 国内语音（二选一） |
| 频率 | 每月一次，下月可再领 |
| 网龄 | 满 1 年档常见为 5GB/200 分钟；更短网龄可能只有更小流量包 |
| 人工入口 | 微信公众号 **北京电信** 回复 **`533`**；电信 App 搜 **网龄礼**；短链如 `bb.bj.cn/bjdx`、`wapbj.189.cn/xkwlhd?channelId=dx533` |

「当月生效 / 次月生效」在不同入口（App 网龄礼 vs 部分 WAP 分享链）说法不一致，以你打开的页面文案为准。

参考（第三方汇总，链接会失效）：

- [爱吾线报 · 专享福利说明](https://25xianbao.com/archives/16287)
- [爱吾线报 · 网龄与成长入口汇总](https://25xianbao.com/archives/18286)
- [线报酷 · 入口讨论](https://new.ixbk.net/douban-maizu/6194874.html)

## 本仓库实际自动化的是哪条路径

默认 recipe 针对冷启动 CI 已跑通的 **成长礼 / HighPic** 壳：

| 阶段 | 期望 |
| --- | --- |
| 入口 | `wap2017` + `preDepositHighPic_check.html` |
| 登录后 | 仍在 `wap2017`，多为 `preDepositCfg_list` / `preDepositCfg_confirm` |
| 拒绝 | `echnwap/preDepositCfq_*` 等 → `wrong_activity` 硬失败 |

公开汇总里常见的成长礼基路径：

```text
https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=16239231179147085&version=V1
```

这里的 `campaignId` 只是社区反复出现的 **路径提示**，不保证对每个号、每个月都可用。你的真实分享链通常还会带 `channelId`、`wxopenid`；冷跑 GitHub runner 时这些 query 键一般需要齐全。

### 默认不要拿来当入口的活动

| 公开称呼（示例） | 典型路径 | 默认 recipe |
| --- | --- | --- |
| 成长礼 / HighPic 月领 | `wap2017/.../preDepositHighPic_check.html` | 支持 |
| 网龄礼包登录页 | `echnwap/preDepositHigh_login?...` | 不是默认入口门 |
| Cfq 仅流量列表 | `echnwap/preDepositCfq_*` | 硬失败 |
| 签到 / 充值礼 / 见面礼 / 福袋 | 其他 HighPic `campaignId` | 别的活动，勿Blind复用 |

## 内置套餐 preset

用 `TELECOM_TARGET_PACKAGE` 只选 **一个**：

| Preset | 校验用的产品名 | 方案编号 |
| --- | --- | --- |
| `voice200`（默认） | `互联网卡网龄享200分钟国内语音` | `24BJ102053` |
| `5g` | `互联网卡网龄享5GB国内通用流量` | `24BJ100433` |

页上即使两个都有，也只会办理你配置的那一个。

## 如何拿到你自己的入口 URL

1. 用你可控的官方路径：公众号回复当前口令（线报常写 `533`）、App 搜网龄礼/成长礼、或客服发来的 WAP 链。
2. 打开后复制 **跳转完成** 的最终 URL（不要只留短链）。
3. 理想形态：

```text
https://wapbj.189.cn/wap2017/index/preDepositHighPic_check.html?campaignId=...&version=V1&channelId=...&wxopenid=...
```

4. **无痕窗口**打开同一 URL，确认能看到你要领的档位。微信暖会话不能代表 CI 冷启动。
5. 完整 URL 只放进 secret `TELECOM_ENTRY_URL`（禁止进 git）。`http://wapbj.189.cn/...` 会自动升成 `https`。

### Query 与环境变量

| Query | 作用 | 开源策略 |
| --- | --- | --- |
| `campaignId` | 活动壳 | 默认只要「有这个键」 |
| `version` | 常为 `V1` | 有则保留 |
| `channelId` | 渠道（公开出现过 `dx531`、`dx533` 等） | 默认要有键；可用 `TELECOM_EXPECTED_CHANNEL_ID` 钉死你的值 |
| `wxopenid` | 账号相关 | 默认要有键；**永不**提交具体值 |

| 变量 | 存放 | 默认 | 含义 |
| --- | --- | --- | --- |
| `TELECOM_ENTRY_URL` | secret | 必填 | 你的完整分享链 |
| `TELECOM_ENTRY_REQUIRED_PARAMS` | variable | `campaignId,channelId,wxopenid` | 必填键名列表 |
| `TELECOM_EXPECTED_CHANNEL_ID` | variable | 空 | 可选精确 channel |

### 领 200 分钟示例

```text
# secrets
TELECOM_PHONE=<北京号>
TELECOM_ENTRY_URL=<含 wxopenid 的完整 HighPic URL>

# variables
TELECOM_TARGET_PACKAGE=voice200
TELECOM_ENTRY_REQUIRED_PARAMS=campaignId,channelId,wxopenid
# TELECOM_EXPECTED_CHANNEL_ID=dx531   # 仅当你的渠道长期固定时
```

### 改领 5GB

同一入口若货架仍有两档，只改：

```text
TELECOM_TARGET_PACKAGE=5g
```

## 上线前自检

1. `probe_only=true`：只看入口与登录滑块。
2. 日志里确认 fingerprint、`wap2017`/`Cfg`、目标产品文案。
3. `dry_run=true`：可走短信，停在最终提交前。
4. 再 `dry_run=false`。

若冷跑落到 `echnwap/Cfq` 或只有小流量包：更新本月官方分享链；不要改去领未配置的 1/2/3GB。

## 相关文档

- [Configuration](configuration.md)（英文总配置）
- [Connectivity](connectivity.md)
- [SMS providers](sms-providers.md)
- [Development](development.md)
- English twin: [beijing-campaign-setup.md](beijing-campaign-setup.md)

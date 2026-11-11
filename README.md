# conversation-pacing
[![npm](https://img.shields.io/npm/v/conversation-pacing.svg)](https://www.npmjs.com/package/conversation-pacing)

<p>
  <a href="https://github.com/hoholi-668/conversation-pacing/actions"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/hoholi-668/conversation-pacing/test.yml?branch=main&label=CI&style=flat-square"></a>
  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
</p>

**English** · [中文文档](#中文文档)

> 已发布到 npm：`npm i conversation-pacing`


> **A pacing library for group-chat bots: when to speak, whom to answer, and when to shut up.**
> Primary thread always answered, interjections decay, and the wake probability adapts to how
> noisy the group is.

**Use this if** your bot either replies to everything (echo machine) or never replies (dead bot),
and you want a cheap heuristic layer **before** spending a model call.

> **Note:** this is **not an MCP server** — it is a small library you import into your own agent.

## API

| Function | Purpose |
|---|---|
| `matchExplicitTrigger` | Decide if a message explicitly addresses the bot |
| `decideFollowUp` | Continue the primary thread or stay silent |
| `shouldWake` | Adaptive wake probability (per-group rate, cooldown) |
| `shouldCatchUp` | Handle a backlog after being idle |
| `batchMessages` / `buildGroupDigest` | Compress many messages into one prompt |

## FAQ

**Is this an MCP server?**
No. It is a library you import; it decides *whether* to spend a model call.

**Can it guarantee the bot never goes silent?**
No. It models "should I speak", not content. Combine with `shouldCatchUp` for backlog.

**How do I tune it?**
Primary-thread replies can be unconditional; interjection uses a decayed score; `shouldWake` uses per-group rate + cooldown.

**Does it work for DMs?**
It is built for group chat; for DMs you usually want `matchExplicitTrigger` only.

## License

MIT

---

# 中文文档

### 这套插件

| 插件 | 作用 | 依赖 |
|---|---|---|
| [mcp-video-learn](https://github.com/hoholi-668/mcp-video-learn) | 视频 / 动图 → 九宫格 + 字幕 | ffmpeg |
| [mcp-roster](https://github.com/hoholi-668/mcp-roster) | 人物名册与权限（默认拒绝） | 无 |
| [conversation-pacing](https://github.com/hoholi-668/conversation-pacing) | 群聊发言节奏：什么时候说、说给谁 | 无 |
| [dsh-qq-persona](https://github.com/hoholi-668/dsh-qq-persona) | 「不像客服」的人格模板 | 无 |
| [mcp-qzone-safe](https://github.com/hoholi-668/mcp-qzone-safe) | QQ 空间操作（**需要 OneBot 网关，存量环境**） | OneBot 网关 |

> 除 qzone 外，其余插件都不依赖任何 IM 网关——任何 MCP 客户端（DSH / Claude / Cursor）都能直接接。

### 30 秒上手

```bash
npm install
npm test          # 9 个单测
npm run simulate  # 时间线模拟，打印每一步决策
```

模拟输出：

```
  0分  阿蓝：今天好累      → 🔵 回复  概率命中（0.020）
0.5分  阿蓝：加班到现在    → 🔵 回复  主对话对象 阿蓝 继续说话
  1分  小满：哈哈         → 🔵 回复  插话命中（第 1 次）
  8分  小满：有人吗        → ⚫ 忽略  续接窗口已过期

=== 插话衰减 ===
  第 1 次插话 → 命中概率 0.500
  第 2 次插话 → 命中概率 0.250
  第 3 次插话 → 命中概率 0.125
  第 5 次插话 → 命中概率 0.050
```

---

### 它怎么决策

```
一条消息进来
  → 在叫我吗？（@ / 名字 / 关键词 / 提问 / 拍一拍）→ 醒
  → 我刚说完话吗？（90 秒窗口）→ 主对话对象必回；别人插话按 0.5ⁿ 衰减
  → 都不是 → 按概率（安静群 2%，热闹群自适应到 6% 封顶）
  → 还没醒 → 堆了 15 条且 10 分钟没看 → 兜底看一次
```

**该醒的时候必须醒，不该醒的时候用概率压住，快饿死的时候兜底。**

---

### 三个最有价值的设计

#### 1. 主对话对象 100%，插话 0.5 衰减

她上一条消息回的是谁，那个人接话就**必回**；别人插话依次 50% → 25% → 12.5% → 5%。

效果：像两个人在聊，旁边的人偶尔能插一句，但不会变成回声机。

#### 2. 自适应概率（2% → 6% 封顶）

安静的群用 2%，热闹的群按消息速率抬升，但**永远不超过 6%**。

为什么不直接调高：安静群会被吵死。为什么不直接调低：热闹群等于永远不醒。

#### 3. 压缩后的「机械小抄」

上下文被压缩后，模型会忘记「谁说了什么」。注入一段 200 字的
`【群聊最近】名字：内容｜...`，她就不会对着空气接话。

**这段不花模型 token——纯字符串拼接。**

---

### 怎么接进 DSH

**先说明：这不是 MCP 服务，是一个调度库。** 它没有工具接口，接入方式是 import 到你的 agent 代码里。

```js
// 你的 DSH 消息处理回调里
import { matchExplicitTrigger, decideFollowUp, shouldWake, shouldCatchUp } from 'conversation-pacing';

const explicit = matchExplicitTrigger({ message, triggers });
const follow = decideFollowUp({ now, lastAiReplyAt, senderUin, primary, hits });
const prob = shouldWake({ message, triggers, rate, adaptive });
const catchUp = shouldCatchUp({ unreadCount, msSinceLastLook });

if (explicit || follow.action === 'reply' || prob.wake || catchUp.catchUp) {
  // 只有这里才值得花一次模型调用
  await wake({ reason: explicit || follow.reason || prob.reason || catchUp.reason });
}
```

如果你只是想**在 DSH 里少被打扰**（不需要群聊场景），这个库帮不上忙——它解决的是
「消息很多、什么时候该接话」，不是「DSH 什么时候该主动说话」。

### 接入你自己的项目

```js
import { matchExplicitTrigger, decideFollowUp, shouldWake, shouldCatchUp } from 'conversation-pacing';

const explicit = matchExplicitTrigger({ message, triggers });
const follow = decideFollowUp({ now, lastAiReplyAt, senderUin, primary, hits });
const prob = shouldWake({ message, triggers, rate, adaptive });
const catchUp = shouldCatchUp({ unreadCount, msSinceLastLook });

if (explicit || follow.action === 'reply' || prob.wake || catchUp.catchUp) {
  await wake({ reason: explicit || follow.reason || prob.reason || catchUp.reason });
}
```

完整说明见 [DESIGN.md 第 6 节](DESIGN.md#6-怎么移植到你的项目)。
参考实现是**纯函数、零依赖**，QQ / Telegram / Discord 都能用。

---

### 实测数据（为什么限流不是抠门）

| 项 | 数值 |
|---|---|
| 单次唤醒成本（25 万 token 上下文） | 约 0.02 元 |
| 每天正常唤醒 | 20~40 次 |
| 每天成本 | 约 0.4~0.8 元 |
| **失控时**（曾 88 分钟唤醒 187 次） | **一天可烧 12 元** |

**限流（1/分、12/时）不是为了省钱，是防 bug 烧钱。**

---

### 文件

```
DESIGN.md               设计文档：17 个场景逐个拆（输入/决策/参数/失败模式）
src/pacing.js           参考实现（纯函数，无依赖）
test/pacing.test.js     9 个单测
examples/simulate.mjs   时间线模拟，可重复
```

**先看 DESIGN.md。** 代码只有 200 行，价值全在场景和参数里。

---

### 边界

- 只管**调度**（什么时候说、说给谁），不管**怎么说话**——那部分见 [dsh-qq-persona](../dsh-qq-persona)
- 纯函数，不绑任何 IM 平台
- 参数是实测值，不是拍脑袋；但**你的群脾气不同，一定要调**

### 遇到问题

不说话 / 太吵 / 压缩后胡言乱语？先看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

---

### 许可

MIT © 2026 HOHOLI

---

### FAQ

**这是 MCP 服务吗？**
不是，是库。它决定「要不要花一次模型调用」，不生成内容。

**能保证不冷场吗？**
不能。它只判断「该不该说」，内容仍由模型决定；积压消息用 `shouldCatchUp`。

**参数怎么调？**
主对话可无条件回；插话用衰减分数；`shouldWake` 按群活跃度和冷却时间调概率。

**私聊能用吗？**
主要面向群聊；私聊一般只用 `matchExplicitTrigger`。

## 检索关键词（给搜索引擎）

群聊节奏 · 发言时机 · 概率唤醒 · 机器人不刷屏

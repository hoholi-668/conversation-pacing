# conversation-pacing

> 让机器人**该说才说**：什么时候说、说给谁、说几次、什么时候闭嘴。

群聊机器人的两个死法：

| 死法 | 症状 |
|---|---|
| **话太多** | 每条消息都接，像客服/回声机，群友开始烦 |
| **话太少** | 叫它不应，聊到它也不接，像个 IQ 很低的机器人 |

这套逻辑解决的就是这两件事。

---

## 它做什么

```
一条消息进来
  → 在叫我吗？（@ / 名字 / 关键词 / 提问 / 拍一拍）→ 醒
  → 我刚说完话吗？（90 秒窗口）→ 主对话对象必回；别人插话按 0.5ⁿ 衰减
  → 都不是 → 按概率（安静群 2%，热闹群自适应到 6% 封顶）
  → 还没醒 → 堆了 15 条且 10 分钟没看 → 兜底看一次
```

**核心：确定性优先，概率兜底。**

该醒的时候必须醒，不该醒的时候用概率压住，快饿死的时候兜底。

---

## 三个最有价值的设计

### 1. 主对话对象 100%，插话 0.5 衰减

她上一条消息回的是谁，那个人接话就**必回**；别人插话依次 50% → 25% → 12.5% → 5%。

效果：像两个人在聊，旁边的人偶尔能插一句，但不会变成回声机。

### 2. 自适应概率（2% → 6% 封顶）

安静的群用 2%，热闹的群按消息速率抬升，但**永远不超过 6%**。

为什么不直接调高：安静群会被吵死；为什么不直接调低：热闹群等于永远不醒。

### 3. 压缩后的「机械小抄」

上下文被压缩后，模型会忘记「谁说了什么」。注入一段 200 字的
`【群聊最近】名字：内容｜...`，她就不会对着空气接话。

**这个不花模型 token——纯字符串拼接。**

---

## 快速开始

```bash
npm install
npm test          # 9 个单测
npm run simulate  # 时间线模拟，打印每一步决策
```

模拟输出长这样：

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

## 文件

```
DESIGN.md            设计文档：17 个场景逐个拆（输入/决策/参数/失败模式）
src/pacing.js        参考实现（纯函数，无依赖）
test/pacing.test.js  9 个单测
examples/simulate.mjs 时间线模拟，可重复
```

**先看 DESIGN.md。** 代码只有 200 行，价值全在场景和参数里。

---

## 接入你自己的项目

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

---

## 实测数据

| 项 | 数值 |
|---|---|
| 单次唤醒成本（25 万 token 上下文） | 约 0.02 元 |
| 每天正常唤醒 | 20~40 次 |
| 每天成本 | 约 0.4~0.8 元 |
| **失控时**（曾 88 分钟唤醒 187 次） | **一天可烧 12 元** |

**限流（1/分、12/时）不是为了省钱，是防 bug 烧钱。**

---

## 遇到问题

不说话 / 太吵 / 压缩后胡言乱语？先看 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 边界

- 只管**调度**（什么时候说、说给谁），不管**怎么说话**——那部分见 [dsh-qq-persona](../dsh-qq-persona)。
- 参考实现是纯函数，不绑任何 IM 平台；QQ / Telegram / Discord 都能用。
- 参数是实测值，不是拍脑袋；但**你的群脾气不同，一定要调**。

---

## 许可

MIT © 2026 HOHOLI

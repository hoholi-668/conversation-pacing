// 参考实现：让机器人「该说才说」。
//
// 全部是纯函数：时间、随机数、状态都从参数传进来，方便单测和模拟。
// 真实项目里你只需要把 state 换成你的会话对象，把 rng 换成 Math.random。

/**
 * 自适应唤醒概率。
 *
 * 群越热闹，普通消息越容易触发唤醒——但**永远不超过 capProbability**。
 * 为什么需要它：群冷时 2% 就够，群热时 2% 等于永远不醒；而调高基础概率
 * 又会让安静的群变成话痨。所以按「最近一分钟消息量」线性抬升，再封顶。
 *
 * @param {object} p
 * @param {number} p.base 基础概率（安静的群用这个）
 * @param {number} p.rate 最近 60 秒的消息条数
 * @param {number} p.capProbability 上限（群再热也不超过）
 * @param {number} p.hotMsgsPerMinute 多热算「热」（达到这个速率就顶到上限）
 * @returns {number} 实际概率 0~1
 */
export function effectiveWakeProbability({ base = 0, rate = 0, capProbability = 0.3, hotMsgsPerMinute = 40 } = {}) {
  const b = Number(base) || 0;
  if (b <= 0) return 0;
  const cap = Math.max(b, Math.min(1, Number(capProbability) || 0));
  const hot = Math.max(1, Number(hotMsgsPerMinute) || 40);
  const lift = cap * Math.min(1, Math.max(0, rate) / hot);
  return Math.min(cap, Math.max(b, lift));
}

/**
 * 「续接窗口」判定：她刚说完话的一小段时间内，谁说话该被接住。
 *
 * 规则（这是整套调度里最关键的一条）：
 *   · 主对话对象（她上一条消息回复的人）→ 100% 唤醒，不限次
 *   · 其他人插话 → 0.5 → 0.25 → 0.125 → 0.05，逐次衰减
 *   · 窗口外 → 只清理，不动作（不补话、不收尾、不额外唤醒）
 *
 * 为什么衰减：三个人同时接话时，如果每条都回，她会变成群里的回声机；
 * 但如果完全不回，又显得"说完就跑"。衰减给了「偶尔接一句插话」的余地。
 *
 * @returns {{action:'reply'|'wait'|'skip', reason:string, hits:number, probability?:number}}
 */
export function decideFollowUp({
  now,
  lastAiReplyAt = 0,
  windowMs = 90_000,
  senderUin = '',
  primary = null,
  hits = 0,
  rng = Math.random
} = {}) {
  if (!lastAiReplyAt) return { action: 'wait', reason: '从未发过言', hits };
  const since = now - lastAiReplyAt;
  if (since > windowMs) return { action: 'skip', reason: '续接窗口已过期', hits: 0 };

  if (primary && senderUin && String(primary.uin) === String(senderUin)) {
    return { action: 'reply', reason: `主对话对象 ${primary.name || primary.uin} 继续说话`, hits };
  }

  const probability = Math.max(0.05, 0.5 * 0.5 ** hits);
  const roll = rng();
  if (roll < probability) {
    return { action: 'reply', reason: `插话命中（第 ${hits + 1} 次）`, hits: hits + 1, probability };
  }
  return { action: 'wait', reason: `插话未命中（roll=${roll.toFixed(2)} ≥ ${probability.toFixed(2)}）`, hits, probability };
}

/**
 * 显式触发条件：这些消息不看概率，直接叫醒。
 *
 * 顺序有意义：@ → 名字 → 关键词 → 提问 → 拍一拍 → 指定成员 → anyMessage。
 * 前几个是「确定在找我」，越靠前越优先。
 */
export function matchExplicitTrigger({ message, triggers = {} } = {}) {
  const text = String(message?.text || '');
  const at = Boolean(message?.atSelf) || /\[At[:：]/.test(text);
  if (at && triggers.atMention !== false) return 'at';
  if (triggers.nameMention && Array.isArray(triggers.names) && triggers.names.some((n) => n && text.includes(n))) return 'name';
  if (Array.isArray(triggers.keywords) && triggers.keywords.some((k) => k && text.includes(k))) return 'keyword';
  if (triggers.question && /[?？]\s*$/.test(text)) return 'question';
  if (message?.kind === 'poke' && triggers.poke) return 'poke';
  const sender = String(message?.userId ?? '');
  if (Array.isArray(triggers.speakerIds) && sender && triggers.speakerIds.map(String).includes(sender)) return 'speaker';
  return null;
}

/**
 * 一条群消息到底要不要叫醒她（不含续接窗口，那部分单独算）。
 *
 * @returns {{wake:boolean, reason:string, probability:number}}
 */
export function shouldWake({
  message,
  triggers = {},
  rate = 0,
  adaptive = {},
  rng = Math.random
} = {}) {
  const explicit = matchExplicitTrigger({ message, triggers });
  if (explicit) return { wake: true, reason: `显式触发：${explicit}`, probability: 1 };

  if (triggers.anyMessage) {
    const p = effectiveWakeProbability({ base: triggers.probability || 0, rate, ...adaptive });
    if (p >= 1) return { wake: true, reason: 'anyMessage', probability: 1 };
    if (p > 0 && rng() < p) return { wake: true, reason: `anyMessage 命中（${p.toFixed(3)}）`, probability: p };
    return { wake: false, reason: `anyMessage 未命中（${p.toFixed(3)}）`, probability: p };
  }

  const p = effectiveWakeProbability({ base: triggers.probability || 0, rate, ...adaptive });
  if (p > 0 && rng() < p) return { wake: true, reason: `概率命中（${p.toFixed(3)}）`, probability: p };
  return { wake: false, reason: p > 0 ? `概率未命中（${p.toFixed(3)}）` : '没有配置概率触发', probability: p };
}

/**
 * 消息批量合并：短时间内多条消息合成一次唤醒，别一条一条叫。
 *
 * 8 秒窗口的意义：群友经常「一句一句蹦」，逐条唤醒会让她看到半句话就接。
 */
export function batchMessages(messages, { windowMs = 8000, now = 0 } = {}) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (!list.length) return { batch: [], pending: [] };
  const cutoff = now - windowMs;
  const batch = [];
  const pending = [];
  for (const m of list) {
    if (Number(m.at || 0) >= cutoff) batch.push(m);
    else pending.push(m);
  }
  return { batch, pending };
}

/**
 * 积压兜底：长时间没看、消息又堆了很多时，只看一次，不逐条接。
 *
 * 为什么需要：概率触发会让她在冷群里彻底消失；但逐条补又像复读机。
 * 折中：「≥N 条 且 ≥M 分钟」才触发，且只读最新的一段。
 */
export function shouldCatchUp({ unreadCount = 0, msSinceLastLook = 0, minUnread = 15, minMinutes = 10 } = {}) {
  if (unreadCount < minUnread) return { catchUp: false, reason: `未读不足 ${minUnread} 条` };
  if (msSinceLastLook < minMinutes * 60_000) return { catchUp: false, reason: `距上次查看不足 ${minMinutes} 分钟` };
  return { catchUp: true, reason: `积压 ${unreadCount} 条、已 ${Math.round(msSinceLastLook / 60_000)} 分钟未看` };
}

/**
 * 上下文压缩后的「机械小抄」：不花模型，纯字符串拼接。
 *
 * 目的：压缩会把「谁说了什么」抹掉，但群聊是连续的。给她一段
 * 「最近 12 条：名字：内容」的小抄，她就不会对着空气接话。
 */
export function buildGroupDigest(messages, { maxKeep = 12, maxChars = 16, nameOf = (m) => m?.sender || '' } = {}) {
  const list = Array.isArray(messages) ? messages.slice(-24) : [];
  const parts = [];
  let dropped = 0;
  for (const m of list) {
    if (!m) continue;
    const who = nameOf(m);
    if (!who) { dropped += 1; continue; }        // 没有名字 = 系统消息，不占位
    const text = String(m.tail || m.plain || m.text || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
    if (!text) continue;
    parts.push(`${who}：${text}`);
  }
  if (parts.length < 3) return { line: '', dropped };
  return { line: `【群聊最近】${parts.slice(-maxKeep).join('｜')}`, dropped };
}

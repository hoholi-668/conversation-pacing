#!/usr/bin/env node
// 时间线模拟：把一串群消息喂给调度器，打印每一步的决策。
//
// 用途：不用真的接机器人，就能看清「什么时候会说话、为什么」。
// 用固定种子的伪随机数，结果可重复。
//
// 用法：node examples/simulate.mjs

import {
  shouldWake,
  decideFollowUp,
  shouldCatchUp,
  buildGroupDigest,
  effectiveWakeProbability
} from '../src/pacing.js';

// 固定种子（mulberry32），保证每次跑出来一样
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = seeded(20261106);
const now0 = new Date('2026-11-07T20:00:00+08:00').getTime();
const min = (n) => n * 60_000;

const triggers = {
  atMention: true,
  nameMention: true,
  names: ['小鲸鱼'],
  keywords: ['DeepSeek'],
  question: true,
  poke: true,
  probability: 0.02
};
const adaptive = { capProbability: 0.06, hotMsgsPerMinute: 40 };

// 模拟一段群聊：主对话对象是「阿蓝」，中间有别人插话
const timeline = [
  { t: 0, from: '阿蓝', text: '今天好累' },
  { t: 0.5, from: '阿蓝', text: '加班到现在' },
  { t: 1, from: '小满', text: '哈哈' },
  { t: 2, from: '阿蓝', text: '你在干嘛' },
  { t: 3, from: '小满', text: '你俩聊啥呢' },
  { t: 4, from: '阿蓝', text: '小鲸鱼你说呢' },
  { t: 5, from: '阿蓝', text: '算了不说了' },
  { t: 8, from: '小满', text: '有人吗' },
  { t: 12, from: '小满', text: '好无聊' },
  { t: 20, from: '阿蓝', text: '困了' }
];

const state = {
  lastAiReplyAt: 0,
  hits: 0,
  lastLookAt: now0,
  recent: [],
  unread: 0
};

const log = [];
function say(msg) {
  const now = now0 + min(msg.t);
  const message = { text: msg.text, userId: msg.from === '阿蓝' ? '111' : '222' };
  const primary = { uin: '111', name: '阿蓝' };

  // 1) 显式触发 / 概率
  const rate = state.recent.filter((m) => now - m.at < 60_000).length;
  const w = shouldWake({ message, triggers, rate, adaptive, rng });

  // 2) 续接窗口
  const f = decideFollowUp({
    now,
    lastAiReplyAt: state.lastAiReplyAt,
    senderUin: message.userId,
    primary,
    hits: state.hits,
    rng
  });

  // 3) 积压兜底
  const c = shouldCatchUp({ unreadCount: state.unread, msSinceLastLook: now - state.lastLookAt });

  let act = 'skip';
  let reason = '无触发';
  if (w.wake) { act = 'reply'; reason = w.reason; }
  else if (f.action === 'reply') { act = 'reply'; reason = f.reason; }
  else if (c.catchUp) { act = 'catch-up'; reason = c.reason; }
  else if (f.action === 'wait' && f.reason.includes('插话')) { act = 'wait'; reason = f.reason; }
  else { reason = f.reason || w.reason; }

  state.hits = f.hits;
  state.unread += 1;
  state.recent.push({ at: now, text: msg.text, from: msg.from });

  if (act === 'reply' || act === 'catch-up') {
    state.lastAiReplyAt = now;
    state.hits = 0;
    state.unread = 0;
    state.lastLookAt = now;
  }

  const tag = act === 'reply' ? '🔵 回复' : act === 'catch-up' ? '🟡 补看' : act === 'wait' ? '⚪ 等待' : '⚫ 忽略';
  log.push(`${String(msg.t).padStart(3)}分  ${msg.from.padEnd(3)}：${msg.text.padEnd(12)} → ${tag}  ${reason}`);
}

for (const m of timeline) say(m);

console.log('=== 时间线模拟（群聊，主对话对象=阿蓝）===\n');
for (const line of log) console.log('  ' + line);

console.log('=== 插话衰减（同一窗口内，她不回复插话者时）===');
const nowFix = now0;
for (let hits = 0; hits <= 5; hits += 1) {
  const r = decideFollowUp({
    now: nowFix + 30_000,
    lastAiReplyAt: nowFix,
    senderUin: '222',
    primary: { uin: '111', name: '阿蓝' },
    hits,
    rng: () => 0.999   // 用一个「注定不命中」的 roll，只看概率
  });
  console.log(`  第 ${hits + 1} 次插话 → 命中概率 ${r.probability.toFixed(3)}`);
}


console.log('\n=== 自适应概率（同一份配置，群热度不同）===');
for (const rate of [0, 5, 20, 40, 80]) {
  const p = effectiveWakeProbability({ base: 0.02, rate, ...adaptive });
  console.log(`  一分钟 ${String(rate).padStart(2)} 条 → 唤醒概率 ${p.toFixed(3)}`);
}

console.log('\n=== 压缩后的小抄 ===');
const digest = buildGroupDigest(
  state.recent.map((m) => ({ sender: m.from, text: m.text })),
  { nameOf: (m) => m.sender }
);
console.log('  ' + (digest.line || '(消息太少，不生成)'));

console.log('\n=== 统计 ===');
const replies = log.filter((l) => l.includes('🔵')).length;
console.log(`  ${timeline.length} 条消息，回复 ${replies} 次（${Math.round((replies / timeline.length) * 100)}%）`);

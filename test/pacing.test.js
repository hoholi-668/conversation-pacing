import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveWakeProbability,
  decideFollowUp,
  matchExplicitTrigger,
  shouldWake,
  batchMessages,
  shouldCatchUp,
  buildGroupDigest
} from '../src/pacing.js';

// 固定随机数，测试才可重复
const always = () => 0;
const never = () => 0.999;
const seq = (...vals) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]; };

test('自适应概率：安静的群用基础值，热闹的群抬升但封顶', () => {
  assert.equal(effectiveWakeProbability({ base: 0, rate: 100 }), 0);
  assert.equal(effectiveWakeProbability({ base: 0.02, rate: 0, capProbability: 0.06, hotMsgsPerMinute: 40 }), 0.02);
  // 40 条/分钟 = 顶到上限
  assert.equal(effectiveWakeProbability({ base: 0.02, rate: 40, capProbability: 0.06, hotMsgsPerMinute: 40 }), 0.06);
  // 20 条/分钟 = 半程抬升
  const half = effectiveWakeProbability({ base: 0.02, rate: 20, capProbability: 0.06, hotMsgsPerMinute: 40 });
  assert.ok(half > 0.02 && half < 0.06, `实际 ${half}`);
  // 超过上限的 rate 也不会突破 cap
  assert.equal(effectiveWakeProbability({ base: 0.02, rate: 999, capProbability: 0.06, hotMsgsPerMinute: 40 }), 0.06);
});

test('续接窗口：主对话对象必回，窗口外只清理', () => {
  const now = 1_000_000;
  const primary = { uin: '111', name: '阿蓝' };

  // 主对话对象说话 → 必回
  const r1 = decideFollowUp({ now, lastAiReplyAt: now - 5000, senderUin: '111', primary, hits: 2 });
  assert.equal(r1.action, 'reply');
  assert.match(r1.reason, /主对话对象/);

  // 窗口过期 → skip
  const r2 = decideFollowUp({ now, lastAiReplyAt: now - 120_000, senderUin: '111', primary });
  assert.equal(r2.action, 'skip');

  // 从没说过话 → wait
  const r3 = decideFollowUp({ now, lastAiReplyAt: 0, senderUin: '111', primary });
  assert.equal(r3.action, 'wait');
});

test('续接窗口：插话按 0.5 逐次衰减，地板 0.05', () => {
  const now = 1_000_000;
  const base = { now, lastAiReplyAt: now - 1000, senderUin: '222', primary: { uin: '111', name: '阿蓝' } };

  // 第一次插话：命中阈值 0.5（roll=0.4 → 命中）
  const first = decideFollowUp({ ...base, hits: 0, rng: () => 0.4 });
  assert.equal(first.action, 'reply');
  assert.equal(first.hits, 1);
  assert.equal(first.probability, 0.5);

  // 第二次：0.25（roll=0.4 → 不中）
  const second = decideFollowUp({ ...base, hits: 1, rng: () => 0.4 });
  assert.equal(second.action, 'wait');
  assert.equal(second.probability, 0.25);

  // 多次之后地板 0.05
  const floor = decideFollowUp({ ...base, hits: 6, rng: always });
  assert.equal(floor.probability, 0.05);
  assert.equal(floor.action, 'reply'); // roll=0 < 0.05
});

test('显式触发：@ / 名字 / 关键词 / 提问 / 拍一拍 / 指定成员', () => {
  assert.equal(matchExplicitTrigger({ message: { text: 'hi', atSelf: true } }), 'at');
  assert.equal(matchExplicitTrigger({ message: { text: '[At:123] 在吗' } }), 'at');
  assert.equal(matchExplicitTrigger({ message: { text: '小鲸鱼你好' }, triggers: { nameMention: true, names: ['小鲸鱼'] } }), 'name');
  assert.equal(matchExplicitTrigger({ message: { text: '今天天气如何？' }, triggers: { question: true } }), 'question');
  assert.equal(matchExplicitTrigger({ message: { kind: 'poke' }, triggers: { poke: true } }), 'poke');
  assert.equal(matchExplicitTrigger({ message: { text: '普通聊天' }, triggers: {} }), null);
});

test('唤醒判定：显式触发不看概率，普通消息看概率', () => {
  // 显式触发
  const at = shouldWake({ message: { text: '在吗', atSelf: true }, triggers: {} });
  assert.equal(at.wake, true);

  // 概率 1 → 必醒
  const all = shouldWake({ message: { text: '随便说说' }, triggers: { probability: 1 } });
  assert.equal(all.wake, true);

  // 概率 0 → 不醒
  const none = shouldWake({ message: { text: '随便说说' }, triggers: { probability: 0 } });
  assert.equal(none.wake, false);

  // 概率 0.5，roll=0.4 → 醒
  const hit = shouldWake({ message: { text: '随便说说' }, triggers: { probability: 0.5 }, rng: always });
  assert.equal(hit.wake, true);

  // 概率 0.5，roll=0.999 → 不醒
  const miss = shouldWake({ message: { text: '随便说说' }, triggers: { probability: 0.5 }, rng: never });
  assert.equal(miss.wake, false);
});

test('批量窗口：8 秒内的消息合并，老消息进 pending', () => {
  const now = 100_000;
  const { batch, pending } = batchMessages([
    { text: 'a', at: now - 60_000 },
    { text: 'b', at: now - 3_000 },
    { text: 'c', at: now - 1_000 }
  ], { windowMs: 8000, now });
  assert.deepEqual(batch.map((m) => m.text), ['b', 'c']);
  assert.deepEqual(pending.map((m) => m.text), ['a']);
});

test('积压兜底：必须同时满足条数和时间', () => {
  assert.equal(shouldCatchUp({ unreadCount: 5, msSinceLastLook: 3600_000 }).catchUp, false);
  assert.equal(shouldCatchUp({ unreadCount: 30, msSinceLastLook: 60_000 }).catchUp, false);
  assert.equal(shouldCatchUp({ unreadCount: 20, msSinceLastLook: 11 * 60_000 }).catchUp, true);
});

test('群聊小抄：保留名字和内容，系统消息不占位，少于 3 条不出', () => {
  const msgs = [
    { sender: '阿蓝', text: '今天好累' },
    { sender: '', text: '系统提示：xxx 加入了群聊' },
    { sender: '小满', text: '累了就睡' },
    { sender: '阿蓝', text: '醒了继续累' }
  ];
  const r = buildGroupDigest(msgs, { nameOf: (m) => m.sender });
  assert.match(r.line, /阿蓝：今天好累/);
  assert.match(r.line, /小满：累了就睡/);
  assert.equal(r.dropped, 1);

  const few = buildGroupDigest([{ sender: 'A', text: '1' }, { sender: 'B', text: '2' }], { nameOf: (m) => m.sender });
  assert.equal(few.line, '');
});

test('群聊小抄：内容截断到指定长度，最多保留 12 条', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ sender: `人${i}`, text: '这是一句很长的话'.repeat(5) }));
  const r = buildGroupDigest(msgs, { nameOf: (m) => m.sender, maxChars: 8 });
  const cells = r.line.split('｜');
  assert.equal(cells.length, 12, `实际 ${cells.length}`);
  assert.ok(cells[0].includes('人18'), `第一条应是第 19 条：${cells[0]}`);
  // 每条内容被截到 8 字以内（不含名字）
  assert.ok(cells[0].split('：')[1].length <= 8);
});

/**
 * 身体事件通道测试：反射不进逐条唤醒，死亡立刻叫醒。
 *
 * 设计约束（来自"每醒一次 = 一个回合 = 一次完整提示词"）：
 *   - 反射是 10Hz 的，几秒能触发好几条 → 必须聚合成摘要
 *   - 死亡是"上次决策错了"的唯一硬信号 → 必须立刻，且不受冷却约束
 *   - 摘要要有"这些你没参与"的暗示，避免她以为自己做过这些决定
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEventAggregator, decideEventWake, formatEventDigest } from "../lib/mc-events.js";

test("聚合：只收非聊天事件，按窗口裁剪", () => {
  const agg = createEventAggregator({ windowMs: 10_000 });
  agg.push({ kind: "chat", text: "<张三> 你好" });
  agg.push({ kind: "reflex", name: "EAT", why: "food=16", t: 1000 });
  agg.push({ kind: "reflex", name: "RETALIATE", why: "hurt(steve)", t: 2000 });

  assert.equal(agg.size, 2, "聊天不该进事件聚合");

  // 窗口外（now=20000，只留 t>10000 的 → 全被裁掉）
  assert.equal(agg.prune(20_000), 0);
  assert.equal(agg.size, 0);
});

test("死亡：立刻叫醒，不受冷却限制", () => {
  const agg = createEventAggregator();
  agg.push({ kind: "death", pos: [96, 110, 3], goal: true, deaths: 2, t: 1000 });
  const v = decideEventWake({
    aggregator: agg,
    evt: { kind: "death" },
    lastWakeAt: 999_999, // 刚叫醒过
    cooldownMs: 180_000,
    now: 1_000_000,
  });
  assert.equal(v.wake, true, "死亡必须无视冷却");
  assert.equal(v.reason, "death");
});

test("反射：单条不叫醒（quiet），攒到阈值才叫", () => {
  const agg = createEventAggregator({ windowMs: 120_000 });
  agg.push({ kind: "reflex", name: "EAT", why: "food=16", t: 1000 });
  const one = decideEventWake({ aggregator: agg, evt: { kind: "reflex" }, lastWakeAt: 0, burstThreshold: 3, now: 2000 });
  assert.equal(one.wake, false, "一条反射不值得一个回合");

  agg.push({ kind: "reflex", name: "RETALIATE", why: "hurt", t: 1500 });
  agg.push({ kind: "reflex", name: "RETALIATE", why: "hurt", t: 1600 });
  const burst = decideEventWake({ aggregator: agg, evt: { kind: "reflex" }, lastWakeAt: 0, burstThreshold: 3, now: 2000 });
  assert.equal(burst.wake, true);
  assert.equal(burst.reason, "burst");
});

test("反射：冷却过后给摘要；冷却内闭嘴", () => {
  const agg = createEventAggregator({ windowMs: 900_000 });
  agg.push({ kind: "reflex", name: "GOTO", why: "lava(2)", t: 1000 });
  agg.push({ kind: "reflex", name: "STOP", why: "lava-no-exit", t: 1100 });

  const inCooldown = decideEventWake({
    aggregator: agg,
    evt: { kind: "reflex" },
    lastWakeAt: 1000,
    cooldownMs: 180_000,
    burstThreshold: 9,
    now: 60_000,
  });
  assert.equal(inCooldown.wake, false);
  assert.equal(inCooldown.reason, "cooldown");

  const afterCooldown = decideEventWake({
    aggregator: agg,
    evt: { kind: "reflex" },
    lastWakeAt: 1000,
    cooldownMs: 180_000,
    burstThreshold: 9,
    now: 400_000,
  });
  assert.equal(afterCooldown.wake, true);
  assert.equal(afterCooldown.reason, "digest");
});

test("目标完成：冷却过后立刻给", () => {
  const agg = createEventAggregator();
  agg.push({ kind: "goal-done", t: 1000 });
  const v = decideEventWake({ aggregator: agg, evt: { kind: "goal-done" }, lastWakeAt: 0, now: 2000 });
  assert.equal(v.wake, true);
  assert.equal(v.reason, "goal-done");
});

test("摘要文本：分组计数、带 why、明确说「你没参与」", () => {
  const entries = [
    { kind: "reflex", name: "RETALIATE", why: "hurt(steve)", t: 1000 },
    { kind: "reflex", name: "RETALIATE", why: "latch(player)", t: 1100 },
    { kind: "reflex", name: "RETALIATE", why: "hurt(steve)", t: 1200 },
    { kind: "reflex", name: "EAT", why: "food=16,hp=6.2", t: 1300 },
    { kind: "death", pos: [96, 110, 3], goal: true, deaths: 1, t: 1400 },
  ];
  const text = formatEventDigest(entries, { now: 5000 });
  assert.ok(text.includes("身体自己动了"));
  assert.ok(text.includes("这些动作你事先不知道"), "必须点明这些不是她的决策");
  assert.ok(text.includes("RETALIATE（还手） ×3"), `应按名字分组计数，实际：${text}`);
  assert.ok(text.includes("触发：被 steve 打了"), "why 要翻译成人话，不是原样贴机器串");
  assert.ok(text.includes("想改：不想还手 → directive.combat.players=false"), "要告诉她能改哪个旋钮");
  assert.ok(!text.includes("hurt(steve)"), "机器串不该原样出现");
  assert.ok(text.includes("EAT（吃东西） ×1"));
  assert.ok(text.includes("饥饿 16"), "进食原因要带饥饿值");
  assert.ok(text.includes("死了 ×1"));
  assert.ok(text.includes("当时有目标"));
  assert.ok(text.includes("directive"), "应告诉她怎么改");
  assert.ok(text.includes("它听不见你说话"), "必须说明反射层听不见文本");

  assert.equal(formatEventDigest([], {}), "");
});

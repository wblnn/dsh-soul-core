/**
 * 收件箱测试：回合制思考 vs 连续事件簇。
 *
 * 硬约束：
 *   P0 立刻唤醒（但不重复唤醒——单飞）
 *   P1 合并窗口后一次唤醒，带上窗口内全部
 *   P2 永不唤醒，只进 context
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createInbox, decideDispatch, severityOf } from "../lib/mc-inbox.js";

test("分发：忙时插话（不开新回合），闲时才开回合", () => {
  const now = 100_000;

  // 忙：P0 / P1 都走 inject —— 这是"塞进对话图里"，时效性最好且零额外回合
  assert.equal(decideDispatch({ severity: "P0", busy: true, now, lastWakeAt: now - 500 }).action, "inject");
  assert.equal(decideDispatch({ severity: "P1", busy: true, now, lastWakeAt: now - 500 }).action, "inject");

  // 闲：P0 立刻开回合；刚开过则先攒（单飞）
  assert.equal(decideDispatch({ severity: "P0", busy: false, now, lastWakeAt: 0 }).action, "wake");
  assert.equal(
    decideDispatch({ severity: "P0", busy: false, now, lastWakeAt: now - 2_000, singleFlightMs: 15_000 }).action,
    "hold",
  );

  // 闲：P1 等合并窗口；P2 永远只进 context
  assert.equal(decideDispatch({ severity: "P1", busy: false, now, lastWakeAt: 0 }).action, "hold");
  assert.equal(decideDispatch({ severity: "P2", busy: true, now }).action, "context");
  assert.equal(decideDispatch({ severity: "P2", busy: false, now }).action, "context");
});

test("分级：死亡/挨打/低血/岩浆 → P0；打断/完成 → P1；其余反射 → P2", () => {
  assert.equal(severityOf({ kind: "death" }), "P0");
  assert.equal(severityOf({ kind: "reflex", name: "RETALIATE", why: "hurt(player:steve)" }), "P0");
  assert.equal(severityOf({ kind: "reflex", name: "GOTO", why: "lowhp" }), "P0");
  assert.equal(severityOf({ kind: "reflex", name: "GOTO", why: "lava(2)" }), "P0");
  assert.equal(severityOf({ kind: "reflex", name: "RESPAWN", why: "dead" }), "P0");

  assert.equal(severityOf({ kind: "interrupt", explain: "新目标覆盖" }), "P1");
  assert.equal(severityOf({ kind: "goal-done" }), "P1");

  assert.equal(severityOf({ kind: "reflex", name: "EAT", why: "food=17" }), "P2");
  assert.equal(severityOf({ kind: "reflex", name: "GOTO", why: "return-home(4.0)" }), "P2");
  assert.equal(severityOf({ kind: "reflex", name: "DROP", why: "discard junk" }), "P2");
  assert.equal(severityOf({ kind: "whatever" }), "P2");
});

test("收件箱：push 返回级别，take 取走并清空", () => {
  const box = createInbox();
  assert.equal(box.push({ kind: "reflex", name: "EAT", why: "food=17" }), "P2");
  assert.equal(box.push({ kind: "death" }), "P0");
  assert.equal(box.size, 2);
  assert.equal(box.has("P0"), true);
  assert.equal(box.has("P1"), false);

  const p0 = box.take(["P0"]);
  assert.equal(p0.length, 1);
  assert.equal(p0[0].kind, "death");
  assert.equal(box.size, 1, "P0 取走后 P2 还在");

  const rest = box.take();
  assert.equal(rest.length, 1);
  assert.equal(rest[0].name, "EAT");
  assert.equal(box.size, 0);
});

test("簇：一波里多个 P0 + 若干 P2，一次 take 全拿到（只开一个回合）", () => {
  const box = createInbox();
  const burst = [
    { kind: "reflex", name: "RETALIATE", why: "hurt(player:steve)" },
    { kind: "reflex", name: "RETALIATE", why: "hurt(player:steve)" },
    { kind: "reflex", name: "GOTO", why: "lowhp" },
    { kind: "reflex", name: "EAT", why: "food=6" },
    { kind: "death" },
  ];
  for (const e of burst) box.push(e);

  const all = box.take();
  assert.equal(all.length, 5, "整簇一次取完");
  assert.equal(box.size, 0);
});

test("容量上限：超出丢最老的（防止长时间空闲积爆）", () => {
  const box = createInbox({ maxItems: 3 });
  for (let i = 0; i < 6; i++) box.push({ kind: "reflex", name: "EAT", why: `food=${i}`, seq: i });
  assert.equal(box.size, 3);
  const left = box.take();
  assert.deepEqual(left.map((e) => e.seq), [3, 4, 5]);
});

test("oldestAt 用来算最迟延迟", () => {
  const box = createInbox();
  assert.equal(box.oldestAt(), 0);
  box.push({ kind: "death" }, 1000);
  box.push({ kind: "reflex", name: "EAT", why: "food=1" }, 2000);
  assert.equal(box.oldestAt(), 1000);
});

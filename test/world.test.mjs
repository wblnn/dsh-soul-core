/**
 * delta（世界状态）+ 预算闸 + 检索门控 的测试。
 *
 * 三条都来自"会咬人的地方"清单：
 *   ① cursor 必须落盘（重启不能把 12 小时当新事件重放）
 *   ② delta 要有白名单（公屏闲聊不算，否则变成变相全量注入）
 *   ③ 命中 ≠ 相关（寒暄不跑检索；命中行要跟输入有实词重叠）
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { openStore } from "../lib/memory-store.js";
import { isPhatic, isRelevant } from "../lib/relevance.js";
import { collectDelta, getCursor, markInjected, alreadyInjected, recordWorldEvent, resetSessionMemory, setCursor, shouldEmitState } from "../lib/world.js";

const roots = [];
const dbs = [];

function tmpDb() {
  const root = mkdtempSync(join(tmpdir(), "soul-world-"));
  roots.push(root);
  const db = openStore(join(root, "memory-tree", "memory.db"));
  dbs.push(db);
  return db;
}

after(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  resetSessionMemory("S1");
  resetSessionMemory("S2");
});

function seedSession(db, sessionId, preset = "soul") {
  db.prepare("INSERT OR IGNORE INTO sessions (session_id, file, workspace, preset) VALUES (?,?,?,?)").run(
    sessionId,
    `f-${sessionId}`,
    "w",
    preset,
  );
}
function addMessage(db, { sessionId, seq, role, text, time }) {
  db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?,?,?,?,?,?,?,?)",
  ).run(sessionId, seq, "soul", role, text, time, 1, text.length);
}

/* ─────────────────── cursor ─────────────────── */

test("cursor：落盘、只往前推、重启还在", () => {
  const db = tmpDb();
  assert.equal(getCursor(db, "S1"), null, "没记录就是 null（不是 0）");

  setCursor(db, "S1", 1000);
  assert.equal(getCursor(db, "S1"), 1000);

  setCursor(db, "S1", 500); // 想往回退
  assert.equal(getCursor(db, "S1"), 1000, "只能往前推");

  // 关掉再开（模拟重启）：值还在
  const path = db.prepare("PRAGMA database_list").all().find((r) => r.name === "main").file;
  db.close();
  const reopened = openStore(path);
  dbs.push(reopened);
  assert.equal(getCursor(reopened, "S1"), 1000, "重启后 cursor 必须还在（否则 delta 会把历史重放一遍）");
});

/* ─────────────────── delta 白名单 ─────────────────── */

test("delta：别的会话里他说的话算新事件", () => {
  const db = tmpDb();
  seedSession(db, "S1");
  seedSession(db, "S2");
  const now = 2_000_000;
  addMessage(db, { sessionId: "S2", seq: 1, role: "user", text: "我把钥匙放鞋柜第二层了", time: now - 1000 });

  const r = collectDelta(db, { sessionId: "S1", sinceMs: now - 5000, now, budget: 180 });
  assert.ok(r.text.includes("钥匙"));
  assert.ok(r.text.includes("你不在这会儿"));
});

test("delta：MC 公屏闲聊不算（否则变相全量注入）", () => {
  const db = tmpDb();
  seedSession(db, "S1");
  seedSession(db, "S2");
  const now = 3_000_000;
  addMessage(db, {
    sessionId: "S2",
    seq: 1,
    role: "user",
    text: "【MC 公屏 · 最近 5 条】<steve> 在吗 <steve> 哈哈哈",
    time: now - 1000,
  });

  const r = collectDelta(db, { sessionId: "S1", sinceMs: now - 5000, now });
  assert.equal(r.text, "", "信封式公屏消息不该进 delta");
});

test("delta：她自己说的话不算", () => {
  const db = tmpDb();
  seedSession(db, "S1");
  seedSession(db, "S2");
  const now = 4_000_000;
  addMessage(db, { sessionId: "S2", seq: 1, role: "assistant", text: "我自己刚说了这句", time: now - 1000 });
  const r = collectDelta(db, { sessionId: "S1", sinceMs: now - 5000, now });
  assert.equal(r.text, "", "role=assistant 不进 delta");
});

test("delta：world_events 里的遭遇算（P0 优先）", () => {
  const db = tmpDb();
  seedSession(db, "S1");
  const now = 5_000_000;
  recordWorldEvent(db, { kind: "death", severity: "P0", text: "被骷髅射死了，掉了铁剑", atMs: now - 60_000 });
  recordWorldEvent(db, { kind: "goal-done", severity: "P1", text: "挖到 3 颗钻石", atMs: now - 30_000 });

  const r = collectDelta(db, { sessionId: "S1", sinceMs: now - 120_000, now, budget: 180 });
  assert.ok(r.text.includes("铁剑"));
  assert.ok(r.lines[0].includes("铁剑"), "P0 要排在前面");
});

test("delta：光标之后才算，已交代过的不重复", () => {
  const db = tmpDb();
  seedSession(db, "S1");
  seedSession(db, "S2");
  const now = 6_000_000;
  addMessage(db, { sessionId: "S2", seq: 1, role: "user", text: "旧消息", time: now - 60_000 });
  const r = collectDelta(db, { sessionId: "S1", sinceMs: now - 1000, now });
  assert.equal(r.text, "", "光标之后没有新东西");
});

test("delta：预算生效，不超过给定字符数", () => {
  const db = tmpDb();
  seedSession(db, "S1");
  seedSession(db, "S2");
  const now = 7_000_000;
  for (let i = 0; i < 10; i++) {
    addMessage(db, { sessionId: "S2", seq: i + 1, role: "user", text: `第${i}条比较长的消息内容啊啊啊`, time: now - 1000 + i });
  }
  const r = collectDelta(db, { sessionId: "S1", sinceMs: now - 10_000, now, budget: 120, maxLines: 3 });
  assert.ok(r.chars <= 160, `预算要生效，实际 ${r.chars}`);
  assert.ok(r.lines.length <= 3);
});

/* ─────────────────── 去重账本 ─────────────────── */

test("hash 去重：同一会话同一行只给一次", () => {
  const db = tmpDb();
  assert.equal(alreadyInjected("S1", "同一行"), false);
  markInjected("S1", "同一行");
  assert.equal(alreadyInjected("S1", "同一行"), true);
  assert.equal(alreadyInjected("S2", "同一行"), false, "不同会话互不影响");
});

test("状态类：值变了才给 / 冷却期内不给 / 冷却过了复现", () => {
  resetSessionMemory("S1");
  const now = 10_000_000;

  const first = shouldEmitState("S1", "mine:钻石", "3", now, 6 * 3600_000);
  assert.equal(first.emit, true);
  assert.equal(first.reason, "first");

  const same = shouldEmitState("S1", "mine:钻石", "3", now + 60_000, 6 * 3600_000);
  assert.equal(same.emit, false, "值没变、冷却没到 → 不给");

  const changed = shouldEmitState("S1", "mine:钻石", "2", now + 120_000, 6 * 3600_000);
  assert.equal(changed.emit, true, "值变了 → 给");
  assert.equal(changed.reason, "value-changed");

  const cooldown = shouldEmitState("S1", "mine:钻石", "2", now + 7 * 3600_000, 6 * 3600_000);
  assert.equal(cooldown.emit, true, "牵挂该复现");
  assert.equal(cooldown.reason, "cooldown");
});

/* ─────────────────── 检索门控 ─────────────────── */

test("门控：寒暄不跑检索", () => {
  for (const t of ["在吗", "吃了吗", "哈哈哈哈", "嗯", "？", "晚安喵", "ok"]) {
    assert.equal(isPhatic(t), true, `应判寒暄：${t}`);
  }
  for (const t of ["上次说的那个爬虫怎么样了", "你还记得钥匙放哪吗", "今天在 MC 里挖到钻石了"]) {
    assert.equal(isPhatic(t), false, `不该判寒暄：${t}`);
  }
});

test("门控：命中行要跟输入有 ≥2 实词重叠", () => {
  assert.equal(isRelevant("你还记得钥匙放哪吗", "钥匙放在鞋柜第二层").ok, true);
  assert.equal(isRelevant("你还记得钥匙放哪吗", "今天天气不错").ok, false, "命中 ≠ 相关");
  assert.equal(isRelevant("上次说的那个爬虫", "三个月前我们吃了顿火锅").ok, false);

  // 虚词不参与重叠
  const v = isRelevant("这个那个就是东西", "那个东西在这里");
  assert.ok(v.overlap < 2, `虚词不该算重叠，实际 ${v.overlap}`);
});

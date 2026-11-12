/**
 * 跨会话简报（B）：换个会话接着聊，不该要求他复述。
 *
 * 预检索是词法的——"钥匙放鞋柜了" vs "那东西在哪" 一个词都对不上。
 * 这段不靠命中，直接把别的会话里最近的原话接上。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { openStore, recentOtherSessions } from "../lib/memory-store.js";

const roots = [];
const dbs = [];

function tmpDb() {
  const root = mkdtempSync(join(tmpdir(), "soul-recent-"));
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
});

function seed(db, { sessionId, preset, messages, baseTime }) {
  db.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, file, workspace, preset, updated_at) VALUES (?,?,?,?,?)",
  ).run(sessionId, `f-${sessionId}`, "w", preset, new Date(baseTime).toISOString());
  const stmt = db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?,?,?,?,?,?,?,?)",
  );
  messages.forEach((m, i) =>
    stmt.run(sessionId, i + 1, preset, m.role, m.text, baseTime + i * 1000, 1, m.text.length),
  );
}

test("别的会话说过的话会被带上来（不需要关键词命中）", () => {
  const db = tmpDb();
  const now = Date.now();
  seed(db, {
    sessionId: "A",
    preset: "soul",
    baseTime: now - 3600_000,
    messages: [{ role: "user", text: "钥匙放在鞋柜第二层了" }],
  });

  const r = recentOtherSessions(db, { currentSession: "B", hours: 12, budget: 600 });
  assert.equal(r.entries.length, 1);
  assert.ok(r.text.includes("钥匙放在鞋柜第二层"), "原话要在");
  assert.ok(r.text.includes("不是这个会话"), "要说明这不是当前会话");
});

test("当前会话自己不算「别的会话」", () => {
  const db = tmpDb();
  const now = Date.now();
  seed(db, {
    sessionId: "B",
    preset: "soul",
    baseTime: now - 600_000,
    messages: [{ role: "user", text: "这句话来自当前会话，不该被当成外部记忆" }],
  });

  const r = recentOtherSessions(db, { currentSession: "B", hours: 12 });
  assert.equal(r.entries.length, 0);
  assert.equal(r.text, "");
});

test("超过时间窗的旧事不带（避免每次都翻陈年旧账）", () => {
  const db = tmpDb();
  const now = Date.now();
  seed(db, {
    sessionId: "A",
    preset: "soul",
    baseTime: now - 48 * 3600_000,
    messages: [{ role: "user", text: "两天前说的旧事" }],
  });

  const r = recentOtherSessions(db, { currentSession: "B", hours: 12 });
  assert.equal(r.text, "");
});

test("预算生效：不无限塞，最多 3 个会话", () => {
  const db = tmpDb();
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    seed(db, {
      sessionId: `S${i}`,
      preset: "soul",
      baseTime: now - i * 60_000 - 60_000,
      messages: [{ role: "user", text: `第${i}个会话说的话` }],
    });
  }
  const r = recentOtherSessions(db, { currentSession: "X", hours: 12, budget: 200 });
  assert.ok(r.entries.length <= 3, `最多 3 个会话，实际 ${r.entries.length}`);
  assert.ok(r.text.length <= 400, `预算要生效，实际 ${r.text.length} 字符`);
});

test("群里/游戏里的信封消息不进简报", () => {
  const db = tmpDb();
  const now = Date.now();
  seed(db, {
    sessionId: "A",
    preset: "soul-mc",
    baseTime: now - 3600_000,
    messages: [
      { role: "user", text: "【MC 公屏 · 最近 5 条】<steve> 帮我挖矿" },
      { role: "user", text: "真的原话在这" },
    ],
  });

  const r = recentOtherSessions(db, { currentSession: "B", hours: 12 });
  assert.ok(!r.text.includes("最近 5 条"), "信封要过滤掉");
  assert.ok(r.text.includes("真的原话在这"));
});

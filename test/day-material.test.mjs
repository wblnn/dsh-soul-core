/**
 * 按日期取素材的测试：她要"补写某天的日记"时，这是唯一可靠的原料来源。
 *
 * 起因：她翻 Diary 目录看到空的，就以为"那天没发生事"，于是拒绝补写
 * —— 其实底仓里那天有 214 条消息。日记目录 ≠ 底仓。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { materialsForDay, openStore } from "../lib/memory-store.js";

const roots = [];
const dbs = [];
function tmpDb() {
  const root = mkdtempSync(join(tmpdir(), "soul-day-"));
  roots.push(root);
  const db = openStore(join(root, "memory-tree", "memory.db"));
  dbs.push(db);
  return db;
}
after(() => {
  // 先关句柄，否则 Windows 上删目录会 EPERM
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function seed(db, { day, rows }) {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d, 10, 0, 0).getTime();
  db.prepare("INSERT OR IGNORE INTO sessions (session_id, file, workspace, preset) VALUES (?,?,?,?)").run(
    "s1",
    "f",
    "w",
    "soul",
  );
  const stmt = db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?,?,?,?,?,?,?,?)",
  );
  rows.forEach((r, i) => stmt.run("s1", i + 1, "soul", r.role, r.text, start + i * 1000, 1, r.text.length));
}

test("按日期取素材：那天有就说有，没有就说没有", () => {
  const db = tmpDb();
  seed(db, {
    day: "2026-10-31",
    rows: [
      { role: "user", text: "来啦 上线试试" },
      { role: "assistant", text: "上来了，我在楼上床上 (96,110,4)" },
      { role: "tool", text: "工具输出（不算正文）" },
    ],
  });

  const hit = materialsForDay(db, { day: "2026-10-31" });
  assert.equal(hit.error, undefined);
  assert.equal(hit.sessions.length, 1);
  assert.equal(hit.messages.length, 2, "只取 user/assistant，工具输出不算素材");
  assert.ok(hit.messages[0].text.includes("上线试试"));

  const miss = materialsForDay(db, { day: "2026-11-07" });
  assert.equal(miss.messages.length, 0);
  assert.equal(miss.total, 0);
});

test("日期格式不对要报错，不能静默返回空", () => {
  const db = tmpDb();
  assert.equal(materialsForDay(db, { day: "10月31号" }).error, "day 需要 YYYY-MM-DD");
  assert.equal(materialsForDay(db, {}).error, "day 需要 YYYY-MM-DD");
});

test("预算生效：超了就截断（素材是给模型看的，不能无限）", () => {
  const db = tmpDb();
  seed(db, {
    day: "2026-10-31",
    rows: Array.from({ length: 40 }, (_, i) => ({ role: "user", text: `第${i}句`.repeat(40) })),
  });
  const r = materialsForDay(db, { day: "2026-10-31", maxChars: 500 });
  assert.ok(r.chars <= 500, `预算应生效，实际 ${r.chars}`);
  assert.ok(r.messages.length < 40);
  assert.equal(r.total, 40, "total 反映那天真实条数");
});

test("跨月边界：月末那天的 23:59 也算那天", () => {
  const db = tmpDb();
  const late = new Date(2026, 9, 31, 23, 59, 0).getTime(); // 2026-10-31 23:59 本地
  db.prepare("INSERT OR IGNORE INTO sessions (session_id, file, workspace, preset) VALUES (?,?,?,?)").run(
    "s2",
    "f",
    "w",
    "soul",
  );
  db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?,?,?,?,?,?,?,?)",
  ).run("s2", 1, "soul", "user", "月末最后一句话", late, 1, 7);

  const r = materialsForDay(db, { day: "2026-10-31" });
  assert.equal(r.messages.length, 1);
  assert.ok(r.messages[0].text.includes("月末"));
});

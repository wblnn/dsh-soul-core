/**
 * 梦的测试（不调模型）：素材收集、prompt、JSON 解析、锚点校验、落库、日记。
 *
 * 最要紧的一条：**锚点对不上的 note 必须丢掉**——否则她"记错了"和"编了"分不出来。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  collectDay,
  buildDreamPrompt,
  hasDayActivity,
  keepVerifiedNotes,
  parseDreamJson,
  previousDay,
  saveDreamNotes,
  textOfChunks,
  verifyAnchor,
  writeDreamDiary,
} from "../lib/dream.js";
import { openStore } from "../lib/memory-store.js";

const roots = [];
const dbs = [];
function tmpDb() {
  const root = mkdtempSync(join(tmpdir(), "soul-dream-"));
  roots.push(root);
  const db = openStore(join(root, "memory-tree", "memory.db"));
  dbs.push(db);
  return { root, db };
}
after(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* 句柄 */
    }
  }
});

const DAY = "2026-11-13";
const T = new Date(2026, 10, 13, 20, 0, 0).getTime();

function seedDay(db) {
  db.prepare("INSERT OR IGNORE INTO sessions (session_id, file, workspace, preset) VALUES (?,?,?,?)").run(
    "session-abc",
    "f",
    "w",
    "soul",
  );
  const stmt = db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?,?,?,?,?,?,?,?)",
  );
  stmt.run("session-abc", 10, "soul", "user", "屋顶还差三块木板", T, 1, 9);
  stmt.run("session-abc", 11, "soul", "assistant", "明天接着封吧，我先记着", T + 1000, 1, 12);
  // 信封不该进素材
  stmt.run("session-abc", 12, "soul", "user", "【MC 公屏 · 最近 5 条】<steve> 在吗", T + 2000, 1, 20);
  // 建一条 episode 覆盖 10..12
  db.prepare(
    "INSERT OR REPLACE INTO episodes (episode_id, session_id, seq_start, seq_end, turn_start, turn_end, reason, event_count, chars, preview, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("session-abc#10-12", "session-abc", 10, 12, 1, 1, "session-start", 3, 41, "", new Date().toISOString());
}

test("collectDay：只取当天、过滤信封、带锚点", () => {
  const { db } = tmpDb();
  seedDay(db);
  const m = collectDay(db, DAY);
  assert.equal(m.empty, false);
  assert.equal(m.lines.length, 1);
  assert.ok(m.lines[0].includes("session-abc#10-12"), "要带锚点");
  assert.ok(!m.lines[0].includes("MC 公屏"), "信封不能进素材");
  assert.ok(m.lines[0].includes("屋顶"));
});

test("collectDay：没有素材的日子是空的", () => {
  const { db } = tmpDb();
  assert.equal(collectDay(db, "2020-01-01").empty, true);
  assert.equal(hasDayActivity(db, "2020-01-01"), false);
});

test("buildDreamPrompt：带人格、带锚点规则、不塞全文", () => {
  const { root, db } = tmpDb();
  seedDay(db);
  const m = collectDay(db, DAY);
  const p = buildDreamPrompt(root, m);
  assert.ok(p.system.includes("不许编造"));
  assert.ok(p.system.includes("anchors"), "要规定锚点格式");
  assert.ok(p.user.includes(DAY));
  assert.ok(p.messages.length === 2);
  assert.equal(p.messages[0].role, "system");
});

test("parseDreamJson：容忍代码块围栏与前后废话", () => {
  assert.deepEqual(parseDreamJson('{"notes":[]}'), { notes: [] });
  assert.deepEqual(parseDreamJson('好的，这是结果：\n```json\n{"notes":[]}\n```\n以上'), { notes: [] });
  assert.equal(parseDreamJson("完全不是 JSON"), null);
  assert.equal(parseDreamJson(""), null);
});

test("锚点校验：对得上的留，对不上的丢", () => {
  const { db } = tmpDb();
  seedDay(db);

  assert.equal(verifyAnchor(db, { session: "session-abc", from: 10, to: 11 }).ok, true);
  assert.equal(verifyAnchor(db, { session: "session-abc", from: 500, to: 600 }).ok, false);
  assert.equal(verifyAnchor(db, { session: "nope", from: 1, to: 2 }).ok, false);
  assert.equal(verifyAnchor(db, {}).ok, false);

  const { kept, dropped } = keepVerifiedNotes(db, [
    { topic: "真", text: "a", anchors: [{ session: "session-abc", from: 10, to: 11 }] },
    { topic: "编", text: "b", anchors: [{ session: "session-abc", from: 900, to: 999 }] },
    { topic: "没锚点", text: "c", anchors: [] },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].topic, "真");
  assert.equal(dropped.length, 2);
});

test("落库：同一天重跑覆盖，不产生重复", () => {
  const { db } = tmpDb();
  seedDay(db);
  const note = { topic: "屋顶", text: "还差三块", tags: ["屋顶"], anchors: [{ session: "session-abc", from: 10, to: 11 }] };
  assert.equal(saveDreamNotes(db, DAY, [note], "deepseek-flash"), 1);
  assert.equal(saveDreamNotes(db, DAY, [note, note], "deepseek-flash"), 2, "同一天覆盖");
  const rows = db.prepare("SELECT COUNT(*) AS n FROM dream_notes WHERE day = ?").get(DAY);
  assert.equal(Number(rows.n), 2);
});

test("日记：写到 diary/<day>.md，空内容不写", () => {
  const { root } = tmpDb();
  const file = writeDreamDiary(root, DAY, "今天把屋顶又试了一遍，还是差三块。");
  assert.ok(file && existsSync(file));
  assert.ok(readFileSync(file, "utf8").includes("屋顶"));
  assert.equal(writeDreamDiary(root, DAY, "   "), "", "空日记不写");
});

test("textOfChunks：拼 text-delta", () => {
  const text = textOfChunks([
    { type: "block-start" },
    { type: "text-delta", text: '{"notes":' },
    { type: "text-delta", text: "[]}" },
    { type: "finish" },
  ]);
  assert.equal(text, '{"notes":[]}');
});

test("previousDay：凌晨跑时取的是刚过去的那一天", () => {
  const at0230 = new Date(2026, 10, 14, 2, 30, 0);
  assert.equal(previousDay(at0230), "2026-11-13");
});

/**
 * 底仓测试：用一个**真实的多帧 zstd 日志**跑通
 *   摄取 → 事件索引 → 事件骨架（硬边界 + idle gap）→ 锚点下钻回原文。
 *
 * 夹具是现场造的：把 JSONL 分几段、每段各压一帧再拼接，
 * 跟 DSH 逐次追加写日志的形态一致（这也是 Node 内置 zstd 只解第一帧的坑）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { after, test } from "node:test";

import {
  DEFAULT_IDLE_GAP_MS,
  buildDigest,
  expand,
  ingestAll,
  ingestSession,
  listEpisodes,
  listMessages,
  listNotes,
  listNotesRanked,
  listSessions,
  openStore,
  purgeNonPersona,
  rebuildEpisodes,
  recordUsage,
  saveNote,
  searchMessages,
  searchNotes,
  stats,
  tierSummary,
  verifyAnchors,
} from "../lib/memory-store.js";
import { buildMemoryBrief } from "../lib/inject.js";
import { decodeFrames, eventText, findSessionFiles, sessionIdOf, toIndexRow } from "../lib/session-source.js";

const dirs = [];
const stores = [];
function track(db) { stores.push(db); return db; }
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "soul-mem-"));
  dirs.push(d);
  return d;
}
after(() => {
  for (const db of stores) { try { db.close(); } catch { /* already closed */ } }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SESSION_ID = "session-test-0001";

function ev(type, seq, time, data) {
  return JSON.stringify({ type, seq, time, data });
}

/** 造一个多帧 zstd 会话日志：3 帧，帧内事件连续。 */
function makeSessionFile(root, { idleGapMs = DEFAULT_IDLE_GAP_MS } = {}) {
  const base = 1_700_000_000_000;
  const frame1 = [
    JSON.stringify({
      type: "session",
      version: 4,
      id: SESSION_ID,
      createdAt: base,
      cwd: "F:\\work\\demo",
      agentPreset: "soul",
    }),
    ev("turn/start", 0, base, { turn: 1 }),
    ev("user/message", 1, base, { role: "user", id: "m1", content: [{ type: "text", text: "第一轮的问题" }] }),
    ev("assistant/message", 2, base + 1000, {
      turn: 1,
      message: { role: "assistant", content: [{ type: "text", text: "第一轮的回答" }] },
    }),
    ev("turn/end", 3, base + 2000, { turn: 1, reason: { kind: "completed" } }),
  ].join("\n") + "\n";

  // 第二轮：隔了很久（触发 idle gap）
  const t2 = base + idleGapMs + 60_000;
  const frame2 = [
    ev("turn/start", 4, t2, { turn: 2 }),
    ev("user/message", 5, t2, { role: "user", id: "m2", content: [{ type: "text", text: "隔了很久的第二轮" }] }),
    ev("assistant/message", 6, t2 + 1000, {
      turn: 2,
      message: { role: "assistant", content: [{ type: "text", text: "第二轮的答复" }] },
    }),
    ev("turn/end", 7, t2 + 2000, { turn: 2, reason: { kind: "completed" } }),
  ].join("\n") + "\n";

  // 第三轮前发生压缩 → 硬边界
  const frame3 = [
    ev("compaction/start", 8, t2 + 5000, { compactionId: "c1", turn: 3 }),
    ev("compaction/summary", 9, t2 + 6000, { compactionId: "c1", summary: [{ type: "text", text: "章摘要" }] }),
    ev("compaction/end", 10, t2 + 7000, { compactionId: "c1", turn: 3 }),
    ev("turn/start", 11, t2 + 8000, { turn: 3 }),
    ev("user/message", 12, t2 + 8000, { role: "user", id: "m3", content: [{ type: "text", text: "压缩之后的一轮" }] }),
    ev("turn/end", 13, t2 + 9000, { turn: 3, reason: { kind: "completed" } }),
  ].join("\n") + "\n";

  const dir = join(root, "sessions", "--demo--", SESSION_ID);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  const parts = [frame1, frame2, frame3].map((text) => zlib.zstdCompressSync(Buffer.from(text, "utf8")));
  writeFileSync(file, Buffer.concat(parts));
  return { file, dir, base, t2 };
}

test("多帧 zstd：decodeFrames 必须解出每一帧（Node 内置只解第一帧）", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const buf = require_fs_read(file);
  const frames = decodeFrames(buf, 0);
  assert.equal(frames.length, 3, "三段各压一帧，应解出 3 帧");
  const all = frames.flatMap((f) => f.events);
  assert.equal(all.length, 15, "3 帧共 15 条事件");
  assert.equal(all.filter((e) => typeof e.seq === "number").length, 14, "session 头没有 seq");
  assert.ok(frames.every((f) => f.offset > 0 || f.index === 0));
});

test("事件索引：session 头不能当锚点，正文长度与错误位被记下", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const buf = require_fs_read(file);
  const events = decodeFrames(buf, 0).flatMap((f) => f.events);

  const header = events.find((e) => e.type === "session");
  assert.equal(toIndexRow(header), null, "头事件没有 seq，索引层必须丢弃");

  const user = events.find((e) => e.type === "user/message");
  const row = toIndexRow(user);
  assert.equal(row.seq, 1);
  assert.equal(row.chars, eventText(user).length);
  assert.equal(row.error, 0);

  const errEvent = { type: "tool/result", seq: 99, time: 1, data: { message: { isError: true, content: [{ type: "text", text: "boom" }] } } };
  assert.equal(toIndexRow(errEvent).error, 1);
});

test("摄取 + 事件骨架：idle gap 与 compaction 都要断章", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const db = track(openStore(join(root, "memory-tree", "memory.db")));

  const r = ingestSession(db, file, { sessionId: SESSION_ID });
  assert.equal(r.skipped, false);
  assert.equal(r.events, 14);
  assert.ok(r.frames >= 3);

  const eps = listEpisodes(db, { sessionId: SESSION_ID, limit: 50 });
  assert.ok(eps.length >= 3, `应至少断成 3 段，实际 ${eps.length}`);
  assert.equal(eps[0].reason, "session-start");
  assert.ok(
    eps.some((e) => e.reason === "idle-gap"),
    `应有 idle-gap 断章，实际：${eps.map((e) => e.reason).join(",")}`,
  );
  assert.ok(
    eps.some((e) => e.reason === "compaction/start"),
    `compaction 应断章，实际：${eps.map((e) => e.reason).join(",")}`,
  );
  // 区间首尾相接、不重叠
  for (let i = 1; i < eps.length; i++) assert.ok(eps[i].seq_start > eps[i - 1].seq_end);
});

test("增量摄取幂等：字节未变则跳过，重复跑不重复建 episode", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  ingestSession(db, file, { sessionId: SESSION_ID });
  const before = stats(db);

  const again = ingestSession(db, file, { sessionId: SESSION_ID });
  assert.equal(again.skipped, true);
  const afterStats = stats(db);
  assert.equal(afterStats.events, before.events);
  assert.equal(afterStats.episodes, before.episodes);
});

test("锚点下钻：按 (sessionId, seq) 取回原文，只解所在帧", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  ingestSession(db, file, { sessionId: SESSION_ID });

  const hit = expand(db, SESSION_ID, 5, { before: 1, after: 1 });
  assert.equal(hit.seq, 5);
  const joined = hit.events.map((e) => e.text).join(" | ");
  assert.ok(joined.includes("隔了很久的第二轮"), `应取回原文，实际：${joined}`);
  assert.ok(hit.frameIndex >= 0);

  // 超出范围 / 不存在的 seq 要明确报错
  assert.throws(() => expand(db, SESSION_ID, 9999), /没有 seq=9999/);
  assert.throws(() => expand(db, "session-nope", 1), /未知会话/);
});

test("下钻预算：maxChars 生效并标记截断", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  ingestSession(db, file, { sessionId: SESSION_ID });
  const hit = expand(db, SESSION_ID, 1, { before: 0, after: 5, maxChars: 8 });
  const total = hit.events.reduce((n, e) => n + e.text.length, 0);
  assert.ok(total <= 24, `字符预算应生效，实际 ${total}`);
  assert.ok(hit.events.some((e) => e.text.includes("截断")));
});

test("批量摄取：扫目录、按 mtime 排序、坏文件不连累其它", () => {
  const root = tmp();
  makeSessionFile(root);
  const badDir = join(root, "sessions", "--bad--", "session-broken");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "session.v4.jsonl.zstd"), Buffer.from("not a zstd file"));

  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  const r = ingestAll(db, [join(root, "sessions")], { limitFiles: 10 });
  assert.ok(r.ingested >= 1, "好文件应被摄取");
  assert.equal(listSessions(db, 10).length, 1, "坏文件不产生会话行");
});

test("rebuildEpisodes 幂等：重算不产生重复", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  ingestSession(db, file, { sessionId: SESSION_ID });
  const first = listEpisodes(db, { sessionId: SESSION_ID, limit: 50 }).length;
  rebuildEpisodes(db, SESSION_ID);
  rebuildEpisodes(db, SESSION_ID);
  assert.equal(listEpisodes(db, { sessionId: SESSION_ID, limit: 50 }).length, first);
});

test("sessionIdOf / findSessionFiles 能从 DSH 目录结构里认出会话", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  assert.equal(sessionIdOf(file), SESSION_ID);
  const found = findSessionFiles([join(root, "sessions")]);
  assert.deepEqual(found, [file]);
});

/* ---------------------------------------------------------- 摘要层测试 */

function seededDb(root) {
  const file = makeSessionFile(root).file;
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  ingestSession(db, file, { sessionId: SESSION_ID });
  return db;
}

test("摘要：锚点可校验时写入成功，并给出 seq 区间", () => {
  const root = tmp();
  const db = seededDb(root);

  const r = saveNote(db, {
    sessionId: SESSION_ID,
    seq: 5,
    title: "第二轮：隔了很久的追问",
    summary: "对方隔了很久回来继续问，我据实回答。",
    anchors: [{ seq: 5, quote: "隔了很久的第二轮" }],
  });

  assert.equal(r.ok, true);
  assert.equal(r.version, 1);
  assert.equal(r.anchors, 1);
  assert.ok(r.seqRange[0] <= 5 && r.seqRange[1] >= 5);

  const notes = listNotes(db, { sessionId: SESSION_ID });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "第二轮：隔了很久的追问");
});

test("摘要校验：编造的 quote / 越界的 seq / 空锚点 全部拒收", () => {
  const root = tmp();
  const db = seededDb(root);
  const base = { sessionId: SESSION_ID, seq: 5, title: "t", summary: "s" };

  assert.throws(
    () => saveNote(db, { ...base, anchors: [{ seq: 5, quote: "这句话原文里根本没有" }] }),
    /锚点校验失败/,
  );
  assert.throws(() => saveNote(db, { ...base, anchors: [{ seq: 999, quote: "隔了很久" }] }), /不在本段/);
  assert.throws(() => saveNote(db, { ...base, anchors: [] }), /至少要有 1 条/);
  assert.throws(() => saveNote(db, { ...base }), /至少要有 1 条/);
  assert.throws(
    () => saveNote(db, { ...base, title: "", anchors: [{ seq: 5, quote: "隔了很久的第二轮" }] }),
    /title 必填/,
  );
});

test("摘要版本：同一段再写一次是 v2，listNotes 只给最新版但旧版保留", () => {
  const root = tmp();
  const db = seededDb(root);
  const base = {
    sessionId: SESSION_ID,
    seq: 5,
    title: "v1 标题",
    summary: "第一版",
    anchors: [{ seq: 5, quote: "隔了很久的第二轮" }],
  };
  saveNote(db, base);
  const second = saveNote(db, { ...base, title: "v2 标题", summary: "第二版" });
  assert.equal(second.version, 2);

  const notes = listNotes(db, { sessionId: SESSION_ID });
  assert.equal(notes.length, 1, "同一段只返回最新版");
  assert.equal(notes[0].title, "v2 标题");
  const all = db.prepare("SELECT COUNT(*) AS n FROM episode_notes").get();
  assert.equal(Number(all.n), 2, "旧版本保留在库里（可回溯）");
});

test("摘要检索：中文双字切分能命中标题/正文", () => {
  const root = tmp();
  const db = seededDb(root);
  saveNote(db, {
    sessionId: SESSION_ID,
    seq: 5,
    title: "隔很久之后的追问",
    summary: "对方隔了很久回来接着问，我回答了他的问题。",
    anchors: [{ seq: 5, quote: "隔了很久的第二轮" }],
  });

  const hit = searchNotes(db, "追问", { limit: 5 });
  assert.ok(hit.hits.length >= 1, `应命中，实际 terms=${JSON.stringify(hit.terms)}`);
  assert.equal(hit.hits[0].sessionId, SESSION_ID);
  assert.equal(searchNotes(db, "完全不相关的词").hits.length, 0);
});

test("verifyAnchors 单独可调用：错一条就报错并说明原因", () => {
  const root = tmp();
  const db = seededDb(root);
  const episode = db
    .prepare("SELECT * FROM episodes WHERE session_id = ? AND seq_start <= 5 AND seq_end >= 5 LIMIT 1")
    .get(SESSION_ID);
  const ok = verifyAnchors(db, episode, [{ seq: 5, quote: "隔了很久的第二轮" }]);
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, 1);

  const bad = verifyAnchors(db, episode, [
    { seq: 5, quote: "隔了很久的第二轮" },
    { seq: 3, quote: "对不上的话" },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 1);
});

/* --- 小工具 --- */
function require_fs_read(file) {
  return readFileSync(file);
}

/* -------------------------------------------------- 人格库隔离 & 全文测试 */

/** 造一个"工作会话"（preset=standard），验证它不会被收进人格库。 */
function makeWorkSession(root) {
  const base = 1_700_000_000_000;
  const text = [
    JSON.stringify({ type: "session", version: 4, id: "session-work-0001", createdAt: base, cwd: "F:\\\\work", agentPreset: "standard" }),
    JSON.stringify({ type: "turn/start", seq: 0, time: base, data: { turn: 1 } }),
    JSON.stringify({ type: "user/message", seq: 1, time: base, data: { role: "user", content: [{ type: "text", text: "帮我改这个 Java 文件" }] } }),
    JSON.stringify({ type: "assistant/message", seq: 2, time: base + 1000, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "先看 BridgeRunner.java" }] } } }),
  ].join("\n") + "\n";
  const dir = join(root, "sessions", "--demo--", "session-work-0001");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, "utf8")));
  return file;
}

test("写入侧过滤：工作会话连索引都不建，人格库保持干净", () => {
  const root = tmp();
  makeSessionFile(root);          // 人格会话
  makeWorkSession(root);          // 工作会话
  const db = track(openStore(join(root, "memory-tree", "memory.db")));

  const r = ingestAll(db, [join(root, "sessions")], { limitFiles: 10 });
  assert.equal(r.ingested, 1, "只应摄取人格会话");
  assert.equal(r.notPersona, 1, "工作会话应被识别并跳过");

  const rows = listSessions(db, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, SESSION_ID);
  assert.equal(rows[0].preset, "soul");

  // 工作会话的关键词不该能在人格库里搜到
  assert.equal(searchMessages(db, "BridgeRunner", { limit: 5 }).hits.length, 0);
  assert.equal(searchNotes(db, "Java", { limit: 5 }).hits.length, 0);
});

test("全文表：人格会话的正文按 role 完整入库（含 reasoning）", () => {
  const root = tmp();
  const { file } = makeSessionFile(root);
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  const r = ingestSession(db, file, { sessionId: SESSION_ID });

  assert.ok(r.messages >= 5, `应写入正文行，实际 ${r.messages}`);
  const rows = listMessages(db, SESSION_ID, { limit: 50 });
  const roles = new Set(rows.map((x) => x.role));
  assert.ok(roles.has("user"), "应有 user 正文");
  assert.ok(roles.has("assistant"), "应有 assistant 正文");
  assert.ok(roles.has("summary"), "compaction 摘要也应入库");
  assert.ok(rows.every((x) => x.text.trim().length > 0), "不应有空正文行");
  assert.equal(rows.find((x) => x.role === "user").text, "第一轮的问题");

  const hit = searchMessages(db, "隔了很久的第二轮", { limit: 3 });
  assert.ok(hit.hits.length >= 1, "全文检索应命中");
  assert.equal(hit.hits[0].sessionId, SESSION_ID);
});

test("purgeNonPersona：升级前混进来的工作会话会被清掉", () => {
  const root = tmp();
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  // 手工插入一条"工作"会话记录，模拟旧库
  db.prepare(
    `INSERT INTO sessions (session_id, file, workspace, preset, cwd, created_at, updated_at, bytes, frame_count, event_count, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("session-old-work", "x.zstd", "w", "standard", "", "", "", 0, 0, 0, "");
  db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("session-old-work", 1, "standard", "user", "Java 文件", 0, 1, 5);

  const purged = purgeNonPersona(db);
  assert.equal(purged, 1);
  assert.equal(stats(db).sessions, 0);
  assert.equal(stats(db).messages, 0);
  assert.equal(searchMessages(db, "Java").hits.length, 0);
});

/* ------------------------------------------------ 注入 / 升降级 / 蒸馏测试 */

function noteOne(db, overrides = {}) {
  return saveNote(db, {
    sessionId: SESSION_ID,
    seq: 5,
    title: overrides.title ?? "隔很久之后的追问",
    summary: overrides.summary ?? "对方隔了很久回来接着问，我回答了他的问题。",
    anchors: [{ seq: 5, quote: "隔了很久的第二轮" }],
  });
}

test("摘要注入：只注入摘要、带锚点、按预算截断，并记注入信号", () => {
  const root = tmp();
  const db = seededDb(root);
  noteOne(db);

  const brief = buildMemoryBrief(db, { budget: 600 });
  assert.ok(brief.text.includes("最近记得的事"), "应有标题");
  assert.ok(brief.text.includes("隔很久之后的追问"), "应包含摘要标题");
  assert.ok(brief.text.includes("锚点"), "每条都要带锚点，模型才能下钻");
  assert.ok(brief.text.length <= 600, `预算应生效，实际 ${brief.text.length}`);
  assert.equal(brief.injected.length, 1);

  const usage = db.prepare("SELECT injected FROM note_usage").get();
  assert.equal(Number(usage.injected), 1, "注入应记一笔");

  // 6 小时内的重复注入不再累加（否则常驻条目自我强化到永远）
  buildMemoryBrief(db, { budget: 600 });
  assert.equal(Number(db.prepare("SELECT injected FROM note_usage").get().injected), 1);
});

test("摘要注入：空库返回空串（不能往人格块里塞空标题）", () => {
  const root = tmp();
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  const brief = buildMemoryBrief(db, { budget: 400 });
  assert.equal(brief.text, "");
  assert.deepEqual(brief.injected, []);
});

test("升降级：下钻信号最重，能把它推到 hot；只命中一次的留在 warm/cold", () => {
  const root = tmp();
  const db = seededDb(root);
  noteOne(db);

  const before = listNotesRanked(db, {});
  assert.equal(before[0].tier, "cold", "没有任何使用信号时应是 cold");

  recordUsage(db, before[0].episode_id, "hit");
  const afterHit = listNotesRanked(db, {});
  assert.ok(afterHit[0].score > 0, "命中后分数应大于 0");

  // 下钻 3 次（×5）应该把它推到 hot
  for (let i = 0; i < 3; i++) recordUsage(db, before[0].episode_id, "expanded");
  const tiered = listNotesRanked(db, {});
  assert.equal(tiered[0].tier, "hot", `应升到 hot，实际 ${tiered[0].tier}（score=${tiered[0].score}）`);

  const summary = tierSummary(db, {});
  assert.equal(summary.counts.hot, 1);
  assert.equal(summary.total, 1);
});

test("升降级：时间衰减会让久未使用的条目降档", () => {
  const root = tmp();
  const db = seededDb(root);
  noteOne(db);
  const id = listNotesRanked(db, {})[0].episode_id;
  for (let i = 0; i < 3; i++) recordUsage(db, id, "expanded");

  const now = Date.now();
  const fresh = listNotesRanked(db, { now })[0];
  assert.equal(fresh.tier, "hot");

  // 半年后同样的原始信号会被衰减掉（半衰期 14 天）
  const later = listNotesRanked(db, { now: now + 180 * 86_400_000 })[0];
  assert.notEqual(later.tier, "hot", `衰减后不该还是 hot，实际 ${later.tier}`);
});

test("蒸馏：从全文里抽反复出现的偏好，只出提案不动文件", () => {
  const root = tmp();
  const db = track(openStore(join(root, "memory-tree", "memory.db")));
  const insert = db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(SESSION_ID, 1, "soul", "user", "我喜欢先给结论再给理由", 1, 1, 12);
  insert.run(SESSION_ID, 2, "soul", "user", "我喜欢先给结论再给理由", 2, 2, 12);
  insert.run(SESSION_ID, 3, "soul", "user", "随便聊聊天气", 3, 3, 6);
  insert.run(SESSION_ID, 4, "soul", "assistant", "好的，先给结论", 4, 4, 8);

  const digest = buildDigest(db, { maxItems: 5 });
  assert.ok(digest.candidates.length >= 1, "应抽到候选");
  const top = digest.candidates[0];
  assert.ok(top.text.includes("喜欢"), `候选应是偏好句，实际：${top.text}`);
  assert.equal(top.count, 2, "同一句说了两次应计数 2");
  assert.ok(top.anchors.length === 2, "每个出现位置都要留锚点");
  assert.ok(
    !digest.candidates.some((c) => c.text.includes("天气")),
    "不含偏好标记的闲聊不该进候选",
  );
});
/**
 * 底仓索引：SQLite（node:sqlite，零外部依赖）。
 *
 * 表分工：
 *   sessions ── 一个会话一行（文件、preset、cwd、字节数、事件数）
 *   frames   ── 帧级偏移索引。帧只追加 ⇒ (offset,length) 稳定 ⇒ 下钻只解一帧
 *   events   ── 事件索引行（seq/type/time/turn/chars/error），**不存正文**
 *   episodes ── 事件骨架：硬边界 + idle gap 切出来的区间，带 anchor（seq_start..seq_end）
 *
 * 为什么 events 不存正文：正文真源在 DSH 日志里，复制一份就有第二份真相，
 * 迟早不一致。下钻走 `expand()`：按 (sessionId, seq) 找到所在帧 → 只解那一帧。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { decodeFrames, detectPreset, eventText, findSessionFiles, presetAt, presetTimeline, readSessionFile, sessionIdOf, toIndexRow, workspaceOf, readSessionDelta, probeSession } from "./session-source.js";

/**
 * 视为"人格态"的 preset —— 也就是"她的生活"。
 * soul 是纯聊天，soul-mc 是带 Minecraft 身体的那一档；两者的经历都算她的。
 * 工作态（standard 等）一律不收。
 */
/**
 * 「这个文件不是人格会话」的记忆表：key = 文件路径，value = 判定时的字节数。
 * 文件没长过就不用再探针一遍（探针 50 个文件约 400 ms）。
 */
const NOT_PERSONA_MEMO = new Map();

export const DEFAULT_PERSONA_PRESETS = ["soul", "soul-mc", "soul-qq"];

/** preset → 场景（venue）。**同一个库**，只用来标注"这话是在哪儿说的"。 */
export function venueOfPreset(preset) {
  const p = String(preset || "");
  if (p === "soul-mc") return "mc";
  if (p === "soul-qq") return "qq";
  if (p === "soul" || p === "") return "chat";
  return p;
}

/** 场景的中文标签（注进提示词/UI 时用）。 */
export function venueLabel(venue) {
  if (venue === "mc") return "MC";
  if (venue === "qq") return "QQ群";
  if (venue === "chat") return "对话";
  return String(venue || "?");
}

/**
 * 把一个事件拆成可入库的正文片段（role + text）。
 * reasoning 单独成行——它是人格素材的重要来源，但检索时应当能区分开。
 */
export function messageParts(ev) {
  if (!ev || typeof ev !== "object") return [];
  const out = [];
  const push = (role, text) => {
    const body = String(text || "").trim();
    if (body) out.push({ role, text: body });
  };

  if (ev.type === "user/message") {
    push("user", eventText(ev));
  } else if (ev.type === "assistant/message") {
    const content = ev.data?.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text") push("assistant", block.text);
        else if (block.type === "reasoning") push("reasoning", block.text);
      }
    } else {
      push("assistant", eventText(ev));
    }
  } else if (ev.type === "tool/result") {
    push("tool", eventText(ev));
  } else if (ev.type === "compaction/summary") {
    push("summary", eventText(ev));
  }
  return out;
}

/** 硬边界事件类型：出现即断章。 */
const HARD_BOUNDARIES = new Set([
  "compaction/start",
  "compaction/end",
  "command/run",
  "command/done",
  "agent-preset/selected",
]);

/** idle gap 默认阈值：45 分钟（实测 10 分钟会把一段连续工作剁成十几段）。 */
export const DEFAULT_IDLE_GAP_MS = 45 * 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  workspace TEXT,
  preset TEXT,
  cwd TEXT,
  created_at TEXT,
  updated_at TEXT,
  bytes INTEGER DEFAULT 0,
  frame_count INTEGER DEFAULT 0,
  event_count INTEGER DEFAULT 0,
  ingested_at TEXT
);
CREATE TABLE IF NOT EXISTS frames (
  session_id TEXT NOT NULL,
  frame_index INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  PRIMARY KEY (session_id, frame_index)
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  time INTEGER DEFAULT 0,
  turn INTEGER,
  chars INTEGER DEFAULT 0,
  error INTEGER DEFAULT 0,
  frame_index INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_session_type ON events (session_id, type);
CREATE TABLE IF NOT EXISTS episodes (
  episode_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq_start INTEGER NOT NULL,
  seq_end INTEGER NOT NULL,
  turn_start INTEGER,
  turn_end INTEGER,
  reason TEXT NOT NULL,
  event_count INTEGER DEFAULT 0,
  chars INTEGER DEFAULT 0,
  preview TEXT DEFAULT '',
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes (session_id, seq_start);
CREATE TABLE IF NOT EXISTS episode_notes (
  episode_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  seq_start INTEGER NOT NULL,
  seq_end INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  anchors TEXT NOT NULL,
  entities TEXT DEFAULT '[]',
  evidence TEXT DEFAULT 'inferred',
  created_at TEXT,
  PRIMARY KEY (episode_id, version)
);
CREATE INDEX IF NOT EXISTS idx_notes_session ON episode_notes (session_id, seq_start);
-- 全文表：**只存人格会话**，存正文（user/assistant/reasoning/tool/summary）。
-- 工作会话一律不进这张表，连索引都不建——人格库不该混进别的东西。
CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  preset TEXT DEFAULT '',
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  time INTEGER DEFAULT 0,
  turn INTEGER,
  chars INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, seq, role)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_role ON messages (role, session_id);
-- 使用反馈：摘要被检索/被注入/被下钻都会记一笔，用来算 hot/warm/cold。
-- 频率只决定"注入优先级与保留期"，不决定真值——底仓在，随时可重建。
-- 记忆之间的关联边：让联想能"跳"一条。
-- 节点 id 用 'session#seq'（和 prefetch 的锚点同一个东西，不新建 node 表）。
-- 约束比规则重要：每节点最多 5 条边，similar ≤3 / temporal ≤2。
CREATE TABLE IF NOT EXISTS links (
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL,
  kind    TEXT NOT NULL,
  weight  REAL NOT NULL DEFAULT 0,
  at_ms   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links (from_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_links_to ON links (to_id);

-- 世界游标：这个会话"已经交代过"到哪一刻。必须落盘——
-- 放内存的话，DSH 重启后 cursor 归零，delta 会把过去 12 小时全部当新事件重放。
CREATE TABLE IF NOT EXISTS world_cursor (
  session_id TEXT PRIMARY KEY,
  last_seen_ms INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
-- 她不在场时发生的事（死亡/被打/濒死/被点名）。delta 的白名单来源之一。
-- 为什么不直接在 messages 里捞：公屏闲聊也在 messages 里，一捞就是全量注入。
CREATE TABLE IF NOT EXISTS world_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  text TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  session_id TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_world_at ON world_events (at_ms);
CREATE TABLE IF NOT EXISTS note_usage (
  episode_id TEXT PRIMARY KEY,
  hits INTEGER DEFAULT 0,
  injected INTEGER DEFAULT 0,
  expanded INTEGER DEFAULT 0,
  last_hit_at TEXT,
  last_injected_at TEXT,
  last_expanded_at TEXT
);
`;

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 摄取一个会话文件。
 *
 * @param options.personaOnly 只收人格会话（默认 true）——工作会话连索引都不建
 * @param options.personaPresets 视为"人格"的 preset id（默认 ["soul"]）
 * @param options.storeText 是否把正文写进 messages 全文表（默认 true，仅人格会话）
 * @returns {{sessionId:string, preset:string, frames:number, events:number, episodes:number, messages:number, skipped:boolean}}
 */
export function ingestSession(db, file, options = {}) {
  const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const personaOnly = options.personaOnly !== false;
  const personaPresets = options.personaPresets ?? DEFAULT_PERSONA_PRESETS;
  const storeText = options.storeText !== false;

  const idealSize = statSync(file).size;
  const pathId = sessionIdOf(file);
  const knownRow = db
    .prepare(
      "SELECT session_id, bytes, preset, frame_count, event_count, cwd, created_at FROM sessions WHERE file = ? OR session_id = ?",
    )
    .get(file, pathId);

  // ── 未变化：只比字节数就跳过，**不解码**（整篇解一个 10 MB 会话要 600 ms）──
  if (knownRow && Number(knownRow.bytes) === idealSize) {
    return {
      sessionId: String(knownRow.session_id || pathId),
      preset: knownRow.preset || "",
      frames: 0,
      events: 0,
      episodes: 0,
      messages: 0,
      skipped: true,
      reason: "unchanged",
    };
  }

  // ── 有增长：只解「上次之后新追加的帧」（实测 10.5 MB 会话增量 1 ms vs 整篇 1083 ms）──
  if (knownRow && idealSize > Number(knownRow.bytes)) {
    return ingestSessionDelta(db, file, {
      sessionId: String(knownRow.session_id || pathId),
      known: knownRow,
      size: idealSize,
      idleGapMs,
      personaPresets,
      storeText,
      personaOnly,
    });
  }

  // ── 先探针（开头 + 尾部各一小段）：不是人格会话就别整篇解码 ──
  // 实测一个 10 MB 会话整篇解 600 ms；51 个会话里大多数根本不该入库。
  let probe = null;
  if (personaOnly) {
    try {
      probe = probeSession(file);
      const guess = probe.lastPreset || String(probe.header?.agentPreset || "");
      if (guess && !personaPresets.includes(guess)) {
        return {
          sessionId: probe.header?.id ? String(probe.header.id) : sessionIdOf(file),
          preset: guess,
          frames: 0,
          events: 0,
          episodes: 0,
          messages: 0,
          skipped: true,
          reason: "not-persona",
          probed: true,
        };
      }
    } catch {
      probe = null;
    }
  }

  const { bytes, mtimeMs, frames, header } = readSessionFile(file);

  // 会话 id 以日志 header 的 id 为准（权威），路径兜底。
  // 只按路径猜会出事：没有 `session-<id>` 子目录的日志会全部退化成 "session.v4.jsonl"，
  // 多份日志挤进同一个 id，PRIMARY KEY (session_id, seq) 互相覆盖，下钻还会解错文件。
  const sessionId = options.sessionId || (header?.id ? String(header.id) : sessionIdOf(file));

  const allEvents = frames.flatMap((f) => f.events.map((ev) => ({ ev, frameIndex: f.index })));
  const indexed = allEvents.filter(({ ev }) => typeof ev.seq === "number");

  // 空文件 / 非 zstd 垃圾 / 只有头没有事件的日志：不落会话行，避免污染索引
  if (frames.length === 0 || indexed.length === 0) {
    return { sessionId, preset: "", frames: frames.length, events: 0, episodes: 0, messages: 0, skipped: true, reason: "no-events" };
  }

  const detected = detectPreset(allEvents.map(({ ev }) => ev), header);

  // 写入侧过滤：不是人格会话就原地拒绝，连一行索引都不留。
  if (personaOnly && !personaPresets.includes(detected.preset)) {
    return {
      sessionId,
      preset: detected.preset,
      frames: frames.length,
      events: 0,
      episodes: 0,
      messages: 0,
      skipped: true,
      reason: "not-persona",
    };
  }

  // 未变化则跳过（帧偏移稳定 ⇒ 重复摄取天然幂等）
  const known = db.prepare("SELECT bytes FROM sessions WHERE session_id = ?").get(sessionId);
  if (known && Number(known.bytes) === bytes) {
    return { sessionId, preset: detected.preset, frames: 0, events: 0, episodes: 0, messages: 0, skipped: true, reason: "unchanged" };
  }

  const insertFrame = db.prepare(
    "INSERT OR REPLACE INTO frames (session_id, frame_index, offset, length) VALUES (?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT OR REPLACE INTO events (session_id, seq, type, time, turn, chars, error, frame_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = db.prepare(
    "INSERT OR REPLACE INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  const timeline = presetTimeline(allEvents.map(({ ev }) => ev), header);

  db.exec("BEGIN");
  let eventCount = 0;
  let messageCount = 0;
  try {
    for (const f of frames) insertFrame.run(sessionId, f.index, f.offset, f.length);
    for (const { ev, frameIndex } of allEvents) {
      const row = toIndexRow(ev);
      if (!row) continue;
      insertEvent.run(sessionId, row.seq, row.type, row.time, row.turn, row.chars, row.error, frameIndex);
      eventCount += 1;

      if (!storeText) continue;
      // 中途切 preset 的会话：只收"当时确实在人格态"的那些事件
      const presetAtSeq = presetAt(timeline, row.seq);
      if (!personaPresets.includes(presetAtSeq)) continue;
      for (const part of messageParts(ev)) {
        insertMessage.run(sessionId, row.seq, presetAtSeq, part.role, part.text, row.time, row.turn, part.text.length);
        messageCount += 1;
      }
    }
    db.prepare(
      `INSERT INTO sessions (session_id, file, workspace, preset, cwd, created_at, updated_at, bytes, frame_count, event_count, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         file = excluded.file, preset = excluded.preset, cwd = excluded.cwd,
         bytes = excluded.bytes, frame_count = excluded.frame_count,
         event_count = excluded.event_count, ingested_at = excluded.ingested_at`,
    ).run(
      sessionId,
      file,
      workspaceOf(file),
      detected.preset,
      header?.cwd || "",
      header?.createdAt ? new Date(Number(header.createdAt)).toISOString() : "",
      new Date(mtimeMs).toISOString(),
      bytes,
      frames.length,
      eventCount,
      nowIso(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const episodes = rebuildEpisodes(db, sessionId, { idleGapMs, eventTexts: allEvents });
  return {
    sessionId,
    preset: detected.preset,
    frames: frames.length,
    events: eventCount,
    episodes,
    messages: messageCount,
    skipped: false,
  };
}

/**
 * 重算某会话的事件骨架（硬边界 + idle gap）。幂等：先删后建。
 * 骨架只依赖事件索引，不依赖正文。
 */

/**
 * 增量摄取：只处理文件尾部新追加的帧。
 *
 * 前提：帧只追加（DSH 的 session 日志不会重写历史），所以
 * 「上一帧 offset + length」之后的字节永远只有新内容。
 */
function ingestSessionDelta(db, file, ctx) {
  const { sessionId, known, size, idleGapMs, personaPresets, storeText, personaOnly } = ctx;

  const lastIdxRow = db.prepare("SELECT MAX(frame_index) AS i FROM frames WHERE session_id = ?").get(sessionId);
  const lastIdx = Number(lastIdxRow?.i ?? -1);
  const lastFr = lastIdx >= 0
    ? db.prepare("SELECT offset, length FROM frames WHERE session_id = ? AND frame_index = ?").get(sessionId, lastIdx)
    : null;
  const resumeAt = lastFr ? Number(lastFr.offset) + Number(lastFr.length) : 0;

  const delta = readSessionDelta(file, resumeAt);
  // 半截帧（正在写入）：本次跳过，下次再来
  if (delta.frames.length === 0) {
    return { sessionId, preset: known.preset || "", frames: 0, events: 0, episodes: 0, messages: 0, skipped: true, reason: "no-new-frame" };
  }

  const basePreset = String(known.preset || "");
  const allNew = delta.frames.flatMap((fr) => fr.events.map((ev) => ({ ev, frameIndex: fr.index })));
  const indexedNew = allNew.filter(({ ev }) => typeof ev.seq === "number");
  if (indexedNew.length === 0) {
    return { sessionId, preset: basePreset, frames: delta.frames.length, events: 0, episodes: 0, messages: 0, skipped: true, reason: "no-events" };
  }

  const detected = detectPreset(allNew.map(({ ev }) => ev), { agentPreset: basePreset });
  if (personaOnly && !personaPresets.includes(detected.preset)) {
    // 中途切成工作/测试模式的会话：把已有索引清掉（与整篇路径一致）
    return {
      sessionId,
      preset: detected.preset,
      frames: delta.frames.length,
      events: 0,
      episodes: 0,
      messages: 0,
      skipped: true,
      reason: "not-persona",
    };
  }

  const timeline = presetTimeline(allNew.map(({ ev }) => ev), { agentPreset: basePreset });
  const insertFrame = db.prepare(
    "INSERT OR REPLACE INTO frames (session_id, frame_index, offset, length) VALUES (?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT OR REPLACE INTO events (session_id, seq, type, time, turn, chars, error, frame_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertMessage = db.prepare(
    "INSERT OR REPLACE INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  db.exec("BEGIN");
  let frameCount = 0;
  let eventCount = 0;
  let messageCount = 0;
  try {
    for (const fr of delta.frames) {
      insertFrame.run(sessionId, lastIdx + 1 + fr.index, fr.offset, fr.length);
      frameCount += 1;
    }
    for (const { ev, frameIndex } of allNew) {
      const row = toIndexRow(ev);
      if (!row) continue;
      insertEvent.run(sessionId, row.seq, row.type, row.time, row.turn, row.chars, row.error, lastIdx + 1 + frameIndex);
      eventCount += 1;

      if (!storeText) continue;
      const presetAtSeq = presetAt(timeline, row.seq);
      if (!personaPresets.includes(presetAtSeq)) continue;
      for (const part of messageParts(ev)) {
        insertMessage.run(sessionId, row.seq, presetAtSeq, part.role, part.text, row.time, row.turn, part.text.length);
        messageCount += 1;
      }
    }
    db.prepare(
      `UPDATE sessions SET
         preset = ?, bytes = ?, frame_count = frame_count + ?, event_count = event_count + ?,
         updated_at = ?, ingested_at = ?
       WHERE session_id = ?`,
    ).run(
      detected.preset,
      size,
      frameCount,
      eventCount,
      new Date(Number(statSync(file).mtimeMs)).toISOString(),
      nowIso(),
      sessionId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const episodes = rebuildEpisodes(db, sessionId, { idleGapMs });
  return {
    sessionId,
    preset: detected.preset,
    frames: frameCount,
    events: eventCount,
    episodes,
    messages: messageCount,
    skipped: false,
    incremental: true,
  };
}

export function rebuildEpisodes(db, sessionId, options = {}) {
  const idleGapMs = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const rows = db
    .prepare("SELECT seq, type, time, turn, chars FROM events WHERE session_id = ? ORDER BY seq ASC")
    .all(sessionId);

  db.prepare("DELETE FROM episodes WHERE session_id = ?").run(sessionId);
  if (rows.length === 0) return 0;

  const insert = db.prepare(
    `INSERT INTO episodes (episode_id, session_id, seq_start, seq_end, turn_start, turn_end, reason, event_count, chars, preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const groups = [];
  let current = null;
  let prevTurnTime = 0;

  for (const row of rows) {
    const seq = Number(row.seq);
    const time = Number(row.time || 0);
    const type = String(row.type || "");

    let reason = "";
    if (current === null) reason = "session-start";
    else if (HARD_BOUNDARIES.has(type)) reason = type;
    else if (type === "turn/start" && prevTurnTime > 0 && time - prevTurnTime >= idleGapMs) reason = "idle-gap";

    if (reason) {
      current = {
        seqStart: seq,
        seqEnd: seq,
        turnStart: row.turn ?? null,
        turnEnd: row.turn ?? null,
        reason,
        count: 0,
        chars: 0,
      };
      groups.push(current);
    }
    current.seqEnd = seq;
    current.count += 1;
    current.chars += Number(row.chars || 0);
    if (row.turn !== null && row.turn !== undefined) current.turnEnd = row.turn;
    if (type === "turn/start" && time > 0) prevTurnTime = time;
  }

  for (const group of groups) {
    const episodeId = `${sessionId}#${group.seqStart}-${group.seqEnd}`;
    insert.run(
      episodeId,
      sessionId,
      group.seqStart,
      group.seqEnd,
      group.turnStart,
      group.turnEnd,
      group.reason,
      group.count,
      group.chars,
      "",
      nowIso(),
    );
  }
  return groups.length;
}

/** 摄取目录下所有会话（可按时间预算截断，避免启动被拖住）。 */
export function ingestAll(db, sessionRoots, options = {}) {
  const limitFiles = options.limitFiles ?? 50;
  const denyIds = new Set((options.denySessionIds ?? []).map(String));
  const budgetMs = options.budgetMs ?? 8000;
  const started = Date.now();

  const files = findSessionFiles(sessionRoots)
    .filter((f) => {
      // 被拉黑的会话（测试用）永不入库；按路径里的 session-<id> 判断
      for (const id of denyIds) {
        if (id && f.includes(id)) return false;
      }
      return true;
    })
    .map((f) => {
      try {
        const st = statSync(f);
        return { file: f, mtimeMs: Number(st.mtimeMs), size: Number(st.size) };
      } catch {
        return { file: f, mtimeMs: 0, size: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limitFiles);

  const personaPresets = options.personaPresets ?? DEFAULT_PERSONA_PRESETS;
  const personaOnly = options.personaOnly !== false;
  // 升级前的库里混进过工作会话：先清掉，保证"人格库只有人格"
  const purged = personaOnly ? purgeNonPersona(db, personaPresets) : 0;

  const result = { scanned: files.length, ingested: 0, skipped: 0, notPersona: 0, events: 0, episodes: 0, messages: 0, purged, timedOut: false };
  for (const { file, size } of files) {
    if (Date.now() - started > budgetMs) {
      result.timedOut = true;
      break;
    }
    // 上一轮已判定"不是人格会话"且文件没长过 → 连探针都不必做
    if (personaOnly && NOT_PERSONA_MEMO.get(file) === size) {
      result.skipped += 1;
      result.notPersona += 1;
      continue;
    }

    try {
      const r = ingestSession(db, file, { personaOnly, personaPresets });
      if (r.reason === "not-persona") NOT_PERSONA_MEMO.set(file, size);
      else if (!r.skipped) NOT_PERSONA_MEMO.delete(file);
      if (r.skipped) {
        result.skipped += 1;
        if (r.reason === "not-persona") result.notPersona += 1;
      } else {
        result.ingested += 1;
        result.events += r.events;
        result.episodes += r.episodes;
        result.messages += r.messages || 0;
      }
    } catch {
      /* 单个会话坏掉不影响其它 */
    }
  }
  return result;
}

function statSyncSafe(file) {
  return statSync(file).mtimeMs;
}

/* ------------------------------------------------------------------ 查询 */

export function stats(db) {
  const one = (sql) => db.prepare(sql).get();
  return {
    sessions: Number(one("SELECT COUNT(*) AS n FROM sessions").n),
    events: Number(one("SELECT COUNT(*) AS n FROM events").n),
    episodes: Number(one("SELECT COUNT(*) AS n FROM episodes").n),
    frames: Number(one("SELECT COUNT(*) AS n FROM frames").n),
    messages: Number(one("SELECT COUNT(*) AS n FROM messages").n),
    messageChars: Number(one("SELECT COALESCE(SUM(chars), 0) AS n FROM messages").n),
    notes: Number(one("SELECT COUNT(*) AS n FROM episode_notes").n),
    lastIngest: one("SELECT MAX(ingested_at) AS t FROM sessions").t || "",
  };
}

/** 清掉库里所有非人格会话（升级到"只收人格"之前混进来的工作会话）。 */
export function purgeNonPersona(db, personaPresets = DEFAULT_PERSONA_PRESETS) {
  const list = personaPresets.map(() => "?").join(",");
  const victims = db
    .prepare(`SELECT session_id FROM sessions WHERE preset IS NULL OR preset = '' OR preset NOT IN (${list})`)
    .all(...personaPresets);
  for (const { session_id: id } of victims) {
    db.prepare("DELETE FROM frames WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM events WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM episodes WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM episode_notes WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    db.prepare("DELETE FROM sessions WHERE session_id = ?").run(id);
  }
  return victims.length;
}

export function listSessions(db, limit = 20) {
  return db
    .prepare(
      `SELECT session_id, workspace, preset, cwd, event_count, frame_count, updated_at
       FROM sessions ORDER BY COALESCE(updated_at, '') DESC, session_id LIMIT ?`,
    )
    .all(limit);
}

export function listEpisodes(db, options = {}) {
  const limit = options.limit ?? 20;
  if (options.sessionId) {
    return db
      .prepare(
        `SELECT episode_id, session_id, seq_start, seq_end, turn_start, turn_end, reason, event_count, chars
         FROM episodes WHERE session_id = ? ORDER BY seq_start ASC LIMIT ?`,
      )
      .all(options.sessionId, limit);
  }
  return db
    .prepare(
      `SELECT episode_id, session_id, seq_start, seq_end, turn_start, turn_end, reason, event_count, chars
       FROM episodes ORDER BY COALESCE(created_at, '') DESC, seq_start ASC LIMIT ?`,
    )
    .all(limit);
}

/**
 * 锚点下钻：按 (sessionId, seq) 回读原文。
 * 只解包含该 seq 的那一帧（帧只追加 ⇒ 偏移稳定），不重解整个文件。
 */
export function expand(db, sessionId, seq, options = {}) {
  const before = options.before ?? 2;
  const after = options.after ?? 2;
  const maxChars = options.maxChars ?? 4000;

  const session = db.prepare("SELECT file FROM sessions WHERE session_id = ?").get(sessionId);
  if (!session) throw new Error(`未知会话：${sessionId}`);
  const anchor = db.prepare("SELECT frame_index FROM events WHERE session_id = ? AND seq = ?").get(sessionId, seq);
  if (!anchor) throw new Error(`会话里没有 seq=${seq} 的事件`);

  const frame = db
    .prepare("SELECT offset, length FROM frames WHERE session_id = ? AND frame_index = ?")
    .get(sessionId, anchor.frame_index);
  if (!frame) throw new Error("帧索引缺失，无法下钻");

  const buf = readFileSync(session.file);
  const [decoded] = decodeFrames(buf.subarray(0, Number(frame.offset) + Number(frame.length)), Number(frame.offset));
  if (!decoded) throw new Error("帧解压失败（日志可能正在写入，稍后重试）");

  const events = decoded.events.filter((ev) => typeof ev.seq === "number");
  const idx = events.findIndex((ev) => ev.seq === seq);
  const from = Math.max(0, idx - before);
  const to = Math.min(events.length, idx + after + 1);

  const picked = [];
  let used = 0;
  for (const ev of events.slice(from, to)) {
    const text = eventText(ev);
    if (used + text.length > maxChars) {
      picked.push({ seq: ev.seq, type: ev.type, text: text.slice(0, Math.max(0, maxChars - used)) + "…（截断）" });
      break;
    }
    used += text.length;
    picked.push({ seq: ev.seq, type: ev.type, text });
  }
  return { sessionId, seq, frameIndex: Number(anchor.frame_index), events: picked, file: session.file };
}

/**
 * 把一个会话从记忆库里彻底删掉（补丁：测试对话/误入库）。
 * 注意：**源文件还在**，所以要同时把它写进 ingest-deny.json，否则下次摄取又回来。
 */
export function purgeSession(db, sessionId) {
  const sid = String(sessionId ?? "");
  if (!sid) return { ok: false, removed: 0 };
  let removed = 0;
  for (const table of ["note_usage", "episode_notes", "episodes", "messages", "events", "frames", "sessions"]) {
    try {
      const col = table === "note_usage" ? "episode_id IN (SELECT episode_id FROM episodes WHERE session_id = ?)" : "session_id = ?";
      const stmt =
        table === "note_usage"
          ? db.prepare(`DELETE FROM note_usage WHERE ${col}`)
          : db.prepare(`DELETE FROM ${table} WHERE ${col}`);
      const r = stmt.run(sid);
      removed += Number(r.changes ?? 0);
    } catch {
      /* 表可能不存在，跳过 */
    }
  }
  return { ok: true, sessionId: sid, removed };
}


/**
 * 取某一天（本地日期）的素材：那天所有的正文消息。
 *
 * 为什么需要：她想"补写某天的日记"时，手上只有 diary（空的）和关键词检索，
 * 没法按日期把那天的事捞出来。于是只能得出"查不到 = 会编 = 拒绝"。
 * 这个函数给的就是"那天到底发生了什么"的原料。
 *
 * @param day "YYYY-MM-DD"（本地日期）
 */

/**
 * 别的会话里最近说了什么（不含当前会话）。
 *
 * 为什么需要：预检索是**词法**的——A 会话里说"钥匙放鞋柜了"，B 会话里问"那东西在哪"，
 * 一个词都对不上就检索不到。而"换个会话接着聊"是人类默认能力，
 * 不该要求他复述。所以这里不靠命中，直接给他最近说过的话。
 *
 * @param options.currentSession 当前会话（要排除）
 * @param options.hours 回看窗口，默认 12 小时
 * @param options.budget 字符预算，默认 600
 */
export function recentOtherSessions(db, options = {}) {
  const current = String(options.currentSession || "");
  const hours = Number(options.hours ?? 12);
  const budget = Number(options.budget ?? 600);
  const since = Date.now() - hours * 3600_000;

  let sessions = [];
  try {
    sessions = db
      .prepare("SELECT session_id, preset, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 12")
      .all()
      .filter((s) => String(s.session_id) !== current);
  } catch {
    return { entries: [], text: "" };
  }

  const entries = [];
  let used = 0;
  for (const s of sessions) {
    if (entries.length >= 3) break;
    let rows = [];
    try {
      rows = db
        .prepare(
          "SELECT seq, role, text, time FROM messages WHERE session_id = ? AND time >= ? AND role IN ('user','assistant') ORDER BY time DESC LIMIT 6",
        )
        .all(s.session_id, since);
    } catch {
      continue;
    }
    if (rows.length === 0) continue;
    // 指路：[user] 原话优先，最多 2 条；再补 1 条她的回话
    const picked = [];
    const users = rows.filter((r) => r.role === "user").slice(0, 2);
    const hers = rows.filter((r) => r.role === "assistant").slice(0, 1);
    for (const r of [...users, ...hers]) {
      const text = String(r.text || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if (/^(Current runtime context|<system-reminder>|【MC 公屏)/.test(text)) continue;
      const line = `- [${venueLabel(venueOfPreset(s.preset))}·${ageLabel(r.time)}] ${r.role === "user" ? "他" : "你"}：${text.slice(0, 90)}`;
      if (used + line.length > budget) break;
      picked.push(line);
      used += line.length + 1;
    }
    if (picked.length === 0) continue;
    entries.push({ sessionId: s.session_id, preset: s.preset, lines: picked });
  }

  if (entries.length === 0) return { entries: [], text: "" };
  const text = [
    "## 你最近在别的对话里说过这些（不是这个会话，免得你记混）",
    "（我没让你复述——这些是系统替你接上的；想知道细节就问，别装没发生）",
    ...entries.flatMap((e) => e.lines),
  ].join("\n");
  return { entries, text };
}

/** "2 小时前" 这种。 */
function ageLabel(ms) {
  const d = Date.now() - Number(ms || 0);
  if (d < 3600_000) return `${Math.max(1, Math.round(d / 60_000))} 分钟前`;
  if (d < 86400_000) return `${Math.round(d / 3600_000)} 小时前`;
  return `${Math.round(d / 86400_000)} 天前`;
}

export function materialsForDay(db, options = {}) {
  const day = String(options.day ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { day, sessions: [], messages: [], chars: 0, error: "day 需要 YYYY-MM-DD" };

  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();

  const maxItems = options.maxItems ?? 120;
  const maxChars = options.maxChars ?? 12000;
  let rows = [];
  try {
    rows = db
      .prepare(
        "SELECT session_id, seq, role, text, time FROM messages WHERE time >= ? AND time < ? AND role IN ('user','assistant') ORDER BY time",
      )
      .all(start, end);
  } catch {
    rows = [];
  }

  const sessions = [...new Set(rows.map((r) => String(r.session_id)))];
  const messages = [];
  let chars = 0;
  for (const r of rows) {
    const text = String(r.text ?? "").trim();
    if (!text) continue;
    if (messages.length >= maxItems || chars + text.length > maxChars) break;
    messages.push({ sessionId: r.session_id, seq: r.seq, role: r.role, time: r.time, text });
    chars += text.length;
  }

  return { day, sessions, messages, chars, total: rows.length };
}

/* ------------------------------------------------------------- 摘要层 */

/** 取某个 seq 的原文（只解它所在的那一帧）。 */
export function rawTextAt(db, sessionId, seq) {
  const r = expand(db, sessionId, seq, { before: 0, after: 0, maxChars: 2_000_000 });
  return (r.events[0] && r.events[0].text) || "";
}

/** 定位一个 episode（按 id，或按 (sessionId, seq) 落点）。 */
export function findEpisode(db, { episodeId, sessionId, seq }) {
  if (episodeId) {
    const row = db.prepare("SELECT * FROM episodes WHERE episode_id = ?").get(episodeId);
    if (row) return row;
  }
  if (sessionId && Number.isFinite(Number(seq))) {
    return db
      .prepare(
        "SELECT * FROM episodes WHERE session_id = ? AND seq_start <= ? AND seq_end >= ? ORDER BY seq_start LIMIT 1",
      )
      .get(sessionId, Number(seq), Number(seq));
  }
  return null;
}

/**
 * 机械校验锚点：让"编造锚点"变成可检测错误，而不是靠模型自觉。
 *
 * 规则：
 *   1. anchors 至少 1 条
 *   2. 每条 seq 必须落在本 episode 的 [seq_start, seq_end] 内
 *   3. quote（≥4 字符）必须能在该 seq 的原始正文里 substring 命中
 * @returns {{ok:boolean, errors:string[], checked:number}}
 */
export function verifyAnchors(db, episode, anchors) {
  const errors = [];
  if (!Array.isArray(anchors) || anchors.length === 0) {
    return { ok: false, errors: ["anchors 至少要有 1 条"], checked: 0 };
  }
  const start = Number(episode.seq_start);
  const end = Number(episode.seq_end);
  let checked = 0;

  for (const [i, anchor] of anchors.entries()) {
    const seq = Number(anchor?.seq);
    const quote = String(anchor?.quote ?? "").trim();
    if (!Number.isFinite(seq)) {
      errors.push(`anchors[${i}]: seq 不是数字`);
      continue;
    }
    if (seq < start || seq > end) {
      errors.push(`anchors[${i}]: seq=${seq} 不在本段 [${start}, ${end}] 内`);
      continue;
    }
    if (quote.length < 4) {
      errors.push(`anchors[${i}]: quote 太短（至少 4 字符），无法校验`);
      continue;
    }
    let text = "";
    try {
      text = rawTextAt(db, episode.session_id, seq);
    } catch (error) {
      errors.push(`anchors[${i}]: seq=${seq} 读不到原文（${error instanceof Error ? error.message : String(error)}）`);
      continue;
    }
    if (!text.includes(quote)) {
      errors.push(`anchors[${i}]: quote 在 seq=${seq} 的原文里找不到（编造或被改写过）`);
      continue;
    }
    checked += 1;
  }
  return { ok: errors.length === 0, errors, checked };
}

/**
 * 写一条事件摘要（带版本，不覆盖旧版）。
 * 校验不过直接抛错——宁缺勿假，和 memory-bridge "截断产物一律不进库" 同一条原则。
 */
export function saveNote(db, input = {}) {
  const episode = findEpisode(db, {
    episodeId: input.episodeId,
    sessionId: input.sessionId,
    seq: input.seq,
  });
  if (!episode) throw new Error("找不到对应的事件骨架（先 memory_episodes 看一眼锚点）");

  const title = String(input.title ?? "").trim();
  const summary = String(input.summary ?? "").trim();
  if (!title) throw new Error("title 必填");
  if (!summary) throw new Error("summary 必填");

  const verdict = verifyAnchors(db, episode, input.anchors);
  if (!verdict.ok) {
    throw new Error(`锚点校验失败：${verdict.errors.join("；")}`);
  }

  const prev = db
    .prepare("SELECT MAX(version) AS v FROM episode_notes WHERE episode_id = ?")
    .get(episode.episode_id);
  const version = Number(prev?.v ?? 0) + 1;

  db.prepare(
    `INSERT INTO episode_notes (episode_id, version, session_id, seq_start, seq_end, title, summary, anchors, entities, evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    episode.episode_id,
    version,
    episode.session_id,
    Number(episode.seq_start),
    Number(episode.seq_end),
    title,
    summary,
    JSON.stringify(input.anchors),
    JSON.stringify(Array.isArray(input.entities) ? input.entities : []),
    String(input.evidence || "inferred"),
    nowIso(),
  );

  return {
    ok: true,
    episodeId: episode.episode_id,
    version,
    anchors: input.anchors.length,
    seqRange: [Number(episode.seq_start), Number(episode.seq_end)],
  };
}

/** 每个 episode 的最新摘要。 */
export function listNotes(db, options = {}) {
  const limit = options.limit ?? 30;
  const rows = options.sessionId
    ? db
        .prepare(
          `SELECT n.* FROM episode_notes n
           JOIN (SELECT episode_id, MAX(version) AS v FROM episode_notes WHERE session_id = ? GROUP BY episode_id) m
             ON n.episode_id = m.episode_id AND n.version = m.v
           ORDER BY n.seq_start LIMIT ?`,
        )
        .all(options.sessionId, limit)
    : db
        .prepare(
          `SELECT n.* FROM episode_notes n
           JOIN (SELECT episode_id, MAX(version) AS v FROM episode_notes GROUP BY episode_id) m
             ON n.episode_id = m.episode_id AND n.version = m.v
           ORDER BY n.seq_start DESC LIMIT ?`,
        )
        .all(limit);
  return rows.map((r) => ({
    ...r,
    anchors: (() => {
      try {
        return JSON.parse(r.anchors).length;
      } catch {
        return 0;
      }
    })(),
  }));
}

function queryTerms(q) {
  const out = new Set();
  for (const m of String(q || "").toLowerCase().matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]+/g)) {
    const s = m[0];
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (s.length <= 2) out.add(s);
      else for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    } else if (s.length > 1) out.add(s);
  }
  return [...out];
}

/** 在事件摘要上做朴素检索（中文双字切分 + 词命中计分）。跨场景检索，同场景轻微加权。 */
export function searchNotes(db, query, options = {}) {
  const limit = options.limit ?? 8;
  const terms = queryTerms(query);
  if (terms.length === 0) return { query, terms: [], hits: [] };

  const rows = listNotesRanked(db, { limit: 500, venue: options.venue });
  const hits = [];
  for (const row of rows) {
    const haystack = `${row.title}\n${row.summary}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (haystack.includes(t)) score += 1;
    if (score > 0) {
      hits.push({
        episodeId: row.episode_id,
        sessionId: row.session_id,
        venue: row.venue,
        seqStart: row.seq_start,
        seqEnd: row.seq_end,
        title: row.title,
        summary: row.summary,
        version: row.version,
        anchors: row.anchors,
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { query, terms, hits: hits.slice(0, limit) };
}
/* --------------------------------------------------------- 全文（人格库） */

/** 某个会话的正文（按 seq 顺序）。 */
export function listMessages(db, sessionId, options = {}) {
  const limit = options.limit ?? 200;
  return db
    .prepare(
      "SELECT session_id, seq, role, text, time, turn, chars FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?",
    )
    .all(sessionId, limit);
}

/** 在人格库全文里检索（中文双字切分 + 命中计分）。 */
export function searchMessages(db, query, options = {}) {
  const limit = options.limit ?? 8;
  const roles = options.roles;
  const terms = queryTerms(query);
  if (terms.length === 0) return { query, terms: [], hits: [] };

  const rows = roles
    ? db
        .prepare(
          `SELECT session_id, seq, role, text, time, turn FROM messages WHERE role IN (${roles.map(() => "?").join(",")})`,
        )
        .all(...roles)
    : db.prepare("SELECT session_id, seq, role, text, time, turn FROM messages").all();

  const hits = [];
  for (const row of rows) {
    const haystack = row.text.toLowerCase();
    let score = 0;
    for (const t of terms) if (haystack.includes(t)) score += 1;
    if (score === 0) continue;
    hits.push({
      sessionId: row.session_id,
      seq: row.seq,
      role: row.role,
      time: row.time,
      score,
      text: row.text.length > 600 ? row.text.slice(0, 600) + "…" : row.text,
    });
  }
  hits.sort((a, b) => b.score - a.score || a.seq - b.seq);
  return { query, terms, hits: hits.slice(0, limit) };
}
/* ----------------------------------------------------- 使用反馈 & 升降级 */

/** hot/warm/cold 阈值与名额。频率只影响注入与保留期，不影响真值。 */
export const TIERS = {
  hotMinScore: 6,
  hotSlots: 3,
  warmMinScore: 1.5,
  halfLifeDays: 14,
};

function ageDays(iso, now) {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, (now - t) / 86_400_000);
}

/** 记一次使用信号：hit（被检索到）/ injected（被注入）/ expanded（被下钻）。 */
export function recordUsage(db, episodeId, kind, at = new Date().toISOString()) {
  if (!episodeId) return;
  const column = kind === "injected" ? "injected" : kind === "expanded" ? "expanded" : "hits";
  const stamp = kind === "injected" ? "last_injected_at" : kind === "expanded" ? "last_expanded_at" : "last_hit_at";
  db.prepare(
    `INSERT INTO note_usage (episode_id, ${column}, ${stamp}) VALUES (?, 1, ?)
     ON CONFLICT(episode_id) DO UPDATE SET ${column} = ${column} + 1, ${stamp} = excluded.${stamp}`,
  ).run(episodeId, at);
}

/** 带使用反馈与档位的摘要列表（每个 episode 取最新版）。 */
export function listNotesRanked(db, options = {}) {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 50;
  const here = options.venue || "";
  const rows = db
    .prepare(
      `SELECT n.*, COALESCE(u.hits,0) AS hits, COALESCE(u.injected,0) AS injected, COALESCE(u.expanded,0) AS expanded,
              u.last_hit_at, u.last_injected_at, u.last_expanded_at, s.preset AS preset
       FROM episode_notes n
       JOIN (SELECT episode_id, MAX(version) AS v FROM episode_notes GROUP BY episode_id) m
         ON n.episode_id = m.episode_id AND n.version = m.v
       LEFT JOIN note_usage u ON u.episode_id = n.episode_id
       LEFT JOIN sessions s ON s.session_id = n.session_id
       ORDER BY n.seq_start ASC
       LIMIT ?`,
    )
    .all(limit);

  const scored = rows.map((r) => {
    const hits = Number(r.hits || 0);
    const injected = Number(r.injected || 0);
    const expanded = Number(r.expanded || 0);
    // 下钻最强（说明摘要不够用、真去翻了原文），其次检索命中，注入最弱
    const raw = expanded * 5 + hits * 3 + injected * 0.5;
    const last =
      [r.last_expanded_at, r.last_hit_at, r.last_injected_at, r.created_at]
        .filter(Boolean)
        .sort()
        .pop() || "";
    const decay = Math.pow(0.5, ageDays(last, now) / TIERS.halfLifeDays);
    const venue = venueOfPreset(r.preset);
    // 同场景的经历稍微靠前——但**不把别的场景排除**：她在哪儿都是同一个人。
    const venueBoost = here && venue === here ? 1.25 : 1;
    const score = raw * decay * venueBoost;
    return { ...r, venue, hits, injected, expanded, rawScore: raw, score: Number(score.toFixed(3)), last };
  });

  scored.sort((a, b) => b.score - a.score || a.seq_start - b.seq_start);
  const hotIds = new Set(
    scored.filter((n) => n.score >= TIERS.hotMinScore).slice(0, TIERS.hotSlots).map((n) => n.episode_id),
  );
  return scored.map((n) => ({
    ...n,
    tier: hotIds.has(n.episode_id) ? "hot" : n.score >= TIERS.warmMinScore ? "warm" : "cold",
  }));
}

/** 摘要的档位统计（给设置页/CLI 看）。 */
export function tierSummary(db, options = {}) {
  const ranked = listNotesRanked(db, { limit: options.limit ?? 500, now: options.now });
  const counts = { hot: 0, warm: 0, cold: 0 };
  for (const n of ranked) counts[n.tier] += 1;
  return { counts, total: ranked.length, ranked };
}

/* ------------------------------------------------------------ 长期画像 */

/** 偏好/立场类陈述的触发词（零 LLM 的第一层过滤）。 */
const PREFERENCE_MARKERS = [
  "我喜欢", "我不喜欢", "我更喜欢", "我讨厌", "我受不了", "我习惯", "我希望你", "你别", "以后都",
  "记住", "别再", "下次", "每次都", "不要再用", "我喜欢你", "我想要",
];

/**
 * 从人格库的 user 正文里抽"反复出现的偏好"——纯规则，不调模型。
 * 输出的是**提案**：让模型自己判断要不要写进人格文件（写入仍走 soul_remember/soul_update 的校验）。
 */
export function buildDigest(db, options = {}) {
  const limit = options.limit ?? 400;
  const rows = db
    .prepare("SELECT session_id, seq, text, time FROM messages WHERE role = 'user' ORDER BY time DESC LIMIT ?")
    .all(limit);

  const items = [];
  for (const row of rows) {
    const text = String(row.text || "").replace(/\s+/g, " ").trim();
    if (text.length < 4 || text.length > 400) continue;
    if (!PREFERENCE_MARKERS.some((m) => text.includes(m))) continue;
    items.push({ sessionId: row.session_id, seq: row.seq, text, time: Number(row.time || 0) });
  }

  // 同一条被反复说（去掉标点后近似）→ 计数
  const buckets = new Map();
  for (const item of items) {
    const key = item.text.replace(/[，。！？、；：\s"'`]/g, "").slice(0, 40);
    const hit = buckets.get(key);
    if (hit) {
      hit.count += 1;
      hit.anchors.push({ sessionId: item.sessionId, seq: item.seq });
    } else {
      buckets.set(key, { text: item.text, count: 1, anchors: [{ sessionId: item.sessionId, seq: item.seq }] });
    }
  }

  const repeated = [...buckets.values()]
    .filter((b) => b.count >= 2 || b.text.includes("记住"))
    .sort((a, b) => b.count - a.count)
    .slice(0, options.maxItems ?? 8);

  const topics = listNotesRanked(db, { limit: options.topicLimit ?? 6, venue: options.venue });
  return {
    candidates: repeated,
    recentNotes: topics.map((n) => ({
      title: n.title,
      summary: n.summary,
      tier: n.tier,
      venue: n.venue,
      score: n.score,
      anchor: `${n.session_id}#${n.seq_start}-${n.seq_end}`,
    })),
    scannedMessages: rows.length,
    matched: items.length,
  };
}
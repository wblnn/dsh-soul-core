/**
 * 世界状态：光标（交代到哪一刻）+ 她不在场时发生的事 + 去重账本。
 *
 * 为什么需要这一层：
 *   会话进行中，外部世界还在变（QQ 聊了、MC 里被打了、别的会话在说话）。
 *   开场简报只在第一轮出现，之后新事件进不来——这就是"活人感"的漏洞。
 *
 * 三条硬约束（都是被指出来的，别再犯）：
 *   ① **cursor 必须落盘**。放内存的话 DSH 重启后归零，delta 会把过去 12 小时
 *      全部当新事件重放，而内存里的 hash 集合同时丢了 → 重启 = 简报风暴。
 *   ② **白名单，不是黑名单**。MC 公屏每句闲聊都算"新内容"就变成变相全量注入，
 *      所以 delta 只认"她不在场时发生的事"和"别的会话里他说的新话"。
 *   ③ **去重分两类**：事件类（发生过的事实）永久去重；状态类（未完成/牵挂/心情）
 *      按科目键 + 值变化 + 复现冷却——因为牵挂的生命力就在于反复浮现。
 */

import { createHash } from "node:crypto";

/** 默认开场窗口：12 小时。 */
export const DEFAULT_LOOKBACK_MS = 12 * 3600_000;
/** 状态类复现冷却：6 小时。 */
export const STATE_COOLDOWN_MS = 6 * 3600_000;

/* ───────────────────────── 光标 ───────────────────────── */

/** 这个会话已经交代到哪一刻（毫秒）。没有记录返回 null。 */
export function getCursor(db, sessionId) {
  try {
    const row = db.prepare("SELECT last_seen_ms FROM world_cursor WHERE session_id = ?").get(String(sessionId));
    return row ? Number(row.last_seen_ms) : null;
  } catch {
    return null;
  }
}

/** 推进光标（幂等；只许往前推）。 */
export function setCursor(db, sessionId, ms) {
  const at = Number(ms || Date.now());
  try {
    db.prepare(
      `INSERT INTO world_cursor (session_id, last_seen_ms, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen_ms = MAX(world_cursor.last_seen_ms, excluded.last_seen_ms),
         updated_at = excluded.updated_at`,
    ).run(String(sessionId), at, new Date().toISOString());
    return at;
  } catch {
    return null;
  }
}

/* ───────────────────────── 世界事件 ───────────────────────── */

/** 记一条"她不在场时发生的事"。severity: P0（死亡/濒死/被打）/ P1（被打断/目标完成）。 */
export function recordWorldEvent(db, { kind, severity = "P1", text, atMs = Date.now(), sessionId = "" }) {
  const body = String(text ?? "").trim();
  if (!body) return false;
  try {
    db.prepare("INSERT INTO world_events (kind, severity, text, at_ms, session_id) VALUES (?, ?, ?, ?, ?)").run(
      String(kind || "event"),
      String(severity),
      body.slice(0, 300),
      Number(atMs),
      String(sessionId),
    );
    return true;
  } catch {
    return false;
  }
}

/* ───────────────────────── 去重账本 ───────────────────────── */

export function lineHash(text) {
  return createHash("sha1").update(String(text ?? "").trim()).digest("hex").slice(0, 16);
}

/** 每个会话的"已注入"账本。丢了解释：最坏是重注一次；cursor 落盘保证不会风暴。 */
const SESSION_HASHES = new Map();
/** 状态类科目：sessionId → Map(subjectKey, {value, injectedAt}) */
const STATE_LEDGER = new Map();

function hashesOf(sessionId) {
  const key = String(sessionId);
  let set = SESSION_HASHES.get(key);
  if (!set) {
    set = new Set();
    SESSION_HASHES.set(key, set);
  }
  return set;
}

export function alreadyInjected(sessionId, text) {
  return hashesOf(sessionId).has(lineHash(text));
}

export function markInjected(sessionId, text) {
  hashesOf(sessionId).add(lineHash(text));
}

/**
 * 状态类要不要放行。
 * @param subject 科目键（如 "mine:钻石"）——按科目而不是按文本，否则措辞一变就当成"新值"
 * @param value 规范化后的值（如 "3"、"未完成"）
 */
export function shouldEmitState(sessionId, subject, value, now = Date.now(), cooldownMs = STATE_COOLDOWN_MS) {
  const key = String(sessionId);
  let ledger = STATE_LEDGER.get(key);
  if (!ledger) {
    ledger = new Map();
    STATE_LEDGER.set(key, ledger);
  }
  const prev = ledger.get(String(subject));
  const norm = String(value ?? "");
  if (!prev) {
    ledger.set(String(subject), { value: norm, injectedAt: now });
    return { emit: true, reason: "first" };
  }
  if (prev.value !== norm) {
    ledger.set(String(subject), { value: norm, injectedAt: now });
    return { emit: true, reason: "value-changed" };
  }
  if (now - prev.injectedAt >= cooldownMs) {
    ledger.set(String(subject), { value: norm, injectedAt: now });
    return { emit: true, reason: "cooldown" };
  }
  return { emit: false, reason: "cooling" };
}

/** 测试/诊断用：清掉某个会话的账本。 */
export function resetSessionMemory(sessionId) {
  SESSION_HASHES.delete(String(sessionId));
  STATE_LEDGER.delete(String(sessionId));
}

/* ───────────────────────── delta ───────────────────────── */

/**
 * 收集光标之后的新东西。
 *
 * 白名单（按这条来判断"算不算新事件"）：
 *   - 别的会话里 **他** 说的新话（不含信封、不含她自己说）
 *   - world_events 里 P0 / P1 的事（她不在场时的遭遇）
 * **不认**：MC 公屏的普通闲聊（她本来就会收到唤醒，重复注入=噪音）
 */
export function collectDelta(db, options = {}) {
  const sessionId = String(options.sessionId || "");
  const sinceMs = Number(options.sinceMs || 0);
  const now = Number(options.now || Date.now());
  const budget = Number(options.budget ?? 180);
  const maxLines = Number(options.maxLines ?? 3);

  const lines = [];
  let used = 0;
  const add = (line) => {
    if (!line) return false;
    if (lines.length >= maxLines) return false;
    if (used + line.length > budget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  // ① 她不在场时发生的事（P0 优先）
  try {
    const events = db
      .prepare(
        `SELECT kind, severity, text, at_ms FROM world_events
         WHERE at_ms > ? AND at_ms <= ?
         ORDER BY CASE severity WHEN 'P0' THEN 0 ELSE 1 END, at_ms DESC
         LIMIT 6`,
      )
      .all(sinceMs, now);
    for (const e of events) {
      if (e.session_id && String(e.session_id) === sessionId) continue;
      const tag = e.severity === "P0" ? "刚刚" : "不久前";
      if (!add(`- 〔${tag}·${e.kind}〕${String(e.text).slice(0, 60)}`)) break;
    }
  } catch {
    /* 表不存在就当没有 */
  }

  // ② 别的会话里他说的话
  try {
    const rows = db
      .prepare(
        `SELECT session_id, role, text, time FROM messages
         WHERE time > ? AND time <= ? AND role = 'user' AND session_id != ?
         ORDER BY time DESC LIMIT 8`,
      )
      .all(sinceMs, now, sessionId);
    for (const m of rows) {
      const text = String(m.text || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 2) continue;
      // 信封/系统注入不算"他说的话"
      if (/^(【MC |【你不在|【来自会话|Current runtime context|<system-reminder>)/.test(text)) continue;
      const mins = Math.max(1, Math.round((now - Number(m.time || now)) / 60_000));
      if (!add(`- 〔${mins} 分钟前·另一个对话里他说的〕${text.slice(0, 60)}`)) break;
    }
  } catch {
    /* 忽略 */
  }

  if (lines.length === 0) return { text: "", lines: [], chars: 0, sinceMs, now };
  const text = ["## 你不在这会儿（刚刚发生的事）", ...lines].join("\n");
  return { text, lines, chars: text.length, sinceMs, now };
}

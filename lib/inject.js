/**
 * 摘要注入：把"最近记得的事"塞进人格态的系统提示词。
 *
 * 设计取舍：
 *   - 只注入**摘要**，不注入原文——原文按锚点下钻，prompt 里放原文等于把上下文烧光。
 *   - 预算独立且很小（默认 ≤1400 字符，且不超过总注入预算的 15%），人格本体优先。
 *   - 注入顺序：hot（常驻）在前，其余按分数/时间；每条都带锚点，模型可以据此下钻。
 *   - 注入本身记一笔使用信号，但**同一段 6 小时内只记一次**，否则常驻条目会自我强化到永远。
 */

import { listNotesRanked, recordUsage, venueLabel } from "./memory-store.js";

const INJECT_STAMP_WINDOW_MS = 6 * 3600 * 1000;

function shorten(text, max) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (body.length <= max) return body;
  return body.slice(0, Math.max(0, max - 1)) + "…";
}

function shortSession(sessionId) {
  const s = String(sessionId || "");
  return s.length > 22 ? s.slice(0, 22) + "…" : s;
}

/**
 * 生成注入用的事件摘要块。
 *
 * @param db 记忆库
 * @param options.budget 字符预算
 * @param options.maxItems 最多几条
 * @param options.now 当前时间（测试注入）
 * @param options.record 是否记注入信号（默认 true）
 * @returns {{text:string, injected:string[]}}
 */
export function buildMemoryBrief(db, options = {}) {
  const budget = Number.isFinite(options.budget) ? options.budget : 1200;
  const maxItems = options.maxItems ?? 4;
  const now = options.now ?? Date.now();
  const record = options.record !== false;
  const here = options.venue || "";

  let ranked;
  try {
    ranked = listNotesRanked(db, { limit: 60, now, venue: here });
  } catch {
    return { text: "", injected: [] };
  }
  if (!ranked || ranked.length === 0) return { text: "", injected: [] };

  const hot = ranked.filter((n) => n.tier === "hot");
  const others = ranked.filter((n) => n.tier !== "hot");
  const picked = [...hot.slice(0, 2), ...others].slice(0, maxItems);

  const header = "## 最近记得的事（来自人格库，可按锚点下钻原文；跨场景共享）";
  const lines = [];
  let used = header.length;
  const injected = [];

  for (const note of picked) {
    const tag = note.tier === "hot" ? "常驻" : note.tier === "warm" ? "常提" : "偶及";
    const where = venueLabel(note.venue);
    const line = `- 〔${where}｜${tag}〕${shorten(note.title, 30)}：${shorten(note.summary, 100)}　锚点 ${shortSession(note.session_id)}#${note.seq_start}-${note.seq_end}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    injected.push(note.episode_id);
  }

  if (lines.length === 0) return { text: "", injected: [] };

  const footer = "需要细节时用 memory_expand 按锚点回原文；说「记得」之前先 memory_search。";
  const text = `${header}\n${lines.join("\n")}\n${footer}`;

  if (record) {
    const at = new Date(now).toISOString();
    for (const episodeId of injected) {
      const row = db.prepare("SELECT last_injected_at FROM note_usage WHERE episode_id = ?").get(episodeId);
      const last = row?.last_injected_at ? Date.parse(row.last_injected_at) : 0;
      if (Number.isFinite(last) && now - last < INJECT_STAMP_WINDOW_MS) continue;
      try {
        recordUsage(db, episodeId, "injected", at);
      } catch {
        /* 反馈记账失败不能影响注入 */
      }
    }
  }

  return { text, injected };
}

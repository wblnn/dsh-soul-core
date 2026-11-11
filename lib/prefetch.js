/**
 * 预检索：Harness 层自动把「相关记忆」摆到她面前。
 *
 * 为什么必须有这一层：
 *   只给模型一个 recall 工具 = 指望它自己想起来"我该查一下"。这是最不可靠的设计——
 *   没有任何信号提示"这里有相关记忆"，它自然不查，然后凭印象编。
 *
 * 分工：
 *   **预检索（自动，每轮）**：用当前用户输入检索 Top-K 摘要 + 锚点，直接注入上下文。
 *                          负责"让她看见相关记忆存在"。这是主入口，不依赖她决策。
 *   **下钻工具（她主动）**：摘要里标了「细节已省略」，她看到这个信号才会去读原文。
 *                          这是补充入口，触发信号明确。
 *
 * 检索实现：现在是**词法检索**（中文双字切分 + 词命中），零依赖、零延迟、可解释。
 * 位置留在 `searchNotes/searchMessages` 后面，将来换成 embedding + 向量库只需替换这一层。
 */

import { searchMessages, searchNotes, venueLabel } from "./memory-store.js";

const NOTE_MARK = "（此处有细节省略，需要原话就用 memory_expand）";

/** 只做格式化，便于测试。 */
export function formatPrefetch({ notes = [], messages = [] } = {}, options = {}) {
  const query = String(options.query ?? "").trim();
  const limit = options.maxItems ?? 5;
  const budget = options.budget ?? 900;

  const lines = [];
  if (notes.length === 0 && messages.length === 0) return "";

  const shown = String(query || "").replace(/\s+/g, " ").trim().slice(0, 24);
  const header = shown
    ? `## 可能相关的记忆（按你刚说的话自动检索：${shown}）`
    : "## 可能相关的记忆（自动检索）";
  lines.push(header);
  lines.push("（不用你主动查——这些是系统替你找出来的；摘要不够再看锚点去翻原文）");

  let used = header.length + 40;
  let n = 0;

  for (const note of notes) {
    if (n >= limit) break;
    const where = venueLabel(note.venue);
    const line =
      `- 〔${where}〕${String(note.title || "").slice(0, 30)}：${String(note.summary || "").slice(0, 90)}` +
      `　锚点 ${String(note.sessionId || "").slice(0, 18)}#${note.seqStart}-${note.seqEnd} ${NOTE_MARK}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
    n += 1;
  }

  for (const m of messages) {
    if (n >= limit) break;
    const text = String(m.text || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `- 〔原话·${m.role}〕${text.slice(0, 80)}…　锚点 #${m.seq}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
    n += 1;
  }

  if (lines.length <= 2) return "";
  return lines.join("\n");
}

/**
 * 从"输入"里剥出可以当检索词的部分。
 *
 * 直接拿整段输入检索有两个坑（实测踩到）：
 *   ① 我们注入的信封（【MC 公屏 · 最近 5 条】、<玩家名>）会污染检索词；
 *   ② 信封自己也出现在检索目标里 → 自己命中自己。
 * 所以先剥信封与说话人标签，再截断长度。
 */
export function cleanQuery(raw) {
  let s = String(raw ?? "");
  s = s.replace(/【[^】]*】/g, " "); // 信封
  s = s.replace(/<[^>]{1,40}>/g, " "); // <玩家名>
  s = s.replace(/（[^）]*）/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, 160);
}

/**
 * 用当前输入检索并组装预检索块。
 * @param db 记忆库
 * @param options.query 当前用户输入（空则返回空串，不猜）
 */
export function buildPrefetchBlock(db, options = {}) {
  const raw = String(options.query ?? "").trim();
  if (!raw) return "";
  const query = cleanQuery(raw);
  if (query.length < 4) return ""; // 剥完信封没剩几个词，就别猜

  const venue = options.venue || "";
  let notes = [];
  let messages = [];
  try {
    const rawNotes = searchNotes(db, query, { limit: (options.noteLimit ?? 3) * 2, venue }).hits || [];
    notes = rawNotes
      .filter((n) => Number(n.score || 0) >= 2)
      .filter((n) => !(options.excludeSession && String(n.sessionId) === String(options.excludeSession)))
      .slice(0, options.noteLimit ?? 3);
  } catch {
    notes = [];
  }
  try {
    const rawMsgs = searchMessages(db, query, { limit: (options.msgLimit ?? 2) * 3, roles: ["user", "assistant"] }).hits || [];
    const curSid = String(options.currentSession || "");
    const curSeq = Number(options.currentSeq || 0);
    messages = rawMsgs
      .filter((m) => Number(m.score || 0) >= 2)
      .filter((m) => !options.excludeSeq || Number(m.seq) !== Number(options.excludeSeq))
      // **排除"当前会话里比提问更晚"的记录**：那是她刚刚说的总结，不是记忆。
      // 不排就会自己命中自己 → 她会觉得"这条不可靠，我再查一下"。
      .filter((m) => !(curSid && String(m.sessionId) === curSid && Number(m.seq) >= curSeq))
      .filter((m) => !(options.excludeSession && String(m.sessionId) === String(options.excludeSession)))
      // 原始记录优先：用户原话 > 她的复述
      .sort((a, b) => {
        const pri = (m) => (m.role === "user" ? 1 : 0);
        return Number(b.score || 0) - Number(a.score || 0) || pri(b) - pri(a);
      })
      .slice(0, options.msgLimit ?? 2);
  } catch {
    messages = [];
  }
  return formatPrefetch({ notes, messages }, { query, budget: options.budget ?? 900, maxItems: options.maxItems ?? 5 });
}

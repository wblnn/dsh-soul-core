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
import { bigrams, passGate, rankDocs } from "./similarity.js";
import { isSyntheticInput } from "./session-source.js";
import { loadMessages, spread } from "./links.js";

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
    const tag = m.via === "spread" ? `联想到·${m.role}` : `原话·${m.role}`;
    const tail = m.via === "spread" ? "（跟上面那件事连着，不是原话命中）" : "";
    const line = `- 〔${tag}〕${text.slice(0, 80)}…　锚点 #${m.seq}${tail}`;
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
/**
 * 取候选池：最近的一批正文记忆。
 *
 * 为什么换成"池内打分"而不是 SQL 词命中：
 *   原来的做法是「命中二元组个数 ≥ 2」——长文本天然占优、短句吃亏；
 *   现在把池子拉进内存，用 Dice + BM25 + 情绪对齐打分（见 lib/similarity.js）。
 *
 * 池子大小有上限（默认 1200 条），并按池指纹缓存索引，避免每轮重算。
 */
const POOL_LIMIT = 1200;
let POOL_CACHE = { key: "", docs: [] };

function loadMessagePool(db, options = {}) {
  const limit = Number(options.poolLimit ?? POOL_LIMIT);
  try {
    const stamp = db.prepare("SELECT COUNT(*) AS n, MAX(seq) AS s, MAX(time) AS t FROM messages").get();
    const key = `${stamp?.n ?? 0}:${stamp?.s ?? 0}:${stamp?.t ?? 0}:${limit}`;
    if (POOL_CACHE.key === key) return POOL_CACHE.docs;

    const rows = db
      .prepare(
        "SELECT session_id, seq, role, text, time FROM messages WHERE role IN ('user','assistant') ORDER BY time DESC LIMIT ?",
      )
      .all(limit);

    const docs = rows
      .map((r) => ({
        id: `${r.session_id}#${r.seq}`,
        sessionId: String(r.session_id),
        seq: Number(r.seq),
        role: String(r.role),
        time: Number(r.time || 0),
        text: String(r.text || "").replace(/\s+/g, " ").trim(),
      }))
      // 信封/系统注入不是她的记忆，别进池子（实测它们会靠"压力/累"这类词挤到前面）
      .filter((d) => d.text.length >= 4 && !isSyntheticInput(d.text));
    for (const d of docs) d.grams = bigrams(d.text);
    POOL_CACHE = { key, docs };
    return docs;
  } catch {
    return [];
  }
}

/** 池内检索：Dice + BM25 + 情绪，过证据闸后返回。 */
function rankMessages(db, query, options = {}) {
  const pool = loadMessagePool(db, options);
  if (pool.length === 0) return [];

  const curSid = String(options.currentSession || "");
  const curSeq = Number(options.currentSeq || 0);
  const filtered = pool.filter((d) => {
    if (options.excludeSeq && d.seq === Number(options.excludeSeq) && d.sessionId === curSid) return false;
    // 排除"当前会话里比提问更晚"的记录：那是她刚说的总结，不是记忆
    if (curSid && d.sessionId === curSid && d.seq >= curSeq) return false;
    if (options.excludeSession && d.sessionId === String(options.excludeSession)) return false;
    return true;
  });
  if (filtered.length === 0) return [];

  const ranked = rankDocs(query, filtered);
  const passed = passGate(ranked, {
    minAbs: Number(options.minAbs ?? 0.12),
    minRel: Number(options.minRel ?? 0.35),
  });

  // 原始记录优先：同一分数下用户原话 > 她的复述
  passed.sort((a, b) => b.evidence - a.evidence || (b.doc.role === "user" ? 1 : 0) - (a.doc.role === "user" ? 1 : 0));

  // 同一个会话最多取 2 条，避免整段都是同一段对话
  const perSession = new Map();
  const out = [];
  for (const r of passed) {
    const n = (perSession.get(r.doc.sessionId) ?? 0) + 1;
    if (n > 2) continue;
    perSession.set(r.doc.sessionId, n);
    out.push(r);
    if (out.length >= (options.msgLimit ?? 2) * 3) break;
  }
  return out;
}

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
    // 池内 Dice + BM25 + 情绪，过证据闸（见 lib/similarity.js）
    const ranked = rankMessages(db, query, options);
    // ── 联想扩散：从直接命中出发，沿关联边走两跳 ──
    // 这一步是"网状"和"树状"的分界线：直接命中之外，还能捞回
    // 字面不重叠、但跟命中那条在内容/时间上相连的记忆。
    const direct = ranked.slice(0, options.msgLimit ?? 2);
    const seedIds = ranked.slice(0, 3).map((r) => r.doc.id);
    let spreadDocs = [];
    if (seedIds.length > 0 && options.spread !== false) {
      try {
        const activation = spread(db, seedIds, {
          rounds: Number(options.spreadRounds ?? 2),
          decay: Number(options.spreadDecay ?? 0.5),
        });
        const directIds = new Set(direct.map((r) => r.doc.id));
        const extraIds = [...activation.entries()]
          .filter(([id, v]) => !directIds.has(id) && v >= 0.2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, Number(options.spreadLimit ?? 2))
          .map(([id]) => id);
        if (extraIds.length > 0) {
          const loaded = loadMessages(db, extraIds);
          spreadDocs = extraIds
            .map((id) => loaded.get(id))
            .filter(Boolean)
            .filter((d) => d.text.length >= 4 && !isSyntheticInput(d.text))
            .map((d) => ({ ...d, via: "spread" }));
        }
      } catch {
        spreadDocs = [];
      }
    }

    messages = direct.map((r) => ({
      sessionId: r.doc.sessionId,
      seq: r.doc.seq,
      role: r.doc.role,
      text: r.doc.text,
      // 给下游一个"为什么被选中"的依据，日志里能看见
      evidence: Number(r.evidence.toFixed(3)),
      why: { dice: Number(r.dice.toFixed(3)), bm25: Number(r.bm25.toFixed(3)), emotion: r.emotion },
    }));
    // 联想项排在后面，并标明来由（不标她会以为是直接命中的原话）
    messages = messages.concat(spreadDocs);
  } catch {
    messages = [];
  }
  return formatPrefetch({ notes, messages }, { query, budget: options.budget ?? 900, maxItems: options.maxItems ?? 5 });
}

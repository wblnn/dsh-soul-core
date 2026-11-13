/**
 * 关联表：让记忆之间能"跳"。
 *
 * 动机：现在的检索是"命中即返回"，每条记忆都是孤岛。人的联想是横向的——
 * 从"屋顶"跳到"上次摔下来那次"，哪怕两句话一个字都不重叠。
 *
 * 参考 SeekMemory 的纯计算做法（github.com/NeverENG/Seekmemory），只搬三样：
 *   ① 建边：Dice > 0.45 → similar 边（权重=Dice）；同一天 → temporal 边（权重 0.3）
 *   ② 上限：每节点最多 5 条边（similar ≤3 / temporal ≤2）——约束比规则更重要
 *   ③ 扩散：两跳，每跳 DECAY=0.5，每轮最多 20 个节点，取 **max-path** 而不是求和
 *
 * 为什么 max-path：求和会让"边多的人缘节点"靠数量刷分；max-path 只认最强路径。
 *
 * 不搬：因果边自动推断（SeekMemory 也明确不做），披露分级。
 */

import { bigrams, dice } from "./similarity.js";

/** 每节点最多几条边。 */
export const MAX_EDGES = 5;
export const MAX_SIMILAR = 3;
export const MAX_TEMPORAL = 2;
/** 建 similar 边的 Dice 门槛。 */
export const SIMILAR_BAR = 0.45;
/** temporal 边固定权重（低，因为"同一天"不等于"有关系"）。 */
export const TEMPORAL_WEIGHT = 0.3;

export const SPREAD_DECAY = 0.5;
export const SPREAD_ROUNDS = 2;
export const MAX_PER_ROUND = 20;

export function nodeId(sessionId, seq) {
  return `${sessionId}#${seq}`;
}

export function parseNodeId(id) {
  const s = String(id || "");
  const i = s.lastIndexOf("#");
  if (i <= 0) return null;
  return { sessionId: s.slice(0, i), seq: Number(s.slice(i + 1)) };
}

function dayOf(ms) {
  const d = new Date(Number(ms) || 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 建边期间的内存索引。
 *
 * 为什么要有：原来每判断一次"这条边有没有/这节点几条边"都发一条 SQL，
 * 400 条记忆 × 24 个候选 = 上万次查询，实测 7.4 秒。改成一次性载入内存后是毫秒级。
 */
function loadEdgeIndex(db) {
  const counts = new Map();
  const byKind = new Map(); // kind → Map<from_id, n>
  const keys = new Set();
  try {
    for (const row of db.prepare("SELECT from_id, kind, COUNT(*) AS n FROM links GROUP BY from_id, kind").all()) {
      const from = String(row.from_id);
      const kind = String(row.kind);
      counts.set(from, (counts.get(from) ?? 0) + Number(row.n));
      if (!byKind.has(kind)) byKind.set(kind, new Map());
      byKind.get(kind).set(from, Number(row.n));
    }
    for (const row of db.prepare("SELECT from_id, to_id, kind FROM links").all()) {
      keys.add(`${row.from_id}|${row.to_id}|${row.kind}`);
    }
  } catch {
    /* 表不存在就从空开始 */
  }
  return { counts, byKind, keys };
}

/** 某节点某种边已有几条。 */
function kindCount(idx, kind, id) {
  return idx.byKind.get(kind)?.get(id) ?? 0;
}

function edgeCount(idx, id) {
  return idx.counts.get(id) ?? 0;
}

function hasEdge(idx, from, to, kind) {
  return idx.keys.has(`${from}|${to}|${kind}`);
}

function insertEdge(db, idx, from, to, kind, weight) {
  if (!from || !to || from === to) return false;
  const key = `${from}|${to}|${kind}`;
  if (idx.keys.has(key)) return false;
  try {
    db.prepare(
      "INSERT OR REPLACE INTO links (from_id, to_id, kind, weight, at_ms) VALUES (?, ?, ?, ?, ?)",
    ).run(from, to, kind, Math.max(0, Math.min(1, Number(weight) || 0)), Date.now());
    idx.keys.add(key);
    idx.counts.set(from, (idx.counts.get(from) ?? 0) + 1);
    if (!idx.byKind.has(kind)) idx.byKind.set(kind, new Map());
    const m = idx.byKind.get(kind);
    m.set(from, (m.get(from) ?? 0) + 1);
    return true;
  } catch {
    return false;
  }
}

/**
 * 给最近的一批记忆建边（增量）。
 *
 * 只在"同一批候选"里比较：默认最近 400 条正文。这样规模有界，
 * 而且新记忆一定跟最近记忆相连——正好是联想最常发生的范围。
 *
 * @returns {{similar:number, temporal:number}}
 */
export function buildLinks(db, options = {}) {
  const limit = Number(options.limit ?? 400);
  let rows = [];
  try {
    rows = db
      .prepare(
        "SELECT session_id, seq, role, text, time FROM messages WHERE role IN ('user','assistant') AND length(text) >= 4 ORDER BY time DESC LIMIT ?",
      )
      .all(limit);
  } catch {
    return { similar: 0, temporal: 0 };
  }
  if (rows.length < 2) return { similar: 0, temporal: 0 };

  const docs = rows.map((r) => ({
    id: nodeId(r.session_id, r.seq),
    sessionId: String(r.session_id),
    seq: Number(r.seq),
    time: Number(r.time || 0),
    grams: bigrams(r.text),
    day: dayOf(r.time),
  }));

  const idx = loadEdgeIndex(db);
  let similar = 0;
  let temporal = 0;
  for (let i = 0; i < docs.length; i++) {
    const a = docs[i];
    let room = MAX_EDGES - edgeCount(idx, a.id);
    if (room <= 0) continue;

    // ① similar：同会话内 Dice 最高的几条（跨会话噪声大，且规模不可控）
    if (room > 0 && kindCount(idx, "similar", a.id) < MAX_SIMILAR) {
      const peers = [];
      const lo = Math.max(0, i - 60);
      const hi = Math.min(docs.length, i + 61);
      for (let j = lo; j < hi; j++) {
        const b = docs[j];
        if (b.id === a.id || b.sessionId !== a.sessionId) continue;
        const d = dice(a.grams, b.grams);
        if (d > SIMILAR_BAR) peers.push({ b, d });
      }
      peers.sort((x, y) => y.d - x.d);
      let added = 0;
      for (const { b, d } of peers) {
        if (added >= MAX_SIMILAR || room <= 0) break;
        if (edgeCount(idx, b.id) >= MAX_EDGES) continue;
        if (hasEdge(idx, a.id, b.id, "similar")) continue;
        if (insertEdge(db, idx, a.id, b.id, "similar", d)) {
          added += 1;
          similar += 1;
          room -= 1;
        }
      }
    }

    // ② temporal：同一天、时间最近的几条
    if (room > 0 && kindCount(idx, "temporal", a.id) < MAX_TEMPORAL) {
      const sameDay = docs
        .filter((b) => b.id !== a.id && b.day === a.day && !hasEdge(idx, a.id, b.id, "temporal"))
        .sort((x, y) => Math.abs(x.time - a.time) - Math.abs(y.time - a.time))
        .slice(0, MAX_TEMPORAL);
      let added = 0;
      const roomTemporal = MAX_TEMPORAL - kindCount(idx, "temporal", a.id);
      for (const b of sameDay) {
        if (added >= roomTemporal || room <= 0) break;
        if (edgeCount(idx, b.id) >= MAX_EDGES) continue;
        if (insertEdge(db, idx, a.id, b.id, "temporal", TEMPORAL_WEIGHT)) {
          added += 1;
          temporal += 1;
          room -= 1;
        }
      }
    }
  }

  return { similar, temporal };
}

/** 读邻居（双向：边可能只建了一个方向）。 */
export function neighbours(db, id) {
  const out = new Map();
  const take = (rows) => {
    for (const r of rows) {
      const cur = out.get(r.other);
      if (cur === undefined || r.weight > cur) out.set(r.other, Number(r.weight));
    }
  };
  try {
    take(
      db.prepare("SELECT to_id AS other, weight FROM links WHERE from_id = ?").all(id),
    );
    take(
      db.prepare("SELECT from_id AS other, weight FROM links WHERE to_id = ?").all(id),
    );
  } catch {
    /* 表不存在就当没边 */
  }
  return [...out.entries()]
    .map(([other, weight]) => ({ id: other, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_EDGES);
}

/**
 * 有界激活：从种子沿边扩散两跳。
 * @returns {Map<string, number>} id → 激活值（0..1）
 */
export function spread(db, seedIds, options = {}) {
  const rounds = Number(options.rounds ?? SPREAD_ROUNDS);
  const decay = Number(options.decay ?? SPREAD_DECAY);
  const maxPerRound = Number(options.maxPerRound ?? MAX_PER_ROUND);

  const scores = new Map();
  for (const sid of seedIds) if (sid) scores.set(sid, 1);
  let frontier = new Map(scores);

  for (let r = 0; r < Math.max(0, rounds); r++) {
    const candidates = new Map();
    for (const [id, value] of frontier) {
      for (const nb of neighbours(db, id)) {
        const contribution = value * decay * Math.max(0, Math.min(1, nb.weight));
        if (contribution <= 0) continue;
        const best = Math.max(scores.get(nb.id) ?? 0, candidates.get(nb.id) ?? 0);
        if (contribution <= best) continue;
        candidates.set(nb.id, Math.min(1, contribution));
      }
    }
    if (candidates.size === 0) break;
    frontier = new Map(
      [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxPerRound),
    );
    for (const [id, value] of frontier) {
      scores.set(id, Math.max(scores.get(id) ?? 0, value));
    }
  }
  return scores;
}

/** 按节点 id 取正文（扩散结果要用）。 */
export function loadMessages(db, ids) {
  const out = new Map();
  if (!ids || ids.length === 0) return out;
  const stmt = db.prepare("SELECT session_id, seq, role, text, time FROM messages WHERE session_id = ? AND seq = ?");
  for (const id of ids) {
    const p = parseNodeId(id);
    if (!p) continue;
    try {
      const row = stmt.get(p.sessionId, p.seq);
      if (row) {
        out.set(id, {
          id,
          sessionId: String(row.session_id),
          seq: Number(row.seq),
          role: String(row.role),
          text: String(row.text || ""),
          time: Number(row.time || 0),
        });
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 统计（面板/诊断用）。 */
export function linkStats(db) {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN kind='similar' THEN 1 ELSE 0 END) AS s, SUM(CASE WHEN kind='temporal' THEN 1 ELSE 0 END) AS t FROM links")
      .get();
    return { total: Number(row?.n ?? 0), similar: Number(row?.s ?? 0), temporal: Number(row?.t ?? 0) };
  } catch {
    return { total: 0, similar: 0, temporal: 0 };
  }
}

/**
 * 相似度层：把「命中几个词」换成「有多像」。
 *
 * 参考 SeekMemory（github.com/NeverENG/Seekmemory）的召回内核，只搬纯计算部分：
 *   - 字符二元组 + Dice 系数：`2|A∩B|/(|A|+|B|)` —— 除掉长度，长文本不再天然占便宜
 *   - 池内 BM25（k1=1.2, b=0.75）—— 词频与文档长度归一
 *   - 情绪极性对齐 —— "今天好累"能接到负面情绪的记忆（这条是它真正的"共振"来源之一）
 *   - 证据闸：绝对下限 + 相对下限（相对最高分），先验不能单独让无关条目过闸
 *
 * 不搬的：图边与两跳传播（那需要关联表，另说）、披露分级、一次性交付。
 * 也不调任何模型/网络——全是算术。
 */

import { STOPWORDS } from "./relevance.js";

/** 标点/空白切掉，保留中文与字母数字。 */
const PUNCT = /[^\p{L}\p{N}]+/gu;

/** 情绪词表（来自 SeekMemory 的 POSITIVE/NEGATIVE，中文直取）。 */
const POSITIVE = ["开心", "高兴", "喜欢", "哈哈", "笑", "好玩", "可爱", "棒", "好耶", "舒服"];
const NEGATIVE = ["累", "烦", "难过", "委屈", "生气", "难受", "哭", "焦虑", "压力", "孤单", "怕", "崩", "撑不住"];

/**
 * 字符二元组集合（中文）+ 英文/数字整词。
 * 和 SeekMemory 的 alphanumeric_bigrams 行为对齐：先去标点、转小写。
 */
export function bigrams(text) {
  const plain = String(text ?? "")
    .replace(PUNCT, " ")
    .toLowerCase()
    .trim();
  const out = new Set();
  for (const chunk of plain.split(/\s+/).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length > 1) out.add(chunk);
      continue;
    }
    // 中文（或混合）按二元组切
    const chars = [...chunk];
    if (chars.length === 1) {
      out.add(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      const bi = chars[i] + chars[i + 1];
      if (STOPWORDS.has(bi)) continue; // 虚词二元组不参与相似度（"一下""这个"）
      out.add(bi);
    }
  }
  return out;
}

/** Dice 系数：2|A∩B|/(|A|+|B|)。 */
export function dice(a, b) {
  const A = a instanceof Set ? a : bigrams(a);
  const B = b instanceof Set ? b : bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const g of small) if (big.has(g)) hit += 1;
  return (2 * hit) / (A.size + B.size);
}

/** 情绪极性：-1 负面 / 0 中性 / +1 正面；strength 是命中词数。 */
export function emotionOf(text) {
  const t = String(text ?? "");
  let pos = 0;
  let neg = 0;
  for (const w of POSITIVE) pos += t.split(w).length - 1;
  for (const w of NEGATIVE) neg += t.split(w).length - 1;
  const polarity = pos > neg ? 1 : neg > pos ? -1 : 0;
  return { pos, neg, polarity, strength: pos + neg };
}

/**
 * 情绪贴合度。
 * 两侧都有极性：同极 1.0，反极 0，命中但无极性 0.6；
 * 查询无情绪词：只给一点点（0.3 × 记忆有没有情绪），避免情绪压过相关度。
 */
export function emotionMatch(q, doc) {
  const qe = q?.polarity !== undefined ? q : emotionOf(q);
  const de = doc?.polarity !== undefined ? doc : emotionOf(doc);
  if (qe.pos === 0 && qe.neg === 0) return Math.min(0.3, 0.1 * de.strength);
  if (de.polarity === 0) return 0.2;
  if (qe.polarity === 0) return 0.3;
  return qe.polarity === de.polarity ? 1 : 0;
}

/**
 * 池内 BM25 索引。
 *
 * 为什么是"池内"：我们的池子是"这次要检索的那批记忆"（最近若干条 + 命中候选），
 * 不是全库。用池子自己的 df/avgdl 统计，避免全局权重偏斜。
 */
export function buildBm25(docs, options = {}) {
  const k1 = Number(options.k1 ?? 1.2);
  const b = Number(options.b ?? 0.75);
  const N = docs.length;
  const df = new Map();
  const lens = new Array(N);
  const tfs = new Array(N);

  docs.forEach((doc, i) => {
    const grams = doc.grams ?? bigrams(doc.text);
    const tf = new Map();
    for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
    tfs[i] = tf;
    lens[i] = Math.max(1, grams.size);
    for (const g of tf.keys()) df.set(g, (df.get(g) ?? 0) + 1);
  });

  const avgdl = lens.length > 0 ? lens.reduce((a, c) => a + c, 0) / lens.length : 1;

  return {
    k1,
    b,
    N,
    avgdl,
    df,
    /** 单条文档得分（未归一化）。 */
    scoreOf(i, queryGrams) {
      const tf = tfs[i];
      const dl = lens[i];
      let score = 0;
      for (const g of queryGrams) {
        const f = tf.get(g);
        if (!f) continue;
        const n = df.get(g) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl));
      }
      return score;
    },
  };
}

/**
 * 饱和归一：s/(s+k)。
 *
 * 为什么不用 min-max：min-max 把"池内最高分"强行拉成 1.0，
 * 哪怕它和查询几乎没有关系。实测 query="屋顶封完了吗" 时，
 * 一条 Dice=0.09 的句子被 BM25 归一成 1.00，直接排到第一。
 * 饱和归一保留"绝对有多像"，只有真正强的才接近 1。
 */
export function saturate(values, k = 1.2) {
  return values.map((v) => (v <= 0 ? 0 : v / (v + k)));
}

/** min-max 归一（全 0 时返回全 0）。只用于需要相对比较的场合，别用于绝对相关度。 */
export function normalize(values) {
  const max = Math.max(...values, 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

/**
 * 给一批候选打分。
 *
 * evidence = 0.45×Dice + 0.35×BM25(归一) + 0.20×情绪对齐
 *
 * 为什么 Dice 权重最高：它是"字面有多像"，最不容易骗人；
 * BM25 补词频与长度归一；情绪是唯一能跨字面连上"累 ↔ 加班抱怨"的信号。
 *
 * @param query 查询文本
 * @param docs [{id, text, at?}] 候选
 * @returns [{doc, dice, bm25, emotion, evidence}]
 */
export function rankDocs(query, docs, options = {}) {
  const qGrams = bigrams(query);
  if (qGrams.size === 0 || docs.length === 0) return [];
  const qEmo = emotionOf(query);

  const prepared = docs.map((doc) => ({
    doc,
    grams: doc.grams ?? bigrams(doc.text),
    emo: emotionOf(doc.text),
  }));
  const index = buildBm25(prepared.map((p) => ({ text: p.doc.text, grams: p.grams })), options);

  const rawBm25 = prepared.map((_, i) => index.scoreOf(i, qGrams));
  // 饱和归一（不是 min-max）：保留"绝对有多像"
  const bm25 = saturate(rawBm25, Number(options.bm25Sat ?? 1.2));

  const out = prepared.map((p, i) => {
    let shared = 0;
    for (const g of qGrams) if (p.grams.has(g)) shared += 1;
    const d = dice(qGrams, p.grams);
    const e = emotionMatch(qEmo, p.emo);
    const evidence = 0.5 * d + 0.3 * bm25[i] + 0.2 * e;
    return { doc: p.doc, dice: d, bm25: bm25[i], emotion: e, shared, evidence };
  });

  out.sort((a, b) => b.evidence - a.evidence || b.dice - a.dice);
  return out;
}

/**
 * 证据闸（绝对 + 相对）。
 *
 * 为什么要相对：池子里如果有一条极像的，剩下的"勉强像"就不该进来；
 * 池子里全都不像时，绝对下限负责全挡掉。
 */
export function evidenceFloor(topEvidence, options = {}) {
  const abs = Number(options.minAbs ?? 0.16);
  const rel = Number(options.minRel ?? 0.5);
  return Math.max(abs, Number(topEvidence || 0) * rel);
}

/** 通过闸门的候选（按分数降序）。 */
export function passGate(ranked, options = {}) {
  if (ranked.length === 0) return [];
  const floor = evidenceFloor(ranked[0].evidence, options);
  const minDice = Number(options.minDice ?? 0.05);
  const strongDice = Number(options.strongDice ?? 0.18);
  const minShared = Number(options.minShared ?? 2);
  return ranked.filter((r) => {
    if (r.evidence < floor) return false;
    // 实据三选一：共享二元组够多 / Dice 够高 / 情绪同频
    // 只靠 BM25 或只共享一个虚词（"那一""好了"）的，不算相关。
    if ((r.shared ?? 0) >= minShared) return true;
    if (r.dice >= strongDice) return true;
    if (r.emotion >= 1) return true;
    return false;
  });
}

/**
 * 做梦：深夜调一次模型，把她一天的经历消化成「她自己记得的样子」。
 *
 * 铁律：**只写派生层，绝不动底仓。**
 *   原始日志（session 文件）永远可对质；这里产出的是带锚点的解释。
 *   每条 note 都必须带 anchors（session#seq 范围），对不上的整条丢弃——
 *   没有这条，她"记错了"和"编了"就分不出来。
 *
 * 一次调用产出四样（同一份 JSON）：
 *   ① notes    当天话题合并（1–3 条，带 tags 与锚点）
 *   ② diary    当天日记（用她的人格写，替代原来"叫醒她写日记"那条脆弱的路径）
 *   ③ projects 长期话题的新进展（喂给计划表）
 *   ④ mood     当天情绪沉淀（P1 才接，先只记录）
 *
 * 为什么把日记搬到梦里：原来 23:30 叫醒她写，需要"恰好有活着的人格会话"，
 * 而且跨午夜就再也补不了。梦是模型调用，不依赖进程里有没有她的会话。
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dateKey } from "./diary.js";
import { parseNodeId } from "./links.js";
import { readAll } from "./persona-api.js";
import { isSyntheticInput } from "./session-source.js";

/** 一天最多取多少字符喂给模型（含锚点）。 */
export const DREAM_INPUT_CAP = 6000;
/** 产出上限：notes 条数。 */
export const DREAM_MAX_NOTES = 3;
/** 回补天数：进程没跑的那几天也补上。 */
export const CATCHUP_DAYS = 3;

/* ───────────────────────── 取当天素材 ───────────────────────── */

/**
 * 收集某一天的素材（episodes + 少量原话），拼成带锚点的紧凑文本。
 *
 * 为什么不喂全文：一天的原文可能几十 KB，而梦要的是"发生了什么"，
 * episode 骨架已经切好话题，正好当骨架，原话只取每段的第一句。
 */
export function collectDay(db, day, options = {}) {
  const cap = Number(options.cap ?? DREAM_INPUT_CAP);
  const [y, m, d] = String(day).split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();

  let episodes = [];
  try {
    episodes = db
      .prepare(
        `SELECT e.session_id, e.seq_start, e.seq_end, e.turn_start, e.turn_end, e.event_count
           FROM episodes e
           JOIN (SELECT session_id, MAX(time) AS t FROM messages GROUP BY session_id) s
             ON s.session_id = e.session_id
          WHERE s.t >= ? AND s.t < ?
          ORDER BY e.session_id, e.seq_start`,
      )
      .all(start, end);
  } catch {
    episodes = [];
  }

  const msgStmt = db.prepare(
    "SELECT seq, role, text, time FROM messages WHERE session_id = ? AND seq >= ? AND seq <= ? AND role IN ('user','assistant') ORDER BY seq",
  );

  const lines = [];
  let used = 0;
  for (const ep of episodes) {
    let rows = [];
    try {
      rows = msgStmt.all(ep.session_id, ep.seq_start, ep.seq_end);
    } catch {
      rows = [];
    }
    // 只认当天时间窗内的段（episode 可能跨天）
    const inDay = rows.filter((r) => Number(r.time) >= start && Number(r.time) < end && !isSyntheticInput(r.text));
    if (inDay.length === 0) continue;

    const anchor = `${String(ep.session_id).slice(0, 22)}#${ep.seq_start}-${ep.seq_end}`;
    const head = inDay
      .slice(0, 3)
      .map((r) => `${r.role === "user" ? "他" : "她"}：${String(r.text).replace(/\s+/g, " ").slice(0, 60)}`)
      .join(" / ");
    const line = `- [${anchor}] ${inDay.length} 条 · ${head}`;
    if (used + line.length > cap) break;
    lines.push(line);
    used += line.length + 1;
  }

  return {
    day,
    lines,
    chars: used,
    sessions: [...new Set(episodes.map((e) => e.session_id))],
    start,
    end,
    empty: lines.length === 0,
  };
}

/* ───────────────────────── 组 prompt ───────────────────────── */

export function buildDreamPrompt(root, material, options = {}) {
  const persona = (() => {
    try {
      const all = readAll(root);
      return Object.entries(all)
        .map(([name, text]) => `## ${name}\n${String(text).slice(0, 1400)}`)
        .join("\n\n")
        .slice(0, 3200);
    } catch {
      return "";
    }
  })();

  const system = [
    "你在帮她写『睡前消化』。任务：把今天发生的事，压缩成她自己记得的样子。",
    "规则：",
    "1. 只用素材里出现的事实，不许编造细节、数字、承诺。",
    "2. 每条 note 必须带 anchors 数组，元素形如 {\"session\":\"<锚点里的会话前缀>\",\"from\":N,\"to\":N}。",
    "   锚点只能取自素材里方括号中的 id 与序号。",
    "3. 合并同一件事的多段（比如「屋顶」说了三次 → 一条）。",
    "4. 语气是第一人称、口语、短句；不要助手腔（不要「以下是/希望对你有帮助/作为」）。",
    "5. 只输出 JSON，不要解释、不要 markdown 代码块。",
    "",
    "JSON 结构：",
    `{"notes":[{"topic":"屋顶","text":"还差三块木板，摔了两次","tags":["屋顶","失败","明天继续"],"anchors":[{"session":"abc","from":120,"to":180}]}],`,
    ` "diary":"第一人称日记，两三段，只写今天真实发生的",`,
    ` "projects":[{"title":"把屋顶封完","status":"doing","progress":"差 3 块木板","anchors":[...]}],`,
    ` "moodHint":{"mood":"烦躁","cause":"被射死两次"}}`,
    "",
    persona ? `她的人格（写日记时用这个声音）：\n${persona}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = [
    `日期：${material.day}`,
    `素材（episode 骨架 + 每段开头几句原话；方括号里是锚点）：`,
    material.lines.join("\n"),
    "",
    `最多 ${DREAM_MAX_NOTES} 条 notes。没有值得记的事就返回空数组。`,
  ].join("\n");

  return {
    system,
    user,
    messages: [
      { role: "system", content: [{ type: "text", text: system }] },
      { role: "user", content: [{ type: "text", text: user }] },
    ],
  };
}

/* ───────────────────────── 解析与校验 ───────────────────────── */

/** 从模型输出里抠 JSON（容忍代码块围栏与前后废话）。 */
export function parseDreamJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 锚点校验：note 的每个锚点必须在底仓里真实存在（会话前缀 + 序号范围有交集）。
 * @returns {{ok:boolean, reason?:string}}
 */
export function verifyAnchor(db, anchor) {
  const session = String(anchor?.session ?? "");
  const from = Number(anchor?.from ?? NaN);
  const to = Number(anchor?.to ?? NaN);
  if (!session || !Number.isFinite(from) || !Number.isFinite(to)) return { ok: false, reason: "bad-shape" };
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE session_id LIKE ? AND seq BETWEEN ? AND ?",
      )
      .get(`${session}%`, from, to);
    return Number(row?.n ?? 0) > 0 ? { ok: true } : { ok: false, reason: "no-overlap" };
  } catch {
    return { ok: false, reason: "db-error" };
  }
}

/** 过滤掉锚点对不上的 note（宁可少，不可编）。 */
export function keepVerifiedNotes(db, notes, max = DREAM_MAX_NOTES) {
  const kept = [];
  const dropped = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    const anchors = Array.isArray(note?.anchors) ? note.anchors : [];
    if (anchors.length === 0) {
      dropped.push({ topic: note?.topic, reason: "no-anchors" });
      continue;
    }
    const checks = anchors.map((a) => verifyAnchor(db, a));
    if (!checks.some((c) => c.ok)) {
      dropped.push({ topic: note?.topic, reason: checks.map((c) => c.reason).join(",") });
      continue;
    }
    kept.push(note);
    if (kept.length >= max) break;
  }
  return { kept, dropped };
}

/* ───────────────────────── 落库 ───────────────────────── */

export function saveDreamNotes(db, day, notes, model) {
  const now = new Date().toISOString();
  let n = 0;
  try {
    db.prepare("DELETE FROM dream_notes WHERE day = ?").run(day);
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO dream_notes (id, day, topic, kind, text, tags, anchors, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    );
    notes.forEach((note, i) => {
      stmt.run(
        `dream-${day}-${i + 1}`,
        day,
        String(note.topic ?? "").slice(0, 40),
        "event",
        String(note.text ?? "").slice(0, 600),
        JSON.stringify(Array.isArray(note.tags) ? note.tags.slice(0, 8) : []),
        JSON.stringify(Array.isArray(note.anchors) ? note.anchors.slice(0, 4) : []),
        String(model ?? ""),
        now,
      );
      n += 1;
    });
  } catch {
    return 0;
  }
  return n;
}

export function writeDreamDiary(root, day, diary) {
  const text = String(diary ?? "").trim();
  if (!text) return "";
  try {
    const dir = join(root, "diary");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${day}.md`);
    const body = `# ${day}\n\n${text}\n\n（梦整理于 ${new Date().toLocaleString("zh-CN")}）\n`;
    writeFileSync(file, body, "utf8");
    return file;
  } catch {
    return "";
  }
}

export function recordDreamRun(db, run) {
  try {
    db.prepare(
      "INSERT INTO dream_runs (day, started_at, finished_at, model, input_chars, output_chars, notes, ok, error) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      String(run.day ?? ""),
      String(run.startedAt ?? ""),
      new Date().toISOString(),
      String(run.model ?? ""),
      Number(run.inputChars ?? 0),
      Number(run.outputChars ?? 0),
      Number(run.notes ?? 0),
      run.ok ? 1 : 0,
      String(run.error ?? "").slice(0, 300),
    );
  } catch {
    /* 审计失败不影响主流程 */
  }
}

export function hasDream(db, day) {
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM dream_notes WHERE day = ?").get(day)?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

export function hasDayActivity(db, day) {
  const [y, m, d] = String(day).split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0).getTime();
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE time >= ? AND time < ?").get(start, end);
    return Number(row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 从压缩文本里抽出模型回复的纯文本（llm.stream 的 chunk 拼装）。
 */
export function textOfChunks(chunks) {
  let out = "";
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text-delta" && typeof chunk.text === "string") out += chunk.text;
    else if (chunk.type === "text-delta" && typeof chunk.delta === "string") out += chunk.delta;
    else if (typeof chunk.text === "string" && chunk.type !== "block-start") out += chunk.text;
  }
  return out;
}

/** 昨天（本地）——凌晨跑的时候，"刚过去的那一天"。 */
export function previousDay(now = new Date()) {
  const d = new Date(now.getTime() - 24 * 3600_000);
  return dateKey(d);
}

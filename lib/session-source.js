/**
 * 底仓读取层：把 DSH 的会话日志（`session.v4.jsonl.zstd`）读成事件流。
 *
 * 两条硬事实（都实测过）：
 *   1. 日志是**多帧追加**的 zstd（一个会话文件里 2000+ 个 frame），
 *      `zlib.zstdDecompressSync` 只解第一帧 —— 必须按 magic 逐帧解。
 *   2. 帧是**只追加**的，所以 (offset, length) 对同一帧永远有效 ——
 *      可以给每个事件记「它来自第几帧」，下钻时只解那一帧（几 KB），
 *      而不是把整个 13 MB 重解一遍。
 *
 * 本模块不复制原文：真源永远是 DSH 的日志，这里只产索引与骨架。
 */

import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 递归找出会话日志文件。 */

/**
 * 只解会话文件的**尾部若干帧**：用于"当前用户说了什么"这种只关心最新状态的场景。
 * 不整文件解码（大会话十几 MB，不能每轮都解）。
 *
 * @param file 会话文件
 * @param options.maxBytes 最多读尾部多少字节（默认 512KB）
 * @param options.maxFrames 最多解几帧（默认 40，从新往旧）
 * @returns 事件数组（新的在前）
 */
export function readTailEvents(file, options = {}) {
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const maxFrames = options.maxFrames ?? 40;
  let buf;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const fd = openSync(file, "r");
    try {
      buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }

  const starts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i);
  }
  if (starts.length === 0) return [];

  const events = [];
  let decoded = 0;
  for (let k = starts.length - 1; k >= 0 && decoded < maxFrames; k--) {
    const s = starts[k];
    const e = k + 1 < starts.length ? starts[k + 1] : buf.length;
    const [frame] = decodeFrames(buf.subarray(0, e), s);
    decoded += 1;
    if (!frame) continue;
    // 帧内新的在前
    for (let i = frame.events.length - 1; i >= 0; i--) events.push(frame.events[i]);
  }
  return events;
}

/** 找某个 sessionId 的会话文件（在若干根目录下扫）。 */
export function findSessionFile(roots, sessionId) {
  const want = String(sessionId ?? "");
  if (!want) return "";
  for (const file of findSessionFiles(roots)) {
    if (file.includes(want) || sessionIdOf(file) === want) return file;
  }
  return "";
}

/** 最新的用户输入文本（找不到返回空串）。 */
const SYNTHETIC_PREFIXES = [
  // 我们自己注入的
  "【MC 公屏",
  "【MC 身体自己动了",
  "【你不在的时候",
  "【来自会话",
  // DSH 自己注入的（它们也是 user/message，而且排在真人提问之后）
  "Current runtime context",
  "<system-reminder>",
  "This snapshot supersedes",
];

/**
 * 是不是"不是真人当场说的话"。
 * 实测教训：只过滤我们自己的信封不够——DSH 的 runtime-context / system-reminder
 * 也是 user/message 且排在提问之后，取"最后一条"会拿到技能目录那种基础设施文本。
 */
export function isSyntheticInput(text) {
  const s = String(text ?? "").trimStart();
  return SYNTHETIC_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * 最新的**真人**输入文本；找不到真人输入再退回最后一条（含合成）。
 * @param options.skipSynthetic 默认 true
 */
export function lastUserText(roots, sessionId, options = {}) {
  const file = findSessionFile(roots, sessionId);
  if (!file) return { text: "", seq: 0, file: "" };
  const events = readTailEvents(file, options);
  const skipSynthetic = options.skipSynthetic !== false;
  let fallback = null;
  for (const ev of events) {
    if (ev.type !== "user/message") continue;
    const text = eventText(ev).trim();
    if (!text) continue;
    const kind = String(ev.data?.source?.kind ?? "");
    // source.kind 明确不是 user（runtime-context / plugin / system）→ 直接跳过
    if (kind && kind !== "user") {
      if (!fallback) fallback = { text, seq: Number(ev.seq ?? 0), file, synthetic: true };
      continue;
    }
    if (!isSyntheticInput(text)) return { text, seq: Number(ev.seq ?? 0), file, synthetic: false };
    if (!fallback) fallback = { text, seq: Number(ev.seq ?? 0), file, synthetic: true };
  }
  return fallback ?? { text: "", seq: 0, file };
}

export function findSessionFiles(roots) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".zstd")) out.push(p);
    }
  };
  for (const root of roots) {
    if (existsSync(root)) walk(root);
  }
  return out;
}

/** 从会话文件路径推断会话 id（目录名 `session-<uuid>`）。 */
export function sessionIdOf(file) {
  const parts = file.split(/[\\/]/);
  const dir = parts[parts.length - 2] || "";
  if (dir.startsWith("session-")) return dir;
  return parts[parts.length - 1].replace(/\.zstd$/, "");
}

/** 工作区名（会话目录的上一级）。 */
export function workspaceOf(file) {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 3] || "";
}

/**
 * 逐帧解压 → 每个 frame 的 offsets 与解析后的事件。
 * @param {Buffer} buf 完整文件字节
 * @param {number} fromOffset 只处理该偏移之后的帧（增量摄取用）
 */
export function decodeFrames(buf, fromOffset = 0) {
  const starts = [];
  for (let i = fromOffset; i <= buf.length - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i);
    }
  }
  const frames = [];
  for (let k = 0; k < starts.length; k++) {
    const offset = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(offset, end)).toString("utf8");
    } catch {
      continue; // 半截帧（正在写入）或非帧数据：跳过，下次增量再解
    }
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && typeof ev === "object") events.push(ev);
      } catch {
        /* 坏行丢弃 */
      }
    }
    frames.push({ index: frames.length, offset, length: end - offset, events });
  }
  return frames;
}

/**
 * 只读「新追加的那一段帧」。
 *
 * 为什么需要：整篇解码一个 10 MB 的会话要 600 ms，一个库 51 个会话就是 2 秒——
 * 这就是底仓要"懒摄取"的原因。但帧是只追加的，所以从上次的 offset 往后读，
 * 增量只要读几 KB、解一两个帧（实测 15 ms）。
 *
 * @param fromOffset 上次已摄取到的字节位置（通常是 上一帧 offset + length）
 * @returns {{frames: Array, size: number, from: number, truncated: boolean}}
 */
export function readSessionDelta(file, fromOffset = 0) {
  const size = statSync(file).size;
  const from = Math.max(0, Number(fromOffset) || 0);
  if (from >= size) return { frames: [], size, from, truncated: false };

  const fd = openSync(file, "r");
  try {
    const len = size - from;
    const buf = Buffer.alloc(len);
    const read = readSync(fd, buf, 0, len, from);
    const slice = read === len ? buf : buf.subarray(0, read);
    const frames = decodeFrames(slice, 0).map((f) => ({
      ...f,
      offset: from + f.offset,
    }));
    return { frames, size, from, truncated: false };
  } finally {
    closeSync(fd);
  }
}

/**
 * 快速判定"这是谁的会话"——只读开头和结尾两小段，不解全文。
 *
 * 为什么需要：`ingestSession` 原来一进来就整篇解码，才去判断"是不是人格会话"。
 * 实测一个 10 MB 会话 600 ms，而 51 个会话里绝大多数是标准/工作/测试会话，
 * 全解一遍 2 秒——这些时间全用在"解完再丢掉"上。
 *
 * 这里只解 frame 0（header）+ 尾部几帧（找最后一个 agent-preset/selected）。
 */
export function probeSession(file) {
  const size = statSync(file).size;
  const fd = openSync(file, "r");
  try {
    // 头：足够装下第一帧（header 很小）
    const headLen = Math.min(size, 64 * 1024);
    const head = Buffer.alloc(headLen);
    readSync(fd, head, 0, headLen, 0);
    const headFrames = decodeFrames(head, 0);
    const header = headFrames.flatMap((f) => f.events).find((e) => e && e.type === "session") || null;

    // 尾：最近 256 KB，找最后一个 preset 选择事件
    const tailLen = Math.min(size, 256 * 1024);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    const tailFrames = decodeFrames(tail, 0);
    const presetSelections = [...headFrames, ...tailFrames]
      .flatMap((f) => f.events)
      .filter((e) => e && e.type === "agent-preset/selected" && e.data)
      .sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));

    const preset =
      presetSelections.length > 0
        ? String(presetSelections[presetSelections.length - 1].data.agentPreset || "")
        : String(header?.agentPreset || "");
    return { size, header, preset, lastPreset: preset };
  } finally {
    closeSync(fd);
  }
}

/** 取消息正文（content 里 type==="text" 的块拼接）。 */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
    .trim();
}

/** 一个事件的正文（user/message 本体 vs assistant/message.data.message）。 */
export function eventText(ev) {
  if (!ev || typeof ev !== "object") return "";
  if (ev.type === "user/message") return textOf(ev.data?.content);
  if (ev.type === "assistant/message") return textOf(ev.data?.message?.content);
  if (ev.type === "tool/result") return textOf(ev.data?.message?.content);
  if (ev.type === "compaction/summary") return textOf(ev.data?.summary);
  return "";
}

/**
 * 把一个原始事件压成索引行（不存正文，正文按锚点回读）。
 * @returns {{seq:number,type:string,time:number,turn:number|null,chars:number,error:number}|null}
 */
export function toIndexRow(ev) {
  if (!ev || typeof ev.seq !== "number") return null; // session 头事件没有 seq，不能当锚点
  const type = String(ev.type || "");
  const data = ev.data || {};
  const turn = typeof data.turn === "number" ? data.turn : null;
  const chars = eventText(ev).length;
  const isError = Boolean(data.message?.isError || data.error) ? 1 : 0;
  return { seq: ev.seq, type, time: Number(ev.time || 0), turn, chars, error: isError };
}

/** 读整个文件并解帧（一次性，供小文件/测试用）。 */
export function readSessionFile(file) {
  const buf = readFileSync(file);
  const frames = decodeFrames(buf, 0);
  const header = frames.flatMap((f) => f.events).find((e) => e.type === "session");
  return { file, bytes: buf.length, mtimeMs: statSync(file).mtimeMs, frames, header };
}

/**
 * 判定一个会话是"谁的"。
 *
 * 为什么不能只看 header：`session` 头里的 `agentPreset` 是会话**创建时**的值
 * （通常是 standard），用户可以在会话里切到人格 preset。真正的切换证据是
 * `agent-preset/selected` 事件。所以：以最后一个 `agent-preset/selected` 为准，
 * 没有该事件时回退到 header。
 *
 * @returns {{preset:string, switched:boolean, seqs:number[]}}
 */
export function detectPreset(events, header) {
  const switches = events.filter((e) => e && e.type === "agent-preset/selected" && e.data);
  const seqs = switches.map((e) => e.seq).filter((s) => typeof s === "number");
  if (switches.length > 0) {
    const last = switches[switches.length - 1];
    return { preset: String(last.data.agentPreset || ""), switched: true, seqs };
  }
  return { preset: String(header?.agentPreset || ""), switched: false, seqs: [] };
}

/**
 * 逐事件判定"这段内容属于哪个 preset"——会话中途切换时，
 * 切换之前的轮次仍属于旧的 preset。返回 {seq: preset} 的分界点。
 */
export function presetTimeline(events, header) {
  const points = [{ seq: -1, preset: String(header?.agentPreset || "") }];
  for (const ev of events) {
    if (ev && ev.type === "agent-preset/selected" && ev.data && typeof ev.seq === "number") {
      points.push({ seq: ev.seq, preset: String(ev.data.agentPreset || "") });
    }
  }
  return points;
}

/** 某个 seq 当时生效的 preset。 */
export function presetAt(timeline, seq) {
  let current = "";
  for (const point of timeline) {
    if (point.seq <= seq) current = point.preset;
    else break;
  }
  return current;
}

/**
 * 心情：慢变量，半天到几天。
 *
 * 和「处境」（lib/presence.js 的睡/专注）不是一个东西：
 *   处境 = 现在几点、困不困（分钟级，算出来）
 *   心情 = 这几天什么颜色（半天级，存下来）
 *
 * P0 只做骨架：文件 + 六种行为表 + 注入 + 衰减 + 主人显式指定。
 * 不接事件（P1）、不给自述工具（P2）——先验证"语气真的变了吗"。
 *
 * 三条护栏（不写死就会被滥用）：
 *   ① 心情不改变事实：记忆/事实仍以底仓为准，不许说"我当时心情不好所以记错了"
 *   ② 心情不是拒绝的理由：可以语气冲，不能因此不干活（跟 MC 的合法罢工是两回事）
 *   ③ 不许把系统故障算成情绪来源（"你让我报错了"这种）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MOOD_FILE = "mood.json";
/** 向「平静」回落一档的时间。 */
export const DECAY_HOURS = 8;
/** transitions 环形缓冲长度。 */
const TRACE_MAX = 20;

/**
 * 六种心情，每种都必须是**可观测的行为差异**。
 * 只写形容词没用——模型会照着形容词演一段独白，实际行为不变。
 */
export const MOODS = {
  平静: {
    behavior: "正常说话，不用刻意加戏。",
    intensityHint: "",
  },
  开心: {
    behavior: "话多一点，会主动提细节、会开玩笑。",
    intensityHint: "藏不住的得意可以露出来一点。",
  },
  兴奋: {
    behavior: "句子更碎、感叹更多，容易抢话。",
    intensityHint: "别写长段，一顿一顿地说。",
  },
  低落: {
    behavior: "句子短，不主动起话头；问了才答，答完就停。",
    intensityHint: "不要主动说\"我心情不好\"——让它从字数里透出来。",
  },
  烦躁: {
    behavior: "更短、更容易呛人；但**正事照办**，不许拿心情当借口不干活。",
    intensityHint: "可以顶一句，但别连着顶。",
  },
  疲惫: {
    behavior: "半句话，不想解释。能一个字说完就一个字。",
    intensityHint: "别展开，别列东西。",
  },
};

export function moodPath(root) {
  return join(root, MOOD_FILE);
}

function emptyMood() {
  return {
    version: 1,
    mood: "平静",
    intensity: 1,
    cause: "",
    causeKind: "",
    source: "",
    since: new Date().toISOString(),
    transitions: [],
  };
}

export function readMood(root) {
  const p = moodPath(root);
  if (!existsSync(p)) return emptyMood();
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (!data || typeof data !== "object") return emptyMood();
    return { ...emptyMood(), ...data, transitions: Array.isArray(data.transitions) ? data.transitions : [] };
  } catch {
    return emptyMood();
  }
}

function writeMood(root, state) {
  mkdirSync(root, { recursive: true });
  writeFileSync(moodPath(root), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return state;
}

function trace(state, entry) {
  state.transitions.push(entry);
  while (state.transitions.length > TRACE_MAX) state.transitions.shift();
}

/**
 * 设一个心情。
 * @param params.mood 六种之一
 * @param params.intensity 1..3
 * @param params.cause 为什么（一句话）
 * @param params.causeKind 归因键，如 owner / event:mc:death / project:roof
 */
export function setMood(root, params = {}) {
  const mood = String(params.mood ?? "").trim();
  if (!MOODS[mood]) {
    throw new Error(`没有这种心情：${mood}（可选：${Object.keys(MOODS).join(" / ")}）`);
  }
  const cause = String(params.cause ?? "").trim();
  if (!cause) throw new Error("为什么会有这个心情？给一句话（原因比心情本身重要）");

  const prev = readMood(root);
  const intensity = Math.max(1, Math.min(3, Number(params.intensity ?? 2)));
  const state = {
    ...prev,
    mood,
    intensity,
    cause: cause.slice(0, 120),
    causeKind: String(params.causeKind ?? "").slice(0, 60),
    source: String(params.source ?? "owner").slice(0, 20),
    since: new Date().toISOString(),
  };
  trace(state, {
    at: state.since,
    from: `${prev.mood}${prev.intensity}`,
    to: `${mood}${intensity}`,
    cause: state.cause,
    source: state.source,
  });
  return writeMood(root, state);
}

/**
 * 衰减：没有新事件时每 8 小时向「平静」回落一档。
 *
 * 不衰减的话，一次被炸会记仇三天。
 * @returns {{state, steps:number}}
 */
export function decayMood(root, options = {}) {
  const hours = Number(options.hours ?? DECAY_HOURS);
  const now = Date.parse(options.now ?? new Date().toISOString());
  const state = readMood(root);
  const since = Date.parse(state.since || "");
  if (!Number.isFinite(since) || !Number.isFinite(now)) return { state, steps: 0 };

  const elapsedHours = (now - since) / 3600_000;
  const steps = Math.floor(elapsedHours / hours);
  if (steps <= 0) return { state, steps: 0 };

  let intensity = Number(state.intensity || 1) - steps;
  let mood = state.mood;
  if (intensity <= 0) {
    intensity = 1;
    mood = "平静";
  }
  if (mood === state.mood && intensity === state.intensity) return { state, steps: 0 };

  const next = {
    ...state,
    mood,
    intensity,
    cause: mood === "平静" ? "" : state.cause,
    causeKind: mood === "平静" ? "" : state.causeKind,
    since: new Date(now).toISOString(),
  };
  trace(next, {
    at: next.since,
    from: `${state.mood}${state.intensity}`,
    to: `${mood}${intensity}`,
    cause: `decay ${steps}×${hours}h`,
    source: "decay",
  });
  writeMood(root, next);
  return { state: next, steps };
}

/**
 * 注入用的一两行。
 *
 * 平静时**一个字都不注入**——不能每轮都提醒她"你现在很平静"，
 * 那是噪音，也会让她开始表演情绪。
 */
export function renderMoodBlock(root, options = {}) {
  const budget = Number(options.budget ?? 130);
  const { state } = decayMood(root, options);
  if (state.mood === "平静" && Number(state.intensity) <= 1) return "";

  const spec = MOODS[state.mood] ?? MOODS.平静;
  const level = Number(state.intensity) >= 3 ? "很" : Number(state.intensity) === 2 ? "有点" : "";
  const lines = [
    `你现在的情绪：${level}${state.mood}${state.cause ? `（${state.cause}）` : ""}。${spec.behavior}`,
    "心情只影响语气，不改事实、也不是不干活的借口。",
  ];
  let text = lines.join("\n");
  if (text.length > budget) text = lines[0].slice(0, budget);
  return text;
}

/** 给自己看/给面板看的摘要。 */
export function moodSummary(root) {
  const { state } = decayMood(root);
  return {
    mood: state.mood,
    intensity: Number(state.intensity || 1),
    cause: state.cause,
    since: state.since,
    transitions: state.transitions.slice(-5),
  };
}

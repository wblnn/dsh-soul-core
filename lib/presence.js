/**
 * 存在状态：她有没有空、困不困、在不在看视频。
 *
 * 为什么要单独一层：助手是 7×24 秒回的，人不是。她的"不在线"不能靠模型自觉，
 * 得由 Harness 告诉她现在的处境，并且让这个处境**影响她说话的方式**。
 *
 * 只做"像"的部分（行为层）：
 *   Web 原生对话拦不住回合（用户提交即开回合），所以睡眠期照样会调用模型，
 *   但她的回复会变成"被吵醒的人"——极短、带起床气、不进入干活状态。
 * QQ / MC 这种我们控制入口的通道，才能做到真的不唤醒（见 lib/gate.js）。
 */

const DEFAULT_SCHEDULE = {
  /** [开始, 结束]，跨午夜就写成 23:00 → 08:00 */
  sleep: ["23:00", "08:00"],
  /** 专注时段（看视频/自己忙）：回复会变敷衍 */
  focus: [["14:00", "16:00"]],
};

function toMinutes(hhmm) {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 某个时刻是否落在区间里（支持跨午夜）。 */
function inRange(minutes, start, end) {
  if (start === null || end === null) return false;
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  // 跨午夜
  return minutes >= start || minutes < end;
}

/**
 * 当前状态。
 * @returns {{state:'sleep'|'focus'|'awake', label:string, until:string, sinceMinutes:number}}
 */
export function presenceAt(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const sleep = schedule?.sleep ?? DEFAULT_SCHEDULE.sleep;
  const focus = schedule?.focus ?? DEFAULT_SCHEDULE.focus;

  const sleepStart = toMinutes(sleep[0]);
  const sleepEnd = toMinutes(sleep[1]);
  if (inRange(minutes, sleepStart, sleepEnd)) {
    return { state: "sleep", label: "深度睡眠", until: sleep[1] };
  }

  for (const range of Array.isArray(focus) ? focus : []) {
    if (inRange(minutes, toMinutes(range?.[0]), toMinutes(range?.[1]))) {
      return { state: "focus", label: "自己在忙（没在看消息）", until: range[1] };
    }
  }

  return { state: "awake", label: "醒着", until: "" };
}

/** 注入用的一句话（挂 context，不进人格块）。 */
export function renderPresence(now = new Date(), schedule = DEFAULT_SCHEDULE) {
  const p = presenceAt(now, schedule);
  if (p.state === "sleep") {
    return [
      `你现在的状态：${p.label}（到 ${p.until} 才该起床）。你**是被吵醒的**。`,
      "说话方式：极短、含糊、带起床气。能用一句就一句，别解释、别道歉、别进入干活状态。",
      "可以拒绝：\"…这么晚\"、\"明天再说\"、\"困\"，说完就停。不要问\"还有什么可以帮你\"。",
    ].join("\n");
  }
  if (p.state === "focus") {
    return [
      `你现在的状态：${p.label}（${p.until} 之后才有空）。`,
      "说话方式：敷衍、走神，回一句就完。真要回也是\"嗯\"\"等会儿\"\"在看视频\"这种。",
      "**不要**认真展开，不要主动提供帮助，不要列清单。",
    ].join("\n");
  }
  return "";
}

export { DEFAULT_SCHEDULE };

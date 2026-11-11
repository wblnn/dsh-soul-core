/**
 * 日记本：每到点让她写一篇当天的日记。
 *
 * 四条设计约束（来自主人 2026-11-08）：
 *   ① 每天晚上写，但**只在"底仓最后一条记录是今天"时**写——没活动就别编
 *   ② DSH 在跑才写（插件在进程里，所以这条等于"进程活着"）
 *   ③ **不注入上下文**：日记是 `diary/*.md`，不进人格块，不参与预检索
 *   ④ **尽量少提示**：叫她的那句话只有一行；她要看日记得**明确要求**
 *
 * 为什么不塞进 MEMORY.md：日记是"流水账"，每轮注入会把预算吃光；
 * 它的价值是"以后能翻出来对质"，不是"现在就得记得"。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const DIARY_DIR = "diary";

function pad(n) {
  return String(n).padStart(2, "0");
}

/** 本地日期 YYYY-MM-DD（日记按人过的日子算，不按 UTC）。 */
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function diaryPath(root, date = dateKey()) {
  return join(root, DIARY_DIR, `${date}.md`);
}

export function hasDiary(root, date = dateKey()) {
  try {
    return existsSync(diaryPath(root, date)) && readFileSync(diaryPath(root, date), "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/** 写日记（追加；当天已有内容就续写，不覆盖）。 */
export function writeDiary(root, text, options = {}) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("日记内容为空");
  if (body.length > (options.maxChars ?? 4000)) {
    throw new Error(`日记太长：${body.length} > ${options.maxChars} 字。写当天最值得记的一两件事就够。`);
  }
  const date = options.date || dateKey();
  const dir = join(root, DIARY_DIR);
  mkdirSync(dir, { recursive: true });
  const p = diaryPath(root, date);
  const fresh = !existsSync(p);
  const stamp = `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`;
  if (fresh) appendFileSync(p, `# ${date}\n\n`, "utf8");
  appendFileSync(p, `## ${stamp}\n${body}\n\n`, "utf8");
  return { ok: true, file: `${DIARY_DIR}/${date}.md`, date, fresh, chars: body.length };
}

/** 读日记：某天，或最近 N 天。 */
export function readDiary(root, options = {}) {
  const dir = join(root, DIARY_DIR);
  if (!existsSync(dir)) return { entries: [] };
  if (options.date) {
    const p = diaryPath(root, options.date);
    return existsSync(p) ? { entries: [{ date: options.date, text: readFileSync(p, "utf8") }] } : { entries: [] };
  }
  const days = readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .slice(0, options.days ?? 3);
  return {
    entries: days.map((f) => ({ date: f.replace(/\.md$/, ""), text: readFileSync(join(dir, f), "utf8") })),
  };
}

/**
 * 该不该写了。
 *
 * @param params.now 当前时间
 * @param params.at "23:30" 这种时刻
 * @param params.lastActivityMs 底仓最后一条记录的时间（毫秒）
 * @param params.alreadyWritten 今天是否已有日记
 */
export function shouldWriteNow(params = {}) {
  const now = params.now ?? new Date();
  const at = String(params.at || "23:30");
  const m = at.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { write: false, reason: "bad-time" };

  const due = new Date(now);
  due.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (now < due) return { write: false, reason: "too-early" };

  if (params.alreadyWritten) return { write: false, reason: "already-written" };

  const last = Number(params.lastActivityMs || 0);
  if (!last) return { write: false, reason: "no-activity" };
  // 底仓最后一条必须是"今天"（本地日期）
  if (dateKey(new Date(last)) !== dateKey(now)) return { write: false, reason: "last-record-not-today" };

  return { write: true, reason: "due" };
}

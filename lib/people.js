/**
 * 「人」的跨场景身份：同一个你，在 MC 里叫 A、在 QQ 群里叫 B。
 *
 * 这是"不割裂"的关键一环——记忆可以跨场景检索，但如果她不知道 `张三` 和 `QQ昵称`
 * 是同一个人，就会出现"MC 里的张三说过…""群里那个谁说过…"的分裂叙述。
 *
 * 存储：`<人格目录>/people.json`
 * ```json
 * { "阿鱼": { "mc": ["张三"], "qq": ["qq昵称"], "note": "主人" } }
 * ```
 * 权威键是"你怎么称呼自己/她怎么称呼你"的那个人格名；其余都是别名。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function peoplePath(soulRoot) {
  return join(soulRoot, "people.json");
}

export function loadPeople(soulRoot) {
  const path = peoplePath(soulRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function savePeople(soulRoot, data) {
  const path = peoplePath(soulRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return data;
}

/**
 * 把某个场景下的名字挂到同一个"人"上。
 * @param canonical 你自己怎么叫这个人（如"主人"/"阿鱼"）
 * @param alias 那个场景里的名字（MC 玩家名 / QQ 昵称）
 * @param venue mc | qq | chat
 */
export function linkPerson(soulRoot, { canonical, alias, venue = "chat", note } = {}) {
  const name = String(canonical ?? "").trim();
  const a = String(alias ?? "").trim();
  if (!name) throw new Error("canonical 必填（你怎么称呼这个人）");
  if (!a) throw new Error("alias 必填（那个场景里的名字）");
  const v = ["mc", "qq", "chat"].includes(venue) ? venue : "chat";

  const data = loadPeople(soulRoot);
  const entry = data[name] && typeof data[name] === "object" ? data[name] : {};
  const list = Array.isArray(entry[v]) ? entry[v] : [];
  if (!list.includes(a)) list.push(a);
  entry[v] = list;
  if (note) entry.note = String(note).trim();
  data[name] = entry;
  savePeople(soulRoot, data);

  return { ok: true, canonical: name, alias: a, venue: v, aliases: entry };
}

/** 反查：某个场景下的名字属于谁。 */
export function resolvePerson(soulRoot, { name, venue } = {}) {
  const n = String(name ?? "").trim();
  if (!n) return null;
  const data = loadPeople(soulRoot);
  for (const [canonical, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;
    for (const [v, list] of Object.entries(entry)) {
      if (v === "note" || !Array.isArray(list)) continue;
      if (list.includes(n)) return { canonical, venue: v, aliases: entry };
    }
  }
  return null;
}

/** 注入用：把人名对应关系压成一段短文本（没有就返回空串）。 */
export function renderPeopleBrief(soulRoot, { budget = 260 } = {}) {
  const data = loadPeople(soulRoot);
  const lines = [];
  let used = 0;
  const header = "## 人（同一个人在不同地方的名字）";
  for (const [canonical, entry] of Object.entries(data)) {
    if (!entry || typeof entry !== "object") continue;
    const parts = [];
    for (const [v, list] of Object.entries(entry)) {
      if (v === "note" || !Array.isArray(list) || list.length === 0) continue;
      parts.push(`${v === "mc" ? "MC" : v === "qq" ? "QQ" : "对话"}：${list.join("、")}`);
    }
    if (parts.length === 0) continue;
    const line = `- ${canonical}${entry.note ? `（${entry.note}）` : ""} — ${parts.join("｜")}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  return `${header}\n${lines.join("\n")}`;
}

/**
 * 计划表：她自己认下来的事。
 *
 * 为什么需要：
 *   之前所有"心情来源"都是发生在她身上的（被射死、被夸），没有一件事是**她自己要做**的。
 *   没有这张表，她就只是个环境反射弧，也永远没有"我在忙什么"可讲——
 *   开场简报的未完成事项、主动分享的素材，缺的都是同一个对象。
 *
 * 四条设计约束：
 *   ① **不做日程表**：没有优先级、没有逾期提醒、没有完成率。
 *      一变成待办清单，她就退化成助手了。
 *   ② **允许非生产性计划**：看视频、睡午觉、发呆都是合法条目。
 *   ③ **标 done 必须有证据**：否则"我成功了"就能给自己发奖（正反馈飞轮）。
 *   ④ **主动放弃不扣分**：否则她会不敢开新项目。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PLANS_FILE = "plans.json";
/** 活跃条目上限：超了先归档最老的。 */
export const MAX_ACTIVE = 12;
/** 多久没动就自动放弃（僵尸宏图）。 */
export const STALE_DAYS = 7;

const STATUS = new Set(["todo", "doing", "done", "dropped"]);
const ORIGINS = new Set(["self", "owner", "mc-goal"]);

export function plansPath(root) {
  return join(root, PLANS_FILE);
}

function emptyBook() {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
}

export function readBook(root) {
  const p = plansPath(root);
  if (!existsSync(p)) return emptyBook();
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    if (!data || !Array.isArray(data.items)) return emptyBook();
    return data;
  } catch {
    return emptyBook();
  }
}

function writeBook(root, book) {
  mkdirSync(root, { recursive: true });
  book.updatedAt = new Date().toISOString();
  writeFileSync(plansPath(root), `${JSON.stringify(book, null, 2)}\n`, "utf8");
  return book;
}

function slugOf(title, taken) {
  const base =
    String(title)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 18) || "plan";
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}-${n++}`;
  return id;
}

const active = (item) => item.status === "todo" || item.status === "doing";

/** 活跃条目；按"最近动过"排。 */
export function listPlans(root, options = {}) {
  const book = readBook(root);
  const want = options.status ? new Set(String(options.status).split(",")) : null;
  let items = book.items.filter((it) => (want ? want.has(it.status) : true));
  if (options.activeOnly) items = items.filter(active);
  items = [...items].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return options.limit ? items.slice(0, options.limit) : items;
}

/**
 * 加一条计划。
 * @param params.title 计划名（必须具体、可验证）
 * @param params.origin self | owner | mc-goal
 */
export function addPlan(root, params = {}) {
  const title = String(params.title ?? "").trim();
  if (!title) throw new Error("计划得有名字");
  if (title.length > 60) throw new Error("计划名太长（≤60 字）——要么拆开，要么说具体点");
  const origin = ORIGINS.has(params.origin) ? params.origin : "self";

  const book = readBook(root);
  // 同名活跃条目直接返回，避免重复登记
  const dup = book.items.find((it) => active(it) && it.title === title);
  if (dup) return { ok: true, item: dup, duplicate: true };

  const taken = new Set(book.items.map((it) => it.id));
  // 同一毫秒内连加多条时 updatedAt 会撞在一起，排序不稳（测试抓到过）→ 时间戳单调递增
  let stamp = Date.now();
  for (const it of book.items) {
    const parsed = Date.parse(it.updatedAt || it.createdAt || "");
    if (Number.isFinite(parsed) && parsed >= stamp) stamp = parsed + 1; // monotonic
  }
  const now = new Date(stamp).toISOString();
  const item = {
    id: slugOf(title, taken),
    title,
    origin,
    status: "todo",
    attempts: 0,
    lastOutcome: "",
    evidence: "",
    note: String(params.note ?? "").slice(0, 200),
    createdAt: now,
    updatedAt: now,
  };
  book.items.push(item);

  // 上限：先把最老的活跃条目归档成 dropped（不是删除，留痕）
  const actives = book.items.filter(active).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  while (actives.length > MAX_ACTIVE) {
    const old = actives.shift();
    old.status = "dropped";
    old.note = `${old.note ? `${old.note} ` : ""}（太久没动，自动归档）`;
    old.updatedAt = now;
  }

  writeBook(root, book);
  return { ok: true, item };
}

/**
 * 更新一条计划。
 *
 * @param params.id 计划 id
 * @param params.status todo|doing|done|dropped
 * @param params.evidence 标 done 时必须给（坐标/物品/事件锚点）
 * @param params.outcome fail 时记一次失败
 */
export function updatePlan(root, params = {}) {
  const book = readBook(root);
  const id = String(params.id ?? "").trim();
  const item = book.items.find((it) => it.id === id || it.title === id);
  if (!item) throw new Error(`没有这条计划：${id}（先 plan { action: "list" }）`);

  const now = new Date().toISOString();
  const next = params.status ? String(params.status) : "";

  if (next === "done") {
    const evidence = String(params.evidence ?? "").trim();
    if (!evidence) {
      throw new Error(
        "标「完成」要有证据（坐标/物品/事件锚点，如 \"MC goal-done 且 (101,104,19) 到达\"）。没有证据就先留着 doing——不许自己给自己发奖。",
      );
    }
    item.evidence = evidence.slice(0, 200);
    item.status = "done";
    item.lastOutcome = "ok";
  } else if (next === "dropped") {
    item.status = "dropped";
    item.note = String(params.note ?? item.note ?? "").slice(0, 200);
  } else if (next === "doing" || next === "todo") {
    item.status = next;
  } else if (next === "fail") {
    item.attempts = Number(item.attempts || 0) + 1;
    item.lastOutcome = "fail";
    item.status = "doing";
  } else if (params.note) {
    item.note = String(params.note).slice(0, 200);
  }

  if (next === "done") item.attempts = Math.max(1, Number(item.attempts || 0));
  item.updatedAt = now;
  writeBook(root, book);
  return { ok: true, item };
}

/** 太久没动的活跃条目自动放弃（返回被放弃的条目）。 */
export function autoDropStale(root, options = {}) {
  const days = Number(options.days ?? STALE_DAYS);
  const now = Date.now();
  // 先补一遍僵尸归档，再读
  const book = readBook(root);
  const dropped = [];
  for (const it of book.items) {
    if (!active(it)) continue;
    const t = Date.parse(it.updatedAt || it.createdAt || "");
    if (!Number.isFinite(t)) continue;
    if (now - t >= days * 86400_000) {
      it.status = "dropped";
      it.note = `${it.note ? `${it.note} ` : ""}（${days} 天没动，自动归档）`;
      it.updatedAt = new Date().toISOString();
      dropped.push(it);
    }
  }
  if (dropped.length > 0) writeBook(root, book);
  return dropped;
}

/**
 * 注入用的三行。
 *
 * 为什么不整张表：全给就是待办清单，她会围着清单写汇报。
 * 给 3 行才是"心里记着几件事"。
 */
export function renderPlansBlock(root, options = {}) {
  const budget = Number(options.budget ?? 140);
  const limit = Number(options.limit ?? 3);
  const items = listPlans(root, { activeOnly: true, limit });
  if (items.length === 0) return "";

  const lines = [];
  let used = 0;
  const header = "## 你手上的事";
  used += header.length + 1;
  for (const it of items) {
    const bits = [];
    if (it.note) bits.push(it.note.slice(0, 24));
    if (Number(it.attempts) > 1) bits.push(`试了 ${it.attempts} 次`);
    if (it.origin === "owner") bits.push("他交办的");
    const tail = bits.length > 0 ? `（${bits.join("，")}）` : "";
    const line = `- ${it.title.slice(0, 22)}${tail}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  return [header, ...lines].join("\n");
}

/** 计数（给 soul_status / 面板用）。 */
export function planStats(root) {
  const items = readBook(root).items;
  const by = { todo: 0, doing: 0, done: 0, dropped: 0 };
  const byOrigin = { self: 0, owner: 0, "mc-goal": 0 };
  for (const it of items) {
    if (by[it.status] !== undefined) by[it.status] += 1;
    if (byOrigin[it.origin] !== undefined) byOrigin[it.origin] += 1;
  }
  return { total: items.length, ...by, byOrigin, active: by.todo + by.doing };
}

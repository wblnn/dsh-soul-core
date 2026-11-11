/**
 * 技能层：把"她学会的游戏技巧"存成**可读可改的文件**，不是数据库行。
 *
 * 为什么技能是文件：
 *   - 技能是"我该怎么做"的程序性知识，要能被 prompt 直接读进来（按触发词注入）
 *   - 人类要能直接改（就像人格文件那样），模型也要能改——数据库行做不到这点
 *   - 进化靠 diff：一次实践 → 文件改一行 → 看得见
 *
 * 目录：`<人格目录>/skills/<domain>/<slug>.md`
 *
 * 文件格式（frontmatter + 正文）：
 * ```
 * ---
 * name: 挖矿用 2 格高坑道
 * domain: mc
 * trigger: 挖矿,隧道,坑道,tunnel
 * attempts: 3
 * successes: 2
 * confidence: 0.67
 * evidence: soul-mc session-abc#120-140
 * updated_at: 2026-10-28T...
 * ---
 * ## 什么时候用
 * ## 步骤
 * ## 教训
 * ## 实践记录
 * ```
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SKILL_MAX_BODY = 4000;
export const SKILL_MAX_NAME = 40;

function nowIso() {
  return new Date().toISOString();
}

/** 名字 → 文件名（中文保留，去掉路径危险字符）。 */
export function slugOf(name) {
  const s = String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|#\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (s || "skill").slice(0, 60);
}

export function skillsDir(soulRoot, domain) {
  return join(soulRoot, "skills", domain || "persona");
}

function splitFrontmatter(text) {
  const src = String(text || "");
  if (!src.startsWith("---")) return { meta: {}, body: src.trim() };
  const end = src.indexOf("\n---", 3);
  if (end < 0) return { meta: {}, body: src.trim() };
  const head = src.slice(3, end).trim();
  const body = src.slice(end + 4).replace(/^\s*\n/, "").trim();
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    meta[key] = value;
  }
  return { meta, body };
}

export function parseSkill(text) {
  const { meta, body } = splitFrontmatter(text);
  return {
    meta: {
      name: meta.name || "",
      domain: meta.domain || "persona",
      trigger: meta.trigger || "",
      attempts: Number(meta.attempts || 0),
      successes: Number(meta.successes || 0),
      confidence: Number(meta.confidence || 0),
      evidence: meta.evidence || "",
      updated_at: meta.updated_at || "",
    },
    body,
  };
}

export function serializeSkill(meta, body) {
  const head = [
    "---",
    `name: ${meta.name}`,
    `domain: ${meta.domain}`,
    `trigger: ${meta.trigger || ""}`,
    `attempts: ${Number(meta.attempts || 0)}`,
    `successes: ${Number(meta.successes || 0)}`,
    `confidence: ${Number(meta.confidence || 0).toFixed(2)}`,
    `evidence: ${meta.evidence || ""}`,
    `updated_at: ${meta.updated_at || nowIso()}`,
    "---",
    "",
  ].join("\n");
  return `${head}${String(body || "").trim()}\n`;
}

/** 列出某个域（或全部域）的技能。 */
export function listSkills(soulRoot, domain) {
  const base = join(soulRoot, "skills");
  if (!existsSync(base)) return [];
  const domains = domain ? [domain] : readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const out = [];
  for (const d of domains) {
    const dir = join(base, d);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const path = join(dir, file);
      let parsed;
      try {
        parsed = parseSkill(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      out.push({
        slug: file.replace(/\.md$/, ""),
        path,
        domain: parsed.meta.domain || d,
        name: parsed.meta.name || file.replace(/\.md$/, ""),
        trigger: parsed.meta.trigger,
        attempts: parsed.meta.attempts,
        successes: parsed.meta.successes,
        confidence: parsed.meta.confidence,
        evidence: parsed.meta.evidence,
        updatedAt: parsed.meta.updated_at,
      });
    }
  }
  out.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  return out;
}

export function readSkill(soulRoot, { domain, slug }) {
  const path = join(skillsDir(soulRoot, domain), `${slugOf(slug)}.md`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return { slug: slugOf(slug), path, text, ...parseSkill(text) };
}

/**
 * 写/更新一条技能。
 *
 * @param input.name 技能名（同时是文件名）
 * @param input.domain 域（mc / qq / persona）
 * @param input.when 什么时候用（一句话）
 * @param input.steps 步骤（数组或文本）
 * @param input.lessons 教训（可选）
 * @param input.trigger 触发词（逗号分隔）
 * @param input.evidence 证据：哪一次实践得出的（必填）
 * @param input.result "worked" | "failed" —— 有档次的实践结果，用来更新成功率
 */
export function saveSkill(soulRoot, input = {}) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("name 必填（技能名就是文件名）");
  if (name.length > SKILL_MAX_NAME) throw new Error(`name 太长（≤${SKILL_MAX_NAME} 字）`);
  const domain = String(input.domain ?? "persona").trim() || "persona";
  const evidence = String(input.evidence ?? "").trim();
  if (!evidence) throw new Error("evidence 必填：写清这条技能是从哪次实践学来的（会话锚点/步骤）");

  const when = String(input.when ?? "").trim();
  const stepsRaw = input.steps ?? "";
  const steps = Array.isArray(stepsRaw) ? stepsRaw.map((s) => String(s).trim()).filter(Boolean) : String(stepsRaw).split(/\r?\n/).map((s) => s.replace(/^\s*\d+[.、)]\s*/, "").trim()).filter(Boolean);
  const lessons = String(input.lessons ?? "").trim();
  if (!when) throw new Error("when 必填：什么情况下用这条");
  if (steps.length === 0) throw new Error("steps 至少一步");

  const slug = slugOf(name);
  const dir = skillsDir(soulRoot, domain);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);

  const existing = existsSync(path) ? parseSkill(readFileSync(path, "utf8")) : null;
  const attempts = Number(existing?.meta.attempts || 0) + (input.result ? 1 : 0);
  const successes = Number(existing?.meta.successes || 0) + (input.result === "worked" ? 1 : 0);
  const confidence = attempts > 0 ? successes / attempts : Number(input.confidence ?? 0.3);

  // 保留旧的「实践记录」，这次追加一行
  const oldLog = existing ? (existing.body.match(/## 实践记录\s*\n([\s\S]*)$/) || [])[1] || "" : "";
  const logLine = input.result
    ? `- ${nowIso().slice(0, 10)} ${input.result === "worked" ? "✅ 成功" : "❌ 失败"}：${evidence}${input.note ? `（${String(input.note).trim()}）` : ""}`
    : `- ${nowIso().slice(0, 10)} 记录：${evidence}`;
  const log = `${oldLog.trim()}\n${logLine}`.trim();

  const body = [
    "## 什么时候用",
    when,
    "",
    "## 步骤",
    steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    lessons ? `\n## 教训\n${lessons}` : "",
    "\n## 实践记录",
    log,
  ]
    .filter((part) => part !== "")
    .join("\n");

  if (body.length > SKILL_MAX_BODY) {
    throw new Error(`技能正文会超预算：${body.length} > ${SKILL_MAX_BODY} 字。先压缩旧步骤/记录再写。`);
  }

  const text = serializeSkill(
    {
      name,
      domain,
      trigger: String(input.trigger ?? existing?.meta.trigger ?? "").trim(),
      attempts,
      successes,
      confidence,
      evidence,
      updated_at: nowIso(),
    },
    body,
  );
  writeFileSync(path, text, "utf8");
  return { ok: true, slug, path, attempts, successes, confidence: Number(confidence.toFixed(2)), created: !existing };
}

function terms(query) {
  const out = new Set();
  for (const m of String(query || "").toLowerCase().matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]+/g)) {
    const s = m[0];
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (s.length <= 2) out.add(s);
      else for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    } else if (s.length > 1) out.add(s);
  }
  return [...out];
}

/** 按情境检索技能（触发词权重最高）。 */
export function recallSkills(soulRoot, { domain, query, limit = 5 } = {}) {
  const list = listSkills(soulRoot, domain);
  const ts = terms(query);
  if (ts.length === 0) return list.slice(0, limit).map((s) => ({ ...s, score: s.confidence }));

  const scored = [];
  for (const skill of list) {
    const full = readSkill(soulRoot, { domain: skill.domain, slug: skill.slug });
    const trigger = String(skill.trigger || "").toLowerCase();
    const bodyText = `${skill.name}\n${full?.body || ""}`.toLowerCase();
    let score = 0;
    for (const t of ts) {
      if (trigger.includes(t)) score += 3;
      if (skill.name.toLowerCase().includes(t)) score += 2;
      if (bodyText.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ ...skill, score, confidence: skill.confidence });
  }
  scored.sort((a, b) => b.score - a.score || b.confidence - a.confidence);
  return scored.slice(0, limit);
}

/** 生成注入用技能块（只放名字 + 何时用 + 前几步，正文留给她自己去 soul_read / skill_read）。 */
export function renderSkillBrief(soulRoot, { domain, query, budget = 900 } = {}) {
  const picked = recallSkills(soulRoot, { domain, query, limit: 4 });
  if (picked.length === 0) return { text: "", slugs: [] };

  const header = "## 你学过的技巧（按需 skill_read 看全文）";
  const lines = [];
  const slugs = [];
  let used = header.length;
  for (const skill of picked) {
    const full = readSkill(soulRoot, { domain: skill.domain, slug: skill.slug });
    const when = (full?.body.match(/## 什么时候用\s*\n([^\n]+)/) || [])[1] || "";
    const line = `- ${skill.name}（置信 ${skill.confidence.toFixed(2)}，试过 ${skill.attempts} 次）：${when.slice(0, 60)}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
    slugs.push(skill.slug);
  }
  if (lines.length === 0) return { text: "", slugs: [] };
  return { text: `${header}\n${lines.join("\n")}`, slugs };
}

#!/usr/bin/env node
/**
 * 底仓命令行：不用开 DSH 也能查/看/导出。
 *
 *   node bin/mem.mjs stats
 *   node bin/mem.mjs sessions [limit]
 *   node bin/mem.mjs episodes [sessionId] [limit]
 *   node bin/mem.mjs expand <sessionId> <seq> [before] [after]
 *   node bin/mem.mjs dump <sessionId> [--json]     导出该会话的**完整**原文（含 reasoning / 工具结果）
 *   node bin/mem.mjs notes                         看已有的事件摘要
 *   node bin/mem.mjs messages <sessionId> [limit]   看该会话的完整正文（人格库全文）
 *   node bin/mem.mjs search <关键词>                 摘要 + 全文一起搜
 *   node bin/mem.mjs skills [域]                     列出学过的技巧
 *   node bin/mem.mjs skill <域> <名字>               读一条技能全文
 *   node bin/mem.mjs index                          手动跑一次摄取
 *
 * 索引库默认在 `<人格目录>/memory-tree/memory.db`；可用 DSH_SOUL_ROOT / DSH_MEMORY_ROOT 覆盖。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveMemoryRoot, resolveRoot } from "../lib/persona-api.js";
import {
  buildDigest,
  expand,
  ingestAll,
  listEpisodes,
  listNotes,
  listMessages,
  listNotesRanked,
  searchMessages,
  searchNotes,
  listSessions,
  openStore,
  stats,
  tierSummary,
} from "../lib/memory-store.js";
import { decodeFrames, eventText, readSessionFile } from "../lib/session-source.js";
import { listSkills, readSkill } from "../lib/skills.js";
import { resolveDshHome } from "../lib/persona-api.js";

const [cmd = "stats", ...rest] = process.argv.slice(2);

const soulRoot = resolveRoot();
const memoryRoot = resolveMemoryRoot(soulRoot);
const dbPath = join(memoryRoot, "memory.db");

function db() {
  mkdirSync(memoryRoot, { recursive: true });
  return openStore(dbPath);
}

function need(conn) {
  const s = stats(conn);
  if (s.sessions === 0) {
    process.stderr.write("索引还是空的，先跑一次摄取（node bin/mem.mjs index）…\n");
    ingestAll(conn, [join(resolveDshHome(), "sessions")], { limitFiles: 60, budgetMs: 60000 });
  }
  return conn;
}

const conn = db();

switch (cmd) {
  case "stats": {
    need(conn);
    console.log(`索引库：${dbPath}`);
    console.log(JSON.stringify(stats(conn), null, 2));
    break;
  }
  case "index": {
    const r = ingestAll(conn, [join(resolveDshHome(), "sessions")], { limitFiles: 60, budgetMs: 120000 });
    console.log("摄取：", JSON.stringify(r, null, 2));
    console.log("统计：", JSON.stringify(stats(conn), null, 2));
    break;
  }
  case "sessions": {
    need(conn);
    const limit = Number(rest[0] || 20);
    for (const s of listSessions(conn, limit)) {
      console.log(`${s.session_id}\n  ${s.workspace || "-"} · preset=${s.preset || "-"} · ${s.event_count} 事件 · ${s.frame_count} 帧 · ${s.updated_at || ""}`);
      console.log(`  ${s.file || ""}`);
    }
    break;
  }
  case "episodes": {
    need(conn);
    // 用法：episodes [limit] 或 episodes <sessionId> [limit]
    const first = rest[0];
    const looksLikeNumber = first !== undefined && /^\d+$/.test(first);
    const sessionId = first && !looksLikeNumber ? first : undefined;
    const limit = Number(looksLikeNumber ? first : rest[1] || 30);
    const rows = listEpisodes(conn, { sessionId, limit });
    for (const e of rows) {
      console.log(`#${e.seq_start}-${e.seq_end}  ${e.reason}  turn ${e.turn_start ?? "?"}..${e.turn_end ?? "?"}  ${e.event_count} 事件 ${e.chars} 字符  [${e.session_id}]`);
    }
    break;
  }
  case "expand": {
    need(conn);
    const [sessionId, seqText, before, after] = rest;
    if (!sessionId || !seqText) {
      console.error("用法：node bin/mem.mjs expand <sessionId> <seq> [before] [after]");
      process.exit(1);
    }
    const r = expand(conn, sessionId, Number(seqText), {
      before: Number(before || 2),
      after: Number(after || 2),
      maxChars: 20000,
    });
    console.log(`frame=${r.frameIndex}  文件=${r.file}\n`);
    let printed = 0;
    for (const e of r.events) {
      if (!e.text) continue;
      printed += 1;
      console.log(`[${e.seq}｜${e.type}]\n${e.text}\n`);
    }
    if (printed === 0) console.log("（这个锚点附近没有正文事件——多半是配置类事件；换个大一点的 seq 试试）");
    break;
  }
  case "dump": {
    const sessionId = rest[0];
    if (!sessionId) {
      console.error("用法：node bin/mem.mjs dump <sessionId> [--json]");
      process.exit(1);
    }
    need(conn);
    const row = conn.prepare("SELECT file FROM sessions WHERE session_id = ?").get(sessionId);
    if (!row) {
      console.error(`索引里没有会话：${sessionId}（先 node bin/mem.mjs sessions 看一眼）`);
      process.exit(1);
    }
    const { frames } = readSessionFile(row.file);
    const events = frames.flatMap((f) => f.events);
    if (rest.includes("--json")) {
      process.stdout.write(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } else {
      for (const ev of events) {
        const text = eventText(ev);
        if (!text) continue;
        const tag = ev.type === "user/message" ? "我" : ev.type === "assistant/message" ? "它" : ev.type;
        console.log(`--- [${ev.seq}｜${tag}] ${new Date(Number(ev.time || 0)).toLocaleString()}`);
        console.log(text);
        console.log();
      }
    }
    break;
  }
  case "skills": {
    const domain = rest[0];
    const rows = listSkills(soulRoot, domain);
    if (rows.length === 0) {
      console.log(`（${domain || "全部域"}还没有学过的技巧）`);
      break;
    }
    for (const s of rows) {
      console.log(`〔${s.domain}｜置信 ${s.confidence.toFixed(2)}｜${s.successes}/${s.attempts}〕${s.name}`);
      console.log(`   触发：${s.trigger || "-"}　文件：${s.path}`);
    }
    break;
  }
  case "skill": {
    const [domain, ...nameParts] = rest;
    const found = readSkill(soulRoot, { domain, slug: nameParts.join(" ") });
    if (!found) {
      console.error(`没有这条技能：${nameParts.join(" ")}（先 mem.mjs skills 看看）`);
      process.exit(1);
    }
    console.log(found.text);
    break;
  }
  case "tiers": {
    need(conn);
    const summary = tierSummary(conn, {});
    console.log(`hot ${summary.counts.hot} · warm ${summary.counts.warm} · cold ${summary.counts.cold}（共 ${summary.total}）\n`);
    for (const n of summary.ranked.slice(0, Number(rest[0] || 20))) {
      console.log(`〔${String(n.tier).padEnd(4)} ${String(n.score).padStart(6)}〕${n.title}`);
      console.log(`   hits=${n.hits} injected=${n.injected} expanded=${n.expanded}  ${n.session_id} #${n.seq_start}-${n.seq_end}`);
    }
    break;
  }
  case "digest": {
    need(conn);
    const d = buildDigest(conn, { maxItems: Number(rest[0] || 8) });
    console.log(`扫描 user 正文 ${d.scannedMessages} 条，命中偏好标记 ${d.matched} 条\n`);
    if (d.candidates.length === 0) console.log("（还没有反复出现的偏好）");
    for (const c of d.candidates) {
      console.log(`- ${c.text}（出现 ${c.count} 次）`);
      for (const a of c.anchors) console.log(`    锚点 ${a.sessionId} #${a.seq}`);
    }
    if (d.recentNotes.length) {
      console.log("\n== 最近常聊的 ==");
      for (const n of d.recentNotes) console.log(`〔${n.tier} ${n.score}〕${n.title}：${n.summary.slice(0, 100)}`);
    }
    break;
  }
  case "messages": {
    need(conn);
    const [sessionId, limit] = rest;
    if (!sessionId) {
      console.error("用法：node bin/mem.mjs messages <sessionId> [limit]");
      process.exit(1);
    }
    for (const m of listMessages(conn, sessionId, { limit: Number(limit || 200) })) {
      console.log(`[${m.seq}｜${m.role}] ${new Date(Number(m.time || 0)).toLocaleString()}`);
      console.log(m.text);
      console.log();
    }
    break;
  }
  case "search": {
    need(conn);
    const q = rest.join(" ");
    if (!q) {
      console.error("用法：node bin/mem.mjs search <关键词>");
      process.exit(1);
    }
    const notes = searchNotes(conn, q, { limit: 5 });
    const msgs = searchMessages(conn, q, { limit: 10 });
    if (notes.hits.length) {
      console.log("== 事件摘要命中 ==");
      for (const h of notes.hits) console.log(`[${h.score}] ${h.title}（${h.sessionId} #${h.seqStart}-${h.seqEnd}）\n   ${h.summary.slice(0, 160)}`);
    }
    if (msgs.hits.length) {
      console.log("== 全文命中 ==");
      for (const h of msgs.hits) console.log(`[${h.score}] ${h.sessionId} seq=${h.seq} ${h.role}\n   ${h.text.slice(0, 220)}`);
    }
    if (!notes.hits.length && !msgs.hits.length) console.log("（没有命中）");
    break;
  }
  case "notes": {
    need(conn);
    const rows = listNotes(conn, { limit: 50 });
    if (rows.length === 0) console.log("（还没有事件摘要）");
    for (const n of rows) {
      console.log(`#${n.seq_start}-${n.seq_end}  ${n.title}  (v${n.version}, ${n.anchors} 锚点)`);
      console.log(`  ${n.summary.slice(0, 200)}`);
      console.log(`  [${n.session_id}]`);
    }
    break;
  }
  default:
    console.error(`未知命令：${cmd}`);
    console.error("可用：stats | index | sessions | episodes | expand | dump | notes | messages | search | tiers | digest | skills | skill");
    process.exit(1);
}

try {
  conn.close();
} catch {
  /* noop */
}

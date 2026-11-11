#!/usr/bin/env node
/**
 * 预检索探针：手敲一句话，看 Harness 会替她捞到哪几条记忆。
 *
 * 用法：
 *   node bin/prefetch.mjs "你还记得上次被苦力怕炸死吗"
 *   node bin/prefetch.mjs --last                 # 用她最后一个会话里最后一条真人输入
 *   node bin/prefetch.mjs --last --venue chat
 *   node bin/prefetch.mjs "挖矿" --budget 1500 --notes 5 --msgs 3
 *
 * 退出码：0 命中，2 没命中（方便脚本判断）。
 */

import { join } from "node:path";

import { buildPrefetchBlock, cleanQuery } from "../lib/prefetch.js";
import { openStore } from "../lib/memory-store.js";
import { lastUserText } from "../lib/session-source.js";
import { resolveDshHome, resolveMemoryRoot, resolveRoot } from "../lib/persona-api.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : true;
};

const root = resolveRoot();
const memoryRoot = resolveMemoryRoot(root, null);
const dbPath = join(memoryRoot, "memory.db");
const venue = String(flag("venue", "") || "");
const budget = Number(flag("budget", 900));
const notes = Number(flag("notes", 3));
const msgs = Number(flag("msgs", 2));
let excludeSeq = Number(flag("exclude", 0)); // 别让问题自己命中自己

let query = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--venue" && args[args.indexOf(a) - 1] !== "--budget" && args[args.indexOf(a) - 1] !== "--notes" && args[args.indexOf(a) - 1] !== "--msgs") || "";

if (flag("last", false)) {
  // 找最近改过的会话文件，取它最后一条真人输入
  const { findSessionFiles } = await import("../lib/session-source.js");
  const { statSync } = await import("node:fs");
  const files = findSessionFiles([join(resolveDshHome(), "sessions")]);
  const newest = files.map((f) => ({ f, t: statSync(f).mtimeMs })).sort((a, b) => b.t - a.t)[0];
  if (!newest) {
    console.error("找不到任何会话文件");
    process.exit(2);
  }
  const id = (newest.f.match(/session-([0-9a-f-]{36})/) || [])[1] || "";
  const last = lastUserText([join(resolveDshHome(), "sessions")], id, {
    maxBytes: 4 * 1024 * 1024,
    maxFrames: 400,
  });
  if (!last.text) {
    console.error("这个会话里没找到用户输入");
    process.exit(2);
  }
  query = last.text;
  excludeSeq = last.seq;
  console.log(`（用会话 ${id.slice(0, 12)}… 的第 ${last.seq} 条输入${last.synthetic ? "·合成" : "·真人"}）`);
}

if (!query) {
  console.error('用法：node bin/prefetch.mjs "<一句话>"  或  node bin/prefetch.mjs --last');
  process.exit(1);
}

console.log("原始输入：", JSON.stringify(String(query).slice(0, 120)));
console.log("清洗后  ：", JSON.stringify(cleanQuery(query).slice(0, 120)));
console.log("");

if (!(await import("node:fs")).existsSync(dbPath)) {
  console.error(`记忆库不存在：${dbPath}（先跑 node bin/mem.mjs index）`);
  process.exit(2);
}

const db = openStore(dbPath);
const block = buildPrefetchBlock(db, { query, venue, noteLimit: notes, msgLimit: msgs, budget, excludeSeq });
db.close();

if (!block) {
  console.log("（没命中——阈值 ≥2 个词，或库里确实没有相关的）");
  process.exit(2);
}

console.log(block);
console.log("");
console.log(`—— ${block.length} 字符（预算 ${budget}）`);

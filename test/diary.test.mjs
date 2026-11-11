/**
 * 日记测试：到点才写、没活动不写、写下来不注入上下文。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { hasDiary, readDiary, shouldWriteNow, writeDiary, dateKey } from "../lib/diary.js";

const roots = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "soul-diary-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

test("写日记：落在 diary/YYYY-MM-DD.md，同一天续写不覆盖", () => {
  const root = tmp();
  const day = "2026-11-08";
  const r1 = writeDiary(root, "今天挖到了钻石，但被苦力怕炸死了。", { date: day });
  assert.equal(r1.ok, true);
  assert.equal(r1.fresh, true);
  assert.ok(existsSync(join(root, "diary", `${day}.md`)));

  writeDiary(root, "晚上又去试了梯子，还是爬不上去。", { date: day });
  const text = readDiary(root, { date: day }).entries[0].text;
  assert.ok(text.includes("钻石"));
  assert.ok(text.includes("梯子"), "同一天第二次应该续写");
  assert.ok(text.startsWith(`# ${day}`), "文件头只出现一次");
  assert.equal((text.match(/^# /gm) || []).length, 1);
});

test("日记不写进人格文件：只在 diary/ 下", () => {
  const root = tmp();
  writeDiary(root, "测试内容 XYZ");
  assert.ok(existsSync(join(root, "diary")), "应有 diary 目录");
  assert.ok(!existsSync(join(root, "MEMORY.md")), "不该碰 MEMORY.md");
  assert.ok(!existsSync(join(root, "MEMORY.mc.md")), "不该碰域记忆");
});

test("长度上限：太长的日记被拒（逼她挑重点）", () => {
  const root = tmp();
  assert.throws(() => writeDiary(root, "很长".repeat(3000), { maxChars: 4000 }), /日记太长/);
  assert.throws(() => writeDiary(root, "   "), /内容为空/);
});

test("读日记：按天读 / 最近 N 篇", () => {
  const root = tmp();
  writeDiary(root, "第一天", { date: "2026-11-06" });
  writeDiary(root, "第二天", { date: "2026-11-07" });
  writeDiary(root, "第三天", { date: "2026-11-08" });

  assert.equal(readDiary(root, { date: "2026-11-07" }).entries[0].text.includes("第二天"), true);

  const recent = readDiary(root, { days: 2 }).entries;
  assert.equal(recent.length, 2);
  assert.equal(recent[0].date, "2026-11-08", "最新的在前");
  assert.equal(readDiary(tmp(), {}).entries.length, 0, "没有日记时返回空数组");
});

test("触发条件：到点 + 今天有活动 + 今天还没写", () => {
  const now = new Date("2026-11-08T23:40:00");
  const today = new Date("2026-11-08T20:00:00").getTime();

  // 正常该写
  assert.equal(shouldWriteNow({ now, at: "23:30", lastActivityMs: today }).write, true);

  // 还没到点
  assert.equal(shouldWriteNow({ now, at: "23:59", lastActivityMs: today }).reason, "too-early");

  // 已经写过
  assert.equal(shouldWriteNow({ now, at: "23:30", lastActivityMs: today, alreadyWritten: true }).reason, "already-written");

  // 底仓最后一条不是今天
  const yesterday = new Date("2026-11-07T22:00:00").getTime();
  assert.equal(shouldWriteNow({ now, at: "23:30", lastActivityMs: yesterday }).reason, "last-record-not-today");

  // 完全没有记录
  assert.equal(shouldWriteNow({ now, at: "23:30", lastActivityMs: 0 }).reason, "no-activity");
});

test("dateKey 用本地日期（不按 UTC）", () => {
  assert.equal(dateKey(new Date(2026, 10, 8, 23, 59)), "2026-11-08");
  assert.equal(dateKey(new Date(2026, 0, 1, 0, 1)), "2026-01-01");
});

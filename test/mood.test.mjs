/**
 * 心情 P0 测试：文件 / 六种行为表 / 衰减 / 注入预算 / 三条护栏。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { DECAY_HOURS, MOODS, decayMood, moodSummary, readMood, renderMoodBlock, setMood } from "../lib/mood.js";

const roots = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "soul-mood-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

test("默认是平静，且平静时一个字都不注入", () => {
  const root = tmp();
  const s = readMood(root);
  assert.equal(s.mood, "平静");
  assert.equal(renderMoodBlock(root), "", "平静不注入——否则她会开始表演情绪");
});

test("设心情：要有原因；没有原因直接拒", () => {
  const root = tmp();
  assert.throws(() => setMood(root, { mood: "烦躁" }), /为什么/);
  assert.throws(() => setMood(root, { mood: "暴躁", cause: "x" }), /没有这种心情/);

  const s = setMood(root, { mood: "烦躁", intensity: 2, cause: "被骷髅射死，掉了把铁剑", causeKind: "event:mc:death" });
  assert.equal(s.mood, "烦躁");
  assert.equal(s.intensity, 2);
  assert.equal(s.transitions.length, 1);
});

test("强度被夹在 1..3", () => {
  const root = tmp();
  assert.equal(setMood(root, { mood: "开心", intensity: 99, cause: "x" }).intensity, 3);
  assert.equal(setMood(root, { mood: "开心", intensity: 0, cause: "x" }).intensity, 1);
});

test("注入：带行为和护栏，且守预算", () => {
  const root = tmp();
  setMood(root, { mood: "烦躁", intensity: 2, cause: "被骷髅射死" });
  const text = renderMoodBlock(root);
  assert.ok(text.includes("有点烦躁"), text);
  assert.ok(text.includes("被骷髅射死"), "原因要带上——原因比心情重要");
  assert.ok(text.includes("正事照办") || text.includes("不改事实"), "要有护栏");
  assert.ok(text.length <= 130, `预算 130，实际 ${text.length}`);
});

test("六种心情每种都有可观测的行为描述（不是形容词）", () => {
  for (const [name, spec] of Object.entries(MOODS)) {
    assert.ok(spec.behavior.length > 4, `${name} 缺行为描述`);
    assert.ok(!/^很|^有点/.test(spec.behavior), `${name} 的行为描述不该只是形容词`);
  }
});

test("衰减：8 小时后降一档，归零回到平静", () => {
  const root = tmp();
  const base = Date.parse("2026-11-13T10:00:00+08:00");
  setMood(root, { mood: "烦躁", intensity: 3, cause: "被炸死" });
  // 把 since 拨到 base
  const raw = JSON.parse(readFileSync(join(root, "mood.json"), "utf8"));
  raw.since = new Date(base).toISOString();
  writeFileSync(join(root, "mood.json"), JSON.stringify(raw), "utf8");

  // 8 小时后 → 2
  let r = decayMood(root, { now: new Date(base + DECAY_HOURS * 3600_000).toISOString() });
  assert.equal(r.state.intensity, 2);

  // 再 8 小时 → 1
  r = decayMood(root, { now: new Date(base + 2 * DECAY_HOURS * 3600_000).toISOString() });
  assert.equal(r.state.intensity, 1);

  // 再 8 小时 → 平静
  r = decayMood(root, { now: new Date(base + 3 * DECAY_HOURS * 3600_000).toISOString() });
  assert.equal(r.state.mood, "平静");
  assert.equal(r.state.cause, "", "回到平静就把原因清掉");
  assert.equal(renderMoodBlock(root), "", "平静后不再注入");
});

test("衰减：很久没动一次回到平静，且留一条 decay 记录", () => {
  const root = tmp();
  const base = Date.parse("2026-11-13T00:00:00+08:00");
  setMood(root, { mood: "低落", intensity: 2, cause: "屋顶没封完" });
  const raw = JSON.parse(readFileSync(join(root, "mood.json"), "utf8"));
  raw.since = new Date(base).toISOString();
  writeFileSync(join(root, "mood.json"), JSON.stringify(raw), "utf8");

  const r = decayMood(root, { now: new Date(base + 40 * 3600_000).toISOString() });
  assert.equal(r.state.mood, "平静");
  assert.ok(r.state.transitions.some((t) => t.source === "decay"), "衰减也要留痕");
});

test("transitions 环形缓冲不超过 20 条", () => {
  const root = tmp();
  for (let i = 0; i < 26; i++) {
    setMood(root, { mood: i % 2 ? "开心" : "烦躁", cause: `第 ${i} 次` });
  }
  assert.equal(readMood(root).transitions.length, 20);
});

test("摘要：给面板/status 用，只回最近 5 条", () => {
  const root = tmp();
  setMood(root, { mood: "兴奋", cause: "挖到钻石" });
  const s = moodSummary(root);
  assert.equal(s.mood, "兴奋");
  assert.ok(Array.isArray(s.transitions));
  assert.ok(s.transitions.length <= 5);
});

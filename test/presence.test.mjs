/**
 * 状态锁 / 意图闸门 / 反助手腔 三件事的测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyChat, pickRefusal, refusalLine } from "../lib/gate.js";
import { DEFAULT_SCHEDULE, presenceAt, renderPresence } from "../lib/presence.js";

/* ───────────────────────── 作息 ───────────────────────── */

test("作息：23:00–08:00 是睡眠，跨午夜也算", () => {
  assert.equal(presenceAt(new Date(2026, 10, 8, 23, 30)).state, "sleep");
  assert.equal(presenceAt(new Date(2026, 10, 9, 3, 0)).state, "sleep");
  assert.equal(presenceAt(new Date(2026, 10, 9, 7, 59)).state, "sleep");
  assert.equal(presenceAt(new Date(2026, 10, 9, 8, 0)).state, "awake");
  assert.equal(presenceAt(new Date(2026, 10, 9, 12, 0)).state, "awake");
});

test("作息：专注时段落区间内，且优先级低于睡眠", () => {
  assert.equal(presenceAt(new Date(2026, 10, 9, 14, 30)).state, "focus");
  assert.equal(presenceAt(new Date(2026, 10, 9, 16, 0)).state, "awake");
  // 自定义：睡眠和专注重叠时睡眠优先
  const s = { sleep: ["13:00", "15:00"], focus: [["14:00", "16:00"]] };
  assert.equal(presenceAt(new Date(2026, 10, 9, 14, 30), s).state, "sleep");
});

test("作息：注入文案要给出说话方式（不是只报时间）", () => {
  const sleep = renderPresence(new Date(2026, 10, 9, 2, 0));
  assert.ok(sleep.includes("被吵醒"));
  assert.ok(sleep.includes("极短"));
  assert.ok(sleep.includes("拒绝"));

  const focus = renderPresence(new Date(2026, 10, 9, 14, 30));
  assert.ok(focus.includes("敷衍"));
  assert.ok(focus.includes("不要列清单"));

  assert.equal(renderPresence(new Date(2026, 10, 9, 12, 0)), "", "醒着不加噪音");
  assert.ok(DEFAULT_SCHEDULE.sleep.length === 2);
});

/* ───────────────────────── 意图闸门 ───────────────────────── */

test("闸门：工具性指令认得出", () => {
  const cases = [
    "帮我写个爬虫抓一下豆瓣",
    "这个函数报错了你看看",
    "总结一下今天的会议",
    "帮我做个表格",
    "翻译一下这段英文",
    "查一下 zstd 多帧怎么解",
    "帮我实现一个 LRU",
  ];
  for (const c of cases) {
    assert.equal(classifyChat(c).taskish, true, `应判为任务：${c}`);
  }
});

test("闸门：聊天放行（宁可放过不误拦）", () => {
  const cases = [
    "小鱼你在吗",
    "在干嘛呢",
    "晚安喵",
    "哈哈哈哈哈",
    "想你了",
    "陪我挖矿好不好",
  ];
  for (const c of cases) {
    assert.equal(classifyChat(c).taskish, false, `不该拦：${c}`);
  }
});

test("闸门：说得很短的话不算任务（避免误伤）", () => {
  assert.equal(classifyChat("嗯").taskish, false);
  assert.equal(classifyChat("在吗").taskish, false);
  assert.equal(classifyChat("").taskish, false);
});

test("闸门：带聊天特征的任务句放行（他在玩的时候不该被任务打断，但也不该装死）", () => {
  const v = classifyChat("小鱼你在吗？帮我写个脚本");
  assert.equal(v.taskish, false, "带 '在吗' 的算聊天");
  assert.equal(v.chatty, true);
});

/* ───────────────────────── 拒绝语 ───────────────────────── */

test("拒绝语：按状态给不同口吻，且不会每次都一样", () => {
  const sleepLine = pickRefusal("sleep", 0);
  const focusLine = pickRefusal("focus", 0);
  assert.notEqual(sleepLine, focusLine);

  const a = pickRefusal("busy", 1);
  const b = pickRefusal("busy", 2);
  assert.notEqual(a, b, "不同 seed 应该换一句");

  const line = refusalLine({ state: "sleep", name: "主人", seed: 0 });
  assert.ok(line.startsWith("主人，"), "带称呼");
  assert.ok(line.length > 4);
});

test("moodful: false 时不搞脾气（工作模式/测试模式）", async () => {
  const { apply } = await import("../lib/index.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const render = (config) => {
    const root = mkdtempSync(join(tmpdir(), "soul-mood-"));
    const vars = {};
    const ctx = {
      logger: { info() {}, warn() {} },
      inject: (s, cb) => cb(ctx),
      systemPrompt: { variable: (n, fn) => { vars[n] = fn; }, context: () => {} },
      tools: { register: () => {} },
      webServer: { register: () => ({}) },
    };
    apply(ctx, { root, ...config });
    return { block: vars.soul_block ? vars.soul_block() : "", presence: vars.soul_presence ? vars.soul_presence() : "" };
  };

  // 有脾气：反助手腔 + 姿态
  const moody = render({ mode: "persona", domain: "persona" });
  assert.ok(moody.block.includes("别像个助手"), "人格模式该有反助手腔");

  // 不搞脾气：工作模式（后端是 prompt + handTools）
  const work = render({ mode: "prompt", domain: "persona", handTools: true, moodful: false });
  assert.ok(!work.block.includes("别像个助手"), "工作模式不该有反助手腔");
  assert.equal(work.presence, "", "工作模式不该有起床气/敷衍语气");

  // 不搞脾气：测试模式
  const testMode = render({ mode: "persona", domain: "mc", testMode: true, moodful: false });
  assert.ok(!testMode.block.includes("别像个助手"), "测试模式不该有反助手腔");
  assert.equal(testMode.presence, "", "测试模式不该有姿态语气");
});

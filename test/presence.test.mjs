/**
 * 状态锁 / 意图闸门 / 反助手腔 的测试。
 *
 * 闸门用例直接来自实跑翻车：
 *   「我修了个房子，好看不」/「这地图改得不错啊」/「我刚修好屋顶，累死」
 *   —— 上一版正则把这三句判成"派活"，于是别人正常聊天，她自动去怼一句。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyChat, gateThrottle, isAddressed, pickRefusal, refusalLine } from "../lib/gate.js";
import { DEFAULT_SCHEDULE, presenceAt, renderPresence } from "../lib/presence.js";

/* ───────────────────────── 作息 ───────────────────────── */

test("作息：默认 01:30–08:00 是「深夜」，不是「睡着」", () => {
  assert.equal(DEFAULT_SCHEDULE.night[0], "01:30", "默认深夜起点（主人回家晚）");
  assert.equal(presenceAt(new Date(2026, 10, 8, 23, 30)).state, "awake", "23:30 还清醒");
  assert.equal(presenceAt(new Date(2026, 10, 9, 1, 29)).state, "awake");
  assert.equal(presenceAt(new Date(2026, 10, 9, 1, 30)).state, "night");
  assert.equal(presenceAt(new Date(2026, 10, 9, 3, 0)).state, "night");
  assert.equal(presenceAt(new Date(2026, 10, 9, 7, 59)).state, "night");
  assert.equal(presenceAt(new Date(2026, 10, 9, 8, 0)).state, "awake");
  assert.equal(presenceAt(new Date(2026, 10, 9, 12, 0)).state, "awake");
});

test("作息：深夜不是停机——文案要求「人还在」，不许用困把话头掐断", () => {
  const text = renderPresence(new Date(2026, 10, 9, 2, 0));
  assert.ok(text.includes("深夜"));
  assert.ok(text.includes("不耐烦") || text.includes("耐心低"));
  assert.ok(text.includes("人还在"), "必须写明她还在");
  assert.ok(text.includes("不许"), "要禁止「明天再说」式敷衍");
  assert.ok(!text.includes("是被吵醒的"), "不再是「你是被吵醒的」那套");
});

test("作息：专注时段落区间内，且优先级低于深夜", () => {
  assert.equal(presenceAt(new Date(2026, 10, 9, 14, 30)).state, "focus");
  assert.equal(presenceAt(new Date(2026, 10, 9, 16, 0)).state, "awake");
  const s = { night: ["13:00", "15:00"], focus: [["14:00", "16:00"]] };
  assert.equal(presenceAt(new Date(2026, 10, 9, 14, 30), s).state, "night");
  // 旧配置（schedule.sleep）仍然认，语义当深夜
  assert.equal(presenceAt(new Date(2026, 10, 9, 14, 30), { sleep: ["13:00", "15:00"] }).state, "night");
});

test("作息：注入文案要给出说话方式（不是只报时间）", () => {
  const focus = renderPresence(new Date(2026, 10, 9, 14, 30));
  assert.ok(focus.includes("敷衍"));
  assert.ok(focus.includes("不要列清单"));

  assert.equal(renderPresence(new Date(2026, 10, 9, 12, 0)), "", "醒着不加噪音");
  assert.ok(DEFAULT_SCHEDULE.night.length === 2);
});

/* ───────────────────────── 闸门判定 ───────────────────────── */

test("闸门：真的在派活才判任务", () => {
  const cases = [
    "小鱼帮我写个爬虫抓一下豆瓣",
    "小鱼这个函数报错了你看看",
    "小鱼帮我实现一个 LRU 缓存",
    "小鱼 你查一下 zstd 多帧怎么解",
    "小鱼 帮我把这个接口的文档整理一下",
    "小鱼 翻译一下这段英文文档",
  ];
  for (const c of cases) {
    assert.equal(classifyChat(c).taskish, true, `应判为任务：${c}`);
  }
});

test("闸门：实跑翻车的三句闲聊不许拦", () => {
  const cases = ["我修了个房子，好看不", "这地图改得不错啊", "我刚修好屋顶，累死"];
  for (const c of cases) {
    assert.equal(classifyChat(c).taskish, false, `误拦了正常闲聊：${c}`);
  }
});

test("闸门：其它常见闲聊放行", () => {
  const cases = [
    "小鱼你在吗",
    "在干嘛呢",
    "晚安喵",
    "哈哈哈哈哈",
    "想你了",
    "陪我挖矿好不好",
    "今天挖了好多煤，累死了",
    "这剑看着挺厉害啊",
  ];
  for (const c of cases) {
    assert.equal(classifyChat(c).taskish, false, `不该拦：${c}`);
  }
});

test("闸门：太短的话不判断（避免误伤）", () => {
  assert.equal(classifyChat("嗯").taskish, false);
  assert.equal(classifyChat("在吗").taskish, false);
  assert.equal(classifyChat("").taskish, false);
});

/* ───────────────────────── 必须被点名 ───────────────────────── */

test("点名：名字命中或带 @ 才算在叫她", () => {
  assert.equal(isAddressed("小鱼 帮我写个脚本", ["小鱼"]), true);
  assert.equal(isAddressed("@小鱼 帮我写个脚本", ["小鱼"]), true);
  assert.equal(isAddressed("帮我写个脚本", ["小鱼"]), false, "没点名就不该回");
  assert.equal(isAddressed("张三 帮我写个脚本", []), false);
});

/* ───────────────────────── 节流 ───────────────────────── */

test("节流：冷却期内不回，窗口内超上限不回，之后恢复", () => {
  const now = 1_000_000;
  const opt = { cooldownMs: 30_000, windowMs: 3_600_000, maxPerWindow: 3 };

  const a = gateThrottle({}, now, opt);
  assert.equal(a.allowed, true);
  assert.equal(a.count, 1);

  const b = gateThrottle({ lastAt: now, count: 1, windowStart: now }, now + 5_000, opt);
  assert.equal(b.allowed, false);
  assert.equal(b.reason, "cooldown");

  const c = gateThrottle({ lastAt: now, count: 1, windowStart: now }, now + 60_000, opt);
  assert.equal(c.allowed, true);
  assert.equal(c.count, 2);

  const d = gateThrottle({ lastAt: now, count: 3, windowStart: now }, now + 120_000, opt);
  assert.equal(d.allowed, false);
  assert.equal(d.reason, "window-cap");

  const e = gateThrottle({ lastAt: now, count: 3, windowStart: now }, now + 3_600_001, opt);
  assert.equal(e.allowed, true);
  assert.equal(e.count, 1);
});

test("节流：100 条连刷最多回几次（防封号）", () => {
  const now = 5_000_000;
  let state = {};
  let sent = 0;
  for (let i = 0; i < 100; i++) {
    const t = now + i * 200;
    const v = gateThrottle(state, t);
    if (v.allowed) {
      sent += 1;
      state = { lastAt: t, count: v.count, windowStart: v.windowStart };
    }
  }
  assert.ok(sent <= 6, `100 条连刷只该回很少几次，实际 ${sent}`);
  assert.ok(sent >= 1);
});

/* ───────────────────────── 拒绝语 ───────────────────────── */

test("拒绝语：按状态给不同口吻，且不会每次都一样", () => {
  assert.notEqual(pickRefusal("sleep", 0), pickRefusal("focus", 0));
  assert.notEqual(pickRefusal("busy", 1), pickRefusal("busy", 2));

  const line = refusalLine({ state: "sleep", name: "主人", seed: 0 });
  assert.ok(line.startsWith("主人，"), "带称呼");
});

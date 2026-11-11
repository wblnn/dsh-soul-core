/**
 * MC 聊天桥测试：常驻缓冲 + 两种唤醒（点名 / 氛围）+ 上下文块。
 *
 * 设计意图（用户要的）：
 *   - **不用特意 @**：一直在收，攒够了几条也会叫她一次「要不要接」；
 *   - 叫醒时**带最近几条当上下文**，不是只丢一句；
 *   - 自己说的进缓冲当上下文，但不触发唤醒。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createChatBuffer,
  decideWake,
  formatChatContext,
  openChatStream,
  parseChatLine,
} from "../lib/mc-chat.js";

function bufWith(lines) {
  const b = createChatBuffer({ capacity: 24 });
  for (const l of lines) b.push(l);
  return b;
}

test("parseChatLine：<名字> 正文 / 纯正文都认", () => {
  assert.deepEqual(parseChatLine("<张三> 你好呀"), { speaker: "张三", text: "你好呀" });
  assert.deepEqual(parseChatLine("  <小鱼>   在吗  "), { speaker: "小鱼", text: "在吗" });
  assert.deepEqual(parseChatLine("没有尖括号的一句"), { speaker: "", text: "没有尖括号的一句" });
  assert.deepEqual(parseChatLine(""), { speaker: "", text: "" });
  assert.deepEqual(parseChatLine("<a b> hi"), { speaker: "a b", text: "hi" });
});

test("缓冲：容量上限、pending 只数别人的、reset 后清零", () => {
  const b = createChatBuffer({ capacity: 3 });
  b.push({ speaker: "a", text: "1" });
  b.push({ speaker: "a", text: "2" });
  b.push({ speaker: "b", text: "3" });
  assert.equal(b.size, 3);
  assert.equal(b.pending, 3);
  b.push({ speaker: "c", text: "4" });
  assert.equal(b.size, 3, "超出容量丢最老的");
  assert.deepEqual(b.recent(2).map((x) => x.text), ["3", "4"]);

  b.push({ speaker: "我", text: "自己说的", self: true });
  assert.equal(b.pending, 4, "自己的话不计入 pending");
  b.resetPending();
  assert.equal(b.pending, 0);
});

test("点名唤醒：立刻醒，并带最近 N 条上下文", () => {
  const buffer = bufWith([
    { speaker: "张三", text: "今天挖到钻石了" },
    { speaker: "张三", text: "小鱼你在吗" },
  ]);
  const v = decideWake({ buffer, names: ["小鱼"], contextLines: 5, now: 100_000, lastWakeAt: 0 });
  assert.equal(v.wake, true);
  assert.equal(v.reason, "mention");
  assert.equal(v.lines.length, 2, "应把这两句都带上");
  assert.ok(v.lines[1].text.includes("小鱼"));
});

test("氛围唤醒：没点名，但攒够新消息且冷却过了就叫她一次", () => {
  const buffer = bufWith([
    { speaker: "张三", text: "走走走挖矿去" },
    { speaker: "李四", text: "等我拿下镐子" },
    { speaker: "张三", text: "快点啊" },
  ]);
  const v = decideWake({
    buffer,
    names: ["小鱼"],
    ambientMinNew: 3,
    ambientCooldownMs: 90_000,
    now: 200_000,
    lastWakeAt: 0,
  });
  assert.equal(v.wake, true);
  assert.equal(v.reason, "ambient");

  const few = bufWith([
    { speaker: "张三", text: "a" },
    { speaker: "张三", text: "b" },
  ]);
  assert.equal(decideWake({ buffer: few, names: [], ambientMinNew: 3, now: 200_000 }).wake, false);

  assert.equal(
    decideWake({ buffer, names: [], ambientMinNew: 3, ambientCooldownMs: 90_000, now: 200_000, lastWakeAt: 190_000 })
      .reason,
    "ambient-cooldown",
  );
});

test("ambient:false 时退回「只被点名」", () => {
  const buffer = bufWith([
    { speaker: "张三", text: "a" },
    { speaker: "张三", text: "b" },
    { speaker: "张三", text: "c" },
  ]);
  const v = decideWake({ buffer, names: ["小鱼"], ambient: false, ambientMinNew: 3, now: 200_000 });
  assert.equal(v.wake, false);
  assert.equal(v.reason, "not-mentioned");
});

test("自己说的最后一句不唤醒；唤醒后 pending 清零（下次重新攒）", () => {
  const buffer = bufWith([
    { speaker: "张三", text: "小鱼在吗" },
    { speaker: "小鱼", text: "我在", self: true },
  ]);
  assert.equal(decideWake({ buffer, names: ["小鱼"], now: 100_000 }).wake, false);

  const b2 = bufWith([
    { speaker: "张三", text: "a" },
    { speaker: "张三", text: "b" },
    { speaker: "张三", text: "c" },
  ]);
  const v = decideWake({ buffer: b2, names: [], ambientMinNew: 3, now: 200_000 });
  assert.equal(v.wake, true);
  b2.resetPending();
  assert.equal(b2.pending, 0);
});

test("上下文块：带说话人、自标 <我>、结尾按原因给不同提示", () => {
  const lines = [
    { speaker: "张三", text: "挖矿去" },
    { speaker: "小鱼", text: "来了", self: true },
    { speaker: "张三", text: "小鱼快点" },
  ];
  const mention = formatChatContext(lines, { reason: "mention" });
  assert.ok(mention.includes("【MC 公屏 · 最近 3 条】"));
  assert.ok(mention.includes("<张三> 挖矿去"));
  assert.ok(mention.includes("<我> 来了"), "自己说的要标成 <我>，她才分得清谁说的");
  assert.ok(mention.includes("在叫你"));

  const ambient = formatChatContext(lines, { reason: "ambient" });
  assert.ok(ambient.includes("没人点你名"));
  assert.ok(ambient.includes("不想接就什么都别做"));
  assert.equal(formatChatContext([], { reason: "ambient" }), "");
});

test("SSE：只挑 chat，注释与心跳不影响，断流不重放", async () => {
  const chunks = [
    ": ping\n\n",
    'data: {"kind":"chat","text":"<张三> 小鱼在吗","t":1}\n\n',
    'data: {"kind":"step","intent":"MINE","ok":true}\n\n',
    'data: {"kind":"chat","text":"<李四> 你好","t":2}\n\n',
  ];
  let called = 0;
  let fetches = 0;
  const fakeFetch = async () => {
    fetches += 1;
    if (fetches > 1) throw new Error("stream closed");
    return {
      ok: true,
      body: {
        getReader() {
          let i = 0;
          return {
            async read() {
              if (i >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: new TextEncoder().encode(chunks[i++]) };
            },
          };
        },
      },
    };
  };

  const chats = [];
  const others = [];
  let errors = 0;
  const stream = openChatStream({
    url: "http://x/events",
    fetchImpl: fakeFetch,
    onChat: (e) => {
      called += 1;
      chats.push(e.text);
    },
    onOther: (e) => others.push(e.kind),
    onError: () => {
      errors += 1;
    },
    retryMs: 10,
  });

  await new Promise((r) => setTimeout(r, 60));
  stream.stop();

  assert.equal(called, 2, `应只收到 2 条 chat，实际 ${called}`);
  assert.ok(chats[0].includes("小鱼在吗"));
  assert.deepEqual(others, ["step"]);
  assert.ok(errors >= 1);
  assert.equal(stream.stopped, true);
});

test("SSE：连接失败调用 onError 而不是抛", async () => {
  let errored = null;
  const stream = openChatStream({
    url: "http://x/events",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    onError: (e) => {
      errored = e;
    },
    retryMs: 5,
  });
  await new Promise((r) => setTimeout(r, 30));
  stream.stop();
  assert.ok(errored);
  assert.match(String(errored.message), /ECONNREFUSED/);
});

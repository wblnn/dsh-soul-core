/**
 * 预检索测试：Harness 层自动"把相关记忆摆到她面前"。
 *
 * 这条通道的意义：只给模型一个 recall 工具 = 指望它自己想"我该查一下"，
 * 而没有任何信号提示"这里有相关记忆"。预检索负责那个信号。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanQuery, formatPrefetch } from "../lib/prefetch.js";

test("cleanQuery：剥掉信封与说话人标签，只留可检索的词", () => {
  const raw = "【MC 公屏 · 最近 5 条】\n<dsh_bot> 记录说是被苦力怕炸死的\n<WLTtSA> 逆天";
  const q = cleanQuery(raw);
  assert.ok(!q.includes("【"), "信封要去掉");
  assert.ok(!q.includes("<dsh_bot>"), "说话人标签要去掉");
  assert.ok(q.includes("苦力怕炸死"), `正文要留下，实际：${q}`);

  assert.equal(cleanQuery(""), "");
  assert.ok(cleanQuery("x".repeat(500)).length <= 160, "长度要截断");

  // 普通句子原样可用
  assert.equal(cleanQuery("上次挖矿那事你还记得吗"), "上次挖矿那事你还记得吗");
});

test("formatPrefetch：空输入返回空串（不往上下文塞空标题）", () => {
  assert.equal(formatPrefetch({ notes: [], messages: [] }, { query: "x" }), "");
});

test("formatPrefetch：摘要带锚点 + 明确标「细节已省略」", () => {
  const text = formatPrefetch(
    {
      notes: [
        {
          title: "定下了说话方式",
          summary: "对方要求先给结论再给理由",
          sessionId: "session-abcdef123456789",
          seqStart: 22,
          seqEnd: 40,
          venue: "chat",
        },
      ],
      messages: [{ role: "user", text: "我喜欢先看结论", seq: 12 }],
    },
    { query: "先给结论", budget: 900 },
  );

  assert.ok(text.includes("可能相关的记忆"), "要有标题");
  assert.ok(text.includes("按你刚说的话自动检索"), "要说清这是自动检索的");
  assert.ok(text.includes("不用你主动查"), "要免除她的行动压力");
  assert.ok(text.includes("先给结论"), "摘要要出现");
  assert.ok(text.includes("#22-40"), "要带锚点");
  assert.ok(text.includes("细节省略"), "必须标出「摘要不全」这个下钻信号");
  assert.ok(text.includes("memory_expand"), "要告诉她用什么下钻");
  assert.ok(text.includes("原话·user"), "原话命中要标来源");
});

test("formatPrefetch：受预算限制，超了就不塞", () => {
  const notes = Array.from({ length: 10 }, (_, i) => ({
    title: `记忆${i}`,
    summary: "很长的摘要".repeat(30),
    sessionId: "session-x",
    seqStart: i,
    seqEnd: i + 1,
    venue: "mc",
  }));
  const tight = formatPrefetch({ notes, messages: [] }, { query: "x", budget: 400 });
  const roomy = formatPrefetch({ notes, messages: [] }, { query: "x", budget: 3000 });
  assert.ok(tight.length <= 460, `预算应生效，实际 ${tight.length}`);
  assert.ok(roomy.length > tight.length, "预算大应该塞更多");
});

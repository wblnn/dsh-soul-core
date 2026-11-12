/**
 * 聊天域 vs 游戏域的边界：她不能在本对话里"过来"。
 *
 * 起因：纯人格会话里她没有任何 MC 工具，但她记得自己会玩，
 * 于是会答应「我这就过去」——然后什么也不会发生，主人等半天。
 * 这不是她撒谎，是她不知道自己现在没有身体。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { __resetSessionCache, apply } from "../lib/index.js";

const roots = [];
function renderBlock(config) {
  __resetSessionCache();
  const root = mkdtempSync(join(tmpdir(), "soul-bound-"));
  roots.push(root);
  const vars = {};
  const ctx = {
    logger: { info() {}, warn() {} },
    inject: (names, cb) => cb(Object.assign(Object.create(ctx), { agents: { list: () => [] } })),
    systemPrompt: {
      variable: (n, fn) => {
        vars[n] = fn;
      },
      context: () => {},
    },
    tools: { register: () => {} },
    webServer: { register: () => ({}) },
  };
  apply(ctx, { root, ...config });
  return vars.soul_block ? vars.soul_block() : "";
}

after(() => {
  for (const d of roots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 句柄还开着 */
    }
  }
});

test("纯人格：知道自己能玩 MC，但在这个对话里动不了", () => {
  const block = renderBlock({ mode: "persona", domain: "persona" });
  assert.ok(block.includes("你现在在哪里"), "要有边界说明");
  assert.ok(block.includes("没有身体"), "要说清在这里没有身体");
  assert.ok(block.includes("人格 · 我的世界"), "要告诉她去哪儿才能玩");
  assert.ok(block.includes("过不去"), "要堵死『我这就过去』");
});

test("人格·我的世界：不说这句（那边她真有身体）", () => {
  const block = renderBlock({ mode: "persona", domain: "mc" });
  assert.ok(!block.includes("你现在在哪里"));
});

test("武装大肥鱼：不说这句（那边有手有工具）", () => {
  const block = renderBlock({ mode: "prompt", domain: "persona", handTools: true, moodful: false });
  assert.ok(!block.includes("你现在在哪里"));
});

test("边界说明不会太长（人格块预算有限）", () => {
  const block = renderBlock({ mode: "persona", domain: "persona" });
  const i = block.indexOf("## 你现在在哪里");
  const j = block.indexOf("## ", i + 3);
  const section = block.slice(i, j < 0 ? undefined : j);
  assert.ok(section.length < 260, `边界段 ${section.length} 字符，太长会挤掉别的`);
});

/**
 * 域专属记忆测试：MC 专项别污染每轮注入的 MEMORY.md。
 *
 * 起因（主人 2026-10-29）："能让她不要把 mc 专项记忆直接丢长期记忆里面去吗
 * 太吃上下文了吧 单独给我的世界模式准备一个要额外注入的上下文吧"
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DOMAIN_MEMORY_BUDGET,
  domainMemoryName,
  normalizeDomain,
  remember,
  renderDomainBlock,
  status,
} from "../lib/persona-api.js";

const roots = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "soul-domain-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

test("域名合法化：persona/chat 视为无域，路径穿越被拒", () => {
  assert.equal(normalizeDomain("mc"), "mc");
  assert.equal(normalizeDomain("MC"), "mc");
  assert.equal(normalizeDomain("persona"), "");
  assert.equal(normalizeDomain("chat"), "");
  assert.equal(normalizeDomain("../../etc"), "");
  assert.equal(normalizeDomain("a b"), "");
  assert.equal(domainMemoryName("persona"), "");
  assert.equal(domainMemoryName("mc"), "MEMORY.mc.md");
});

test("remember 带 domain → 写进 MEMORY.mc.md，不碰 MEMORY.md", () => {
  const root = tmp();
  const r = remember(root, {
    dim: "talk",
    text: "MC 里 (96,104,3) 这一片是我的家，不许乱挖",
    why: "游戏世界硬约束，搞错会拆掉主人建筑",
    domain: "mc",
  });

  assert.equal(r.file, "MEMORY.mc.md");
  assert.ok(existsSync(join(root, "MEMORY.mc.md")));
  const mc = readFileSync(join(root, "MEMORY.mc.md"), "utf8");
  assert.ok(mc.includes("不许乱挖"));
  assert.ok(mc.includes("## 对话里的事"), "沿用同一套 dim 小节");
  assert.ok(mc.includes("只在 mc 场景注入"), "文件头要说明它的作用域");

  // 全局记忆文件不该被创建/改动
  assert.equal(existsSync(join(root, "MEMORY.md")), false, "不该顺手创建 MEMORY.md");
});

test("remember 不带 domain → 仍然是全局 MEMORY.md", () => {
  const root = tmp();
  const r = remember(root, { dim: "user", text: "你喜欢先看结论", why: "稳定偏好" });
  assert.equal(r.file, "MEMORY.md");
  const md = readFileSync(join(root, "MEMORY.md"), "utf8");
  assert.ok(md.includes("你喜欢先看结论"));
  assert.equal(existsSync(join(root, "MEMORY.mc.md")), false);
});

test("两者互不串味：全局的不会进域文件，域的不会进全局", () => {
  const root = tmp();
  remember(root, { dim: "user", text: "全局偏好：先给结论", why: "稳定" });
  remember(root, { dim: "talk", text: "MC 家里别乱挖方块", why: "硬约束", domain: "mc" });

  const globalText = readFileSync(join(root, "MEMORY.md"), "utf8");
  const mcText = readFileSync(join(root, "MEMORY.mc.md"), "utf8");

  assert.ok(globalText.includes("先给结论"));
  assert.ok(!globalText.includes("乱挖方块"), "MC 规则不该出现在全局记忆里");

  assert.ok(mcText.includes("乱挖方块"));
  assert.ok(!mcText.includes("先给结论"), "全局偏好不好混进 MC 专项");
});

test("renderDomainBlock：只有对应域才渲染，空/不存在返回空串", () => {
  const root = tmp();
  assert.equal(renderDomainBlock(root, "mc"), "", "没有文件时必须是空串");
  assert.equal(renderDomainBlock(root, "persona"), "", "persona 没有域记忆");

  remember(root, { dim: "talk", text: "家在 (96,104,3)", why: "位置规则", domain: "mc" });

  const block = renderDomainBlock(root, "mc");
  assert.ok(block.includes("mc 专项记忆"));
  assert.ok(block.includes("家在 (96,104,3)"));
  assert.ok(block.includes("只在这个场景注入"), "要告诉她这块在别处看不到");

  assert.equal(renderDomainBlock(root, "qq"), "", "别的域看不到 mc 的记忆");
});

test("域记忆预算独立（2000），超了报错并提示用 soul_update 压缩", () => {
  const root = tmp();
  const huge = "很长的一条".repeat(400); // ≈2000 字符，加文件头必然超预算
  assert.throws(
    () => remember(root, { dim: "talk", text: huge, why: "测试预算", domain: "mc" }),
    new RegExp(`MEMORY\\.mc\\.md 会超预算`),
  );
  assert.ok(DOMAIN_MEMORY_BUDGET > 0);
});

test("status 里能看到域记忆文件及其预算", () => {
  const root = tmp();
  remember(root, { dim: "talk", text: "MC 家坐标", why: "位置", domain: "mc" });
  const st = status(root);
  const mc = st.files.find((f) => f.name === "MEMORY.mc.md");
  assert.ok(mc, "status 应列出 MEMORY.mc.md");
  assert.equal(mc.budget, DOMAIN_MEMORY_BUDGET);
  assert.equal(mc.overBudget, false);
});

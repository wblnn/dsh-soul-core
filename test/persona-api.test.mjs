import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  DIMS,
  FILES,
  appendJournal,
  ensureSeed,
  neutralizeBraces,
  readAll,
  recall,
  remember,
  renderBlock,
  resolveRoot,
  status,
  updateFile,
} from "../lib/persona-api.js";

const roots = [];
function freshRoot() {
  const dir = mkdtempSync(join(tmpdir(), "soul-test-"));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("ensureSeed 播种 5 个文件 + journal/memory 目录，且幂等不覆盖", () => {
  const root = freshRoot();
  const first = ensureSeed(root);
  assert.equal(first.created.length, FILES.length);
  for (const f of FILES) assert.ok(readFileSync(join(root, f.name), "utf8").length > 0, f.name);
  assert.ok(readFileSync(join(root, "MEMORY.md"), "utf8").includes("关于我"));

  writeFileSync(join(root, "SOUL.md"), "# 手写的自我\n", "utf8");
  const second = ensureSeed(root);
  assert.deepEqual(second.created, []);
  assert.equal(readFileSync(join(root, "SOUL.md"), "utf8"), "# 手写的自我\n");
});

test("renderBlock 永不为空，且包含各文件标题与工具清单", () => {
  const root = freshRoot();
  ensureSeed(root);
  const block = renderBlock(root);
  assert.ok(block.trim().length > 0);
  for (const f of FILES) assert.ok(block.includes(f.title), `缺少标题 ${f.title}`);
  assert.ok(block.includes("soul_remember"));
  assert.ok(block.includes("soul_recall"));
});

test("空目录也返回兜底人格块（空系统提示词会被 DSH 清掉）", () => {
  const root = freshRoot();
  mkdirSync(root, { recursive: true });
  const block = renderBlock(root);
  assert.ok(block.trim().length > 0);
});

test("花括号被中和（相邻花括号会让 DSH 插值器抛错），且内容零丢失", () => {
  const root = freshRoot();
  ensureSeed(root);
  const raw = "# 声音\n口癖是 {{name}} 和 {{{{weird}}}}\n";
  writeFileSync(join(root, "SOUL.md"), raw, "utf8");
  const block = renderBlock(root);
  assert.ok(!/\{\{/.test(block), "渲染结果里不应残留相邻花括号");
  assert.ok(!/\}\}/.test(block), "渲染结果里不应残留相邻右花括号");
  // 去掉零宽空格后，渲染结果里应仍能读到原句
  const flat = block.replace(/\u200b/g, "");
  assert.ok(flat.includes("口癖是 {{name}} 和 {{{{weird}}}}"), "除插入的零宽空格外内容不应变化");
  assert.equal(neutralizeBraces("a{{b}}c").replace(/\u200b/g, ""), "a{{b}}c");
  assert.ok(!/\{\{/.test(neutralizeBraces("{{{{"))), "相邻串不得拼出新双括号";
});

test("renderBlock 尊重总预算并截断", () => {
  const root = freshRoot();
  ensureSeed(root);
  writeFileSync(join(root, "SOUL.md"), "# 声音\n" + "啰嗦".repeat(4000), "utf8");
  const block = renderBlock(root, { budget: 1500 });
  assert.ok(block.length <= 1500 + 40, `实际长度 ${block.length}`);
  assert.ok(block.includes("已截断") || block.includes("超预算"));
});

test("remember 写进对应维度小节，并拒绝非法 dim / 缺 why", () => {
  const root = freshRoot();
  ensureSeed(root);

  const r = remember(root, { dim: "lesson", text: "被追问细节时先查记忆再答", why: "上次编过一个细节" });
  assert.equal(r.section, DIMS.lesson);

  const md = readFileSync(join(root, "MEMORY.md"), "utf8");
  const lessonIdx = md.indexOf(`## ${DIMS.lesson}`);
  const bulletIdx = md.indexOf("被追问细节时先查记忆再答");
  assert.ok(lessonIdx >= 0 && bulletIdx > lessonIdx, "bullet 应落在该小节内");
  assert.ok(md.includes("why: 上次编过一个细节"));

  assert.throws(() => remember(root, { dim: "nope", text: "x", why: "y" }), /dim/);
  assert.throws(() => remember(root, { dim: "self", text: "x" }), /why 必填/);
});

test("remember 超预算时抛错而不是静默截断", () => {
  const root = freshRoot();
  ensureSeed(root);
  assert.throws(
    () => remember(root, { dim: "self", text: "很长的记忆".repeat(900), why: "压力测试" }),
    /超预算/,
  );
});

test("updateFile 拒绝只读 RULES.md，允许写且校验预算", () => {
  const root = freshRoot();
  ensureSeed(root);
  assert.throws(() => updateFile(root, { name: "RULES.md", content: "改掉", why: "想绕过" }), /只读/);
  const ok = updateFile(root, { name: "USER.md", content: "# 关于你\n- 喜欢结论先行\n", why: "观察三次" });
  assert.ok(ok.chars > 0);
  assert.ok(readFileSync(join(root, "USER.md"), "utf8").includes("结论先行"));
  assert.throws(
    () => updateFile(root, { name: "USER.md", content: "x".repeat(9999), why: "膨胀" }),
    /超预算/,
  );
});

test("journal 追加 + recall 能检索到（含中文双字切分）", () => {
  const root = freshRoot();
  ensureSeed(root);
  appendJournal(root, "今天她说不想再解释第二遍", { kind: "note" });
  const found = recall(root, "解释", { limit: 5 });
  assert.ok(found.hits.length >= 1, "应命中刚写的日记");
  assert.ok(found.hits[0].text.includes("解释"));
  assert.ok(found.hits[0].source.startsWith("memory/"));
});

test("recall 也能命中 MEMORY.md，并给出 file:line 溯源", () => {
  const root = freshRoot();
  ensureSeed(root);
  remember(root, { dim: "pref", text: "偏好先给结论再给理由", why: "反复提过" });
  const found = recall(root, "结论");
  assert.ok(found.hits.length >= 1);
  assert.ok(found.hits[0].source.startsWith("MEMORY.md:"));
});

test("status 汇总字符/预算/条目数", () => {
  const root = freshRoot();
  ensureSeed(root);
  remember(root, { dim: "self", text: "我是会记错的那种", why: "认了" });
  appendJournal(root, "一条观察");
  const st = status(root);
  assert.equal(st.root, root);
  assert.equal(st.files.length, FILES.length);
  assert.ok(st.totalChars > 0);
  assert.equal(st.journalToday, 2, "remember 会留一条审计日记 + 手写一条");
  assert.ok(st.memoryBullets >= 1);
  assert.deepEqual(readAll(root).map((f) => f.name), FILES.map((f) => f.name));
});

test("resolveRoot 优先级：显式 > DSH_SOUL_ROOT > DSH_HOME/soul", () => {
  const saved = { soul: process.env.DSH_SOUL_ROOT, home: process.env.DSH_HOME };
  try {
    process.env.DSH_SOUL_ROOT = join(tmpdir(), "env-soul");
    process.env.DSH_HOME = join(tmpdir(), "env-home");
    assert.equal(resolveRoot("/tmp/explicit-soul").endsWith("explicit-soul"), true);
    assert.equal(resolveRoot(), join(tmpdir(), "env-soul"));
    delete process.env.DSH_SOUL_ROOT;
    assert.equal(resolveRoot(), join(tmpdir(), "env-home", "soul"));
    process.env.DSH_HOME = "   ";
    assert.ok(resolveRoot().includes(".dsh"));
  } finally {
    if (saved.soul === undefined) delete process.env.DSH_SOUL_ROOT;
    else process.env.DSH_SOUL_ROOT = saved.soul;
    if (saved.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.home;
  }
});

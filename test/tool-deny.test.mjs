/**
 * 联网工具封禁测试：她有手了，但不该有"上网查"的手。
 *
 * 机制：`ctx.tools.restrict({ deny })` 是 per-agent 的（DSH 原生），
 * 只影响她那个 agent；她自己的 scoped 工具（soul_/memory_/skill_）不受影响。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { apply } from "../lib/index.js";

const roots = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "soul-deny-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** 造一个"她的会话"：全局有搜索工具，scope 里有我们自己的工具。 */
function makeAgent({ restrictableNames, failRestrict = false, id = "sess-x", preset = "soul" }) {
  const calls = [];
  const ctx = {
    tools: {
      view: () => ({ restrictableNames: new Set(restrictableNames) }),
      restrict(filter) {
        if (failRestrict) throw new Error("boom");
        calls.push(filter);
        return () => {};
      },
    },
  };
  return { id, preset, ctx, calls };
}

function applyWithAgents(agent, config = {}, others = []) {
  const tools = [];
  let variableFn = null;
  const hostCtx = {
    logger: { info() {}, warn() {} },
    inject: (names, cb) => {
      if (names.includes("agents")) return cb({ agents: { get: () => agent, list: () => [agent, ...others] } });
      return cb(hostCtx);
    },
    systemPrompt: { variable: (n, fn) => { if (n === "soul_block") variableFn = fn; } },
    tools: { register: (d) => tools.push(d) },
    webServer: { register: () => ({}) },
  };
  apply(hostCtx, { mode: "persona", root: tmp(), ...config });
  return { tools, variableFn };
}

test("第一次工具调用时禁掉联网工具，且不误伤自己的工具", async () => {
  const agent = makeAgent({
    restrictableNames: ["bing_search__standard", "web_fetch", "soul_status", "memory_search", "skill_recall"],
  });
  const { tools } = applyWithAgents(agent, { domain: "mc" });

  const status = tools.find((t) => t.name === "soul_status");
  assert.ok(status, "应有 soul_status");
  await status.execute({}, { sessionId: "sess-1" });

  assert.equal(agent.calls.length, 1, "应调用一次 restrict");
  const deny = agent.calls[0].deny;
  assert.ok(deny.includes("bing_search__standard"), `应禁 bing_search，实际 ${deny}`);
  assert.ok(deny.includes("web_fetch"), `应禁 web_fetch，实际 ${deny}`);
  assert.ok(!deny.includes("memory_search"), "自己的 memory_search 不能被禁");
  assert.ok(!deny.includes("skill_recall"), "自己的 skill_recall 不能被禁");
  assert.ok(!deny.includes("soul_status"), "自己的 soul_status 不能被禁");
});

test("同一会话只封一次（第二次调用不再 restrict）", async () => {
  const agent = makeAgent({ restrictableNames: ["web_fetch"] });
  const { tools } = applyWithAgents(agent, { domain: "persona" });

  await tools.find((t) => t.name === "soul_status").execute({}, { sessionId: "sess-2" });
  await tools.find((t) => t.name === "soul_status").execute({}, { sessionId: "sess-2" });
  assert.equal(agent.calls.length, 1);
});

test("没有联网工具可禁时不调用 restrict（避免空 filter 报错）", async () => {
  const agent = makeAgent({ restrictableNames: ["soul_status"] });
  const { tools } = applyWithAgents(agent, { domain: "persona" });
  await tools.find((t) => t.name === "soul_status").execute({}, { sessionId: "sess-3" });
  assert.equal(agent.calls.length, 0);
});

test("restrict 抛错也不影响工具本身", async () => {
  const agent = makeAgent({ restrictableNames: ["web_fetch"], failRestrict: true });
  const { tools } = applyWithAgents(agent, { domain: "persona" });
  const result = await tools.find((t) => t.name === "soul_status").execute({}, { sessionId: "sess-4" });
  assert.ok(result, "工具仍应返回结果");
  assert.ok(String(result.text ?? "").length > 0);
});

test("config.denyTools 能额外点名要禁的工具", async () => {
  const agent = makeAgent({ restrictableNames: ["qq_send__standard", "web_fetch"] });
  const { tools } = applyWithAgents(agent, { domain: "persona", denyTools: ["qq_send__standard"] });
  await tools.find((t) => t.name === "soul_status").execute({}, { sessionId: "sess-5" });
  const deny = agent.calls[0]?.deny ?? [];
  assert.ok(deny.includes("qq_send__standard"), `应额外禁掉点名的工具，实际 ${deny}`);
  assert.ok(deny.includes("web_fetch"), "联网类仍按特征禁");
});

test("组装人格块时就封（早于工具调用），且只封人格 preset 的会话", () => {
  const mine = makeAgent({ restrictableNames: ["bing_search__standard", "web_fetch"], id: "s-mc", preset: "soul-mc" });
  const theirs = makeAgent({ restrictableNames: ["web_fetch"], id: "s-work", preset: "standard" });
  const { variableFn } = applyWithAgents(mine, { domain: "mc" }, [theirs]);

  variableFn();
  assert.equal(mine.calls.length, 1, "她的会话应在组装阶段被 restrict");
  assert.ok(mine.calls[0].deny.includes("bing_search__standard"));
  assert.equal(theirs.calls.length, 0, "标准模式（工作会话）不许被动");

  variableFn();
  assert.equal(mine.calls.length, 1, "同一会话只封一次");
});

test("shell 类工具也在封禁范围（兜底：即使别的全局扩展提供了）", async () => {
  const agent = makeAgent({ restrictableNames: ["pwsh", "bash", "job_list", "soul_status", "skill_learn"] });
  const { tools } = applyWithAgents(agent, { domain: "persona" });
  await tools.find((x) => x.name === "soul_status").execute({}, { sessionId: "sess-6" });
  const deny = agent.calls[0]?.deny ?? [];
  assert.ok(deny.includes("pwsh"), "应禁 pwsh");
  assert.ok(deny.includes("bash"), "应禁 bash");
  assert.ok(!deny.includes("soul_status"), "不能误伤自己的工具");
  assert.ok(!deny.includes("skill_learn"), "不能误伤自己的工具");
});

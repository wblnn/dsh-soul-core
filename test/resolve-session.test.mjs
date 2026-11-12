/**
 * 当前会话解析：多个她同时活着时，挑主人正在说话的那条。
 *
 * 实测踩到的坑：原来只在"恰好一个会话活着"时返回 id。主人开着 MC 会话
 * 再开一个人格会话测跨对话 → 两个都活着 → 返回空串 → 记忆整段不注入，
 * 而日志里连一条 `memory:` 都没有（静默失效）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { __resetSessionCache, apply } from "../lib/index.js";
import { openStore } from "../lib/memory-store.js";
import { recordWorldEvent, setCursor } from "../lib/world.js";

const roots = [];
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "soul-resolve-"));
  roots.push(root);
  const home = join(root, ".dsh");
  mkdirSync(join(home, "sessions", "--ws--"), { recursive: true });
  return { root, home };
}
after(() => {
  // 插件在 apply 时会打开 memory.db 并缓存句柄；Windows 上删临时目录会 EPERM，忽略即可
  for (const d of roots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 句柄还开着，留给系统清理 */
    }
  }
  __resetSessionCache();
});

function touchSession(home, id, { mtimeMs }) {
  const dir = join(home, "sessions", "--ws--", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  writeFileSync(file, Buffer.alloc(8));
  utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return { id, file };
}

function mountPersona(root, agents) {
  const vars = {};
  const ctx = {
    logger: { info() {}, warn() {} },
    inject: (names, cb) => cb(Object.assign(Object.create(ctx), { agents: { list: () => agents } })),
    systemPrompt: {
      variable: (n, fn) => {
        vars[n] = fn;
      },
      context: () => {},
    },
    tools: { register: () => {} },
    webServer: { register: () => ({}) },
  };
  apply(ctx, { mode: "persona", domain: "persona", root });
  return vars;
}

/** 造一条"她不在场时发生的事"，并把光标拨到它之前。 */
function seedDelta(root, sessionId) {
  const db = openStore(join(root, "memory-tree", "memory.db"));
  setCursor(db, sessionId, Date.now() - 60_000);
  recordWorldEvent(db, { kind: "death", severity: "P0", text: "被骷髅射死，掉了一把铁剑", atMs: Date.now() - 1000 });
  db.close();
}

test("多个她会话同时活着：挑会话文件最新的那个", () => {
  __resetSessionCache();
  const { root, home } = sandbox();
  process.env.DSH_HOME = home;

  const oldOne = touchSession(home, "session-old-0001", { mtimeMs: Date.now() - 3600_000 });
  const newOne = touchSession(home, "session-new-0002", { mtimeMs: Date.now() - 1000 });

  const agents = [
    { session: { header: { id: oldOne.id } }, agentPreset: "soul-mc" },
    { session: { header: { id: newOne.id } }, agentPreset: "soul" },
  ];
  const vars = mountPersona(root, agents);

  seedDelta(root, newOne.id);

  const text = vars.soul_memory ? vars.soul_memory() : "";
  assert.ok(text.includes("铁剑"), `应该挑到新会话并注入，实际 ${JSON.stringify(text)}`);
});

test("只有一个她会话活着：直接用那一个", () => {
  __resetSessionCache();
  const { root, home } = sandbox();
  process.env.DSH_HOME = home;
  const only = touchSession(home, "session-only-0001", { mtimeMs: Date.now() });
  const vars = mountPersona(root, [{ session: { header: { id: only.id } }, agentPreset: "soul" }]);
  seedDelta(root, only.id);
  assert.ok(vars.soul_memory().includes("铁剑"));
});

test("没有她会话活着：不注入，且不能炸", () => {
  __resetSessionCache();
  const { root, home } = sandbox();
  process.env.DSH_HOME = home;
  const vars = mountPersona(root, []);
  assert.equal(vars.soul_memory(), "");
});

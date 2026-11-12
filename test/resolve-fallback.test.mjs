/**
 * 解析兜底：AGENTS.list() 里找不到人格会话时，直接从会话文件判断。
 *
 * 实测：`memory: 组装 why=no-session sid=(none)` —— 宿主给的 agent 对象里
 * 读不到 preset，于是整个解析返回空，记忆注入静默失效。
 * 会话文件里的 agent-preset/selected 才是权威，所以从文件兜底。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import zlib from "node:zlib";

import { __resetSessionCache, apply } from "../lib/index.js";
import { openStore } from "../lib/memory-store.js";
import { recordWorldEvent, setCursor } from "../lib/world.js";

const roots = [];
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "soul-fallback-"));
  roots.push(root);
  const home = join(root, ".dsh");
  mkdirSync(join(home, "sessions", "--ws--"), { recursive: true });
  return { root, home };
}
after(() => {
  for (const d of roots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 句柄还开着 */
    }
  }
  __resetSessionCache();
});

function frameOf(events) {
  return zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"));
}

/** 造一个真实的会话文件（header + 一条 preset 选择 + 一条消息）。 */
function makeSession(home, id, preset) {
  const dir = join(home, "sessions", "--ws--", id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.v4.jsonl.zstd");
  const header = { type: "session", version: 4, id, agentPreset: "standard", cwd: "F:/x" };
  const select = { type: "agent-preset/selected", seq: 2, time: Date.now(), data: { agentPreset: preset } };
  writeFileSync(file, Buffer.concat([frameOf([header]), frameOf([select])]));
  return file;
}

function mount(root, agents) {
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

test("agent 对象里读不到 preset 时：从会话文件兜底找到人格会话", () => {
  __resetSessionCache();
  const { root, home } = sandbox();
  process.env.DSH_HOME = home;

  const persona = makeSession(home, "session-file-soul-01", "soul");
  // 故意给一个 preset 读不出来的 agent 对象（模拟宿主形状不一致）
  const agents = [{ session: { header: { id: "session-file-soul-01" } } }];

  const vars = mount(root, agents);

  const db = openStore(join(root, "memory-tree", "memory.db"));
  setCursor(db, "session-file-soul-01", Date.now() - 60_000);
  recordWorldEvent(db, { kind: "death", severity: "P0", text: "被骷髅射死，掉了把铁剑", atMs: Date.now() - 1000 });
  db.close();

  const text = vars.soul_memory();
  assert.ok(text.includes("铁剑"), `文件兜底应生效，实际 ${JSON.stringify(text)}`);
  assert.ok(persona.length > 0);
});

test("最近的会话不是人格：不认，别乱认亲", () => {
  __resetSessionCache();
  const { root, home } = sandbox();
  process.env.DSH_HOME = home;

  makeSession(home, "session-standard-01", "standard");
  const vars = mount(root, []);
  assert.equal(vars.soul_memory(), "");
});

test("agent 对象没有 preset：日记唤醒那条路也能认出是她", () => {
  __resetSessionCache();
  const { root, home } = sandbox();
  process.env.DSH_HOME = home;
  makeSession(home, "session-diary-soul-1", "soul");

  // 只给 session id，不给 preset —— 和宿主真实形状一致
  const vars = mount(root, [{ session: { header: { id: "session-diary-soul-1" } } }]);

  const db = openStore(join(root, "memory-tree", "memory.db"));
  setCursor(db, "session-diary-soul-1", Date.now() - 60_000);
  recordWorldEvent(db, { kind: "death", severity: "P0", text: "又死了", atMs: Date.now() - 1000 });
  db.close();

  assert.ok(vars.soul_memory().includes("又死了"), "认出来了才会注入");
});

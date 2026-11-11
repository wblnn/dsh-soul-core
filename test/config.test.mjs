/**
 * 配置层测试：记忆库位置（root）与注入预算（injectBudget）。
 * 全部在临时 DSH_HOME 下进行，不碰真实的 ~/.dsh。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { apply } from "../lib/index.js";
import {
  CONFIG_FILE_NAME,
  DEFAULT_MEMORY_DIR_NAME,
  configPath,
  injectBudget,
  readConfig,
  renderBlock,
  resolveMemoryRoot,
  resolveMemoryRootSource,
  resolveRoot,
  resolveRootSource,
  writeConfig,
} from "../lib/persona-api.js";

let savedHome;
let savedSoulRoot;
let savedMemoryRoot;
let home;

before(() => {
  savedHome = process.env.DSH_HOME;
  savedSoulRoot = process.env.DSH_SOUL_ROOT;
  savedMemoryRoot = process.env.DSH_MEMORY_ROOT;
  delete process.env.DSH_SOUL_ROOT;
  delete process.env.DSH_MEMORY_ROOT;
  home = mkdtempSync(join(tmpdir(), "soul-cfg-"));
  process.env.DSH_HOME = home;
});

after(() => {
  if (savedHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedHome;
  if (savedSoulRoot !== undefined) process.env.DSH_SOUL_ROOT = savedSoulRoot;
  if (savedMemoryRoot === undefined) delete process.env.DSH_MEMORY_ROOT;
  else process.env.DSH_MEMORY_ROOT = savedMemoryRoot;
  rmSync(home, { recursive: true, force: true });
});

test("配置文件固定在 DSH home 下，坏文件按空配置处理", () => {
  assert.equal(configPath(), join(home, CONFIG_FILE_NAME));
  assert.deepEqual(readConfig(), {}, "文件不存在时返回空对象");
  assert.equal(resolveRootSource(), "default");
  assert.equal(resolveRoot(), join(home, "soul"));
});

test("记忆库默认并进人格目录，可被配置/环境变量改到别处", () => {
  // 默认：<人格目录>/memory-tree（一个自我一个文件夹）
  assert.equal(resolveMemoryRoot(join(home, "soul")), join(home, "soul", DEFAULT_MEMORY_DIR_NAME));
  assert.equal(resolveMemoryRootSource(), "default(co-located)");

  // 配置文件优先
  writeConfig({ memoryRoot: join(home, "elsewhere-tree") });
  assert.equal(resolveMemoryRoot(join(home, "soul")), join(home, "elsewhere-tree"));
  assert.equal(resolveMemoryRootSource(), "config-file");

  // 清空回落到环境变量
  writeConfig({ memoryRoot: "" });
  process.env.DSH_MEMORY_ROOT = join(home, "env-tree");
  assert.equal(resolveMemoryRoot(join(home, "soul")), join(home, "env-tree"));
  assert.equal(resolveMemoryRootSource(), "DSH_MEMORY_ROOT");

  // 显式参数最高
  assert.equal(resolveMemoryRoot(join(home, "soul"), join(home, "arg-tree")), join(home, "arg-tree"));

  delete process.env.DSH_MEMORY_ROOT;
  writeConfig({ memoryRoot: "" });
});

test("writeConfig 只接受已知字段并做范围校验", () => {
  const next = writeConfig({ root: "  F:\\temp\\soul-x  ", injectBudget: 9000, 垃圾: 1 });
  assert.equal(next.root, "F:\\temp\\soul-x");
  assert.equal(next.injectBudget, 9000);
  assert.equal(next["垃圾"], undefined, "未知字段不应写入");
  assert.ok(existsSync(configPath()), "配置文件应已落盘");

  assert.throws(() => writeConfig({ injectBudget: 10 }), /500–200000/);
  assert.throws(() => writeConfig({ injectBudget: "abc" }), /500–200000/);
});

test("root 优先级：显式 > 配置文件 > 环境变量 > 默认", () => {
  writeConfig({ root: join(home, "from-config") });
  process.env.DSH_SOUL_ROOT = join(home, "from-env");

  assert.equal(resolveRoot(), join(home, "from-config"), "配置文件压过环境变量");
  assert.equal(resolveRootSource(), "config-file");
  assert.equal(resolveRoot(join(home, "from-arg")), join(home, "from-arg"), "显式参数最高");

  writeConfig({ root: "" });
  assert.equal(resolveRoot(), join(home, "from-env"), "清空配置后回落到环境变量");
  assert.equal(resolveRootSource(), "DSH_SOUL_ROOT");

  delete process.env.DSH_SOUL_ROOT;
  assert.equal(resolveRoot(), join(home, "soul"));
  assert.equal(resolveRootSource(), "default");
});

test("注入预算：配置覆盖默认，renderBlock 按配置截断", () => {
  writeConfig({ injectBudget: 600 });
  assert.equal(injectBudget(), 600);
  const block = renderBlock(join(home, "soul-x"), {});
  assert.ok(block.length <= 640, `实际 ${block.length}`);

  writeConfig({ injectBudget: 11000 });
  assert.equal(injectBudget(), 11000);
});

test("POST /api/config 写盘并标记需要重启；GET 返回当前生效值", async () => {
  const root = join(home, "soul-route");
  const state = { routes: [], variables: {} };
  const ctx = {
    logger: { info() {}, warn() {} },
    inject: (_s, cb) => cb(ctx),
    systemPrompt: { variable: (n, fn) => { state.variables[n] = fn; } },
    tools: { register: () => () => {} },
    webServer: { register: (spec) => { state.routes.push(spec); return () => {}; } },
  };
  apply(ctx, { root });
  const handler = state.routes[0].handler;

  const call = async (url, opts = {}) => {
    const res = {
      statusCode: 0,
      body: "",
      writeHead(code) { this.statusCode = code; },
      end(b) { this.body = b; },
      json() { return JSON.parse(this.body); },
    };
    const chunks = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body), "utf8")];
    const req = {
      url,
      method: opts.method || "GET",
      headers: {
        host: "127.0.0.1:19387",
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
    };
    await handler(req, res);
    return res;
  };

  const got = await call("/dsh-soul/api/config");
  assert.equal(got.statusCode, 200);
  const gotBody = got.json();
  assert.equal(gotBody.ok, true);
  assert.equal(gotBody.root, root);
  assert.equal(typeof gotBody.configPath, "string");
  assert.equal(typeof gotBody.injectBudget, "number");

  const bad = await call("/dsh-soul/api/config", { method: "POST", body: { injectBudget: 5 }, origin: "http://127.0.0.1:19387" });
  assert.equal(bad.statusCode, 400, "越界预算应被拒");

  const posted = await call("/dsh-soul/api/config", {
    method: "POST",
    body: { root: join(home, "moved"), injectBudget: 8000 },
    origin: "http://127.0.0.1:19387",
  });
  assert.equal(posted.statusCode, 200);
  const postedBody = posted.json();
  assert.equal(postedBody.ok, true);
  assert.equal(postedBody.restartRequired, true, "改 root / 预算必须提示重启");
  assert.equal(readConfig().root, join(home, "moved"));
  assert.equal(readConfig().injectBudget, 8000);

  const cross = await call("/dsh-soul/api/config", { method: "POST", body: { root: "x" }, origin: "https://evil.example" });
  assert.equal(cross.statusCode, 403, "跨站写配置必须被拒");

  // 复原，避免影响后续测试
  writeConfig({ root: "", injectBudget: 11000 });
  assert.ok(readFileSync(configPath(), "utf8").includes("injectBudget"));
});

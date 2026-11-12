/**
 * 加载路径测试：用 mock ctx 跑一遍 apply()，验证
 *   1) 提示词变量 soul_block 注册且返回非空人格块
 *   2) 全部 soul_* / memory_* 工具注册成功（含参数 JSON Schema 与 output.render）
 *   3) /dsh-soul/api/* 路由注册且能应答
 *
 * 工具走本地 defineTool（lib/define-tool.js）——宿主里不 import 官方包，
 * 因为实测那条 await 会挂住，导致工具注册永不执行。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { apply } from "../lib/index.js";

/** 测试期间把 DSH_HOME 指到临时目录：否则摄取会去扫真实的 ~/.dsh/sessions。 */
let savedDshHome;
let fakeHome;
before(() => {
  savedDshHome = process.env.DSH_HOME;
  fakeHome = mkdtempSync(join(tmpdir(), "soul-home-"));
  process.env.DSH_HOME = fakeHome;
});
after(() => {
  if (savedDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = savedDshHome;
  try {
    rmSync(fakeHome, { recursive: true, force: true });
  } catch {
    /* noop */
  }
});

/** 所有域都有的工具。 */
const BASE_TOOLS = [
  "memory_annotate",
  "memory_episodes",
  "memory_expand",
  "memory_search",
  "person_link",
  "plan",
  "skill_learn",
  "skill_list",
  "skill_read",
  "skill_recall",
  "soul_diary",
  "soul_digest",
  "soul_journal",
  "soul_read",
  "soul_recall",
  "soul_remember",
  "soul_status",
  "soul_update",
];

/** mc_chat_* 只在 MC 域注册（纯人格里她永远不调，白占 ~455 tokens schema）。 */
const MC_ONLY_TOOLS = ["mc_chat_status", "mc_chat_watch"];

/** 某个域应该看到的工具清单。 */
const toolsFor = (domain) => [...BASE_TOOLS, ...(domain === "mc" ? MC_ONLY_TOOLS : [])].sort();

const roots = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "soul-load-"));
  roots.push(dir);
  return dir;
}
after(() => {
  // 尽力清理：SQLite 的 WAL 句柄可能还开着，删不掉就算了（临时目录归系统管）
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 句柄未释放时忽略 */
    }
  }
});

function makeCtx(root) {
  const state = { variables: {}, tools: [], routes: [], warnings: [], infos: [] };
  const ctx = {
    logger: {
      info: (m) => state.infos.push(String(m)),
      warn: (m) => state.warnings.push(String(m)),
    },
    inject: (_services, cb) => cb(ctx),
    systemPrompt: {
      variable: (name, fn) => {
        state.variables[name] = fn;
      },
    },
    tools: {
      register: (definition) => {
        state.tools.push(definition);
        return () => {};
      },
    },
    webServer: {
      register: (spec) => {
        state.routes.push(spec);
        return () => {};
      },
    },
    config: { root },
  };
  return { ctx, state };
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: "",
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function fakeRequest(url, { method = "GET", body, origin, host = "127.0.0.1:19387", contentType } = {}) {
  const headers = { host };
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = contentType || "application/json";
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  return {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

test("apply() 同步注册变量 / 工具 / 路由（工具用本地 defineTool）", () => {
  const root = tmp();
  const { ctx, state } = makeCtx(root);

  const result = apply(ctx, { root });
  assert.equal(result, undefined, "apply 必须是同步的——任何 await 都可能让工具注册失效");

  assert.equal(typeof state.variables.soul_block, "function", "soul_block 变量必须注册");
  const block = state.variables.soul_block();
  assert.ok(typeof block === "string" && block.trim().length > 0, "人格块不能为空");
  assert.ok(block.includes("## 身份"), "人格块应包含身份段");
  assert.ok(!/\{\{/.test(block), "人格块不得含相邻花括号");

  assert.deepEqual(state.tools.map((t) => t.name).sort(), toolsFor("persona"));

  for (const tool of state.tools) {
    assert.equal(tool.parameters.type, "object", `${tool.name} 的参数应是 object schema`);
    assert.equal(typeof tool.parameters.properties, "object");
    assert.equal(typeof tool.output.render, "function", `${tool.name} 需要 output.render`);
    assert.ok(tool.description.length > 20, `${tool.name} 的 description 要给模型看`);
    // 回归钉子：render 必须返回内容块数组。返回字符串会让运行时炸在
    // result.content.some(...)，症状是所有工具调用报 content.some is not a function。
    const rendered = tool.output.render({}, { text: "x", ok: true });
    assert.ok(Array.isArray(rendered), `${tool.name}.output.render 必须返回数组，不能是字符串`);
    assert.ok(rendered.length > 0);
    assert.equal(rendered[0].type, "text", `${tool.name}.output.render 的元素应是 text 块`);
    assert.equal(typeof rendered[0].text, "string");
  }

  assert.equal(state.routes.length, 1);
  assert.equal(state.routes[0].path, "/dsh-soul");
  assert.equal(state.routes[0].kind, "prefix");
});

test("mode 分工：ui 实例只挂路由，persona 实例只挂变量+工具", () => {
  const rootUi = tmp();
  const ui = makeCtx(rootUi);
  apply(ui.ctx, { root: rootUi, mode: "ui" });
  assert.equal(ui.state.routes.length, 1, "ui 实例必须挂路由");
  assert.equal(Object.keys(ui.state.variables).length, 0, "ui 实例不应注册 soul_block");
  assert.equal(ui.state.tools.length, 0, "ui 实例不应注册任何模型工具——否则工作会话也能看见");

  const rootP = tmp();
  const persona = makeCtx(rootP);
  apply(persona.ctx, { root: rootP, mode: "persona" });
  assert.equal(persona.state.routes.length, 0, "persona 实例不重复挂路由（会与 ui 实例撞）");
  assert.equal(typeof persona.state.variables.soul_block, "function");
  assert.equal(persona.state.tools.length, toolsFor("persona").length);

  const rootF = tmp();
  const full = makeCtx(rootF);
  apply(full.ctx, { root: rootF });
  assert.equal(full.state.routes.length, 1, "缺省 full：两者都挂");
  assert.equal(full.state.tools.length, toolsFor("persona").length);
});

test("人格文件工具能真的干活：status / remember / recall / read / journal", async () => {
  const root = tmp();
  const { ctx, state } = makeCtx(root);
  apply(ctx, { root });

  const byName = Object.fromEntries(state.tools.map((t) => [t.name, t]));

  const status = await byName.soul_status.execute({}, {});
  assert.ok(status.text.includes("人格块"));

  const remembered = await byName.soul_remember.execute(
    { dim: "user", text: "喜欢结论先行", why: "说过三次" },
    {},
  );
  assert.ok(remembered.ok);
  assert.equal(remembered.section, "关于你");

  const found = await byName.soul_recall.execute({ query: "结论", limit: 5 }, {});
  assert.ok(found.hits.length >= 1);
  assert.ok(found.text.includes("结论"));

  const journaled = await byName.soul_journal.execute({ text: "今天聊得挺久" }, {});
  assert.ok(journaled.ok);

  const read = await byName.soul_read.execute({ name: "MEMORY.md" }, {});
  assert.ok(read.text.includes("喜欢结论先行"));

  await assert.rejects(
    () => byName.soul_update.execute({ name: "RULES.md", content: "x", why: "试试" }, {}),
    /只读/,
  );
});

test("记忆工具在空库上不炸：episodes / search / digest 都给出可读结果", async () => {
  const root = tmp();
  const { ctx, state } = makeCtx(root);
  apply(ctx, { root });
  const byName = Object.fromEntries(state.tools.map((t) => [t.name, t]));

  const episodes = await byName.memory_episodes.execute({ limit: 5 }, {});
  assert.ok(typeof episodes.text === "string" && episodes.text.length > 0);

  const search = await byName.memory_search.execute({ query: "随便什么" }, {});
  assert.ok(typeof search.text === "string");

  const digest = await byName.soul_digest.execute({}, {});
  assert.ok(typeof digest.text === "string" && digest.text.length > 0);

  await assert.rejects(
    () => byName.memory_expand.execute({ sessionId: "session-nope", seq: 1 }, {}),
    /未知会话/,
  );
});

test("同源校验：POST 必须同源，跨站 403，未知路由 404", async () => {
  const root = tmp();
  const { ctx, state } = makeCtx(root);
  apply(ctx, { root });
  const handler = state.routes[0].handler;

  const okRes = fakeResponse();
  await handler(fakeRequest("/dsh-soul/api/state"), okRes);
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.json().ok, true);
  assert.ok(okRes.json().status.files.length >= 5);

  const badRes = fakeResponse();
  await handler(
    fakeRequest("/dsh-soul/api/journal", { method: "POST", body: { text: "x" }, origin: "https://evil.example" }),
    badRes,
  );
  assert.equal(badRes.statusCode, 403);

  const goodRes = fakeResponse();
  await handler(
    fakeRequest("/dsh-soul/api/journal", {
      method: "POST",
      body: { text: "同源写入" },
      origin: "http://127.0.0.1:19387",
    }),
    goodRes,
  );
  assert.equal(goodRes.statusCode, 200);
  assert.equal(goodRes.json().ok, true);

  const missRes = fakeResponse();
  await handler(fakeRequest("/dsh-soul/api/nope"), missRes);
  assert.equal(missRes.statusCode, 404);
});

test("同源判定容错：localhost 与 127.0.0.1 互通、自定义 scheme 放行；公网 Origin 仍拒", async () => {
  const root = tmp();
  const { ctx, state } = makeCtx(root);
  apply(ctx, { root });
  const handler = state.routes[0].handler;

  const post = async (url, origin, extra = {}) => {
    const res = fakeResponse();
    await handler(fakeRequest(url, { method: "POST", body: { text: "t" }, origin, ...extra }), res);
    return res;
  };

  assert.equal((await post("/dsh-soul/api/journal", "http://localhost:19387")).statusCode, 200);
  assert.equal((await post("/dsh-soul/api/journal", "http://127.0.0.1", { host: "127.0.0.1:19387" })).statusCode, 200);
  assert.equal((await post("/dsh-soul/api/journal", "dsh-app://app")).statusCode, 200);
  assert.equal((await post("/dsh-soul/api/journal", "https://evil.example")).statusCode, 403);
  assert.equal((await post("/dsh-soul/api/journal", "not a url")).statusCode, 403);
  assert.equal(
    (
      await post("/dsh-soul/api/journal", "http://127.0.0.1:19387", {
        contentType: "application/x-www-form-urlencoded",
      })
    ).statusCode,
    415,
  );

  const log = readFileSync(join(root, "soul-core.log"), "utf8");
  assert.ok(log.includes("403 POST /api/journal"), "拒绝时应记录日志");
});

test("GET /api/block 返回模型会看到的系统提示词，且含工具清单", async () => {
  const root = tmp();
  const { ctx, state } = makeCtx(root);
  apply(ctx, { root });
  const res = fakeResponse();
  await state.routes[0].handler(fakeRequest("/dsh-soul/api/block"), res);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.block.includes("## 你手上的工具"), "complete 模式没有工具引导段，清单必须写进人格块");
  assert.ok(body.block.includes("memory_expand"));
  assert.ok(body.block.includes("soul_digest"));
});

test("自诊断日志写到人格目录，能看出各步骤是否落地", () => {
  const root = tmp();
  const { ctx } = makeCtx(root);
  apply(ctx, { root });
  const log = readFileSync(join(root, "soul-core.log"), "utf8");
  assert.ok(log.includes("apply()"), "应记录 apply 开始");
  assert.ok(log.includes("mountVariable done"));
  assert.ok(log.includes("mountTools done"), "工具挂载必须留下成功记录");
});

test("动手纪律只在有通用工具时注入（本体模式没有手，讲纪律反而分心）", async () => {
  const render = (config) => {
    const root = tmp();
    let blockFn = null;
    const ctx = {
      logger: { info() {}, warn() {} },
      inject: (s, cb) => cb(ctx),
      systemPrompt: { variable: (n, fn) => { if (n === "soul_block") blockFn = fn; } },
      tools: { register: () => {} },
      webServer: { register: () => ({}) },
    };
    apply(ctx, { root, ...config });
    return blockFn();
  };

  // 本体（人格 / MC）：没有通用工具 → 不注入纪律，也不提通用工具
  for (const domain of ["persona", "mc"]) {
    const block = render({ mode: "persona", domain });
    assert.ok(!block.includes("动手的时候"), domain + ": 本体模式不该有「动手的时候」");
    assert.ok(!block.includes("你还有一套通用工具"), domain + ": 本体模式不该提通用工具");
  }

  // 工作模式：handTools: true → 必须注入纪律
  const work = render({ mode: "prompt", domain: "persona", handTools: true });
  assert.ok(work.includes("动手的时候"), "工作模式缺「动手的时候」");
  assert.ok(work.includes("不许连续 3 次工具调用"), "工作模式缺连续 3 次规则");
  assert.ok(work.includes("soul_update"), "工作模式缺「改自己文件走 soul_update」");
  assert.ok(work.includes("你还有一套通用工具"), "工作模式应提到通用工具");
});

test("别处的记忆：只有能取的模式才给指路牌", async () => {
  const render = (config) => {
    const root = tmp();
    let blockFn = null;
    const ctx = {
      logger: { info() {}, warn() {} },
      inject: (s, cb) => cb(ctx),
      systemPrompt: { variable: (n, fn) => { if (n === "soul_block") blockFn = fn; } },
      tools: { register: () => {} },
      webServer: { register: () => ({}) },
    };
    apply(ctx, { root, ...config });
    return blockFn();
  };

  // 工作模式没有 soul_* 工具 → 不能给她一个取不到的指路牌
  const work = render({ mode: "prompt", domain: "persona", handTools: true });
  assert.ok(!work.includes("别处的记忆"), "工作模式不该出现「别处的记忆」");

  // 本体模式（有 soul_*）→ 允许出现（有内容才有；临时目录没有 MC 记忆，所以只断言不报错）
  const persona = render({ mode: "persona", domain: "persona" });
  assert.ok(typeof persona === "string" && persona.length > 0);
});

/**
 * QQ 模式：4 个 vdd 工具只在 qq 域放行，别的地方一律禁（省 schema + 不抢键盘焦点）。
 *
 * 这是 profile 级插件的工具，全局可见——所以必须由我们按域收窄。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { __resetSessionCache, apply } from "../lib/index.js";

const roots = [];
function render(domain) {
  __resetSessionCache();
  const root = mkdtempSync(join(tmpdir(), `soul-qq-${domain}-`));
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
  apply(ctx, { mode: "persona", domain, root });
  return { block: vars.soul_block ? vars.soul_block() : "", log: join(root, "soul-core.log") };
}

after(() => {
  for (const d of roots) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 句柄 */
    }
  }
});

test("qq 域：人格块里有 OneBot 操作说明", () => {
  const { block } = render("qq");
  assert.ok(block.includes("你在 QQ 上"), "要有场景说明");
  assert.ok(block.includes("协议端"), "要说清走协议端，不是截屏");
  assert.ok(block.includes("napcat_status"), "先看通道状态");
  assert.ok(block.includes("napcat_recent"), "要教她读上下文");
  assert.ok(block.includes("napcat_send"), "要教她怎么发");
  assert.ok(block.includes("napcat_wait"), "要告诉她是真推送，别轮询");
  assert.ok(block.includes("别一口气"), "群里别刷屏");
  assert.ok(block.includes("旧") && block.includes("备用"), "旧虚拟屏方案要说明已停用但保留");
});

test("非 qq 域：不该出现 QQ 说明", () => {
  for (const domain of ["persona", "mc"]) {
    const { block } = render(domain);
    assert.ok(!block.includes("你在 QQ 上"), `${domain} 不该有 QQ 说明`);
  }
});

test("工具按域收窄：旧虚拟屏工具全禁，OneBot 工具只在 qq 放行", async () => {
  // 直接验纯函数，别依赖宿主 restrict
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(src.includes("function scopedDenyFor"), "要有按域收窄的实现");
  assert.ok(src.includes("SCREEN_QQ_TOOLS"), "旧虚拟屏工具要有名单");
  assert.ok(src.includes("ONEBOT_QQ_TOOLS"), "OneBot 工具要有名单");
  // 旧的一律禁（不论哪个域）
  assert.ok(src.includes("...SCREEN_QQ_TOOLS"), "旧工具要永远追加到 deny");
  // 新工具只在非 qq 域禁
  assert.ok(src.includes('if (domainName !== "qq") deny.push(...ONEBOT_QQ_TOOLS)'), "新工具只在 qq 放行");
});

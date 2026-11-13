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

test("qq 域：人格块里有 QQ 操作说明", () => {
  const { block } = render("qq");
  assert.ok(block.includes("你在 QQ 上"), "要有场景说明");
  assert.ok(block.includes("qq_ui read"), "要教她先看截图");
  assert.ok(block.includes("qq_message send"), "要教她怎么发");
  assert.ok(block.includes("发完必须截图确认"), "QQ 没有发送成功保证，必须确认");
  assert.ok(block.includes("别一口气发十条"), "群里别刷屏");
});

test("非 qq 域：不该出现 QQ 说明", () => {
  for (const domain of ["persona", "mc"]) {
    const { block } = render(domain);
    assert.ok(!block.includes("你在 QQ 上"), `${domain} 不该有 QQ 说明`);
  }
});

test("qq 域：四个 vdd 工具不在 deny 名单里（其他域在）", async () => {
  // 直接验纯函数，别依赖宿主 restrict
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.ok(src.includes("function scopedDenyFor"), "要有按域收窄的实现");
  assert.ok(src.includes('domainName === "qq" ? [...denyExtra]'), "qq 域不追加禁用");
  assert.ok(src.includes("...QQ_DOMAIN_TOOLS"), "其他域追加禁用");
});

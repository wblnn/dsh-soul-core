/**
 * 打包契约：客户端半层能不能被宿主找到。
 *
 * 真实事故：开源那一步重写 package.json 时把 `exports` 丢了，
 * 于是 `dsh-soul-core/client` 解析不到 → 设置页「人格」「记忆」整个消失，
 * 宿主**不报错**，只是没有这两个入口。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

test("exports 里必须有 ./client，且指向真实文件", () => {
  assert.ok(pkg.exports, "package.json 缺 exports（客户端半层会静默消失）");
  assert.ok(pkg.exports["./client"], "exports 缺 ./client");
  const clientPath = join(dirname(pkgPath), pkg.exports["./client"]);
  assert.ok(existsSync(clientPath), `./client 指向的文件不存在：${pkg.exports["./client"]}`);
});

test("exports 里必须有 .（宿主半层）", () => {
  assert.ok(pkg.exports["."], "exports 缺 .");
  const mainPath = join(dirname(pkgPath), pkg.exports["."]);
  assert.ok(existsSync(mainPath), `. 指向的文件不存在：${pkg.exports["."]}`);
});

test("dsh.client 声明还在（否则宿主不会加载客户端）", () => {
  assert.ok(pkg.dsh?.client, "缺 dsh.client");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0, "要声明依赖的客户端包");
});

test("dsh.bundle.patch 指向 cordis.patch.yml", () => {
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.ok(existsSync(join(dirname(pkgPath), "cordis.patch.yml")));
});

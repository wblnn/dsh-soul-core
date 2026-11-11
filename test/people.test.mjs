/**
 * 「人」的跨场景身份测试：同一个你，在 MC/QQ 里不同名字。
 * 这是"不割裂"的地基——记忆跨场景共享了，认人还得跨场景认。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { linkPerson, loadPeople, peoplePath, renderPeopleBrief, resolvePerson } from "../lib/people.js";

const roots = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "soul-people-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("linkPerson：同一个人的 MC 名与 QQ 名挂到同一个键上", () => {
  const root = tmp();
  const r1 = linkPerson(root, { canonical: "主人", alias: "张三", venue: "mc", note: "他本人" });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.aliases.mc, ["张三"]);

  linkPerson(root, { canonical: "主人", alias: "qq昵称", venue: "qq" });
  const data = loadPeople(root);
  assert.deepEqual(data["主人"].mc, ["张三"]);
  assert.deepEqual(data["主人"].qq, ["qq昵称"]);
  assert.equal(data["主人"].note, "他本人");
  assert.ok(existsSync(peoplePath(root)), "people.json 应落盘");
});

test("linkPerson 幂等：同一个别名重复挂不会重复", () => {
  const root = tmp();
  linkPerson(root, { canonical: "主人", alias: "张三", venue: "mc" });
  linkPerson(root, { canonical: "主人", alias: "张三", venue: "mc" });
  assert.deepEqual(loadPeople(root)["主人"].mc, ["张三"]);
});

test("resolvePerson：任一场景的名字都能反查到同一个人", () => {
  const root = tmp();
  linkPerson(root, { canonical: "主人", alias: "张三", venue: "mc" });
  linkPerson(root, { canonical: "主人", alias: "qq昵称", venue: "qq" });

  const viaMc = resolvePerson(root, { name: "张三" });
  assert.equal(viaMc.canonical, "主人");
  assert.equal(viaMc.venue, "mc");

  const viaQq = resolvePerson(root, { name: "qq昵称" });
  assert.equal(viaQq.canonical, "主人");
  assert.equal(viaQq.venue, "qq");

  assert.equal(resolvePerson(root, { name: "路人甲" }), null);
  assert.equal(resolvePerson(root, { name: "" }), null);
});

test("注入块：压成一行，带场景标签；没人时返回空串", () => {
  const root = tmp();
  assert.equal(renderPeopleBrief(root), "", "没有 people.json 时必须是空串，不能塞空标题");

  linkPerson(root, { canonical: "主人", alias: "张三", venue: "mc", note: "他本人" });
  linkPerson(root, { canonical: "主人", alias: "qq昵称", venue: "qq" });
  linkPerson(root, { canonical: "同事", alias: "李四", venue: "mc" });

  const brief = renderPeopleBrief(root, { budget: 400 });
  assert.ok(brief.includes("同一个人在不同地方的名字"), "应有标题");
  assert.ok(brief.includes("主人"), "应含规范名");
  assert.ok(brief.includes("MC：张三"), "应标出 MC 名");
  assert.ok(brief.includes("QQ：qq昵称"), "应标出 QQ 名");
  assert.ok(brief.includes("同事"));

  const tight = renderPeopleBrief(root, { budget: 60 });
  assert.ok(tight.length <= 130, `预算应生效，实际 ${tight.length}`);
});

test("损坏的 people.json 不让插件炸", () => {
  const root = tmp();
  linkPerson(root, { canonical: "主人", alias: "张三", venue: "mc" });
  // 手动写坏
  const p = peoplePath(root);
  writeFileSync(p, "{ 这不是 JSON", "utf8");
  assert.deepEqual(loadPeople(root), {}, "坏文件按空处理");
  assert.equal(renderPeopleBrief(root), "");
  // 还能继续写（不因为坏文件永久失效）
  const r = linkPerson(root, { canonical: "主人", alias: "阿鱼", venue: "chat" });
  assert.equal(r.ok, true);
  assert.ok(readFileSync(p, "utf8").includes("阿鱼"));
});

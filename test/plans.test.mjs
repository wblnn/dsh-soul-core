/**
 * 计划表测试：她自己认下来的事。
 *
 * 三条硬约束对应三个真实风险：
 *   ① 标 done 必须有证据（否则"我成功了"就能给自己发奖）
 *   ② 主动放弃不扣分（否则她不敢开新项目）
 *   ③ 注入只给 3 行 / 140 字符（整张表注入就变成待办清单了）
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  MAX_ACTIVE,
  addPlan,
  autoDropStale,
  listPlans,
  planStats,
  readBook,
  renderPlansBlock,
  updatePlan,
} from "../lib/plans.js";

const roots = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "soul-plan-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

test("加计划：落文件、有 id、默认 todo", () => {
  const root = tmp();
  const r = addPlan(root, { title: "把屋顶封完", origin: "self", note: "差 3 块木板" });
  assert.equal(r.ok, true);
  assert.equal(r.item.status, "todo");
  assert.equal(r.item.origin, "self");
  assert.ok(r.item.id.length > 0);

  const book = readBook(root);
  assert.equal(book.items.length, 1);
});

test("加计划：同名活跃条目不会重复登记", () => {
  const root = tmp();
  addPlan(root, { title: "把屋顶封完" });
  const again = addPlan(root, { title: "把屋顶封完" });
  assert.equal(again.duplicate, true);
  assert.equal(readBook(root).items.length, 1);
});

test("加计划：空名字 / 超长名字要拒", () => {
  const root = tmp();
  assert.throws(() => addPlan(root, { title: "  " }), /得有名字/);
  assert.throws(() => addPlan(root, { title: "很长".repeat(40) }), /太长/);
});

test("标 done 必须有证据（不许自己给自己发奖）", () => {
  const root = tmp();
  addPlan(root, { title: "挖够 60 铁" });

  assert.throws(() => updatePlan(root, { id: "挖够 60 铁", status: "done" }), /要有证据/);
  assert.equal(readBook(root).items[0].status, "todo", "被拒后状态不变");

  const ok = updatePlan(root, {
    id: "挖够 60 铁",
    status: "done",
    evidence: "MC goal-done 且背包 60 铁",
  });
  assert.equal(ok.item.status, "done");
  assert.equal(ok.item.evidence, "MC goal-done 且背包 60 铁");
});

test("失败累加：attempts 增长，状态回到 doing", () => {
  const root = tmp();
  addPlan(root, { title: "盖屋顶" });
  updatePlan(root, { id: "盖屋顶", status: "fail" });
  const r = updatePlan(root, { id: "盖屋顶", status: "fail" });
  assert.equal(r.item.attempts, 2);
  assert.equal(r.item.lastOutcome, "fail");
  assert.equal(r.item.status, "doing");
});

test("主动放弃不扣分，也不删（留痕）", () => {
  const root = tmp();
  addPlan(root, { title: "学红石" });
  const r = updatePlan(root, { id: "学红石", status: "dropped", note: "暂时没兴趣" });
  assert.equal(r.item.status, "dropped");
  assert.equal(r.item.note, "暂时没兴趣");
  assert.equal(planStats(root).dropped, 1);
});

test("上限：活跃条目超了就归档最老的，不删", () => {
  const root = tmp();
  for (let i = 0; i < MAX_ACTIVE + 3; i++) {
    addPlan(root, { title: `计划${i}` });
  }
  const s = planStats(root);
  assert.ok(s.active <= MAX_ACTIVE, `活跃条目应 ≤${MAX_ACTIVE}，实际 ${s.active}`);
  assert.ok(s.dropped >= 3, "被挤出去的应该变成 dropped（留痕），不是删除");
  assert.equal(s.total, MAX_ACTIVE + 3);
});

test("僵尸计划：太久没动自动归档", async () => {
  const root = tmp();
  addPlan(root, { title: "爬上那座山" });
  // 手动把时间往前拨
  const { writeFileSync } = await import("node:fs");
  const book = readBook(root);
  book.items[0].updatedAt = new Date(Date.now() - 10 * 86400_000).toISOString();
  writeFileSync(join(root, "plans.json"), JSON.stringify(book), "utf8");

  const dropped = autoDropStale(root, { days: 7 });
  assert.equal(dropped.length, 1);
  assert.equal(readBook(root).items[0].status, "dropped");
  assert.match(readBook(root).items[0].note, /自动归档/);
});

test("注入：只给活跃条目，最多 3 行，且守 140 字符预算", () => {
  const root = tmp();
  assert.equal(renderPlansBlock(root), "", "没有计划就不注入");

  addPlan(root, { title: "把屋顶封完", origin: "self", note: "差 3 块木板" });
  addPlan(root, { title: "陪他打通那个洞", origin: "owner" });
  addPlan(root, { title: "看会儿视频", origin: "self" });
  addPlan(root, { title: "第四条不该出现", origin: "self" });

  const block = renderPlansBlock(root);
  assert.ok(block.startsWith("## 你手上的事"));
  const lines = block.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(lines.length <= 3, `最多 3 行，实际 ${lines.length}`);
  assert.ok(block.length <= 140, `预算 140，实际 ${block.length}`);
  assert.ok(block.includes("他交办的"), "owner 来源要标出来");

  // 完成后不再占位置
  updatePlan(root, { id: "陪他打通那个洞", status: "done", evidence: "他说打通了" });
  assert.ok(!renderPlansBlock(root).includes("陪他打通那个洞"));
});

test("统计：按来源分开算（自己 vs 他人交办）", () => {
  const root = tmp();
  addPlan(root, { title: "自己想做的一" });
  addPlan(root, { title: "自己想做的二" });
  addPlan(root, { title: "他让做的", origin: "owner" });
  addPlan(root, { title: "身体给的目标", origin: "mc-goal" });

  const s = planStats(root);
  assert.equal(s.byOrigin.self, 2);
  assert.equal(s.byOrigin.owner, 1);
  assert.equal(s.byOrigin["mc-goal"], 1);
});

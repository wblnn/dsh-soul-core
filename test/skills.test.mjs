/**
 * 技能层测试：她"在游玩中学会技巧"的落盘与召回。
 *
 * 关键约束：
 *   - 技能是**文件**（可读可改可 diff），不是数据库行
 *   - 每条必须有 evidence（从哪次实践学来的），否则拒收——没有实践依据的"技巧"就是编
 *   - confidence = 成功次数 / 总次数，靠真实实践涨落
 *   - 注入只给名字 + 何时用，正文靠 skill_read（省预算）
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { listSkills, parseSkill, readSkill, recallSkills, renderSkillBrief, saveSkill, slugOf } from "../lib/skills.js";

const roots = [];
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "soul-skill-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("skill_learn：写进 skills/<域>/<名字>.md，frontmatter 齐全", () => {
  const root = tmp();
  const r = saveSkill(root, {
    name: "挖矿用两格高坑道",
    domain: "mc",
    when: "需要往地下挖一条自己能走进去的路",
    steps: ["调 mcc_tunnel blocks=N", "每挖 3 格用 mcc_state 看一次坐标", "脚下 4 格无方块时先蹲再挖"],
    lessons: "一格高的洞自己走不进去，白挖。",
    trigger: "挖矿,隧道,坑道,tunnel",
    evidence: "soul-mc session-abc#120-140：用一格高挖了三格，自己卡在洞里",
    result: "failed",
    note: "洞太窄",
  });

  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.successes, 0);
  assert.equal(r.confidence, 0);

  const path = join(root, "skills", "mc", `${slugOf("挖矿用两格高坑道")}.md`);
  assert.ok(existsSync(path), "技能文件应落盘");
  const text = readFileSync(path, "utf8");
  const parsed = parseSkill(text);
  assert.equal(parsed.meta.domain, "mc");
  assert.equal(parsed.meta.name, "挖矿用两格高坑道");
  assert.ok(parsed.body.includes("## 什么时候用"));
  assert.ok(parsed.body.includes("## 步骤"));
  assert.ok(parsed.body.includes("## 实践记录"));
  assert.ok(parsed.body.includes("❌ 失败"), "失败也要记下来");
});

test("skill_learn：同名再写一次 = 追加实践并更新置信度（成功/失败都算）", () => {
  const root = tmp();
  const base = {
    name: "打跑动中的玩家",
    domain: "mc",
    when: "玩家在跑，站着砍打不到",
    steps: ["mcc_look_at 对准胸口", "疾跑平砍，不要停下"],
    trigger: "打架,pvp,追人",
    evidence: "soul-mc session-x#40：站桩砍空三刀",
    result: "failed",
  };
  saveSkill(root, base);
  const second = saveSkill(root, { ...base, evidence: "soul-mc session-x#88：改用疾跑，2.4 秒击杀", result: "worked" });
  assert.equal(second.created, false);
  assert.equal(second.attempts, 2);
  assert.equal(second.successes, 1);
  assert.equal(second.confidence, 0.5);

  const third = saveSkill(root, { ...base, evidence: "soul-mc session-x#120：又成功", result: "worked" });
  assert.equal(third.confidence, 0.67);

  const full = readSkill(root, { domain: "mc", slug: "打跑动中的玩家" });
  assert.equal((full.body.match(/^- /gm) || []).length, 3, "三条实践记录都应保留");
});

test("校验：没有 evidence / 没有 when / 没有步骤 一律拒收（不许编技巧）", () => {
  const root = tmp();
  assert.throws(() => saveSkill(root, { name: "x", when: "y", steps: ["z"] }), /evidence 必填/);
  assert.throws(() => saveSkill(root, { name: "x", steps: ["z"], evidence: "e" }), /when 必填/);
  assert.throws(() => saveSkill(root, { name: "x", when: "y", steps: [], evidence: "e" }), /至少一步/);
  assert.throws(() => saveSkill(root, { name: "", when: "y", steps: ["z"], evidence: "e" }), /name 必填/);
});

test("检索：触发词权重最高，其次名字，最后正文", () => {
  const root = tmp();
  saveSkill(root, {
    name: "过岩浆",
    domain: "mc",
    when: "前面有岩浆池要过去",
    steps: ["先 mcc_scan blocks filter=lava 找最窄处", "垫方块过去，别跳"],
    trigger: "岩浆,lava,过河",
    evidence: "soul-mc session-l#10：跳过去掉进去了",
    result: "failed",
  });
  saveSkill(root, {
    name: "挖矿用两格高坑道",
    domain: "mc",
    when: "往地下挖通道",
    steps: ["mcc_tunnel blocks=N"],
    trigger: "挖矿,tunnel",
    evidence: "soul-mc session-m#5：挖矿试出来的",
    result: "worked",
  });

  const byTrigger = recallSkills(root, { domain: "mc", query: "岩浆" });
  assert.equal(byTrigger[0].name, "过岩浆", "触发词命中应排第一");

  const byOther = recallSkills(root, { domain: "mc", query: "挖矿" });
  assert.equal(byOther[0].name, "挖矿用两格高坑道");

  // 跨域隔离：mc 的技能不该出现在 qq 域
  assert.equal(recallSkills(root, { domain: "qq", query: "挖矿" }).length, 0);
});

test("注入块：只给名字 + 何时用 + 置信度，且受预算限制", () => {
  const root = tmp();
  for (let i = 0; i < 6; i++) {
    saveSkill(root, {
      name: `技巧${i}`,
      domain: "mc",
      when: `情境${i}：这是一段比较长的说明文字，用来把预算撑满`,
      steps: [`第 ${i} 步`],
      trigger: "通用",
      evidence: `session-${i}#1`,
      result: "worked",
    });
  }
  const brief = renderSkillBrief(root, { domain: "mc", query: "通用", budget: 260 });
  assert.ok(brief.text.startsWith("## 你学过的技巧"), "应有标题");
  assert.ok(brief.text.length <= 260, `预算应生效，实际 ${brief.text.length}`);
  assert.ok(brief.slugs.length >= 1 && brief.slugs.length <= 6);

  // 没有技能时返回空串（不能往人格块塞空标题）
  const empty = renderSkillBrief(tmp(), { domain: "mc", query: "x" });
  assert.equal(empty.text, "");
});

test("listSkills 能跨域列，readSkill 找不到返回 null", () => {
  const root = tmp();
  saveSkill(root, { name: "A", domain: "mc", when: "w", steps: ["s"], evidence: "e", result: "worked" });
  saveSkill(root, { name: "B", domain: "qq", when: "w", steps: ["s"], evidence: "e", result: "worked" });

  assert.equal(listSkills(root).length, 2, "不带域应列出全部");
  assert.equal(listSkills(root, "mc").length, 1);
  assert.equal(listSkills(root, "mc")[0].name, "A");
  assert.equal(readSkill(root, { domain: "mc", slug: "不存在" }), null);
});

test("中日文技能名能正常当文件名（不产生非法字符）", () => {
  const root = tmp();
  const r = saveSkill(root, {
    name: "被苦力怕贴脸时：先退再打",
    domain: "mc",
    when: "苦力怕在 2 格内",
    steps: ["后退两步", "等引爆延迟结束再上去砍"],
    evidence: "session-c#3：被炸死一次",
    result: "failed",
  });
  assert.ok(r.path.endsWith(".md"));
  assert.ok(!/[\\/:*?"<>|]/.test(r.slug), `文件名不该含非法字符：${r.slug}`);
  assert.ok(existsSync(r.path));
});

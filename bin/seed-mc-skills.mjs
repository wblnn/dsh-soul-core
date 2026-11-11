/**
 * 播种：从 dsh-mc-client 的文档里提炼几条起步技巧。
 *
 * 注意 evidence 写的是"文档"，不是"实践"——所以 attempts/successes 都是 0，
 * 置信度停在初始值。她真的按这些做过之后，用 skill_learn(result=worked/failed) 才会涨落。
 */

import { join } from "node:path";

import { saveSkill } from "../lib/skills.js";
import { resolveRoot } from "../lib/persona-api.js";

const root = resolveRoot();
const DOC = "dsh-mc-client/docs（INTEGRATION §7/§10、AGENT-LAYER 反射表）";

const seeds = [
  {
    name: "挖矿用两格高坑道",
    when: "需要往地下挖一条自己能走进去的通道",
    steps: [
      "mcc_tunnel blocks=N（它每一步挖脚下一块 + 头上一块，正好 2 格高）",
      "每挖几格 mcc_state 看一次坐标，确认没跑偏",
      "脚下 4 格无方块时它自己会蹲——别手动跳，跳下去容易摔",
    ],
    lessons: "一格高的洞玩家走不进去，白挖。别自己用 mcc_mine 一格一格刨。",
    trigger: "挖矿,隧道,坑道,矿洞,tunnel,mine",
    evidence: DOC,
  },
  {
    name: "追跑动中的玩家要疾跑平砍",
    when: "目标玩家在跑，站着砍会打空",
    steps: [
      "mcc_look_at 对准目标胸口（先对准再动手，别靠感觉）",
      "用 mcc_fight seconds=N，它内部每 50ms 决策：远了疾跑追、目标站定就跳劈",
      "打完确认位置——追出去会把坐标带跑，需要的话 mcc_goto 回原点",
    ],
    lessons: "站桩砍跑动目标是打空的；打不到不是伤害不够，是没追上。",
    trigger: "打架,pvp,追人,attack,fight",
    evidence: DOC,
  },
  {
    name: "过岩浆不要跳，垫方块走",
    when: "前面有岩浆池要过去",
    steps: [
      "mcc_scan kind=blocks filter=lava radius=12 先找最窄的地方",
      "站在岸边，对着要落脚的那格 mcc_look_at 然后 mcc_use（放方块）",
      "放稳了再踩上去，一格一格铺过去；不要跳",
    ],
    lessons: "跳过去一旦落点偏一格就掉进去；岩浆是反射优先级第二的东西，值得多花两秒铺路。",
    trigger: "岩浆,lava,过河,桥,掉进去",
    evidence: DOC,
  },
  {
    name: "视距只有 2，长途要分段走",
    when: "要走到 30 格以外的地方",
    steps: [
      "先把目标拆成 10~15 格一段，逐段 mcc_goto",
      "每段到了用 mcc_state 确认坐标，再定下一段",
      "中途遇到没见过的地形，先 mcc_panorama 或 mcc_scan 看一眼再走",
    ],
    lessons: "视距 2 时远处是黑的，一路走过去会撞进未知地形。分段比一次到位稳。",
    trigger: "长途,赶路,跑图,goto,寻路",
    evidence: DOC,
  },
];

let created = 0;
for (const seed of seeds) {
  const r = saveSkill(root, { ...seed, domain: "mc" });
  console.log(`${r.created ? "新建" : "更新"} ${r.slug} → ${r.path}`);
  created += r.created ? 1 : 0;
}

console.log(`\n完成：${created} 条新技巧，落在 ${join(root, "skills", "mc")}`);
console.log("注意：这些的 evidence 是文档，attempts=0（置信 0.30）。她真做过一次之后就会开始涨。");

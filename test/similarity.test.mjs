/**
 * 相似度层测试：Dice / BM25 / 情绪 / 证据闸。
 *
 * 这批用例对应三个真实抱怨：
 *   ① 长文本天然占便宜（命中计数）→ Dice 除掉长度
 *   ② 换个说法就召回不到 → Dice 的部分重叠 + 情绪极性
 *   ③ 池子里有一条很像的，剩下的"勉强像"也该被闸掉 → 相对下限
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bigrams,
  buildBm25,
  dice,
  emotionMatch,
  emotionOf,
  evidenceFloor,
  normalize,
  passGate,
  rankDocs,
} from "../lib/similarity.js";

test("bigrams：中文二元组、英文整词（转小写）、去标点", () => {
  assert.deepEqual([...bigrams("今天好累")], ["今天", "天好", "好累"]);
  assert.deepEqual([...bigrams("useState 钩子")], ["usestate", "钩子"]);
  assert.deepEqual([...bigrams("！？，。")], []);
});

test("Dice：除掉长度，短句不再吃亏", () => {
  // 同样命中 2 个二元组：长文本的 Dice 应该明显更低（它"更不像"）
  const q = "今天好累";
  const short = dice(q, "今天好累啊");
  const long = dice(q, "今天好累啊然后我还去挖了两个小时矿又打了一架");
  assert.ok(short > long, `短句 ${short} 应高于长句 ${long}`);
  assert.equal(dice(q, "玩家坐标 101 104"), 0);
});

test("BM25：同样的词，短文档比长文档得分高（长度归一）", () => {
  const docs = [{ text: "屋顶还没封完" }, { text: "屋顶还没封完，然后我去挖矿，又去打怪，回来天都亮了" }];
  const idx = buildBm25(docs);
  const q = bigrams("屋顶");
  const a = idx.scoreOf(0, q);
  const b = idx.scoreOf(1, q);
  assert.ok(a > b, `短文档 ${a.toFixed(3)} 应高于长文档 ${b.toFixed(3)}`);
});

test("BM25：无交集得 0", () => {
  const idx = buildBm25([{ text: "屋顶" }]);
  assert.equal(idx.scoreOf(0, bigrams("钻石")), 0);
});

test("情绪：极性判定与跨字面对齐", () => {
  assert.equal(emotionOf("今天好累").polarity, -1);
  assert.equal(emotionOf("挖到钻石了哈哈").polarity, 1);
  assert.equal(emotionOf("坐标 101 104").polarity, 0);

  // "今天好累" 和 "加班压力大" 一个字都不重叠，但情绪同频
  assert.equal(dice("今天好累", "加班到十一点，压力好大"), 0);
  assert.equal(emotionMatch("今天好累", "加班到十一点，压力好大"), 1);

  // 反极性不给分
  assert.equal(emotionMatch("今天好累", "今天太开心了哈哈"), 0);

  // 查询无情绪词：只给一点点，别让情绪压过相关度
  assert.ok(emotionMatch("屋顶", "今天好累") <= 0.3);
});

test("normalize：全 0 时返回全 0（不能除零）", () => {
  assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(normalize([0, 5, 10]), [0, 0.5, 1]);
});

test("rankDocs：字面像的排在前面", () => {
  const docs = [
    { id: "a", text: "玩家坐标 101 104" },
    { id: "b", text: "屋顶还没封完，差三块木板" },
    { id: "c", text: "屋顶的事我记着了" },
  ];
  const ranked = rankDocs("屋顶封完了吗", docs);
  assert.equal(ranked[0].doc.id, "b");
  assert.ok(ranked[0].evidence > ranked[2].evidence);
});

test("rankDocs：零字面重叠但情绪同频的，也能拿到一点分", () => {
  const docs = [
    { id: "a", text: "今天矿洞里啥也没挖到" },
    { id: "b", text: "加班到十一点，压力好大，脑子都是木的" },
  ];
  const ranked = rankDocs("今天好累", docs);
  const b = ranked.find((r) => r.doc.id === "b");
  assert.ok(b.emotion === 1, "情绪应判为同频");
  assert.ok(b.evidence > 0, "应拿到情绪分");
});

test("证据闸：绝对下限挡掉全不相干，相对下限挡掉勉强像", () => {
  // 全不相干 → 全部低于绝对下限
  const junk = rankDocs("屋顶", [{ id: "x", text: "钻石 铁剑 骷髅" }]);
  assert.equal(passGate(junk, { minAbs: 0.12 }).length, 0, "不该放进来");

  // 有一条很像 → 勉强像的被相对下限挡住
  const mixed = rankDocs("屋顶还没封完", [
    { id: "close", text: "屋顶还没封完，差三块木板" },
    { id: "loose", text: "屋顶的事我记着了" },
    { id: "far", text: "今天天气不错" },
  ]);
  const passed = passGate(mixed, { minAbs: 0.05, minRel: 0.6 });
  assert.ok(passed.length >= 1 && passed.length < 3, `应只放一部分，实际 ${passed.length}`);

  assert.equal(evidenceFloor(1.0, { minAbs: 0.12, minRel: 0.35 }), 0.35);
  assert.equal(evidenceFloor(0.1, { minAbs: 0.12, minRel: 0.35 }), 0.12);
});

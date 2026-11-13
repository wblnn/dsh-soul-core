/**
 * 关联表测试：建边、上限、扩散、联想注入。
 *
 * 三条来自 SeekMemory 的常数必须成立：
 *   ① 每节点最多 5 条边（similar ≤3 / temporal ≤2）——上限比规则重要
 *   ② 扩散 DECAY=0.5、两跳、每轮 ≤20，且取 max-path 不是求和
 *   ③ 联想项必须标注来源，否则她会把联想到的当成原话
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { MAX_EDGES, MAX_SIMILAR, MAX_TEMPORAL, buildLinks, linkStats, loadMessages, neighbours, nodeId, spread } from "../lib/links.js";
import { openStore } from "../lib/memory-store.js";

const roots = [];
const dbs = [];
function tmpDb() {
  const root = mkdtempSync(join(tmpdir(), "soul-links-"));
  roots.push(root);
  const db = openStore(join(root, "memory-tree", "memory.db"));
  dbs.push(db);
  return db;
}
after(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  for (const r of roots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* 句柄 */
    }
  }
});

function seed(db, sessionId, rows) {
  db.prepare("INSERT OR IGNORE INTO sessions (session_id, file, workspace, preset) VALUES (?,?,?,?)").run(
    sessionId,
    `f-${sessionId}`,
    "w",
    "soul",
  );
  const stmt = db.prepare(
    "INSERT INTO messages (session_id, seq, preset, role, text, time, turn, chars) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const r of rows) stmt.run(sessionId, r.seq, "soul", r.role ?? "user", r.text, r.time, 1, r.text.length);
}

const T0 = new Date("2026-11-13T20:00:00+08:00").getTime();

test("建边：同会话里像的连 similar，同一天的连 temporal", () => {
  const db = tmpDb();
  seed(db, "S1", [
    { seq: 1, text: "屋顶还差三块木板，明天接着封", time: T0 },
    { seq: 2, text: "屋顶还差三块木板，明天接着封吧", time: T0 + 1000 },
    { seq: 3, text: "玩家坐标 101 104 附近有钻石", time: T0 + 2000 },
  ]);
  const r = buildLinks(db, { limit: 50 });
  assert.ok(r.similar >= 1, `应有 similar 边，实际 ${JSON.stringify(r)}`);
  assert.ok(r.temporal >= 1, `应有 temporal 边`);
  assert.ok(linkStats(db).total > 0);
});

test("建边：每节点不超过 5 条（similar ≤3 / temporal ≤2）", () => {
  const db = tmpDb();
  const rows = [];
  for (let i = 1; i <= 12; i++) {
    rows.push({ seq: i, text: `屋顶还差三块木板，第 ${i} 次`, time: T0 + i * 1000 });
  }
  seed(db, "S1", rows);
  buildLinks(db, { limit: 50 });

  for (const r of rows) {
    const id = nodeId("S1", r.seq);
    const nb = neighbours(db, id);
    assert.ok(nb.length <= MAX_EDGES, `${id} 边太多：${nb.length}`);
  }
  const byKind = db.prepare("SELECT from_id, kind, COUNT(*) AS n FROM links GROUP BY from_id, kind").all();
  for (const row of byKind) {
    const cap = row.kind === "similar" ? MAX_SIMILAR : MAX_TEMPORAL;
    assert.ok(Number(row.n) <= cap, `${row.from_id} 的 ${row.kind} 边 ${row.n} 超过 ${cap}`);
  }
});

test("建边：重复跑不会无限加边（幂等）", () => {
  const db = tmpDb();
  seed(db, "S1", [
    { seq: 1, text: "屋顶还差三块木板", time: T0 },
    { seq: 2, text: "屋顶还差三块木板啊", time: T0 + 1000 },
  ]);
  buildLinks(db, { limit: 50 });
  const first = linkStats(db).total;
  buildLinks(db, { limit: 50 });
  buildLinks(db, { limit: 50 });
  assert.equal(linkStats(db).total, first, "重复建边不该增加");
});

test("扩散：每跳衰减一半，取最大值而不是求和", () => {
  const db = tmpDb();
  seed(db, "S1", [
    { seq: 1, text: "起点", time: T0 },
    { seq: 2, text: "一跳", time: T0 + 1000 },
    { seq: 3, text: "两跳", time: T0 + 2000 },
  ]);
  // 手工建链 1 → 2 (1.0) → 3 (1.0)
  const ins = db.prepare("INSERT OR REPLACE INTO links (from_id, to_id, kind, weight, at_ms) VALUES (?,?,?,?,?)");
  ins.run(nodeId("S1", 1), nodeId("S1", 2), "similar", 1, Date.now());
  ins.run(nodeId("S1", 2), nodeId("S1", 3), "similar", 1, Date.now());

  const act = spread(db, [nodeId("S1", 1)], { rounds: 2, decay: 0.5 });
  assert.equal(act.get(nodeId("S1", 1)), 1);
  assert.equal(act.get(nodeId("S1", 2)), 0.5);
  assert.equal(act.get(nodeId("S1", 3)), 0.25, "两跳应是 0.25");
});

test("扩散：多条路径取最大，不叠加", () => {
  const db = tmpDb();
  seed(db, "S1", [
    { seq: 1, text: "A", time: T0 },
    { seq: 2, text: "B", time: T0 + 1000 },
    { seq: 3, text: "C", time: T0 + 2000 },
  ]);
  const ins = db.prepare("INSERT OR REPLACE INTO links (from_id, to_id, kind, weight, at_ms) VALUES (?,?,?,?,?)");
  ins.run(nodeId("S1", 1), nodeId("S1", 3), "similar", 0.9, Date.now());
  ins.run(nodeId("S1", 2), nodeId("S1", 3), "similar", 0.9, Date.now());
  const act = spread(db, [nodeId("S1", 1), nodeId("S1", 2)], { rounds: 1, decay: 0.5 });
  assert.equal(act.get(nodeId("S1", 3)), 0.45, "应是 max(0.45, 0.45)，不是 0.9");
});

test("loadMessages：按锚点取回正文", () => {
  const db = tmpDb();
  seed(db, "S1", [{ seq: 7, text: "屋顶还差三块木板", time: T0 }]);
  const got = loadMessages(db, [nodeId("S1", 7), "nope#1"]);
  assert.equal(got.size, 1);
  assert.ok(got.get(nodeId("S1", 7)).text.includes("屋顶"));
});

/**
 * 增量摄取：底仓不该等 2 秒、也不该落后现场很久。
 *
 * 三条约束（都来自实测）：
 *   ① 文件没变 → 只看字节数就跳过，**不解码**（整篇解 10.5 MB 要 1083 ms）
 *   ② 文件变大 → 只解新增的帧（实测 1 ms）
 *   ③ 帧号必须接着往下排，不能从头覆盖
 */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import zlib from "node:zlib";

import { ingestSession, openStore } from "../lib/memory-store.js";

const roots = [];
const dbs = [];

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "soul-inc-"));
  roots.push(root);
  const dir = join(root, "sessions", "--ws--", "session-abc");
  mkdirSync(dir, { recursive: true });
  const db = openStore(join(root, "memory-tree", "memory.db"));
  dbs.push(db);
  return { root, dir, file: join(dir, "session.v4.jsonl.zstd"), db };
}

after(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** 把一批事件压成一帧（和 DSH 的日志同构：每帧几行 JSONL）。 */
function frameOf(events) {
  return zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"));
}

const header = {
  type: "session",
  version: 4,
  // 真实布局：目录名 session-<id>，header.id 就是同一个值
  id: "session-abc",
  seq: 1,
  time: 1_700_000_000_000,
  agentPreset: "soul",
  cwd: "F:/x",
};
const ask1 = {
  type: "user/message",
  seq: 2,
  time: 1_700_000_001_000,
  data: { content: [{ type: "text", text: "钥匙放在鞋柜第二层" }] },
};
const reply1 = {
  type: "assistant/message",
  seq: 3,
  time: 1_700_000_002_000,
  data: { message: { role: "assistant", content: [{ type: "text", text: "记住了" }] } },
};
const ask2 = {
  type: "user/message",
  seq: 4,
  time: 1_700_000_003_000,
  data: { content: [{ type: "text", text: "钥匙在哪" }] },
};

test("增量摄取：没变不解码、变了只解新帧、帧号接着排", () => {
  const box = sandbox();
  writeFileSync(box.file, Buffer.concat([frameOf([header]), frameOf([ask1, reply1])]));

  const first = ingestSession(box.db, box.file, {});
  assert.equal(first.skipped, false);
  assert.equal(first.events, 3);

  // ② 没变化：直接跳过，不解码
  const second = ingestSession(box.db, box.file, {});
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "unchanged");

  // ③ 追加一帧 → 只处理新事件
  appendFileSync(box.file, frameOf([ask2]));
  const third = ingestSession(box.db, box.file, {});
  assert.equal(third.skipped, false);
  assert.equal(third.incremental, true);
  assert.equal(third.events, 1, "只该处理新增的 1 个事件");

  const msgs = box.db.prepare("SELECT seq, role, text FROM messages ORDER BY seq").all();
  assert.equal(msgs.length, 3, "两条 user + 一条 assistant");
  assert.ok(msgs.some((m) => String(m.text).includes("钥匙放在鞋柜第二层")));
  assert.ok(msgs.some((m) => String(m.text).includes("钥匙在哪")));

  const frames = box.db.prepare("SELECT COUNT(*) AS n, MAX(frame_index) AS maxi FROM frames").get();
  assert.equal(frames.n, 3);
  assert.equal(frames.maxi, 2, "帧号必须接着往下排");
});

test("增量摄取：半个帧（正在写）不会算坏数据，下次再来", () => {
  const box = sandbox();
  writeFileSync(box.file, Buffer.concat([frameOf([header]), frameOf([ask1])]));

  const first = ingestSession(box.db, box.file, {});
  assert.equal(first.events, 2);

  // 写一个不完整的帧（只有 magic，没有内容）
  appendFileSync(box.file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
  const partial = ingestSession(box.db, box.file, {});
  assert.equal(partial.skipped, true, "解不开的尾巴应该跳过");

  // 补全后能正常摄入
  appendFileSync(box.file, frameOf([reply1]));
  const done = ingestSession(box.db, box.file, {});
  assert.equal(done.skipped, false);
  assert.ok(done.events >= 1);
});

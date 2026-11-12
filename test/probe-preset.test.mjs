/**
 * 会话探针：preset 事件可能在**开头**（会话第一轮就选好模式），也可能在尾部（中途切换）。
 * 只看尾部会把长会话误判成 standard —— 这一条必须成立，否则文件兜底会认错人。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import zlib from "node:zlib";

import { probeSession } from "../lib/session-source.js";

const roots = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "soul-probe-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const frameOf = (events) =>
  zlib.zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8"));

function writeSession(dir, frames) {
  const d = join(dir, "session-x");
  mkdirSync(d, { recursive: true });
  const file = join(d, "session.v4.jsonl.zstd");
  writeFileSync(file, Buffer.concat(frames));
  return file;
}

test("preset 在选择在开头：长会话也不能误判成 standard", () => {
  const dir = tmp();
  const header = { type: "session", version: 4, id: "session-x", agentPreset: "standard" };
  const select = { type: "agent-preset/selected", seq: 2, time: 1, data: { agentPreset: "soul" } };
  // 中间塞一堆事件，把 preset 事件挤出尾部窗口
  const filler = [];
  for (let i = 0; i < 200; i++) {
    filler.push({ type: "tool/result", seq: 10 + i, time: 2 + i, data: { text: "x".repeat(300) } });
  }
  const file = writeSession(dir, [frameOf([header]), frameOf([select]), frameOf(filler), frameOf(filler)]);
  const probe = probeSession(file);
  assert.equal(probe.preset, "soul", `应从头段读到 soul，实际 ${JSON.stringify(probe.preset)}`);
});

test("中途切换模式：以最后一次为准", () => {
  const dir = tmp();
  const header = { type: "session", version: 4, id: "session-x", agentPreset: "standard" };
  const a = { type: "agent-preset/selected", seq: 2, time: 1, data: { agentPreset: "soul" } };
  const b = { type: "agent-preset/selected", seq: 40, time: 5, data: { agentPreset: "soul-work" } };
  const filler = [];
  for (let i = 0; i < 50; i++) filler.push({ type: "tool/result", seq: 5 + i, time: 2 + i, data: { text: "y" } });
  const file = writeSession(dir, [frameOf([header]), frameOf([a]), frameOf(filler), frameOf([b])]);
  assert.equal(probeSession(file).preset, "soul-work");
});

test("没有选择事件：回退 header 的 preset", () => {
  const dir = tmp();
  const header = { type: "session", version: 4, id: "session-x", agentPreset: "standard" };
  const file = writeSession(dir, [frameOf([header]), frameOf([{ type: "user/message", seq: 3, time: 1, data: {} }])]);
  assert.equal(probeSession(file).preset, "standard");
});

/**
 * 她看不见时间是实测反馈："她看不见发消息时的时间"。
 * 时间不是知识，是处境——所以走 context（user 侧快照），不进人格块 prefix。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { nowStamp } from "../lib/persona-api.js";

test("nowStamp：本地时间 + 星期 + 时区", () => {
  const s = nowStamp(new Date(2026, 10, 8, 23, 55)); // 2026-11-08 23:55 本地
  assert.match(s, /^2026-11-08 23:55 .+（UTC[+-]\d+）$/, "格式不对：" + s);
  assert.ok(s.includes("11-08"), "要带日期");
  assert.ok(s.includes("23:55"), "要带时刻");
  assert.match(s, /UTC[+-]\d+/, "要带时区");
});

test("nowStamp：星期算得对（2026-11-08 是周日）", () => {
  assert.ok(nowStamp(new Date(2026, 10, 8, 12, 0)).includes("周日"));
  assert.ok(nowStamp(new Date(2026, 10, 9, 12, 0)).includes("周一"));
});

test("nowStamp：零点与月末不串位", () => {
  const a = nowStamp(new Date(2026, 0, 1, 0, 0));
  assert.ok(a.startsWith("2026-01-01 00:00"), "实际：" + a);
  const b = nowStamp(new Date(2026, 11, 31, 23, 59));
  assert.ok(b.startsWith("2026-12-31 23:59"), "实际：" + b);
});

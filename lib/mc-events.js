/**
 * 身体"自己动"的事件聚合：反射 / 死亡 / 打断 / 目标完成。
 *
 * 为什么不能一条一条叫醒她：
 *   快反应层是 10Hz，RETALIATE / EAT / FLEE 会在几秒里连着触发好几条。
 *   每叫醒一次 = 一个回合 = 一次完整提示词。逐条转达等于把她的上下文烧光，
 *   而她对这些动作**没有实时决策权**（它们就是在你来不及思考时才存在的）。
 *
 * 所以分两类：
 *   - **死亡**：立刻叫醒。这是"上一次决策错了"的唯一硬信号，必须当场知道。
 *   - **其他**：攒成一份摘要，最多每 N 分钟给一次；短窗口内爆发（≥burst）才提前叫。
 *
 * 产物长这样（给她看的）：
 *   【MC 身体自己动了（这些你没参与）】
 *   - RETALIATE ×3：被 steve 打低血、latch(player)
 *   - EAT ×1：food=16,hp=6.2
 *   最近 2 分钟内，共 5 次。想改它的反应方式就下 directive 调策略。
 */

const REFLEX_WORDS = {
  RETALIATE: "还手",
  GOTO: "移动",
  STOP: "停下",
  EAT: "吃东西",
  RESPAWN: "复活",
  WAIT: "等待",
  MINE: "挖",
  PLACE: "放",
};

/**
 * `why` 前缀 → 人能读的触发条件。
 *
 * 身体给的 why 很短（`hurt(player:steve)` / `lowhp` / `food=17`），她却要拿这个
 * 理解"身体为什么自己动了"。这张表把机器缩写翻译成因果。
 */
const WHY_EXPLAIN = [
  [/^hurt\((.+)\)$/, (m) => `被 ${m[1]} 打了`],
  [/^latch\((.+)\)$/, (m) => `${m[1]} 贴得太近，先手还击`],
  [/^lowhp$/, () => "血量过低，先保命"],
  [/^food=([\d.]+)(?:,hp=([\d.]+))?$/, (m) => `饥饿 ${m[1]}${m[2] ? `，血 ${m[2]}` : ""}，自动进食`],
  [/^lava(?:\((.+)\))?$/, (m) => `脚下是岩浆${m[1] ? `（危险 ${m[1]}）` : ""}，先脱离`],
  [/^lava-no-exit$/, () => "岩浆里找不到安全格，只能先停"],
  [/^return-home\(([\d.]+)\)$/, (m) => `离家 ${m[1]} 格，自动往回走`],
  [/^player-hit$/, () => "被玩家打中，先退开"],
  [/^dead$/, () => "已经死了，自动复活"],
  [/^discard (.+)$/, (m) => `背包垃圾太多，丢掉 ${m[1]}`],
];

function explainWhy(why) {
  const raw = String(why || "");
  if (!raw) return "";
  for (const [re, fn] of WHY_EXPLAIN) {
    const m = raw.match(re);
    if (m) return fn(m);
  }
  return raw; // 认不出来就原样给，别编
}

/**
 * 反射名 → 她能改的那个旋钮。
 *
 * 这张表是"她看到身体自己动了"之后唯一能采取动作的地方：
 * 反射层不听她说话，只听 directive 的字段。
 */
const REFLEX_KNOBS = {
  RETALIATE: "不想还手 → directive.combat.players=false；别追太远 → combat.chase.maxDist",
  GOTO: "不想乱跑 → directive.goal=null 让它闲着，或加 constraints.forbid:['GOTO']",
  STOP: "它停住多半是找不到安全落点；给个明确的 goto 目标它才会动",
  EAT: "不想它自己吃东西 → 先把食物收进箱子，或给我明确的背包安排",
  RESPAWN: "没法改，死了就复活",
  DROP: "不想它丢东西 → 背包别塞满（drop 是满了才触发）",
};

function labelOf(name) {
  return REFLEX_WORDS[name] ? `${name}（${REFLEX_WORDS[name]}）` : String(name || "?");
}

/**
 * 事件聚合器。只收"不是聊天"的事件。
 */
export function createEventAggregator(options = {}) {
  const windowMs = options.windowMs ?? 120_000;
  const entries = []; // {kind, name, why, t, pos, goal, deaths, explain}

  return {
    push(evt) {
      if (!evt || typeof evt !== "object") return;
      const kind = String(evt.kind || "");
      if (!kind || kind === "chat") return;
      entries.push({
        kind,
        name: evt.name ? String(evt.name) : "",
        why: evt.why ? String(evt.why) : "",
        explain: evt.explain ? String(evt.explain) : "",
        pos: Array.isArray(evt.pos) ? evt.pos : null,
        goal: evt.goal,
        deaths: evt.deaths,
        t: Number(evt.t || Date.now()),
      });
    },
    /** 只留窗口内的。 */
    prune(now = Date.now()) {
      while (entries.length > 0 && now - entries[0].t > windowMs) entries.shift();
      return entries.length;
    },
    get size() {
      return entries.length;
    },
    recent() {
      return [...entries];
    },
    reset() {
      entries.length = 0;
    },
  };
}

/**
 * 决定要不要因为这些事件叫醒她。
 *
 * @param params.aggregator createEventAggregator 的实例
 * @param params.evt 刚到的原始事件
 * @param params.lastWakeAt 上次事件类唤醒
 * @param params.cooldownMs 摘要类唤醒最小间隔（默认 180000）
 * @param params.burstThreshold 短窗口内攒够多少条就提前叫（默认 5）
 * @param params.now
 */
export function decideEventWake(params = {}) {
  const evt = params.evt || {};
  const agg = params.aggregator;
  const now = params.now ?? Date.now();
  const cooldownMs = params.cooldownMs ?? 180_000;
  const burst = params.burstThreshold ?? 5;
  const lastWakeAt = Number(params.lastWakeAt || 0);

  const kind = String(evt.kind || "");

  // 死亡：任何时候都立刻叫醒，不受冷却约束（这是最贵的信号）
  if (kind === "death") {
    return { wake: true, immediate: true, reason: "death" };
  }

  // 目标完成：便宜且有意义，冷却过后就给
  if (kind === "goal-done") {
    if (lastWakeAt > 0 && now - lastWakeAt < cooldownMs) return { wake: false, reason: "cooldown" };
    return { wake: true, immediate: true, reason: "goal-done" };
  }

  if (!agg) return { wake: false, reason: "no-aggregator" };
  agg.prune(now);
  if (agg.size === 0) return { wake: false, reason: "empty" };

  // 攒够 burst 条：身体在打硬仗，值得立刻让她知道
  if (agg.size >= burst) return { wake: true, immediate: false, reason: "burst" };

  // 太少（默认 < 2）：一次 EAT 不值得一个回合
  const minCount = params.minCount ?? 2;
  if (agg.size < minCount) return { wake: false, reason: "quiet" };

  if (lastWakeAt > 0 && now - lastWakeAt < cooldownMs) return { wake: false, reason: "cooldown" };
  return { wake: true, immediate: false, reason: "digest" };
}

/** 把聚合内容压成给她的一段话。 */
export function formatEventDigest(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return "";
  const now = options.now ?? Date.now();

  const deaths = list.filter((e) => e.kind === "death");
  const goals = list.filter((e) => e.kind === "goal-done");
  const interrupts = list.filter((e) => e.kind === "interrupt");
  const reflexes = list.filter((e) => e.kind === "reflex");

  const channel = options.channel === "context" ? "context" : "wake";
  const secs = Math.max(1, Math.round((now - Math.min(...list.map((e) => e.t))) / 1000));
  const lines = [];
  lines.push(
    channel === "context"
      ? `【你不在的时候，身体自己做了这些 · 最近 ${secs} 秒】`
      : `【MC 身体自己动了 · 最近 ${secs} 秒】`,
  );
  lines.push(
    channel === "context"
      ? "（这些不用你回，只是让你知道发生过；要改它的反应方式就下 directive）"
      : "（这些动作你事先不知道，它们发生在你来不及想的时候）",
  );

  if (deaths.length > 0) {
    for (const d of deaths) {
      const pos = d.pos ? `(${d.pos.join(",")})` : "位置不明";
      lines.push(`- 死了 ×${deaths.length}：${pos}${d.goal ? "，当时有目标" : "，当时在闲着"}${d.deaths ? `，累计第 ${d.deaths} 次` : ""}`);
    }
  }

  if (reflexes.length > 0) {
    const groups = new Map();
    for (const r of reflexes) {
      const key = r.name || "?";
      const hit = groups.get(key) || { name: key, count: 0, whys: [], args: [] };
      hit.count += 1;
      if (r.why && !hit.whys.includes(r.why)) hit.whys.push(r.why);
      if (r.arg && typeof r.arg === "object") hit.args.push(r.arg);
      groups.set(key, hit);
    }

    for (const g of [...groups.values()].sort((a, b) => b.count - a.count)) {
      const causes = g.whys.slice(0, 2).map(explainWhy).filter(Boolean);
      // 从 arg 里挖一点现场事实（实体类型/血量），让她知道"是谁、多危险"
      const argHints = [];
      for (const a of g.args.slice(0, 2)) {
        if (a.type) argHints.push(a.type);
        if (Number.isFinite(a.health)) argHints.push(`它剩 ${a.health} 血`);
      }
      const facts = [...new Set(argHints)].slice(0, 2).join("，");
      lines.push(
        `- ${labelOf(g.name)} ×${g.count}` +
          (causes.length ? `　触发：${causes.join("；")}` : "") +
          (facts ? `（${facts}）` : ""),
      );
      const knob = REFLEX_KNOBS[g.name];
      if (knob) lines.push(`    想改：${knob}`);
    }
  }

  if (interrupts.length > 0) {
    const ex = interrupts.map((i) => i.explain).filter(Boolean);
    lines.push(`- 指令被打断 ×${interrupts.length}${ex.length ? `：${ex.slice(0, 2).join("、")}` : ""}`);
  }

  if (goals.length > 0) lines.push(`- 目标完成 ×${goals.length}`);

  lines.push("");
  if (channel === "wake") {
    lines.push(
      "这些不是你的决定：反射层只看得到血量/饥饿/脚下方块/附近实体，它听不见你说话，只认 directive 的字段。",
    );
  }
  return lines.join("\n");
}

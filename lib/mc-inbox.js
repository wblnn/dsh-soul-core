/**
 * 事件分级 + 收件箱：解决"回合制思考 vs 连续事件簇"的冲突。
 *
 * 冲突本体：
 *   她要"想"一次，就得开一个完整回合（人格块 + 记忆 + 技能 + 工具，几千 token）。
 *   而反射层是 10Hz 的，重要事件常常成簇（被怪围攻 → 还手/低血/逃跑连着来）。
 *   逐条唤醒 = 每次簇都开好几个回合；全攒着 = 重要的事迟到十几分钟。
 *
 * 解法：**按重要性选通道，而不是按时间**。
 *
 *   P0（必须立刻知道）→ followup 唤醒，但单飞：一次只允许一个在飞
 *   P1（该知道，不急）→ 合并窗口（默认 8 秒）后一次性唤醒，带上窗口内全部
 *   P2（细节，不值得一个回合）→ **不唤醒**，写进下一轮的 context，她下次开口时自然看到
 *
 * 关键洞察：P2 的正确通道不是"唤醒"，而是"下次她思考时顺手看到的上下文"——
 * 这条通道零成本（不额外开回合），也消除了"身体动了但没人告诉她"的空窗。
 */

/** 事件 → 严重级。默认 P2：不认识的一律不吵她。 */
export function severityOf(evt) {
  const kind = String(evt?.kind || "");
  const name = String(evt?.name || "");

  if (kind === "death") return "P0";

  // 反射里真正"她会想知道"的：被打、低血逃命、被玩家打退
  if (kind === "reflex") {
    const why = String(evt?.why || "");
    if (/^hurt\(/.test(why)) return "P0"; // 挨打了
    if (/^lowhp/.test(why)) return "P0"; // 血低逃跑
    if (/^lava/.test(why)) return "P0"; // 岩浆里
    if (name === "RESPAWN") return "P0";
    if (name === "RETALIATE") return "P0";
    if (name === "STOP" && /lowhp|lava/.test(why)) return "P0";
    return "P2"; // EAT / GOTO(return-home) / DROP / WAIT…
  }

  if (kind === "interrupt") return "P1";
  if (kind === "goal-done") return "P1";

  return "P2";
}

/**
 * 决定一条事件该走哪条通道。
 *
 * **最关键的一条**：她"忙"（回合进行中）时，`agent.inject` 会把消息插进**当前回合的下一个
 * step 边界**——不开新回合、几乎零成本、时效性最好。这就是"塞进对话图里"。
 * 所以单飞限制只该作用于**空闲时的新回合**，绝不能拿来押后忙时的插话。
 *
 * @param params.severity P0 | P1 | P2
 * @param params.busy 她的回合是否正在进行
 * @param params.lastWakeAt 上次"开新回合"的时间
 * @param params.singleFlightMs 空闲时两次新回合的最小间隔
 * @returns {{action:'inject'|'wake'|'hold'|'context', reason:string}}
 */
export function decideDispatch(params = {}) {
  const severity = params.severity || "P2";
  const busy = params.busy === true;
  const now = params.now ?? Date.now();
  const lastWakeAt = Number(params.lastWakeAt || 0);
  const singleFlightMs = params.singleFlightMs ?? 15_000;

  // P2 永远不吵她，等下次开口时在 context 里看到
  if (severity === "P2") return { action: "context", reason: "P2 只进上下文" };

  // 忙：插进当前回合的下一个 step——不开新回合，绝不押后
  if (busy) return { action: "inject", reason: "忙 → 插话（当前回合内）" };

  // 空闲
  if (severity === "P0") {
    if (lastWakeAt > 0 && now - lastWakeAt < singleFlightMs) {
      return { action: "hold", reason: "刚开过回合，先攒着等下一轮" };
    }
    return { action: "wake", reason: "P0 空闲 → 新回合" };
  }

  // P1 空闲：等合并窗口（由调用方的定时器判断），这里先攒
  return { action: "hold", reason: "P1 等合并窗口" };
}
export function createInbox(options = {}) {
  const items = []; // {evt, severity, t}
  const max = options.maxItems ?? 60;

  return {
    push(evt, now = Date.now()) {
      const severity = severityOf(evt);
      items.push({ evt, severity, t: now });
      if (items.length > max) items.splice(0, items.length - max);
      return severity;
    },
    /** 有没有某个级别以上的东西在等。 */
    has(level) {
      return items.some((i) => i.severity === level);
    },
    /** 取走（默认全取），返回事件数组并清空。 */
    take(levels) {
      const want = levels ? new Set(levels) : null;
      const taken = [];
      const kept = [];
      for (const item of items) {
        if (!want || want.has(item.severity)) taken.push(item.evt);
        else kept.push(item);
      }
      items.length = 0;
      items.push(...kept);
      return taken;
    },
    get size() {
      return items.length;
    },
    /** 最早那条的时间（用来算"最迟延迟"）。 */
    oldestAt() {
      return items.length ? items[0].t : 0;
    },
    clear() {
      items.length = 0;
    },
  };
}

/**
 * MC 游戏内聊天桥：把公屏当成**常驻输入通道**，像 QQ 群 bot 那样。
 *
 * 关键区别（相比第一版"只有被点名才醒"）：
 *   - **一直在收**：每条都进环形缓冲（默认 20 条），不管叫不叫她；
 *   - **唤醒时带上下文**：不是把一条消息丢过去，而是"最近 N 条"一起给，
 *     这样她才看得懂在聊什么、谁在跟谁说话；
 *   - **两种唤醒**：① 被点名（名字 / @）立刻醒；② 氛围唤醒——攒够了新消息且
 *     冷却过了，就叫她一次"看看要不要接"（**接不接由她决定**，插件只负责叫）。
 *
 * 为什么门控还在插件层：每醒一次 = 一个回合 = 一次完整提示词。
 * 群聊一秒三句，不节流就是烧钱；但这跟"能不能随便跟她说话"是两件事。
 */

/** 环形聊天缓冲。 */
export function createChatBuffer(options = {}) {
  const capacity = options.capacity ?? 20;
  const lines = [];
  let pending = 0; // 上次唤醒之后新到了几条（自己说的不算）

  return {
    push(entry) {
      const line = {
        speaker: String(entry?.speaker ?? "").trim(),
        text: String(entry?.text ?? "").trim(),
        self: entry?.self === true,
        ts: Number(entry?.ts ?? Date.now()),
      };
      if (!line.text) return null;
      lines.push(line);
      if (lines.length > capacity) lines.splice(0, lines.length - capacity);
      if (!line.self) pending += 1;
      return line;
    },
    /** 最近 n 条（不传 n = 全部）。 */
    recent(n) {
      if (!n || n <= 0) return [...lines];
      return lines.slice(Math.max(0, lines.length - n));
    },
    get pending() {
      return pending;
    },
    get size() {
      return lines.length;
    },
    /** 唤醒后清零，下一次氛围唤醒重新计数。 */
    resetPending() {
      pending = 0;
    },
  };
}

/** 把缓冲压成注入给她的上下文块。 */
export function formatChatContext(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return "";
  const lines = list.map((e) => {
    const who = e.speaker || "公屏";
    return e.self ? `<我> ${e.text}` : `<${who}> ${e.text}`;
  });
  const header = `【MC 公屏 · 最近 ${list.length} 条】`;
  const footer =
    options.reason === "mention"
      ? "（最后一句在叫你。想回就用 mcc_chat 说一句；不接也行。）"
      : "（没人点你名。想接一句就用 mcc_chat；不想接就什么都别做，这不算失礼。）";
  return `${header}\n${lines.join("\n")}\n${footer}`;
}

/**
 * 决定这次要不要叫她。
 *
 * @param params.buffer createChatBuffer 的实例
 * @param params.names 叫她的名字（命中 → 立刻醒）
 * @param params.replyToAll true = 每条非自己的消息都醒（调试用）
 * @param params.ambient true = 允许"攒够了就叫她一次"（默认开，像群 bot）
 * @param params.mentionCooldownMs 点名唤醒的最小间隔（默认 3000）
 * @param params.ambientCooldownMs 氛围唤醒的最小间隔（默认 90000 = 90 秒）
 * @param params.ambientMinNew 攒够几条新消息才氛围唤醒（默认 3）
 * @param params.contextLines 每次唤醒带几条上下文（默认 5）
 * @param params.lastWakeAt 上次唤醒时间
 * @param params.now 当前时间（测试注入）
 */
export function decideWake(params = {}) {
  const buffer = params.buffer;
  const now = params.now ?? Date.now();
  const names = (params.names || []).map((s) => String(s).trim()).filter(Boolean);
  const lastWakeAt = Number(params.lastWakeAt || 0);
  const contextLines = params.contextLines ?? 5;
  const mentionCooldownMs = params.mentionCooldownMs ?? 3000;
  const ambientCooldownMs = params.ambientCooldownMs ?? 90_000;
  const ambientMinNew = params.ambientMinNew ?? 3;
  const ambient = params.ambient !== false;

  const recent = buffer ? buffer.recent(contextLines) : [];
  const last = recent.length > 0 ? recent[recent.length - 1] : null;
  if (!last) return { wake: false, reason: "empty", lines: [] };
  if (last.self) return { wake: false, reason: "self", lines: [] };

  const cooldownHit = lastWakeAt > 0 && now - lastWakeAt < mentionCooldownMs;
  const mentioned = names.some((n) => last.text.includes(n)) || /[@＠]/.test(last.text);

  if (mentioned) {
    if (cooldownHit) return { wake: false, reason: "mention-cooldown", lines: [] };
    return { wake: true, reason: "mention", lines: recent };
  }

  if (params.replyToAll === true) {
    if (cooldownHit) return { wake: false, reason: "reply-all-cooldown", lines: [] };
    return { wake: true, reason: "reply-to-all", lines: recent };
  }

  if (!ambient) return { wake: false, reason: "not-mentioned", lines: [] };

  const pending = buffer ? buffer.pending : 0;
  if (pending < ambientMinNew) return { wake: false, reason: "quiet", lines: [] };
  if (lastWakeAt > 0 && now - lastWakeAt < ambientCooldownMs) {
    return { wake: false, reason: "ambient-cooldown", lines: [] };
  }
  return { wake: true, reason: "ambient", lines: recent };
}

/**
 * 读 MC 侧 SSE `/events`，把聊天事件喂给 onChat；断线自动重连。
 * 返回 { stop() }。不抛：连接失败走 onError。
 */
export function openChatStream(options = {}) {
  const url = options.url || "http://127.0.0.1:8790/events";
  const onChat = options.onChat || (() => {});
  const onError = options.onError || (() => {});
  const onOther = options.onOther || null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retryMs = options.retryMs ?? 3000;

  let stopped = false;
  let controller = null;
  let timer = null;

  const loop = async () => {
    if (stopped) return;
    controller = new AbortController();
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "text/event-stream" } });
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf("\n\n");
        while (idx >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of chunk.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue; // 忽略 `: ping` 注释
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let evt;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            if (evt && evt.kind === "chat") onChat(evt);
            else if (evt && onOther) onOther(evt);
          }
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!stopped) onError(error);
    }
    if (stopped) return;
    timer = setTimeout(loop, retryMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  void loop();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        controller?.abort();
      } catch {
        /* noop */
      }
    },
    get stopped() {
      return stopped;
    },
  };
}

/** 把 `<张三> 你好呀` 拆成 {speaker, text}；没有尖括号时 speaker 为空。 */
export function parseChatLine(raw) {
  const line = String(raw ?? "").trim();
  if (!line) return { speaker: "", text: "" };
  const m = line.match(/^<([^>]{1,40})>\s*([\s\S]*)$/);
  if (m) return { speaker: m[1].trim(), text: m[2].trim() };
  return { speaker: "", text: line };
}

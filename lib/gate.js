/**
 * 合法罢工：不是所有话都得接。
 *
 * 只在我们**控制入口**的通道做真拦截（MC 公屏）：
 *   命中 → 不唤醒她（零 token），由插件用她的口吻回一句。
 *
 * 三条铁律（都是踩过坑才加的）：
 *   ① **必须被点名**才回。否则公屏上任何一句"帮我写个脚本"都会让她插嘴。
 *   ② **必须节流**：她的号在公屏刷 100 句命中词 = 发 100 句话 = 封号。
 *      这和 README 里"以她自己账号说话、节流留在插件层"是同一条风险。
 *   ③ **宁可漏判，不可误判**：误判的代价是"别人正常聊天，她自动去怼一句"，
 *      比漏掉一次派活糟得多。所以要求「技术对象 + 派活动词 + 不是自述」三者同时成立。
 */

/** 技术对象：出现这些才可能是在"让她干活"。 */
const TECH_OBJECT =
  /(代码|脚本|函数|程序|爬虫|接口|正则|sql|bug|报错|异常|依赖|仓库|单元测试|测试用例|\bpr\b|文档|表格|报告|配置|环境|编译|部署|算法|缓存|数据库|模块|组件|服务|类库)/i;

/** 派活动词：光有动词不算（"我修了个房子"也是修）。 */
const TASK_VERB = /(写|改|修|调试|实现|重构|整理|总结|翻译|生成|做个|做一下|查一下|搜一下|看看|检查|排查|优化)/;

/** 在跟她说话（"你/小鱼/帮我/给我/替我/能不能…"）。 */
const ADDRESS = /(你|您|帮我|给我|替我|能不能|可以帮|麻烦)/;

/** 自述句：「我/他/她/刚才/今天…」，主语不是"你"，多半在聊天。 */
const NARRATION = /^(我|他|她|刚才|刚刚|今天|昨天|前天|我们|那边)/;

/** 像代码标识符的词（zstd、useState、v4.jsonl 这种）。 */
const CODE_TOKEN = /\b[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+\b|\b[a-z]{2,}[A-Z][a-zA-Z]*\b|\b[a-z][a-z0-9]{2,}\b/;

/** 明显的聊天特征：命中就不拦。 */
const CHAT_SIGNAL =
  /([?？]\s*$|在吗|在不在|干嘛呢|做什么呢|想你了|抱抱|陪我|哈{2,}|嘿{2,}|喵|呜|嘤|晚安|早安|你好|好看|不错|厉害)/;

/**
 * 这段公屏消息是不是"让她干活"。
 * @returns {{taskish:boolean, reason:string}}
 */
export function classifyChat(text) {
  const t = String(text ?? "").trim();
  if (!t) return { taskish: false, reason: "empty" };
  if (t.length < 8) return { taskish: false, reason: "too-short" };

  // 先看有没有技术对象：没有就放行（绝大多数闲聊止步于此）
  if (!TECH_OBJECT.test(t) && !CODE_TOKEN.test(t)) return { taskish: false, reason: "no-tech-object" };

  if (!TASK_VERB.test(t)) return { taskish: false, reason: "no-task-verb" };

  // 自述句不算（"我修了个房子""这地图改得不错"）——除非同时又像在跟她说
  if (NARRATION.test(t) && !ADDRESS.test(t)) return { taskish: false, reason: "narration" };

  if (CHAT_SIGNAL.test(t)) return { taskish: false, reason: "chat-signal" };

  return { taskish: true, reason: "task" };
}

/** 这句话是不是在叫她（名字命中或带 @）。 */
export function isAddressed(text, names = []) {
  const t = String(text ?? "");
  if (/[@＠]/.test(t)) return true;
  return (names || []).some((n) => n && t.includes(n));
}

/**
 * 节流：同一个时间窗内最多回几次。
 * @returns {{allowed:boolean, reason:string, count:number, windowStart?:number}}
 */
export function gateThrottle(state = {}, now = Date.now(), options = {}) {
  const cooldownMs = options.cooldownMs ?? 30_000;
  const windowMs = options.windowMs ?? 60 * 60_000;
  const maxPerWindow = options.maxPerWindow ?? 6;

  const last = Number(state.lastAt || 0);
  if (last > 0 && now - last < cooldownMs) {
    return { allowed: false, reason: "cooldown", count: Number(state.count || 0) };
  }
  const winStart = Number(state.windowStart || 0);
  const inWindow = winStart > 0 && now - winStart < windowMs;
  const count = inWindow ? Number(state.count || 0) : 0;
  if (count >= maxPerWindow) {
    return { allowed: false, reason: "window-cap", count };
  }
  return { allowed: true, reason: "ok", count: count + 1, windowStart: inWindow ? winStart : now };
}

/** 状态化拒绝语料（按当前状态挑一句；不叫模型，零成本）。 */
const REFUSALS = {
  sleep: ["…这么晚了喵", "困着呢…明天", "呼…让我睡", "…嗯（翻个身）"],
  focus: ["在看视频，等会儿", "嗯，一会儿说", "忙着呢喵", "等下哈"],
  busy: ["挖着呢，别吵", "正打怪呢！", "手上没空喵", "等我这一趟挖完"],
  awake: ["不想干这个喵", "这会儿不想动脑子", "你自己弄嘛", "今天我歇着"],
};

export function pickRefusal(state = "awake", seed = Date.now()) {
  const list = REFUSALS[state] ?? REFUSALS.awake;
  const i = Math.abs(Number(seed) || 0) % list.length;
  return list[i];
}

export function refusalLine({ state = "awake", name = "", seed = Date.now() } = {}) {
  const who = name ? `${name}，` : "";
  return `${who}${pickRefusal(state, seed)}`;
}

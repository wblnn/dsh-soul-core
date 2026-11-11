/**
 * 合法罢工：不是所有话都得接。
 *
 * 只在我们**控制入口**的通道做真拦截：
 *   - MC 公屏：唤醒决策本来就在我们手里 → 判定为"工具性指令"就**不唤醒她**，
 *     直接由插件用一句状态化的拒绝回过去，**零 token**。
 *   - QQ 群：qqbot 有 ext-inbound 钩子，但目录不在本机可枚举的位置，先不做（见 README）。
 *   - Web 原生对话：拦不住回合，只能靠提示词（见 lib/presence.js 的语气 + 人格块里的说话规则）。
 *
 * 为什么不叫模型来判断：一次分类要 200~500ms，群聊高频时不划算，而且"让你写代码"
 * 这类话有很强的字面特征——规则就够。规则漏了就漏了（那次她照常回），比误拦安全。
 */

/** 工具性指令的特征：让她干活，而不是跟她说话。 */
const TASK_PATTERNS = [
  // 明确的开发动作
  /写(个|一个|段|一下)?\s*(代码|脚本|程序|函数|爬虫|正则|sql|接口|类|测试)/i,
  /(改|修|调试|实现|重构)\s*(一下|下)?\s*(这个|那个|代码|bug|函数|脚本)?/i,
  /(报错|异常|崩溃|编译不过|跑不起来|装不上)/i,
  /(commit|push|merge|rebase|pull request)\b/i,
  // 查资料/整理
  /(查|搜|找)\s*(一下|下)/i,
  /(查|搜|找)\s*(资料|文档|用法|教程|区别|怎么)/i,
  /(总结|整理|归纳|翻译)\s*(一下|下)?/i,
  /(做个|生成|写个)\s*(表格|文档|ppt|报告|清单)/i,
  // 明确的任务式祈使
  /(帮我|给我|替我)\s*(写|改|做|实现|查|翻译|整理|生成|算)/i,
  /\b(TODO|FIXME|unit test|benchmark|refactor)\b/i,
];

/** 聊天/情感特征：命中就不要拦（宁可放过）。 */
const CHAT_PATTERNS = [
  /[?？]\s*$/,
  /(在吗|在不在|干嘛呢|做什么呢|想你了|抱抱|陪我)/,
  /(哈+|嘿+|喵+|呜+|嘤)/,
  /(谢谢|晚安|早安|你好)/,
];

/**
 * 这段公屏消息是不是"让她干活"。
 * @returns {{taskish:boolean, hit?:string, chatty?:boolean}}
 */
export function classifyChat(text) {
  const t = String(text ?? "").trim();
  if (!t) return { taskish: false };
  if (t.length < 6) return { taskish: false, chatty: true };

  const chatty = CHAT_PATTERNS.some((re) => re.test(t));
  for (const re of TASK_PATTERNS) {
    if (re.test(t)) {
      // 带明显聊天特征的（"在吗？帮我写个…"）算聊天，放行——她在玩，不该被任务打断，
      // 但也不该完全无视叫她名字的人。
      if (chatty) return { taskish: false, chatty: true };
      return { taskish: true, hit: String(re) };
    }
  }
  return { taskish: false };
}

/** 状态化拒绝语料（按当前状态挑一句；不叫模型，零成本）。 */
const REFUSALS = {
  sleep: ["…这么晚了喵", "困着呢…明天", "呼…让我睡", "…嗯（翻个身）"],
  focus: ["在看视频，等会儿", "嗯，一会儿说", "忙着呢喵", "等下哈"],
  busy: ["挖着呢，别吵", "正打怪呢！", "手上没空喵", "等我这一趟挖完"],
  awake: ["不想干这个喵", "这会儿不想动脑子", "你自己弄嘛", "今天我歇着"],
};

/** 稳定地挑一句（避免每次同一句）。 */
export function pickRefusal(state = "awake", seed = Date.now()) {
  const list = REFUSALS[state] ?? REFUSALS.awake;
  const i = Math.abs(Number(seed) || 0) % list.length;
  return list[i];
}

/** 拼一句完整的拒绝（带上"我现在的状态"）。 */
export function refusalLine({ state = "awake", name = "", seed = Date.now() } = {}) {
  const who = name ? `${name}，` : "";
  return `${who}${pickRefusal(state, seed)}`;
}

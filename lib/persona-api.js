/**
 * dsh-soul-core / persona-api —— 纯函数层，零 DSH 依赖、零状态。
 *
 * 设计取舍：人格**不是**内存里的单例服务，而是磁盘上的一个目录（+ git）。
 * 这样任何插件（qqbot / 桌宠 / RP agent）都能 `import` 本模块直接读写同一份自我，
 * 不需要 cordis 服务、也不会触发 "服务向全局泄漏" 的激活审计。
 *
 * 唯一的硬约束：`renderBlock()` 的输出会被塞进提示词变量 `{{soul_block}}`，
 * 而 DSH 的插值器遇到未知的 `{{…}}` 会**直接抛错**，所以写出去的文本必须先中和花括号。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "..", "templates");

/** 人格文件清单。budget 单位是字符（不是字节）。 */
export const FILES = [
  { name: "IDENTITY.md", title: "身份", budget: 1200, writable: true },
  { name: "SOUL.md", title: "声音 / 立场 / 边界", budget: 4000, writable: true },
  { name: "USER.md", title: "关于对方", budget: 2500, writable: true },
  { name: "MEMORY.md", title: "长期记忆", budget: 3000, writable: true },
  { name: "RULES.md", title: "硬规则（只读）", budget: 2000, writable: false },
];

/** `soul_remember` 的维度 → MEMORY.md 里的小节标题。 */
export const DIMS = {
  self: "关于我",
  user: "关于你",
  talk: "对话里的事",
  lesson: "我学到的教训",
  pref: "偏好怎么变",
};

/**
 * 域专属记忆：`MEMORY.<域>.md`（如 `MEMORY.mc.md`）。
 *
 * 为什么要有这一层：MEMORY.md 每轮都注入，而"MC 里 (96,104,3) 是家、别乱挖"这种
 * 只在游戏里有意义的规则，塞进去会**同时**付出两个代价——吃掉所有场景的预算，
 * 并且在聊天场景里制造噪音。所以域记忆**只在那个域的 preset 里注入**。
 *
 * 域名来自插件实例的 `config.domain`（persona / mc / qq）。
 */
export const DOMAIN_MEMORY_BUDGET = 2000;

/** 域名合法化：小写字母数字，防路径穿越。 */
export function normalizeDomain(domain) {
  const d = String(domain ?? "").trim().toLowerCase();
  if (!d || d === "persona" || d === "chat") return "";
  return /^[a-z0-9_-]{1,24}$/.test(d) ? d : "";
}

/** 域记忆的文件名（域为空 → 空串，表示"没有域记忆"）。 */
export function domainMemoryName(domain) {
  const d = normalizeDomain(domain);
  return d ? `MEMORY.${d}.md` : "";
}

/** 整份人格块的默认字符预算（可被配置文件覆盖）。 */
export const INJECT_BUDGET = 11000;

/** 配置文件名（固定在 DSH home 下，不随人格目录走——否则改完 root 就找不到它了）。 */
export const CONFIG_FILE_NAME = "soul-core.config.json";

/** `renderBlock` 在人格全空时的兜底。**永远不能返回空串。** */
const FALLBACK = [
  "你是一个带持续自我的人格体。",
  "当前人格目录为空或尚未初始化：先用 soul_status 看一眼，再用 soul_remember / soul_update 把它填起来。",
].join("\n");

function expandHome(input) {
  const text = String(input ?? "").trim();
  if (!text) return "";
  if (text === "~") return homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return join(homedir(), text.slice(2));
  return text;
}

/** DSH home：$DSH_HOME（空/纯空白视为未设）→ ~/.dsh。 */
export function resolveDshHome() {
  const home = expandHome(process.env.DSH_HOME);
  return resolvePath(home || join(homedir(), ".dsh"));
}

export function configPath() {
  return join(resolveDshHome(), CONFIG_FILE_NAME);
}

/** 读插件配置；坏文件按空配置处理（绝不因为配置损坏让插件挂掉）。 */
export function readConfig() {
  try {
    const text = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 合并写入配置；只接受已知字段，避免 UI 塞进来一堆垃圾。 */
export function writeConfig(patch) {
  const current = readConfig();
  const next = { ...current };
  if (patch && typeof patch === "object") {
    if (typeof patch.root === "string") next.root = patch.root.trim();
    if (typeof patch.memoryRoot === "string") next.memoryRoot = patch.memoryRoot.trim();
    if (patch.injectBudget !== undefined) {
      const n = Number(patch.injectBudget);
      if (!Number.isFinite(n) || n < 500 || n > 200000) {
        throw new Error("injectBudget 必须是 500–200000 之间的数字");
      }
      next.injectBudget = Math.round(n);
    }
  }
  mkdirSync(resolveDshHome(), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/** 生效的注入预算：配置 > 默认。 */
export function injectBudget() {
  const n = Number(readConfig().injectBudget);
  return Number.isFinite(n) && n >= 500 ? Math.round(n) : INJECT_BUDGET;
}

/** 记忆库默认子目录——**在人格目录里面**，跟自我放一起，不再另开一棵树。 */
export const DEFAULT_MEMORY_DIR_NAME = "memory-tree";

/**
 * 解析记忆库（事件树/底仓索引）目录。
 * 优先级：显式 > 配置 `memoryRoot` > `$DSH_MEMORY_ROOT` > `<人格目录>/memory-tree`。
 *
 * 默认并进人格目录（`~/.dsh/soul/memory-tree`）——一个自我一个文件夹，
 * 备份/迁移只要拷一个目录。想要独立位置就在设置页里改。
 */
export function resolveMemoryRoot(soulRoot, explicit) {
  const fromArg = expandHome(explicit);
  if (fromArg) return resolvePath(fromArg);
  const fromConfig = expandHome(readConfig().memoryRoot);
  if (fromConfig) return resolvePath(fromConfig);
  const fromEnv = expandHome(process.env.DSH_MEMORY_ROOT);
  if (fromEnv) return resolvePath(fromEnv);
  return join(soulRoot || resolveRoot(), DEFAULT_MEMORY_DIR_NAME);
}

/** 记忆库目录的来源说明。 */
export function resolveMemoryRootSource(explicit) {
  if (expandHome(explicit)) return "config";
  if (expandHome(readConfig().memoryRoot)) return "config-file";
  if (expandHome(process.env.DSH_MEMORY_ROOT)) return "DSH_MEMORY_ROOT";
  return "default(co-located)";
}

/**
 * 解析人格目录（优先级从高到低）：
 *   1. 显式传入（插件 config，测试用）
 *   2. 插件配置文件 `~/.dsh/soul-core.config.json` 的 `root`（UI 里改的就是这个）
 *   3. 环境变量 `DSH_SOUL_ROOT`
 *   4. `<$DSH_HOME|~/.dsh>/soul`
 */
export function resolveRoot(explicit) {
  const fromArg = expandHome(explicit);
  if (fromArg) return resolvePath(fromArg);
  const fromConfig = expandHome(readConfig().root);
  if (fromConfig) return resolvePath(fromConfig);
  const fromEnv = expandHome(process.env.DSH_SOUL_ROOT);
  if (fromEnv) return resolvePath(fromEnv);
  return join(resolveDshHome(), "soul");
}

/** root 的来源说明（UI 上标一下"这路径是谁定的"）。 */
export function resolveRootSource(explicit) {
  if (expandHome(explicit)) return "config";
  if (expandHome(readConfig().root)) return "config-file";
  if (expandHome(process.env.DSH_SOUL_ROOT)) return "DSH_SOUL_ROOT";
  return "default";
}

function template(name) {
  const p = join(TEMPLATES, name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** 幂等播种：只补缺失文件，绝不覆盖已有内容。 */
export function ensureSeed(root = resolveRoot()) {
  mkdirSync(root, { recursive: true });
  const created = [];
  for (const f of FILES) {
    const p = join(root, f.name);
    if (existsSync(p)) continue;
    writeFileSync(p, template(f.name), "utf8");
    created.push(f.name);
  }
  for (const dir of ["journal", "memory"]) {
    const p = join(root, dir);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
  return { root, created };
}

/** 某个文件名是否是「域专项记忆」（`MEMORY.<域>.md`）。 */
export function isDomainMemoryFile(name) {
  return /^MEMORY\.[a-z0-9_-]{1,24}\.md$/.test(String(name ?? ""));
}

/** 读单个文件；不存在返回 ""。域专项记忆也允许读。 */
export function readFile(root, name) {
  const meta = FILES.find((f) => f.name === name);
  if (!meta && !isDomainMemoryFile(name)) {
    throw new Error(`未知人格文件：${name}（可用：${FILES.map((f) => f.name).join(", ")}，或 MEMORY.<域>.md）`);
  }
  const p = join(root, name);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

/** 带行号的原文（`soul_read` 用）。 */
export function readNumbered(root, name) {
  const text = readFile(root, name);
  return text
    .split(/\r?\n/)
    .map((line, i) => `${String(i + 1).padStart(4, " ")}| ${line}`)
    .join("\n");
}

/** 全部文件的内容 + 预算状态。 */
export function readAll(root = resolveRoot()) {
  return FILES.map((f) => {
    const content = existsSync(join(root, f.name)) ? readFile(root, f.name) : "";
    return {
      ...f,
      content,
      chars: content.length,
      overBudget: content.length > f.budget,
    };
  });
}

/**
 * 中和花括号：DSH 的提示词插值器把 `{{name}}` 当变量引用，未知引用会抛错。
 * 人格文件是用户自由编辑的，必须无条件中和。
 */
/**
 * 从 IDENTITY.md 读她自己定的名字（游戏里被叫的就是它）。
 * 占位符（"还没定"）视为未定，返回空串——别拿占位符去当唤醒词。
 */
export function personaName(root = resolveRoot()) {
  try {
    const text = readFile(root, "IDENTITY.md");
    const m = text.match(/名字\s*[:：]\s*(.+)/);
    if (!m) return "";
    let name = m[1].trim();
    // 去掉括注："小鱼（游戏中）" → "小鱼"
    name = name.replace(/[（(].*?[)）]/g, "").trim();
    name = name.replace(/[\[【].*?[\]】]/g, "").trim();
    if (!name) return "";
    if (/还没定|待定|未定|TODO|todo|^-+$/.test(name)) return "";
    if (name.length > 20) return "";
    return name;
  } catch {
    return "";
  }
}


/**
 * 当前本地时间的一句话描述。
 *
 * 为什么单独给这个：她分不清"今天/昨天/刚才"、也不知道现在几点，
 * 于是会说"现在应该是晚上吧""昨天我们…"这类错话。时间不是知识，是处境。
 */
export function nowStamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  const tz = -d.getTimezoneOffset() / 60;
  const tzLabel = `UTC${tz >= 0 ? "+" : ""}${tz}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${week}（${tzLabel}）`;
}

export function neutralizeBraces(text) {
  // 目标：渲染结果里**不出现相邻的同向花括号**（`{{\u2026}}` 会被 DSH 插值器当成变量引用，
  // 未知引用直接抛错，整个会话的提示词组装失败）。
  // 做法：只在相邻花括号之间插一个零宽空格 U+200B——肉眼无变化、内容零丢失，
  // 且不会像替换成 "{ {" 那样在串联时又拼出新的 "{{"。
  const src = String(text ?? "");
  const ZWSP = "\u200b";
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    out += ch;
    const next = src[i + 1];
    if ((ch === "{" && next === "{") || (ch === "}" && next === "}")) out += ZWSP;
  }
  return out;
}

/**
 * 渲染注入块（会被赋值给提示词变量 `soul_block`，而 `dsh-persona` 的
 * `complete: true` 会让它成为**唯一**的系统提示词）。
 *
 * @param root 人格目录
 * @param options.budget 总字符预算
 * @param options.withTools 是否附上专属工具清单（接管式下没有工具引导段，得在这里说）
 */
export function renderBlock(root = resolveRoot(), options = {}) {
  const budget = Number.isInteger(options.budget) ? options.budget : injectBudget();
  const files = readAll(root).filter((f) => f.content.trim().length > 0);

  const head = [
    "你是一个带持续自我的人格体：不是一次设定好的角色，而是会变、会记、也会记错的那种。",
    "下面是你的自我，每轮从磁盘重新读取——改了立刻生效，不需要重启。",
  ];

  const body = [];
  for (const f of files) {
    let text = f.content.trim();
    // 去掉文件自己的 `# 标题` 行——外层已经给了 `## 标题`
    text = text.replace(/^#\s+[^\n]*\n+/, "");
    if (text.length > f.budget) text = text.slice(0, f.budget) + "\n…（超出预算已截断）";
    body.push(`## ${f.title}\n${text}`);
  }

  const toolLines = [
    "- `soul_status` 看各文件字符/预算、今日日记条数。要改自己之前先看它。",
    "- `soul_read` 读原文（带行号）。",
    "- `soul_remember` 记一条人格记忆（dim: self|user|talk|lesson|pref，why 必填）。在 MC/群场景里写的会进该场景的专项记忆，不进全局。",
    "- `soul_journal` 记一条当天观察（便宜、不限次；不注入，靠 soul_recall 检索）。",
    "- `soul_recall` 检索人格记忆与日笔记。上下文里已自动注入的相关记忆算查过了；注入没覆盖再调它。",
    "- `soul_update` 改可写文件（RULES.md 只读）。超预算会被拒，要先压缩旧内容。",
    "- `memory_episodes` 列出底仓里的事件骨架（话题段 + 锚点 seq）。想知道过去发生过什么时用它。",
    "- `memory_expand` 按锚点（sessionId + seq）下钻回原始对话。摘要不够确定、要原话时用它。",
    "- `memory_annotate` 给一段事件骨架写摘要（锚点 `seq|片段` 会被机械校验，编造直接拒收）。",
    "- `memory_search` 检索事件摘要与全文。遇到『上次那个』先用它，再下钻。",
    "- `soul_digest` 蒸馏提案：从人格库全文抽『反复出现的偏好』与『最近常聊的』（只出提案，写不写由你定）。",
    options.withGenericTools
      ? "- 你还有一套通用工具（读写文件 `read`/`write`/`edit`、检索 `glob`/`grep`、跑命令 `pwsh`、后台任务、技能）。用法看各自的工具描述；**动它们之前，先按「动手的时候」说话**。"
      : "",
  ];
  const tools = options.withTools === false ? [] : [`## 你手上的工具\n${toolLines.join("\n")}`];

  const tail = ["以上是你的自我。不确定的事说不知道，别编。"];

  const parts = [...head, ...body, ...tools, ...tail];
  let text = parts.join("\n\n");
  if (text.length > budget) text = text.slice(0, budget) + "\n…（人格块超预算已截断）";
  const out = neutralizeBraces(text).trim();
  return out.length > 0 ? out : FALLBACK;
}

/**
 * 渲染某个域的专属记忆块（只在那个域的 preset 里注入）。
 *
 * 空文件/不存在 → 返回空串（不能往人格块塞空标题）。
 */
export function renderDomainBlock(root, domain, options = {}) {
  const name = domainMemoryName(domain);
  if (!name) return "";
  const budget = options.budget ?? DOMAIN_MEMORY_BUDGET;
  let text = "";
  try {
    text = readFile(root, name).trim();
  } catch {
    return "";
  }
  if (!text) return "";
  // 去掉文件自己的 `# 标题`
  text = text.replace(/^#\s+[^\n]*\n+/, "");
  if (text.length > budget) text = `${text.slice(0, budget)}\n…（超预算已截断）`;
  const label = normalizeDomain(domain);
  return `## ${label} 专项记忆（只在这个场景注入，别处看不到）\n${text}`;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` };
}

/** 追加一条当天日记（不注入，靠 soul_recall 检索）。 */
export function appendJournal(root, text, options = {}) {
  const body = String(text ?? "").trim();
  if (!body) throw new Error("journal 内容为空");
  const { date, time } = today();
  const kind = options.kind ? `[${options.kind}] ` : "";
  const dir = join(root, "memory");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${date}.md`);
  if (!existsSync(p)) writeFileSync(p, `# ${date}\n\n`, "utf8");
  appendFileSync(p, `- ${time} ${kind}${body.replace(/\r?\n/g, " ")}\n`, "utf8");
  return { file: `memory/${date}.md`, date };
}

/** 读某天（默认今天）的日记。 */
export function readJournal(root, date) {
  const day = date || today().date;
  const p = join(root, "memory", `${day}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function splitSection(md, heading) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) { end = i; break; }
  }
  return { lines, start, end };
}

/**
 * 记一条人格记忆：写进 MEMORY.md 对应维度小节的末尾。
 * 超预算直接抛错——逼模型先压缩旧内容（对应 RULES.md 第 3 条）。
 */
/**
 * 记一条记忆。
 *
 * `domain` 非空（如 "mc"）→ 写进 `MEMORY.mc.md`（**只在那个域的 preset 里注入**），
 * 而不是每轮都注入的 MEMORY.md。这是"MC 专项别污染长期记忆"的落地点。
 */
export function remember(root, { dim, text, why, domain } = {}) {
  const heading = DIMS[dim];
  if (!heading) throw new Error(`dim 必须是 ${Object.keys(DIMS).join("|")} 之一`);
  const body = String(text ?? "").trim().replace(/\r?\n/g, " ");
  if (!body) throw new Error("text 为空");
  const reason = String(why ?? "").trim();
  if (!reason) throw new Error("why 必填：写清为什么这条值得进人格记忆");

  const domainName = domainMemoryName(domain);
  const fileName = domainName || "MEMORY.md";
  const meta = domainName
    ? { name: fileName, budget: DOMAIN_MEMORY_BUDGET }
    : FILES.find((f) => f.name === "MEMORY.md");

  let md = readFile(root, fileName);
  if (!md.trim()) {
    md = domainName
      ? `# ${normalizeDomain(domain)} 专项记忆\n\n> 只在 ${normalizeDomain(domain)} 场景注入。跨场景的稳定事实请写进 MEMORY.md。\n`
      : "# 人格记忆\n";
  }

  const { date } = today();
  const bullet = `- （${date}）${body}${reason ? `　〔why: ${reason}〕` : ""}`;
  const sec = splitSection(md, heading);

  if (sec) {
    // 插到该小节末尾；末尾若不是空行，先补一个空行，避免 bullet 贴住下一个 `##`
    const before = sec.lines.slice(0, sec.end);
    while (before.length && before[before.length - 1].trim() === "") before.pop();
    const next = [...before, bullet, "", ...sec.lines.slice(sec.end)];
    md = next.join("\n");
  } else {
    md = md.replace(/\s*$/, "") + `\n\n## ${heading}\n${bullet}\n`;
  }

  if (md.length > meta.budget) {
    throw new Error(
      `${fileName} 会超预算：${md.length} > ${meta.budget} 字符。先用 soul_update 压缩/合并旧条目，再写新的。`,
    );
  }
  writeFileSync(join(root, fileName), md, "utf8");
  appendJournal(root, `remember[${dim}]${domainName ? `@${normalizeDomain(domain)}` : ""} ${body}（why: ${reason}）`, {
    kind: "remember",
  });
  return { ok: true, file: fileName, chars: md.length, budget: meta.budget, section: heading };
}

/** 覆盖写一个可写文件（`soul_update`）。RULES.md 被拒。 */
export function updateFile(root, { name, content, why } = {}) {
  const meta = FILES.find((f) => f.name === name);
  if (!meta) throw new Error(`未知人格文件：${name}`);
  if (!meta.writable) throw new Error(`${name} 是只读锚点，agent 不允许改写（人类可以直接编辑）`);
  const body = String(content ?? "");
  if (!body.trim()) throw new Error("content 为空：想删内容请明确地写空之外的处理方式");
  if (!String(why ?? "").trim()) throw new Error("why 必填");
  if (body.length > meta.budget) {
    throw new Error(`${name} 会超预算：${body.length} > ${meta.budget} 字符。先压缩再写。`);
  }
  writeFileSync(join(root, name), body, "utf8");
  appendJournal(root, `update[${name}] ${meta.budget - body.length} 字符余量（why: ${why}）`, { kind: "update" });
  return { ok: true, chars: body.length, budget: meta.budget };
}

function terms(query) {
  const out = new Set();
  const text = String(query ?? "").toLowerCase();
  for (const m of text.matchAll(/[a-z0-9_]+|[\u4e00-\u9fff]+/g)) {
    const s = m[0];
    if (/[\u4e00-\u9fff]/.test(s)) {
      if (s.length <= 2) out.add(s);
      else for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    } else if (s.length > 1) {
      out.add(s);
    }
  }
  return [...out];
}

/**
 * 检索人格记忆 + 日笔记（朴素词命中打分，够用且零依赖）。
 * 说自己"记得"之前必须走这里——这是硬规则第 4 条的落地。
 */
export function recall(root, query, options = {}) {
  const limit = Number.isInteger(options.limit) ? options.limit : 8;
  const list = terms(query);
  if (list.length === 0) return { query, terms: [], hits: [] };

  const sources = [];
  const memPath = join(root, "MEMORY.md");
  if (existsSync(memPath)) sources.push({ label: "MEMORY.md", text: readFileSync(memPath, "utf8"), lines: readFileSync(memPath, "utf8").split(/\r?\n/) });

  const memDir = join(root, "memory");
  if (existsSync(memDir)) {
    const days = readdirSync(memDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .slice(-30);
    for (const day of days) {
      const text = readFileSync(join(memDir, day), "utf8");
      sources.push({ label: `memory/${day}`, text, lines: text.split(/\r?\n/) });
    }
  }

  const hits = [];
  for (const src of sources) {
    src.lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      let score = 0;
      for (const t of list) if (trimmed.toLowerCase().includes(t)) score += 1;
      if (score > 0) {
        hits.push({
          text: trimmed.replace(/^-\s*/, ""),
          source: `${src.label}:${i + 1}`,
          score,
        });
      }
    });
  }
  hits.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
  return { query, terms: list, hits: hits.slice(0, limit) };
}

/** 状态汇总（`soul_status` 与 UI 共用）。 */
export function status(root = resolveRoot()) {
  const files = readAll(root).map((f) => ({
    name: f.name,
    title: f.title,
    chars: f.chars,
    budget: f.budget,
    writable: f.writable,
    overBudget: f.overBudget,
  }));
  // 域记忆也算进来（不进人格块，但要能看见）
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const m = entry.isFile() && entry.name.match(/^MEMORY\.([a-z0-9_-]{1,24})\.md$/);
      if (!m) continue;
      const chars = readFileSync(join(root, entry.name), "utf8").length;
      files.push({
        name: entry.name,
        title: `${m[1]} 专项记忆`,
        chars,
        budget: DOMAIN_MEMORY_BUDGET,
        writable: true,
        overBudget: chars > DOMAIN_MEMORY_BUDGET,
      });
    }
  } catch {
    /* 目录读不了就算了 */
  }
  const total = files.reduce((n, f) => n + f.chars, 0);
  const journal = readJournal(root);
  const memoryBullets = readFile(root, "MEMORY.md")
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s+/.test(l)).length;
  let updatedAt = "";
  try {
    updatedAt = statSync(join(root, "MEMORY.md")).mtime.toISOString();
  } catch {
    updatedAt = "";
  }
  return {
    root,
    configPath: configPath(),
    injectBudget: injectBudget(),
    totalChars: total,
    files,
    journalToday: journal.split(/\r?\n/).filter((l) => /^\s*-\s+/.test(l)).length,
    memoryBullets,
    updatedAt,
  };
}

/** 目录是否已经初始化（host 启动时用来决定要不要播种）。 */
export function isSeeded(root) {
  return FILES.every((f) => existsSync(join(root, f.name)));
}

export default {
  FILES,
  DIMS,
  INJECT_BUDGET,
  CONFIG_FILE_NAME,
  DEFAULT_MEMORY_DIR_NAME,
  resolveDshHome,
  resolveRoot,
  resolveRootSource,
  resolveMemoryRoot,
  resolveMemoryRootSource,
  configPath,
  readConfig,
  writeConfig,
  injectBudget,
  ensureSeed,
  isSeeded,
  readFile,
  readNumbered,
  readAll,
  renderBlock,
  neutralizeBraces,
  nowStamp,
  personaName,
  appendJournal,
  readJournal,
  remember,
  renderDomainBlock,
  domainMemoryName,
  normalizeDomain,
  DOMAIN_MEMORY_BUDGET,
  updateFile,
  recall,
  status,
};

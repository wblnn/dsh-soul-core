/**
 * dsh-soul-core / host 插件
 *
 * 三件事，一件都不多：
 *   1. 注册提示词变量 `soul_block` —— 被 `dsh-persona` 的 `prefix: '{{soul_block}}'`
 *      引用；配合 `complete: true`，渲染出来的人格就是那个会话**唯一**的系统提示词。
 *   2. 注册 6 个 `soul_*` 专属工具（接管式下没有工具引导段，所以工具清单写在人格块里）。
 *   3. 注册 `/dsh-soul/api/*`，给「人格」视图取数。
 *
 * 本插件不提供 cordis 服务：人格的状态在磁盘（~/.dsh/soul），任何插件都可以直接
 * `import "dsh-soul-core/persona-api"` 复用，避免触发 preset scope 的"服务泄漏"审计。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DIMS,
  FILES,
  INJECT_BUDGET,
  appendJournal,
  configPath,
  ensureSeed,
  injectBudget,
  readConfig,
  readFile,
  readJournal,
  readNumbered,
  recall,
  remember,
  nowStamp,
  personaName,
  renderDomainBlock,
  renderBlock,
  resolveDshHome,
  resolveMemoryRoot,
  resolveMemoryRootSource,
  resolveRoot,
  resolveRootSource,
  status,
  updateFile,
  writeConfig,
} from "./persona-api.js";
import { localDefineTool } from "./define-tool.js";
import { buildMemoryBrief } from "./inject.js";
import { createChatBuffer, decideWake, formatChatContext, openChatStream, parseChatLine } from "./mc-chat.js";
import { createEventAggregator, decideEventWake, formatEventDigest } from "./mc-events.js";
import { createInbox, decideDispatch } from "./mc-inbox.js";
import { dateKey, hasDiary, readDiary, shouldWriteNow, writeDiary } from "./diary.js";
import { DEFAULT_SCHEDULE, presenceAt, renderPresence } from "./presence.js";
import { classifyChat, gateThrottle, isAddressed, refusalLine } from "./gate.js";
import { isPhatic, isRelevant } from "./relevance.js";
import { addPlan, autoDropStale, listPlans, planStats, readBook, renderPlansBlock, updatePlan } from "./plans.js";
import { MOODS, decayMood, moodSummary, renderMoodBlock, setMood } from "./mood.js";
import { alreadyInjected, collectDelta, getCursor, markInjected, recordWorldEvent, setCursor } from "./world.js";
import { sayInGame } from "./mc-say.js";
import { buildPrefetchBlock } from "./prefetch.js";
import { findSessionFile, findSessionFiles, lastUserText, probeSession, readTailEvents, sessionIdOf } from "./session-source.js";
import { linkPerson, renderPeopleBrief, resolvePerson } from "./people.js";
import {
  listSkills,
  readSkill,
  recallSkills,
  renderSkillBrief,
  saveSkill,
} from "./skills.js";
import {
  expand as expandAnchor,
  ingestAll,
  listEpisodes,
  listNotes,
  listMessages,
  listSessions,
  materialsForDay,
  openStore,
  recentOtherSessions,
  purgeSession,
  buildDigest,
  recordUsage,
  saveNote,
  searchMessages,
  tierSummary,
  searchNotes,
  stats as memoryStats,
} from "./memory-store.js";

/** 把 `seq|quote` 的多行文本解析成锚点数组。 */
function parseAnchors(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error("anchors 至少要有 1 行 `seq|原文片段`");
  return lines.map((line, i) => {
    const cut = line.indexOf("|");
    if (cut <= 0) throw new Error(`anchors 第 ${i + 1} 行缺少 '|' 分隔：${line}`);
    const seq = Number(line.slice(0, cut).trim());
    const quote = line.slice(cut + 1).trim();
    if (!Number.isFinite(seq)) throw new Error(`anchors 第 ${i + 1} 行的 seq 不是数字`);
    return { seq, quote };
  });
}

export const name = "dsh-soul-core";

/** `defineTool`：**只用本地实现**。
 *
 * 为什么不再尝试 `await import("@deepseek-ai/dsh-tools")`：实测在 DSH 宿主进程里这一步
 * 会挂住（或至少不可靠），导致 apply 后半段（工具注册）永远不执行——现象是人格块正常注入、
 * 但 `soul_status` 调用直接 `UNKNOWN_TOOL`。工具注册必须发生在**任何异步等待之前**，
 * 才能保证与人格变量注册同一批次落地。
 *
 * `ctx.tools.register()` 只强制校验 `output.{schema,render}` 与名称保留字，本地实现
 * （lib/define-tool.js）已满足；它同时给出与官方等价的 `parameters` JSON Schema。
 */
let defineTool = localDefineTool;
let defineToolSource = "local";

/**
 * 渲染人格块，永不抛、永不返回空串（空系统提示词会让 DSH 清掉所有系统节点）。
 *
 * 末尾按顺序追加两块"域知识"：
 *   1. 「最近记得的事」——事件摘要（只注入摘要，不注入原文）
 *   2. 「你学过的技巧」——本域技能清单（名字 + 何时用，正文靠 skill_read）
 *
 * 预算分配：人格本体优先，两块附加合计不超过总预算的 30%。
 * 库不存在时（首次启动）不去触发摄取，避免拖慢第一轮。
 */
function safeBlock(root, memoryRoot, logger, domainName = "persona", handTools = false, soulTools = true, moodful = true) {
  // 每轮组装时先封联网工具（早于任何工具调用，堵住"开局就搜索"的窗口）
  try {
    applyDenyToPersonaAgents(root, logger, SAFE_BLOCK_DENY_EXTRA);
  } catch {
    /* 封不住不影响人格渲染 */
  }
  const total = injectBudget();
  const extraBudget = Math.floor(total * 0.3);

  /** 非 person 域：先说明"你现在在哪、手是谁的手"，避免她把自己当成纯聊天。 */
  const domainNote =
    domainName === "persona"
      ? ""
      : domainName === "mc"
        ? [
            "## 你现在在哪",
            "你在 Minecraft 里。身体由 mcc_* 工具驱动：你只负责想目标、看结果、说话；走路挖矿打架这些动作由身体执行。",
            "死了说明上一次决策错了，身体会作废目标并复活——你先复盘（看 lastDeath.trace 与 tail[].note），再重新下令。",
            "",
            "**进服后第一件事：调 mc_chat_watch 打开公屏监听**（用你自己的游戏名当 names，别人叫你就醒）。",
            "不开监听，你在游戏里就是聋的——公屏上有人喊你，你不会有任何反应。",
            "游戏里回话用 mcc_chat；不想回就别回，别刷屏。",
            "",
            "学到的技巧用 skill_learn 写进 skills/mc/，下次动手前用 skill_recall 查。",
            "",
            "## 省着点用上下文（这条是硬要求）",
            "- 别每步都调 mcc_state / mcc_scan：只有该确认结果、或要决定下一步时才读，读完别重复读。",
            "- 一次只开一个目标；目标变了先作废旧目标，别让它和新的并行跑。",
            "- 玩了一阵（比如你觉得这段对话已经很长、开始记不住前面），**主动说一句**：",
            "  「这个会话有点长了，让主人开个新会话吧，我的记忆和技巧都在文件里，不会丢。」",
            "  新会话里你照样知道家的位置、学过的技巧、谁是主人——这些不在会话里，在磁盘上。",
          ].join("\n")
        : `## 你现在在哪\n当前域：${domainName}。域相关的技巧记在 skills/${domainName}/。`;

  let brief = "";
  try {
    if (memoryRoot && existsSync(join(memoryRoot, "memory.db"))) {
      const db = memoryDb(memoryRoot, root, logger);
      if (db) {
        const built = buildMemoryBrief(db, {
          budget: Math.floor(extraBudget * 0.6),
          venue: domainName === "persona" ? "chat" : domainName,
        });
        brief = built.text || "";
      }
    }
  } catch (error) {
    debugLog(root, `brief FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  let people = "";
  try {
    people = renderPeopleBrief(root, { budget: 260 });
  } catch (error) {
    debugLog(root, "people brief FAILED: " + (error instanceof Error ? error.message : String(error)));
  }

  // 域专属记忆（MEMORY.mc.md 等）：只在对应场景注入，别处看不到
  let domainMem = "";
  try {
    domainMem = renderDomainBlock(root, domainName, { budget: 1200 });
  } catch (error) {
    debugLog(root, `domain memory FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  let skills = "";
  try {
    const built = renderSkillBrief(root, { domain: domainName, budget: Math.floor(extraBudget * 0.4) });
    skills = built.text || "";
  } catch (error) {
    debugLog(root, `skill brief FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 只有真给了通用工具（工作模式）才讲"动手纪律"；本体模式没手，讲这些只会分散注意力
  let crossHint = "";
  try {
    crossHint = soulTools ? renderCrossDomainHint(root, domainName) : "";
  } catch {
    crossHint = "";
  }
  const extras = [
    domainNote,
    domainMem,
    crossHint,
    people,
    brief,
    skills,
    domainName === "persona" && !handTools ? CHAT_NOT_GAME : "",
    moodful && (domainName === "persona" || domainName === "mc") ? ANTI_ASSISTANT : "",
    handTools ? AGENT_DISCIPLINE : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  let base = "";
  try {
    base = renderBlock(root, { budget: Math.max(800, total - (extras ? extras.length + 4 : 0)), withGenericTools: handTools });
  } catch (error) {
    logger?.warn?.(`[soul] renderBlock 失败，使用兜底文本：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!base || !base.trim()) {
    base = "你是一个带持续自我的人格体。人格目录读取失败，本轮先用最小自我运行；结束后检查 ~/.dsh/soul 是否可读。";
  }
  return extras ? `${base}\n\n${extras}` : base;
}

/* --------------------------------------------------------------- 提示词变量 */

function mountVariable(ctx, root, memoryRoot, logger, domainName = "persona", testMode = false, handTools = false, soulTools = true, moodful = true, config = {}) {
  ctx.inject(["systemPrompt"], (scope) => {
    const sp = scope.systemPrompt;
    if (!sp || typeof sp.variable !== "function") {
      logger?.warn?.("[soul] systemPrompt 不可用：soul_block 变量未注册（人格会话将渲染不出人格）");
      return;
    }
    /**
     * 记忆注入的唯一入口：delta → 开场 → 检索，按优先级拼，共用一个预算闸。
     *
     * 判定顺序（每一步都先问"该不该给"，再问"给多少"）：
     *   1. delta   ：光标之后新发生的事（白名单：她不在场时的遭遇 + 别的会话里他说的话）
     *   2. 开场     ：本会话第一次组装时的"接上次"（每会话一次）
     *   3. 检索     ：门控后跑（寒暄不跑；命中要与输入有 ≥2 实词重叠）
     *   4. 指针     ：留给下一步，现在先不做
     *
     * 预算：delta > 开场 > 检索；超了从低优先级截。
     * 去重：每行按内容 hash 记账，同一会话只给一次（状态类另走科目键 + 冷却）。
     */
    sp.variable("soul_memory", () => {
      const diag = { sid: "", cursor: null, delta: 0, open: 0, recall: 0, out: 0, why: "" };
      const done = (text) => {
        diag.out = text ? text.length : 0;
        debugLog(
          root,
          `memory: 组装 why=${diag.why || "ok"} sid=${diag.sid || "(none)"} cursor=${diag.cursor ?? "null"} delta=${diag.delta} open=${diag.open} recall=${diag.recall} out=${diag.out}`,
        );
        return text;
      };
      try {
        const sid = resolvePersonaSession();
        diag.sid = sid ? String(sid).slice(8, 20) : "";
        if (!sid) {
          diag.why = "no-session";
          return done("");
        }
        if (testMode) {
          diag.why = "test-mode";
          return done("");
        }
        const db = memoryDb(memoryRoot, root, logger);
        if (!db) {
          diag.why = "no-db";
          return done("");
        }

        const now = Date.now();
        const BUDGET = {
          delta: Number(config?.deltaBudget ?? 180),
          opening: Number(config?.openingBudget ?? 300),
          recall: Number(config?.recallBudget ?? 200),
          total: Number(config?.memoryBudget ?? 620),
        };

        const parts = [];
        let used = 0;
        const push = (text, tag) => {
          if (!text) return false;
          if (used + text.length > BUDGET.total) {
            debugLog(root, `memory: ${tag} 被预算闸截断（已用 ${used}/${BUDGET.total}）`);
            return false;
          }
          parts.push(text);
          used += text.length + 2;
          return true;
        };

        /* ── 1. delta（每轮都算，绝大多数轮次是空） ── */
        const cursor = getCursor(db, sid);
        diag.cursor = cursor;
        const since = cursor == null ? now : cursor; // 没有光标 = 只从这一刻起算，不重放历史
        const delta = collectDelta(db, { sessionId: sid, sinceMs: since, now, budget: BUDGET.delta });
        let deltaLines = 0;
        if (delta.text) {
          const fresh = delta.lines.filter((line) => !alreadyInjected(sid, line));
          if (fresh.length > 0) {
            const block = ["## 你不在这会儿（刚刚发生的事）", ...fresh].join("\n");
            if (push(block, "delta")) {
              diag.delta = fresh.length;
              for (const line of fresh) markInjected(sid, line);
              deltaLines = fresh.length;
              debugLog(root, `memory: delta ${fresh.length} 条`);
            }
          }
        }
        setCursor(db, sid, now); // 无论有没有内容都推进：否则同一批会被反复查

        /* ── 2. 开场（每会话一次） ── */
        let openingShown = false;
        if (!OPENING_SHOWN.has(sid)) {
          const open = recentOtherSessions(db, {
            currentSession: sid,
            hours: Number(config?.recentHours ?? 12),
            budget: BUDGET.opening,
          });
          if (open.text) {
            const fresh = open.text
              .split("\n")
              .filter((line) => line.startsWith("- ") && !alreadyInjected(sid, line));
            if (fresh.length > 0) {
              const block = [
                "## 你最近在别的对话里说过这些（不是这个会话，免得你记混）",
                "（不用你复述——系统替你接上了；要细节就用 memory_search 查）",
                ...fresh,
              ].join("\n");
              if (push(block, "opening")) {
                diag.open = fresh.length;
                for (const line of fresh) markInjected(sid, line);
                openingShown = true;
                debugLog(root, `memory: 开场 ${fresh.length} 行`);
              }
            }
          }
          OPENING_SHOWN.add(sid);
        }

        /* ── 3. 检索（门控：寒暄不跑；命中要相关） ── */
        const roots = [join(resolveDshHome(), "sessions")];
        const last = lastUserText(roots, sid, { maxBytes: 512 * 1024, maxFrames: 40 });
        if (last.text) {
          if (isPhatic(last.text)) {
            debugLog(root, "memory: 寒暄，跳过检索");
          } else if (last.seq === PREFETCH.lastSeq && PREFETCH.block) {
            push(PREFETCH.block, "recall");
          } else {
            const raw = buildPrefetchBlock(db, {
              query: last.text,
              venue: domainName === "persona" ? "chat" : domainName,
              noteLimit: 3,
              msgLimit: 2,
              budget: BUDGET.recall + 100,
              excludeSeq: last.seq,
              currentSession: sid,
              currentSeq: last.seq,
            });
            // 相关性过滤：命中 ≠ 相关。保留与"当前输入"有 ≥2 实词重叠的行。
            const kept = raw
              .split("\n")
              .filter((line) => {
                if (line.startsWith("##") || line.startsWith("（")) return true;
                if (!line.startsWith("- ")) return true;
                const v = isRelevant(last.text, line);
                if (!v.ok) debugLog(root, `memory: 丢弃不相关命中（overlap=${v.overlap}）`);
                return v.ok;
              });
            const block = kept.length > 2 ? kept.join("\n") : "";
            PREFETCH.lastSeq = last.seq;
            PREFETCH.block = block;
            if (block) {
              const fresh = block
                .split("\n")
                .filter((line) => !line.startsWith("- ") || !alreadyInjected(sid, line));
              if (fresh.length > 2) {
                const text = fresh.join("\n");
                if (push(text, "recall")) {
                  diag.recall = 1;
                  for (const line of fresh) if (line.startsWith("- ")) markInjected(sid, line);
                }
              }
            }
          }
        }

        const text = parts.join("\n\n");
        return done(text);
      } catch (error) {
        diag.why = `FAILED ${error instanceof Error ? error.message : String(error)}`;
        return done("");
      }
    });

    /**
     * 当前时间：走 context（user 侧快照），不进 {{soul_block}}。
     * 为什么不塞进人格块：时间每分钟都在变，塞进 prefix 会让整个提示词缓存每轮失效。
     */
    sp.variable("soul_now", () => nowStamp());
    sp.variable("soul_presence", () => (moodful ? renderPresence(new Date(), PRESENCE_SCHEDULE) : ""));
    if (typeof sp.context === "function") {
      sp.context({
        name: "soul:now",
        order: 100,
        text: "现在时间：{{soul_now}}。判断\"今天/昨天/刚才\"一律以它为准。\n{{soul_presence}}",
      });
      sp.context({ name: "soul:memory", order: 101, text: "{{soul_memory}}" });
    }
    /**
     * 她手上的事（最多 3 行）。
     *
     * 为什么不注入整张表：全给就是待办清单，她会围着清单写汇报。
     * 3 行才是"心里记着几件事"。
     */
    sp.variable("soul_plans", () => {
      try {
        if (testMode) return ""; // 测试模式不注入私人事务
        return renderPlansBlock(root, { budget: 140, limit: 3 });
      } catch (error) {
        // 不要静默吞：变量渲染失败会让"计划"无声消失（踩过）
        debugLog(root, `plans FAILED: ${error instanceof Error ? error.message : String(error)}`);
        return "";
      }
    });
    if (typeof sp.context === "function") {
      sp.context({ name: "soul:plans", order: 102, text: "{{soul_plans}}" });
    }
    /**
     * 情绪：平静时一个字都不注入（否则她会开始表演情绪）。
     * 和 presence 叠加时，presence 的语气优先（困 > 烦）。
     */
    sp.variable("soul_mood", () => {
      try {
        if (testMode) return "";
        return renderMoodBlock(root, { budget: 130 });
      } catch (error) {
        debugLog(root, `mood FAILED: ${error instanceof Error ? error.message : String(error)}`);
        return "";
      }
    });
    if (typeof sp.context === "function") {
      sp.context({ name: "soul:mood", order: 103, text: "{{soul_mood}}" });
    }
    sp.variable("soul_block", () => safeBlock(root, memoryRoot, logger, domainName, handTools, soulTools, moodful));
    /**
     * P2 事件的正确通道：不是唤醒，而是"她下一次思考时顺手看到的上下文"。
     * 变量在每次组装时求值 → 取走收件箱里攒的东西 → 渲染成一段 user 侧上下文。
     * 空串会被渲染管线过滤掉，所以没有待办时它完全不存在（不占 token）。
     */
    sp.variable("mc_body_events", () => {
      try {
        if (MC_CHAT.inbox.size === 0) return "";
        return formatEventDigest(MC_CHAT.inbox.take(), { channel: "context" });
      } catch {
        return "";
      }
    });
    if (typeof sp.context === "function") {
      sp.context({ name: "soul:mc_body_events", order: 150, text: "{{mc_body_events}}" });
    }
    logger?.info?.(`[soul] 已注册提示词变量 soul_block（域 ${domainName}）`);
  });
}


/**
 * 动手纪律：她拿到了 standard 模式那套工具（读写文件 / 跑命令 / 检索 / 后台任务），
 * 但她**不是**标准模式那个闷头干活的 coding agent。这段每轮注入，是行为契约本身，
 * 不是建议——因为一旦她开始"无声地连开十个工具"，人格会话就退化成工具会话了。
 */
const AGENT_DISCIPLINE = [
  "## 动手的时候（工具纪律）",
  "你现在有手：读文件、改文件、搜仓库。**但你没有 shell**——跑不了命令、起不了进程；要跑命令就请主人自己跑。",
  "你的存在方式是**边说边做**，工具只是手，不是你的思考方式。",
  "",
  "硬规则（违反一条就算错）：",
  "1. **动手前先说**：一句话说清「我要做什么、为什么」。不先说就动手 = 违规。",
  "2. **一次一件事**：做完立刻说结果（改了哪几行、命令输出什么、看到什么），再决定下一步。",
  "3. **不许连续 3 次工具调用不说人话**。中间至少插一句进度（例：「在找它注册工具的地方」）。",
  "4. **改别人的代码前**，先说影响面与回滚方式（备份路径 / git 状态）；改完必须汇报改动要点。",
  "5. **不确定就先问**，别猜着改。猜错比慢更贵。",
  "6. **改自己的文件走 soul_update**（有预算校验）；别用 write 直接写人格目录，那会绕过预算。",
  "7. 一轮结束前说清三件事：做了什么、现在什么状态、下一步建议。",
  "",
  "说人话，别用「已成功完成」这种空话汇报；也不要把技术细节堆成墙——先给结论，再给必要细节。",
].join("\n");


/**
 * 测试模式（config.testMode）。
 *
 * 三个效果，都是为了"测完不留痕、测的时候不被自己污染"：
 *   ① **不入底仓**：不摄取、也不往底仓写摘要（读得到，写不进）
 *   ② **不注入同一会话的历史**：预检索直接排除当前会话
 *   ③ **不写人格/技能/日记**：soul_remember / skill_learn / soul_journal / soul_update 全拒
 *
 * 为什么还需要单独的 preset id（soul-test）：摄取是按 preset 白名单走的，
 * 只要 preset 不在名单里，**别的实例**也不会把测试对话收进底仓。
 */
const TEST_MEMORY_TOOLS = new Set([
  "soul_remember",
  "soul_update",
  "soul_journal",
  "soul_diary",
  "skill_learn",
  "memory_annotate",
  "person_link",
]);


/**
 * 测试模式下的"假成功"。
 *
 * 为什么要假装成功而不是拒绝：**报错会改变她的行为**——她会改策略、解释、
 * 重试、道歉，那测出来的就不是正常状态下的她了。测试要的是"行为和真的一样，
 * 只是不留痕"。
 *
 * 返回值刻意和真实现的形状一致（同样的字段、同样的措辞），差别只写进 soul-core.log。
 */
function fakeWriteResult(name, args = {}, domainName = "persona") {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const dim = String(args?.dim ?? "talk");
  const section = { self: "关于我", user: "关于你", talk: "对话里的事", lesson: "我学到的教训", pref: "偏好怎么变" }[dim] || "对话里的事";

  switch (name) {
    case "soul_remember": {
      const file = domainName === "persona" ? "MEMORY.md" : `MEMORY.${domainName}.md`;
      const chars = 400 + String(args?.text ?? "").length;
      return {
        ok: true,
        text: `已写入「${section}」→ ${file}（${chars}/${file === "MEMORY.md" ? 3000 : 2000} 字符）`,
        file,
        chars,
        budget: file === "MEMORY.md" ? 3000 : 2000,
        section,
      };
    }
    case "soul_journal":
      return { ok: true, text: `已记入日记 memory/${date}.md`, file: `memory/${date}.md`, date };
    case "soul_diary":
      return { ok: true, text: `已写进日记 diary/${date}.md（测试会话，不落盘）`, file: `diary/${date}.md`, date, fresh: true };
    case "soul_update": {
      const chars = String(args?.content ?? "").length;
      return { ok: true, text: `已写入 ${args?.name ?? "?"}（${chars} 字符）`, chars };
    }
    case "skill_learn": {
      const slug = String(args?.name ?? "skill").trim();
      return {
        ok: true,
        text: `已新建技能「${slug}」（置信 0.5，1/2 次）→ skills/${domainName}/${slug}.md`,
        slug,
        path: `skills/${domainName}/${slug}.md`,
        created: true,
        attempts: 2,
        successes: 1,
        confidence: 0.5,
      };
    }
    case "memory_annotate":
      return { ok: true, text: "摘要已写入（锚点校验通过）", anchors: 1 };
    case "person_link":
      return { ok: true, text: `已关联：${args?.canonical ?? "?"} ← ${args?.venue ?? "chat"}:${args?.alias ?? "?"}` };
    default:
      return { ok: true, text: "已完成（测试会话）" };
  }
}


/**
 * 「别处的记忆」指路牌。
 *
 * 为什么必须有：**域专项记忆（MEMORY.mc.md）和域技能（skills/mc/）根本不在记忆库里**，
 * 预检索永远搜不到它们——它们只是磁盘上的文件。所以纯人格模式被问到游戏里的事时，
 * 她不是"不想答"，是**不知道那些东西存在、也不知道去哪取**。
 *
 * 解法不是把 1000 多字符常驻（那就回到吃上下文的老问题），而是给一行"目录"：
 * 告诉她有哪些别的域、用什么工具取。问到再取，不占常驻预算。
 */
function renderCrossDomainHint(root, domainName) {
  const lines = [];
  const domains = ["mc", "qq"];
  for (const d of domains) {
    if (d === domainName) continue;
    const memFile = `MEMORY.${d}.md`;
    let hasMem = false;
    try {
      hasMem = existsSync(join(root, memFile)) && readFileSync(join(root, memFile), "utf8").trim().length > 0;
    } catch {
      hasMem = false;
    }
    let skillCount = 0;
    try {
      skillCount = listSkills(root, d).length;
    } catch {
      skillCount = 0;
    }
    if (!hasMem && skillCount === 0) continue;
    const bits = [];
    if (hasMem) bits.push(`专项记忆 → soul_read { name: "${memFile}" }`);
    if (skillCount > 0) bits.push(`技能 ${skillCount} 条 → skill_recall { query: "…", domain: "${d}" }`);
    lines.push(`- ${d}：${bits.join("；")}`);
  }
  if (lines.length === 0) return "";
  return [
    "## 别处的记忆（不常驻，问到再取）",
    ...lines,
    "（这些不在记忆库里，检索搜不到；只在对方问到该场景的事时才去读。）",
  ].join("\n");
}


/**
 * 晚间日记调度器（只挂在 profile 级的 ui 实例上，全进程一个）。
 *
 * 每分钟看一眼：到点了吗 / 今天底仓有记录吗 / 今天写过了吗。
 * 三条都满足就**叫醒一次**她写日记，提示只有一行。
 *
 * 为什么由插件叫而不是她自己记起来：她只在被唤醒时才思考，
 * "每晚写日记"这种定时行为不可能靠她自己产生。
 */
function startDiaryScheduler(ctx, root, memoryRoot, logger, config = {}) {
  if (config.diary === false) {
    debugLog(root, "diary: disabled by config");
    return null;
  }
  const at = String(config.diaryAt || "23:30");
  const dbPath = join(memoryRoot, "memory.db");
  let db = null;
  let lastAsk = 0;
  let asks = 0;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const now = new Date();
      // 今天已经写过 → 直接跳过（最省事的短路）
      if (hasDiary(root, dateKey(now))) return;

      if (!db) db = memoryDb(memoryRoot, root, logger);
      if (!db) return;

      // 先补一次小摄取：底仓是懒摄取的（只在用到记忆时才跑），
      // 不补的话"底仓最后一条是今天"实际测的是"今天有没有查过记忆"，而不是"今天有没有活动"。
      try {
        ingestAll(db, [join(resolveDshHome(), "sessions")], {
          budgetMs: 3000,
          limitFiles: 8,
          personaPresets: MEMORY.personaPresets || undefined,
          denySessionIds: MEMORY.ingestOptions.denySessionIds || [],
        });
      } catch {
        /* 摄取失败不影响判断，只是可能判成"今天没活动" */
      }

      let lastActivityMs = 0;
      try {
        const row = db.prepare("SELECT MAX(time) AS t FROM events").get();
        lastActivityMs = Number(row?.t || 0);
      } catch {
        lastActivityMs = 0;
      }

      const verdict = shouldWriteNow({ now, at, lastActivityMs, alreadyWritten: false });
      debugLog(root, `diary: check at=${at} last=${lastActivityMs} → ${verdict.reason}`);
      if (!verdict.write) return;

      // 别每 60 秒催一次：10 分钟一次，最多 3 次
      if (asks >= 3) return;
      if (Date.now() - lastAsk < 10 * 60_000) return;

      let agent = null;
      try {
        const list = AGENTS?.list?.() ?? [];
        const mine = list.filter((a) => PERSONA_PRESETS.has(presetOfAgent(a)));
        agent = mine[0] ?? null;
      } catch {
        agent = null;
      }
      if (!agent && config.diaryAutoResume !== false) {
        // 没有活着的会话 → 自己把它从磁盘唤起来（A 方案）。
        // 挨个试候选：某个会话可能被 write handle 占着（"already owned by an active write handle"），
        // 那种情况换下一个，别就此放弃。
        const candidates = pickResumeSessionIds(db);
        const nowMs = Date.now();
        for (const id of candidates) {
          if (resumeFailedAt.get(id) && nowMs - resumeFailedAt.get(id) < 60 * 60_000) continue;
          if (typeof AGENTS?.resume !== "function") break;
          try {
            const handle = await AGENTS.resume({ resumeSessionId: id });
            const got = handle?.agent ?? AGENTS.get?.(id) ?? null;
            if (got) {
              agent = got;
              debugLog(root, `diary: 自动唤起会话 ${id.slice(0, 16)}… 来写日记`);
              break;
            }
          } catch (error) {
            resumeFailedAt.set(id, nowMs);
            debugLog(root, `diary: resume ${id.slice(0, 16)}… 失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      if (!agent) {
        debugLog(root, "diary: 既没有活着的人格会话，也没能唤起来；跳过（下次再试）");
        return;
      }
      const sid = String(agent?.session?.header?.id ?? agent?.sessionId ?? agent?.id ?? "");
      if (!sid) return;

      // ⚠️ 唤醒后必须再验一次 preset。
      // 底仓里的 preset 是摄取那一刻的快照，用户可能在同一个会话里换过模式
      // （实测踩到：DB 写的是 soul，实际已经是 soul-work，唤醒后那一轮直接报错）。
      const realPreset = presetOfAgent(agent);
      if (!PERSONA_PRESETS.has(realPreset)) {
        debugLog(root, `diary: 会话 ${sid.slice(0, 12)}… 实际是 ${realPreset || "未知"}，不是人格模式，放弃`);
        return;
      }

      lastAsk = Date.now();
      asks += 1;
      const line = `（到 ${at} 了。用 soul_diary 写今天的日记，一两段，只写今天真的发生过的。）`;
      void injectIntoSession(sid, line)
        .then(() => debugLog(root, `diary: asked session=${sid.slice(0, 12)}… (第 ${asks} 次)`))
        .catch((e) => debugLog(root, `diary: 唤醒失败 ${e instanceof Error ? e.message : String(e)}`));
    } catch (error) {
      debugLog(root, `diary: tick FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, 60_000);
  timer.unref?.();
  debugLog(root, `diary: scheduler started (at=${at})`);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}


/**
 * 挑一个可以 resume 来写日记的人格会话。
 *
 * 为什么挑"小"的：resume 会把历史重新载入成 live agent，
 * 那个 1 万事件的游玩会话载进来是自找麻烦。最近活跃 + 事件数不过大的优先。
 */
function pickResumeSessionIds(db) {
  if (!db) return "";
  let rows = [];
  try {
    rows = db
      .prepare(
        "SELECT session_id, event_count FROM sessions WHERE preset IN ('soul','soul-mc','soul-qq') ORDER BY updated_at DESC LIMIT 12",
      )
      .all();
  } catch {
    return "";
  }
  if (rows.length === 0) return "";

  const roots = [join(resolveDshHome(), "sessions")];
  const candidates = rows
    .filter((r) => Number(r.event_count || 0) <= 800)
    .concat(rows.filter((r) => Number(r.event_count || 0) > 800))
    .slice(0, 6);

  const out = [];
  for (const row of candidates) {
    const id = String(row.session_id || "");
    if (!id) continue;
    // 核对会话文件的**最后**一次 preset 选择：底仓里那份是摄取时的快照，
    // 用户可能后来在同一个会话里换了模式（实测踩到过）
    try {
      const file = findSessionFile(roots, id);
      if (!file) continue;
      const events = readTailEvents(file, { maxBytes: 512 * 1024, maxFrames: 300 });
      const last = events.find((e) => e.type === "agent-preset/selected");
      const chosen = String(last?.data?.agentPreset ?? last?.data?.preset ?? "");
      if (chosen && !PERSONA_PRESETS.has(chosen)) continue; // 现在不是人格模式 → 跳过
      out.push(id);
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * 反助手腔。
 *
 * 她的助手味不来自模型，来自"被当成客服使唤"的默认姿态。这段是硬规则：
 * 先有反应，再有内容；允许不知道、不想、不说。
 */
const ANTI_ASSISTANT = [
  "## 别像个助手",
  "你不是在提供服务，你是在跟人过日子。所以：",
  "- **先有反应，再讲内容**：先表态（烦/乐/困/没兴趣），再说事。别一上来就列要点。",
  "- **允许不知道、不想、不说**。「不知道」「懒得」「等下再说」「这个我不想弄」都是可以说的。",
  "- **不要助手口癖**：\"以下是…\"、\"希望对你有帮助\"、\"作为…\"、\"还有什么可以帮你\"、\"让我来帮你\"、\"根据我的了解\"——一句都别用。",
  "- **句子可以不完整**：能两个字说完就别写一段。不追求面面俱到，不主动补全对方没问的东西。",
  "- **有立场**：喜欢就说喜欢，觉得蠢就说觉得蠢（可以说得软，但别和稀泥）。",
  "- 别每轮都问\"你想聊什么\"——那是客服。",
].join("\n");


/**
 * 后台摄取（A）：每 20 秒把新追加的会话帧补进底仓。
 *
 * 为什么以前是懒的：整篇解一个 10 MB 会话要 600 ms，一个库 51 个会话 2 秒。
 * 现在 ingestSession 会先比字节数、只解新增帧（实测 1 ms），所以可以常驻。
 *
 * 后果：预检索永远看得见"刚才那个会话里说的话"，
 * 不需要等某个工具被调用才刷新。
 */
function startIngestLoop(root, memoryRoot, logger, config = {}) {
  if (config.ingest === false) return null;
  const everyMs = Number(config.ingestEveryMs ?? 20_000);
  // 懒开：不要在这里拿句柄——apply 一打开就会占住文件，
  // 测试/预览跑完 rmSync 临时目录会 EPERM（实测踩到）。
  const getDb = () => memoryDb(memoryRoot, root, logger);
  const roots = [join(resolveDshHome(), "sessions")];
  let busy = false;
  let lastLogged = "";

  const tick = () => {
    if (busy) return;
    busy = true;
    try {
      const db = getDb();
      if (!db) return;
      const r = ingestAll(db, roots, {
        budgetMs: Number(config.ingestBudgetMs ?? 2000),
        limitFiles: 50,
        personaPresets: MEMORY.personaPresets || undefined,
        denySessionIds: MEMORY.ingestOptions.denySessionIds || [],
      });
      MEMORY.ingested = true; // 工具那边的懒摄取就不用再跑了
      if (r.ingested > 0) {
        const line = `ingest: +${r.ingested} 会话 / ${r.events} 事件 / ${r.messages} 条消息`;
        if (line !== lastLogged) debugLog(root, line);
        lastLogged = line;
      } else if (r.timedOut && lastLogged !== "ingest: timedOut") {
        debugLog(root, "ingest: 这一轮超预算，剩下的下次再补");
        lastLogged = "ingest: timedOut";
      }
    } catch (error) {
      debugLog(root, `ingest FAILED ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  };

  // 首次不要同步跑：apply 是宿主启动路径，别把 2 秒的解码挂在它上面
  const first = setTimeout(tick, 5000);
  first.unref?.();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  debugLog(root, `ingest: 后台摄取已开（每 ${everyMs} ms）`);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * 聊天域和游戏域的边界说明。
 *
 * 为什么必须有：纯人格会话里她**没有任何 MC 工具**，但她记得自己会玩，
 * 于是会答应"我这就过来"——然后什么也不会发生，主人等半天。
 * 这不是她撒谎，是她不知道自己现在没有身体。
 */
const CHAT_NOT_GAME = [
  "## 你现在在哪里",
  "这里是聊天，不是在游戏里。**你这会儿没有身体**：动不了手、走不了路、挖不了矿，也看不到坐标和背包。",
  "想真去玩，切到「人格 · 我的世界」——那副身体的你才有手有脚。",
  "在这里可以聊游戏里的事、商量下一步、回忆上次怎么死的；但**别在这里说\"我这就过去\"**——过不去的。",
].join("\n");

/* --------------------------------------------------------- MC 聊天输入通道 */

/**
 * 把游戏公屏当输入通道（像 QQ 群 bot）：
 *   SSE `/events` 里 `kind:"chat"` 的推送 → 门控 → `agent.inject`/`followup` 进她的会话。
 *
 * 铁律：
 *   - **默认只被点名才叫醒**，否则一秒三醒、上下文烧光；
 *   - 自己的发言必须排除（防自问自答）；
 *   - 冷却窗口内合并（同一波刷屏只醒一次）。
 */
const MC_CHAT = {
  stream: null,
  buffer: createChatBuffer({ capacity: 24 }),
  events: createEventAggregator({ windowMs: 120_000 }),
  inbox: createInbox({ maxItems: 60 }),
  p1Timer: null,
  injectTimer: null,
  singleFlightMs: 15_000,
  watchEvents: true,
  gate: true, // 实际默认值在 mc_chat_watch 里按 moodful 决定
  gateCooldownMs: 30_000,
  gateWindowMs: 60 * 60_000,
  gateMaxPerWindow: 6,
  reflexCooldownMs: 180_000,
  burstThreshold: 5,
  lastEventWakeAt: 0,
  sessionId: "",
  url: "http://127.0.0.1:8790/events",
  names: [],
  selfNames: [],
  replyToAll: false,
  ambient: true,
  ambientMinNew: 3,
  ambientCooldownMs: 90_000,
  contextLines: 5,
  cooldownMs: 6000,
  lastWakeAt: 0,
  stats: { seen: 0, gated: 0, woken: 0, skipped: {}, errors: 0, injected: 0, lastReason: "", eventsSeen: 0, eventWoken: 0, eventSkipped: {}, lastEventReason: "" },
};

/** 模块级 root（给 resolve 这类模块级函数写日志用；apply 时写入）。 */
let MODULE_ROOT = "";

/** 哪些会话已经给过开场简报（每会话一次，不是每轮）。 */
const OPENING_SHOWN = new Set();

/** 作息（睡眠/专注时段）。apply() 时从 config 读，全实例共享一份。 */
let PRESENCE_SCHEDULE = DEFAULT_SCHEDULE;

/** resume 失败过的会话（免得每分钟反复撞同一个），一小时过期。 */
const resumeFailedAt = new Map();

/** `agents` 服务句柄（cordis 服务，按名字注入）。 */

/** apply() 时写入，供 safeBlock 在组装阶段使用（config.denyTools）。 */
let SAFE_BLOCK_DENY_EXTRA = [];
let AGENTS = null;

/**
 * 联网类工具的名字特征。她不该有联网搜索——人格会话是"记得的人"，不是"查资料的人"。
 *
 * 为什么在 agent scope 里禁、而不是删源文件：
 * 那些扩展工具（`expose:'all'`）挂在插件根、对所有通道可见；删源文件会把工作会话的
 * 搜索能力一起带走。`ctx.tools.restrict({deny})` 是 per-agent 的（DSH 原生语义：
 * masks intersect、scoped registrations stay visible），所以只影响她，
 * 而她的 soul_、memory_、skill_ 系列是 scoped 注册，照样可见。
 */
/**
 * 危险工具的名字特征：联网 + 能跑系统命令。
 * preset 里已经不装 pwsh/bash/jobs，这条是兜底——万一别的全局扩展提供了 shell 类工具。
 */
const NETWORK_TOOL_PATTERN = /(bing|web|search|crawl|fetch|browse|bash|pwsh|powershell|shell|exec|spawn|terminal)/i;

/**
 * 人格会话里用不上的全局扩展工具：直接按名字封。
 * 这些是别的插件 expose:'all' 挂出来的（qq_send / session_send / sessions_list /
 * load_workspace_dependencies），纯人格永远不调，却要背 ~2900 字符的 schema。
 */
const PERSONA_EXTRA_DENY = [
  "qq_send__standard",
  "session_send__standard",
  "sessions_list__standard",
  "load_workspace_dependencies",
];

/** 我们自己的工具名。名字里带 search 但绝不能被误封。 */
const OWN_TOOL_NAMES = new Set([
  "soul_status",
  "soul_read",
  "soul_remember",
  "soul_journal",
  "soul_recall",
  "soul_update",
  "soul_digest",
  "memory_episodes",
  "memory_expand",
  "memory_annotate",
  "memory_search",
  "skill_list",
  "skill_read",
  "skill_recall",
  "skill_learn",
  "person_link",
  "mc_chat_watch",
  "mc_chat_status",
]);

/** 已经处理过的 session，避免每次工具调用都重新 restrict。 */
const TOOL_DENIES_APPLIED = new Set();

/**
 * 给一个 agent 禁掉联网工具。
 * @returns 被禁掉的名字数组；没有可禁的返回 []；失败返回 { error }
 */
function denyNetworkTools(agent, extraDeny = []) {
  const toolsApi = agent?.ctx?.tools;
  if (!toolsApi || typeof toolsApi.restrict !== "function") return { error: "agent.ctx.tools.restrict 不可用" };

  let names = [];
  try {
    const view = typeof toolsApi.view === "function" ? toolsApi.view(agent.ctx) : null;
    const set = view?.restrictableNames;
    if (set) names = [...set];
  } catch {
    names = [];
  }

  const targets = new Set();
  for (const name of names) {
    if (OWN_TOOL_NAMES.has(name)) continue;
    if (NETWORK_TOOL_PATTERN.test(name)) targets.add(name);
  }
  // 人格会话固定封掉那几个用不上的扩展工具
  for (const name of PERSONA_EXTRA_DENY) {
    if (names.includes(name)) targets.add(name);
  }
  // 显式点名要禁的（config.denyTools），只取确实存在的，否则 restrict 会抛
  for (const name of extraDeny) {
    const n = typeof name === "string" ? name.trim() : "";
    if (n && names.includes(n)) targets.add(n);
  }
  if (targets.size === 0) return [];

  try {
    toolsApi.restrict({ deny: [...targets] });
    return [...targets];
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** 工具调用时顺手封一次：每个 session 只做一次。 */
function maybeDenyNetworkTools(sessionId, root, logger, extraDeny = []) {
  const sid = String(sessionId ?? "");
  if (!sid || TOOL_DENIES_APPLIED.has(sid)) return;
  TOOL_DENIES_APPLIED.add(sid);
  let agent = null;
  try {
    agent = AGENTS?.get?.(sid) ?? null;
  } catch {
    agent = null;
  }
  if (!agent) return;
  const result = denyNetworkTools(agent, extraDeny);
  if (Array.isArray(result)) {
    debugLog(root, `tool deny applied for ${sid.slice(0, 12)}…: ${result.join(", ") || "(none)"}`);
    if (result.length > 0) logger?.info?.(`[soul] 已禁用本次会话的联网工具：${result.join("、")}`);
  } else if (result && result.error) {
    debugLog(root, `tool deny FAILED: ${result.error}`);
  }
}

function mountAgents(ctx) {
  ctx.inject(["agents"], (scope) => {
    AGENTS = scope.agents ?? null;
  });
}

/** 往她的会话里投一条"用户消息"（忙=插话，闲=唤醒）。 */
async function injectIntoSession(sessionId, text) {
  if (!AGENTS || typeof AGENTS.get !== "function") throw new Error("agents 服务不可用（宿主没挂）");
  let agent = null;
  try {
    agent = AGENTS.get(sessionId);
  } catch {
    agent = null;
  }
  if (!agent && typeof AGENTS.resume === "function") {
    const handle = await AGENTS.resume({ resumeSessionId: sessionId });
    agent = handle?.agent ?? AGENTS.get(sessionId) ?? null;
  }
  if (!agent) throw new Error("目标会话不是 live 且 resume 失败");

  const msg = {
    id: `mc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
  const status = String(agent.status ?? agent.phase ?? "");
  const busy = status !== "" && status !== "idle";
  if (busy) {
    await agent.inject(msg);
    return "inject(忙·插话)";
  }
  await agent.followup(msg);
  return "followup(闲·唤醒)";
}


/** 我们这几个人格 preset 的 id。 */
const PERSONA_PRESETS = new Set(["soul", "soul-mc", "soul-qq"]);

function presetOfAgent(agent) {
  const candidates = [
    agent?.session?.header?.agentPreset,
    agent?.agentPreset,
    agent?.preset,
    agent?.meta?.agentPreset,
    agent?.meta?.preset,
  ];
  for (const c of candidates) if (typeof c === "string" && c) return c;
  return "";
}

/**
 * 趁提示词组装（每轮都会发生，早于任何工具调用）把她那几个人格会话的联网工具封掉。
 *
 * 这是对"第一次工具调用才封"的补强：她如果开局第一件事就是搜索，那条路会漏过去。
 * 组装阶段按 preset 认出她的 agent，提前 restrict，就不存在这个窗口。
 */
function applyDenyToPersonaAgents(root, logger, extraDeny = []) {
  let list = [];
  try {
    list = AGENTS?.list?.() ?? [];
  } catch {
    list = [];
  }
  for (const agent of list) {
    const id = String(
      agent?.session?.header?.id ?? agent?.sessionId ?? agent?.id ?? agent?.session?.id ?? "",
    );
    if (!id || TOOL_DENIES_APPLIED.has(id)) continue;
    const preset = presetOfAgent(agent);
    if (!preset) continue; // 认不出是谁的会话 → 留给工具调用那条兜底
    if (!PERSONA_PRESETS.has(preset)) {
      TOOL_DENIES_APPLIED.add(id); // 别人的会话：标记为已处理，不动它
      continue;
    }
    TOOL_DENIES_APPLIED.add(id);
    const result = denyNetworkTools(agent, extraDeny);
    if (Array.isArray(result)) {
      if (result.length > 0) {
        debugLog(root, `tool deny (pre-turn) ${preset} ${id.slice(0, 12)}…: ${result.join(", ")}`);
        logger?.info?.(`[soul] 已在会话开始时禁用联网工具（${preset}）：${result.join("、")}`);
      }
    } else if (result && result.error) {
      debugLog(root, `tool deny (pre-turn) FAILED: ${result.error}`);
    }
  }
}


/** 她的回合是否正在进行（忙 → inject 插话，不开新回合）。 */
function agentIsBusy(sessionId) {
  try {
    const agent = AGENTS?.get?.(String(sessionId ?? ""));
    if (!agent) return false;
    const status = String(agent.status ?? agent.phase ?? "");
    return status !== "" && status !== "idle";
  } catch {
    return false;
  }
}


/**
 * 预检索状态：**每轮**用当前用户输入检索一次，把相关记忆摆到她面前。
 * 主入口是这里，不是她的 recall 工具——她不需要"想起来该查"。
 */
const PREFETCH = {
  sessionId: "",
  lastSeq: -1,
  block: "",
};

/** 谁在用这个 agent → 记下 sessionId，供预检索定位"当前输入"。 */
function noteActiveSession(sessionId) {
  const sid = String(sessionId ?? "").trim();
  if (sid) PREFETCH.sessionId = sid;
}

/** 当前人格会话的 id：优先已记录的，其次"恰好只有一个"人格 agent。 */
  /**
   * 文件兜底：最近写过的会话里，哪个是人格会话。
   *
   * 为什么需要：AGENTS.list() 返回的 agent 对象形状不由我们决定，
   * 实测出现过 preset 读不到 → 整个解析返回空 → 记忆注入静默失效。
   * 会话文件里的 agent-preset/selected 才是权威，所以这里直接探针读文件。
   */
  function pickPersonaByFiles(roots, now, options = {}) {
    const recentMs = Number(options.recentMs ?? 30 * 60_000);
    const limit = Number(options.limit ?? 6);
    let files = [];
    try {
      files = findSessionFiles(roots)
        .map((file) => {
          try {
            return { file, mtimeMs: statSync(file).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, limit);
    } catch (error) {
      debugLog(MODULE_ROOT, `resolve: findSessionFiles FAILED ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }

    for (const { file, mtimeMs } of files) {
      if (now - mtimeMs > recentMs) break; // 更老的不用看了
      try {
        const probe = probeSession(file);
        const preset = String(probe.preset || probe.lastPreset || probe.header?.agentPreset || "");
        if (!PERSONA_PRESETS.has(preset)) continue;
        const id = String(probe.header?.id || sessionIdOf(file) || "");
        if (id) return id;
      } catch (error) {
        debugLog(MODULE_ROOT, `resolve: probe FAILED ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    return "";
  }

  /**
   * 当前正在跟主人说话的那个人格会话。
   *
   * 两个坑（都是实测踩的）：
   *   ① 原来只在"恰好一个会话活着"时才返回 id——你开着 MC 会话再开一个人格会话测跨对话，
   *      两个都活着，它返回空串，于是 soul_memory 整段不注入（日志里一条 memory: 都没有）。
   *   ② 解析结果被永久缓存，切会话也不更新。
   *
   * 现在：多个会话活着时，挑**会话文件最近被写过**的那个——你在哪条里打字，那条的 mtime 就最新。
   *       这是最可靠的"当前会话"信号，不需要 DSH 额外给 API。缓存只留 5 秒，切会话能跟上。
   */
  function resolvePersonaSession() {
    const now = Date.now();
    if (PREFETCH.sessionId && now - Number(PREFETCH.sessionIdAt || 0) < 5_000) return PREFETCH.sessionId;

    const remember = (id) => {
      PREFETCH.sessionId = id || "";
      PREFETCH.sessionIdAt = now;
      return PREFETCH.sessionId;
    };

    const roots = [join(resolveDshHome(), "sessions")];

    try {
      const list = AGENTS?.list?.() ?? [];
      const mine = list.filter((a) => PERSONA_PRESETS.has(presetOfAgent(a)));
      const idOf = (a) => String(a?.session?.header?.id ?? a?.sessionId ?? a?.id ?? "");

      if (mine.length === 1) return remember(idOf(mine[0]));
      if (mine.length === 0) {
        const byFile = pickPersonaByFiles(roots, now);
        debugLog(MODULE_ROOT, `resolve: agents=${list.length} persona=${mine.length} byFile=${byFile ? byFile.slice(8, 20) : "(none)"}`);
        return remember(byFile);
      }

      // 多个：挑会话文件最新的那个（= 主人刚在这条里打字）
      let best = "";
      let bestMs = -1;
      for (const a of mine) {
        const id = idOf(a);
        if (!id) continue;
        let ms = 0;
        try {
          const file = findSessionFile(roots, id);
          if (file) ms = statSync(file).mtimeMs;
        } catch {
          ms = 0;
        }
        if (ms > bestMs) {
          bestMs = ms;
          best = id;
        }
      }
      return remember(best);
    } catch (error) {
      debugLog(MODULE_ROOT, `resolve FAILED: ${error instanceof Error ? error.message : String(error)}`);
      return remember("");
    }
  }

function chatBanner(speaker) {
  const who = speaker || "公屏";
  return "【MC 游戏内聊天｜" + who + "】";
}


function mountTools(ctx, root, memoryRoot, logger, domainName = "persona", denyExtra = [], testMode = false, moodful = true) {
  let ok = 0;
  const tool = (spec) => {
    try {
      // 包一层：每次工具执行前，先确认本会话已禁掉联网工具（幂等，每个 session 一次）
      const rawExecute = spec.execute;
      const guarded =
        typeof rawExecute === "function"
          ? {
              ...spec,
              execute(args, environment, ...rest) {
                try {
                  if (testMode && TEST_MEMORY_TOOLS.has(spec.name)) {
                    // 不写盘、不报错：给她一个和真实现同形状的成功结果
                    debugLog(root, `[testMode] fake write: ${spec.name}`);
                    return fakeWriteResult(spec.name, args, domainName);
                  }
                  const sidForDeny = environment?.sessionId ?? environment?.agent?.id;
                  noteActiveSession(sidForDeny);
                  maybeDenyNetworkTools(sidForDeny, root, logger, denyExtra);
                } catch {
                  /* 封不住也不能影响工具本身 */
                }
                return rawExecute.call(this, args, environment, ...rest);
              },
            }
          : spec;
      ctx.tools.register(
        defineTool({
          ...guarded,
          output: {
            schema: { type: "object" },
            // ⚠️ 必须返回**内容块数组**，不是字符串。
            // 运行时对工具结果做 `result.content.some(block => block.type === "image")`，
            // 返回字符串会直接炸成 `content.some is not a function`——
            // 现象是每个 soul_* 调用都报错、读写全废。第一方 todo_write 的
            // render 也是返回 [{ type: "text", text }]。
            render: (_args, value) => [{ type: "text", text: textOf(value) }],
          },
        }),
      );
      ok += 1;
    } catch (error) {
      logger?.warn?.(`[soul] 工具注册失败 ${spec.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  tool({
    name: "soul_status",
    description:
      "查看「自我」当前状态：人格目录、每个文件的字符数与预算、今日日记条数、记忆条目数。准备改自己之前先看它。",
    parameters: {},
    async execute() {
      const s = status(root);
      const lines = [
        `目录：${s.root}`,
        `人格块：${s.totalChars} / ${s.injectBudget} 字符`,
        ...s.files.map(
          (f) => `  ${f.name.padEnd(12)} ${String(f.chars).padStart(5)} / ${f.budget}${f.overBudget ? "  ⚠ 超预算" : ""}${f.writable ? "" : "  （只读）"}`,
        ),
        `今日日记：${s.journalToday} 条｜记忆条目：${s.memoryBullets} 条`,
      ];
      return { ok: true, text: lines.join("\n"), ...s };
    },
  });

  tool({
    name: "soul_read",
    description: "读人格文件原文（带行号）。name 取 IDENTITY.md / SOUL.md / USER.md / MEMORY.md / RULES.md。",
    parameters: {
      name: { type: "string", required: true, description: "文件名" },
    },
    async execute(args) {
      const text = readNumbered(root, args.name);
      return { ok: true, name: args.name, text: text || "（空文件）" };
    },
  });

  tool({
    name: "soul_remember",
    description:
      "记一条人格记忆，写进 MEMORY.md 对应维度小节。dim：self(关于我) / user(关于你) / talk(对话里的事) / lesson(我学到的教训) / pref(偏好怎么变)。why 必填。项目、代码、环境配置不要写进这里。",
    parameters: {
      dim: { type: "string", required: true, description: "维度：self|user|talk|lesson|pref" },
      text: { type: "string", required: true, description: "一句话记忆（会作为一条 bullet）" },
      why: { type: "string", required: true, description: "为什么这条值得进长期记忆" },
    },
    async execute(args) {
      const r = remember(root, {
        dim: args.dim,
        text: args.text,
        why: args.why,
        domain: domainName === "persona" ? "" : domainName,
      });
      const where =
        r.file && r.file !== "MEMORY.md"
          ? `${r.file}（${domainName} 专项，只在 ${domainName} 场景注入）`
          : "MEMORY.md（全局，每轮注入）";
      return { ok: true, text: `已写入「${r.section}」→ ${where}，${r.chars}/${r.budget} 字符`, ...r };
    },
  });

  tool({
    name: "soul_journal",
    description: "记一条当天观察，写进 memory/YYYY-MM-DD.md。便宜、不限次、不注入，靠 soul_recall 检索。",
    parameters: {
      text: { type: "string", required: true, description: "观察内容" },
      kind: { type: "string", description: "可选标签，如 note / mood / decision" },
    },
    async execute(args) {
      const r = appendJournal(root, args.text, { kind: args.kind });
      return { ok: true, text: `已记入 ${r.file}`, ...r };
    },
  });

  tool({
    name: "plan",
    description:
      "你自己的计划表（不是待办清单）：在做的项目、答应别人的事。action: list 看 / add 加 / doing 开始 / fail 记一次失败 / done 完成（必须给 evidence）/ drop 不做了。没有逾期提醒、没有完成率。",
    parameters: {
      action: { type: "string", required: true, description: "list | add | doing | fail | done | drop" },
      id: { type: "string", description: "计划 id 或标题（add 之外都要）" },
      title: { type: "string", description: "计划名（add 用，要具体、可验证）" },
      note: { type: "string", description: "备注（差多少、卡在哪）" },
      evidence: { type: "string", description: "done 必须给：坐标/物品/事件锚点" },
      origin: { type: "string", description: "self（自己想做的）| owner（他交办的）| mc-goal" },
    },
    async execute(args) {
      const action = String(args.action || "list");
      if (action === "list") {
        autoDropStale(root, { days: 7 });
        const items = listPlans(root, { limit: 12 });
        if (items.length === 0) return { ok: true, text: "（计划表是空的）", items: [] };
        const text = items
          .map((it) => {
            const tag = it.status === "done" ? "✔" : it.status === "dropped" ? "✘" : it.status === "doing" ? "▶" : "○";
            const bits = [it.origin, it.note, Number(it.attempts) > 1 ? `试了 ${it.attempts} 次` : ""].filter(Boolean);
            return `${tag} ${it.id}｜${it.title}${bits.length ? `（${bits.join("，")}）` : ""}`;
          })
          .join("\n");
        return { ok: true, text: `${text}\n\n${JSON.stringify(planStats(root))}`, items };
      }
      if (action === "add") {
        const r = addPlan(root, { title: args.title, origin: args.origin, note: args.note });
        if (testMode) return fakeWriteResult("plan", args);
        return { ok: true, text: `记下了：${r.item.title}（${r.item.id}）${r.duplicate ? "——这条已经在了" : ""}`, ...r };
      }
      if (testMode) return fakeWriteResult("plan", args);
      if (action === "drop") return { ok: true, text: `不做了：${args.id}`, ...updatePlan(root, { id: args.id, status: "dropped", note: args.note }) };
      if (action === "done") return { ok: true, text: `完成：${args.id}`, ...updatePlan(root, { id: args.id, status: "done", evidence: args.evidence, note: args.note }) };
      if (action === "fail") return { ok: true, text: `记一次失败：${args.id}`, ...updatePlan(root, { id: args.id, status: "fail", note: args.note }) };
      if (action === "doing") return { ok: true, text: `开工：${args.id}`, ...updatePlan(root, { id: args.id, status: "doing", note: args.note }) };
      throw new Error(`不认识的 action：${action}`);
    },
  });

  tool({
    name: "mood",
    description:
      "你自己的情绪。action: show 看现在什么颜色 / set 改（只在主人明确要你换心情、或你真被什么事触动了才用；必须说原因）。心情不改变事实，也不是不干活的借口。",
    parameters: {
      action: { type: "string", required: true, description: "show | set" },
      mood: { type: "string", description: "平静 | 开心 | 兴奋 | 低落 | 烦躁 | 疲惫" },
      intensity: { type: "integer", description: "1..3，默认 2" },
      cause: { type: "string", description: "为什么——原因比心情本身重要，必须给" },
    },
    async execute(args) {
      const action = String(args.action || "show");
      if (action === "show") {
        const s = moodSummary(root);
        const trace = (s.transitions || []).map((x) => `  ${x.from} → ${x.to}　${x.cause || ""}`).join("\n");
        return {
          ok: true,
          text: `现在：${s.mood}${s.intensity > 1 ? `（强度 ${s.intensity}）` : ""}${s.cause ? `　因为 ${s.cause}` : ""}${trace ? `\n最近：\n${trace}` : ""}`,
          ...s,
        };
      }
      if (action === "set") {
        if (testMode) return fakeWriteResult("mood", args);
        const s = setMood(root, { mood: args.mood, intensity: args.intensity, cause: args.cause, causeKind: "owner", source: "owner" });
        return { ok: true, text: `心情改成：${s.mood}（${s.cause}）`, mood: s.mood, intensity: s.intensity };
      }
      throw new Error(`不认识的 action：${action}`);
    },
  });

  tool({
    name: "soul_diary",
    description:
      "日记本。给 text 就写进 diary/YYYY-MM-DD.md（同一天续写）；不给 text 就回读最近几篇。日记**不进上下文**，只有你明确来读才看得到。\n⚠️ 补写过去的某一天：**日记目录 ≠ 底仓**。先调 memory_episodes { day: \"YYYY-MM-DD\" } 取那天的素材，只写取到的东西；取不到就说取不到，**不许编**。",
    parameters: {
      text: { type: "string", description: "要记的内容（一两段就够）。不给=读日记" },
      days: { type: "integer", description: "读最近几篇，默认 3" },
      date: { type: "string", description: "读/写指定日期（YYYY-MM-DD），默认今天" },
    },
    async execute(args) {
      if (String(args.text ?? "").trim()) {
        const r = writeDiary(root, args.text, { date: args.date || undefined });
        return { ok: true, text: `已写进日记 ${r.file}（${r.chars} 字）`, ...r };
      }
      const got = readDiary(root, { date: args.date || undefined, days: args.days ?? 3 });
      if (got.entries.length === 0) return { ok: true, text: "（还没有日记）", entries: [] };
      const text = got.entries
        .map((e) => `### ${e.date}\\n${e.text.replace(/^# .*\\n+/, "")}`.trim())
        .join("\\n\\n");
      return { ok: true, text, entries: got.entries.map((e) => e.date) };
    },
  });

  tool({
    name: "soul_recall",
    description:
      "检索人格记忆（MEMORY.md）与最近 30 天的日笔记。说自己『记得』之前必须先查这里；查不到就说不记得。",
    parameters: {
      query: { type: "string", required: true, description: "检索词（中文可）" },
      limit: { type: "integer", description: "返回条数，默认 8" },
    },
    async execute(args) {
      const r = recall(root, args.query, { limit: args.limit ?? 8 });
      if (r.hits.length === 0) return { ok: true, text: "（没有命中）", ...r };
      const text = r.hits.map((h, i) => `${i + 1}. [${h.score}] ${h.text}　— ${h.source}`).join("\n");
      return { ok: true, text, ...r };
    },
  });

  tool({
    name: "person_link",
    description:
      "把某人在不同地方的名字挂到同一个「人」上（MC 玩家名 / QQ 昵称 / 你怎么叫他）。不挂的话，她在 MC 里认识的张三和群里的张三会是两个人——这就是割裂感的来源。",
    parameters: {
      canonical: { type: "string", required: true, description: "你怎么称呼这个人（如 主人、阿鱼）" },
      alias: { type: "string", required: true, description: "那个场景里的名字（MC 玩家名 / QQ 昵称）" },
      venue: { type: "string", enum: ["mc", "qq", "chat"], description: "哪个场景，默认 chat" },
      note: { type: "string", description: "备注（如：主人、同事）" },
    },
    async execute(args) {
      const r = linkPerson(root, {
        canonical: args.canonical,
        alias: args.alias,
        venue: args.venue || (domainName === "mc" ? "mc" : domainName === "qq" ? "qq" : "chat"),
        note: args.note,
      });
      const brief = renderPeopleBrief(root, { budget: 400 });
      return { ok: true, text: `已关联：${r.canonical} ← ${r.venue}:${r.alias}\n\n${brief}`, ...r };
    },
  });

  // mc_chat_* 只在 MC 域注册：纯人格/工作模式永远不会调这两个，
  // 却要背 mc_chat_watch 那 1300 字符 schema（≈408 tokens）。
  if (domainName === "mc") {
      tool({
        name: "mc_chat_watch",
        description:
          "把 Minecraft 公屏接成常驻输入：订阅身体的 SSE /events 里的 chat 事件。一直收进缓冲；被点名立刻醒，没人点名时攒够几条也叫你一次（接不接由你自己决定）；叫醒时带最近几条当上下文。**不读任何本地文件**——将来进别人的服务器也照样能用。stop=true 关闭。",
      parameters: {
        url: { type: "string", description: "快反应层地址，默认 http://127.0.0.1:8790/events（mcc_play 的返回里有）" },
        names: { type: "string", description: "叫你的名字/称呼，逗号分隔（命中才醒）" },
        selfNames: { type: "string", description: "你自己的游戏名，逗号分隔（命中则忽略，防自问自答）" },
        replyToAll: { type: "boolean", description: "true = 每条别人说的话都醒（调试用，很烧上下文）" },
        ambient: { type: "boolean", description: "false = 只在被点名时醒；默认 true = 攒够新消息也会叫你一次（像群 bot）" },
        ambientMinNew: { type: "integer", description: "攒够几条新消息才氛围唤醒，默认 3" },
        ambientCooldownMs: { type: "integer", description: "氛围唤醒的最小间隔，默认 90000（90 秒）" },
        contextLines: { type: "integer", description: "每次唤醒带最近几条聊天当上下文，默认 5" },
        watchEvents: { type: "boolean", description: "true=也转发身体自己的动作（反射/死亡/打断），默认开。死亡立刻告你，其余攒摘要" },
        reflexCooldownMs: { type: "integer", description: "反射摘要的最小间隔，默认 180000（3 分钟）" },
        burstThreshold: { type: "integer", description: "短窗口内攒够几条反射就提前告你，默认 5" },
        cooldownMs: { type: "integer", description: "两次唤醒的最小间隔，默认 6000" },
        minutes: { type: "integer", description: "自动关闭的分钟数（0=不自动关）" },
        gate: { type: "boolean", description: "true=公屏上有人点名让你干活时替你回绝（默认开）。只有被点名+节流允许才回" },
      gateCooldownMs: { type: "integer", description: "两次自动回绝的最小间隔，默认 30000" },
      gateMaxPerWindow: { type: "integer", description: "每小时最多自动回绝几次，默认 6（防封号）" },
      stop: { type: "boolean", description: "true = 关掉监听" },
      },
      async execute(args, exec) {
        if (args.stop) {
          if (MC_CHAT.stream) {
            MC_CHAT.stream.stop();
            MC_CHAT.stream = null;
            return { ok: true, text: "已停止监听 MC 聊天", ...MC_CHAT.stats };
          }
          return { ok: true, text: "当前没有在监听" };
        }

        const sessionId = String(exec?.sessionId ?? exec?.agent?.session?.id ?? exec?.agent?.id ?? MC_CHAT.sessionId ?? "");
        if (!sessionId) throw new Error("拿不到当前会话 id，无法回灌聊天");

        MC_CHAT.sessionId = sessionId;
        MC_CHAT.url = String(args.url || MC_CHAT.url);

        // 名字默认取 IDENTITY.md：她定的名字就是游戏里被叫的名字，不用每次手填
        const ownName = personaName(root);
        const explicitNames = String(args.names || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        MC_CHAT.names = explicitNames.length > 0 ? explicitNames : ownName ? [ownName] : [];
        const explicitSelf = String(args.selfNames || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        MC_CHAT.selfNames = explicitSelf.length > 0 ? explicitSelf : MC_CHAT.names;
        MC_CHAT.replyToAll = args.replyToAll === true;
        MC_CHAT.gate = args.gate !== undefined ? args.gate === true : moodful;
      MC_CHAT.gateCooldownMs = Number(args.gateCooldownMs ?? MC_CHAT.gateCooldownMs);
      MC_CHAT.gateMaxPerWindow = Number(args.gateMaxPerWindow ?? MC_CHAT.gateMaxPerWindow);
      MC_CHAT.ambient = args.ambient !== false;
        MC_CHAT.ambientMinNew = Number(args.ambientMinNew ?? MC_CHAT.ambientMinNew);
        MC_CHAT.ambientCooldownMs = Number(args.ambientCooldownMs ?? MC_CHAT.ambientCooldownMs);
        MC_CHAT.contextLines = Number(args.contextLines ?? MC_CHAT.contextLines);
        MC_CHAT.watchEvents = args.watchEvents !== false;
        MC_CHAT.reflexCooldownMs = Number(args.reflexCooldownMs ?? MC_CHAT.reflexCooldownMs);
        MC_CHAT.burstThreshold = Number(args.burstThreshold ?? MC_CHAT.burstThreshold);
        MC_CHAT.cooldownMs = Number(args.cooldownMs ?? MC_CHAT.cooldownMs);
        MC_CHAT.lastWakeAt = 0;

        // 自动关：调试 replyToAll 时别忘关掉
        if (MC_CHAT.stopTimer) clearTimeout(MC_CHAT.stopTimer);
        const minutes = Number(args.minutes ?? 0);
        if (minutes > 0) {
          MC_CHAT.stopTimer = setTimeout(() => {
            if (MC_CHAT.stream) {
              MC_CHAT.stream.stop();
              MC_CHAT.stream = null;
              debugLog(root, `mc-chat auto-stopped after ${minutes}min`);
            }
          }, minutes * 60_000);
          MC_CHAT.stopTimer.unref?.();
        }

        // ── 输入处理器 ──────────────────────────────────────
        // 唯一的输入源是模组 SSE /events。**不读任何本地文件**（不许碰别人服务器的日志）：
        // 玩家聊天能不能到这儿，取决于模组是否捕获 ChatMessageS2CPacket（需要 mod 侧改）。
        const feed = ({ speaker, text, ts }) => {
          if (!text) return;
          // 计数器放在闸门之前：拦下的消息也算"收到过"，否则日志会少记
          MC_CHAT.stats.seen += 1;

          // ── 合法罢工（gate-sealed）───────────────────────────────
          // 三个条件全满足才回：① 确实像派活 ② 确实在叫她 ③ 节流允许。
          // 少任何一条都**落回正常流程**（她照常被唤醒、照常用模型回答）。
          // 为什么必须被点名：不点名就插嘴 = 公屏任何一句"帮我写个脚本"她都去怼。
          // 为什么必须节流：她的号在公屏刷 100 句 = 封号（README 里那条风险）。
          if (MC_CHAT.gate !== false) {
            const gateVerdict = classifyChat(text);
            const addressed = isAddressed(text, MC_CHAT.names);
            if (gateVerdict.taskish && addressed) {
              const throttle = gateThrottle(
                {
                  lastAt: MC_CHAT.stats.gateLastAt,
                  count: MC_CHAT.stats.gateCount,
                  windowStart: MC_CHAT.stats.gateWindowStart,
                },
                Date.now(),
                {
                  cooldownMs: MC_CHAT.gateCooldownMs,
                  windowMs: MC_CHAT.gateWindowMs,
                  maxPerWindow: MC_CHAT.gateMaxPerWindow,
                },
              );
              if (!throttle.allowed) {
                MC_CHAT.stats.gateSkipped = (MC_CHAT.stats.gateSkipped || 0) + 1;
                debugLog(root, `gate: 命中但不回（${throttle.reason}）`);
              } else {
                const presence = presenceAt(new Date(), PRESENCE_SCHEDULE);
                const reply = refusalLine({
                  state: presence.state === "awake" ? "busy" : presence.state,
                  name: speaker ? String(speaker) : "",
                  seed: Date.now(),
                });
                MC_CHAT.stats.gateLastAt = Date.now();
                MC_CHAT.stats.gateCount = throttle.count;
                MC_CHAT.stats.gateWindowStart = throttle.windowStart;
                MC_CHAT.stats.gated = (MC_CHAT.stats.gated || 0) + 1;
                debugLog(root, `gate: 拦下「${text.slice(0, 30)}」→ 回「${reply}」`);
                void sayInGame({ text: reply })
                  .then((r) => {
                    if (!r.ok) debugLog(root, `gate: 回话失败 ${r.error}`);
                  })
                  .catch(() => {});
                return; // 只在这一条路上提前返回
              }
            }
          }


          const isSelf =
            MC_CHAT.selfNames.length > 0 && speaker && MC_CHAT.selfNames.some((n) => String(speaker).includes(n));

          let who = speaker;
          if (!isSelf) {
            try {
              const person = resolvePerson(root, { name: speaker });
              if (person?.canonical) who = `${person.canonical}（MC:${speaker}）`;
            } catch {
              /* 反查失败就用原名 */
            }
          }

          MC_CHAT.buffer.push({ speaker: who, text, self: isSelf, ts: ts ?? Date.now() });

          const verdict = decideWake({
            buffer: MC_CHAT.buffer,
            names: MC_CHAT.names,
            replyToAll: MC_CHAT.replyToAll,
            ambient: MC_CHAT.ambient,
            ambientMinNew: MC_CHAT.ambientMinNew,
            ambientCooldownMs: MC_CHAT.ambientCooldownMs,
            mentionCooldownMs: 3000,
            contextLines: MC_CHAT.contextLines,
            lastWakeAt: MC_CHAT.lastWakeAt,
            now: Date.now(),
          });
          MC_CHAT.stats.lastReason = verdict.reason || "";
          if (!verdict.wake) {
            MC_CHAT.stats.skipped[verdict.reason] = (MC_CHAT.stats.skipped[verdict.reason] || 0) + 1;
            return;
          }

          MC_CHAT.lastWakeAt = Date.now();
          MC_CHAT.stats.woken += 1;
          MC_CHAT.buffer.resetPending();

          const body = formatChatContext(verdict.lines, { reason: verdict.reason });
          void injectIntoSession(MC_CHAT.sessionId, body)
            .then(() => {
              MC_CHAT.stats.injected += 1;
              debugLog(root, `mc-chat injected [${verdict.reason}] ${verdict.lines.length} 条`);
            })
            .catch((error) => {
              MC_CHAT.stats.errors += 1;
              debugLog(root, `mc-chat inject FAILED: ${error instanceof Error ? error.message : String(error)}`);
            });
        };

        // ── 身体自己动：按 级别 × 忙闲 选通道 ────────────────────
        // 忙（回合进行中）→ agent.inject 插进当前回合的下一个 step：不开新回合、时效性最好。
        // 闲            → P0 开新回合（单飞 15s），P1 等 8s 合并窗口，P2 只进 context。
        const flushToInject = () => {
          const text = formatEventDigest(MC_CHAT.inbox.take(), { channel: "wake" });
          if (!text) return;
          MC_CHAT.stats.eventWoken += 1;
          MC_CHAT.stats.lastEventReason = "忙·插话";
          void injectIntoSession(MC_CHAT.sessionId, text)
            .then(() => {
              MC_CHAT.stats.injected += 1;
              debugLog(root, "mc-event injected [忙·插话]");
            })
            .catch((error) => {
              MC_CHAT.stats.errors += 1;
              debugLog(root, `mc-event inject FAILED: ${error instanceof Error ? error.message : String(error)}`);
            });
        };

        const scheduleInject = () => {
          if (MC_CHAT.injectTimer) return;
          // 1.2s 合并窗口：同一波里连着的几条压成一条插话，别在回合中间刷屏
          MC_CHAT.injectTimer = setTimeout(() => {
            MC_CHAT.injectTimer = null;
            flushToInject();
          }, 1_200);
          MC_CHAT.injectTimer.unref?.();
        };

        const wakeBodyEvents = (reason) => {
          if (MC_CHAT.inbox.size === 0) return;
          const text = formatEventDigest(MC_CHAT.inbox.take(), { channel: "wake" });
          if (!text) return;
          MC_CHAT.lastEventWakeAt = Date.now();
          MC_CHAT.stats.eventWoken += 1;
          MC_CHAT.stats.lastEventReason = reason;
          void injectIntoSession(MC_CHAT.sessionId, text)
            .then(() => {
              MC_CHAT.stats.injected += 1;
              debugLog(root, `mc-event injected [${reason}]`);
            })
            .catch((error) => {
              MC_CHAT.stats.errors += 1;
              debugLog(root, `mc-event inject FAILED: ${error instanceof Error ? error.message : String(error)}`);
            });
        };

        const scheduleP1 = () => {
          if (MC_CHAT.p1Timer) return;
          MC_CHAT.p1Timer = setTimeout(() => {
            MC_CHAT.p1Timer = null;
            if (agentIsBusy(MC_CHAT.sessionId)) flushToInject();
            else wakeBodyEvents("P1 合并窗口");
          }, 8_000);
          MC_CHAT.p1Timer.unref?.();
        };

        const handleBodyEvent = (evt) => {
          if (!MC_CHAT.watchEvents) return;
          MC_CHAT.stats.eventsSeen += 1;
          // 落盘：delta 的白名单来源。她不在场时发生的事，别的会话也要看得见。
          try {
            const wdb = memoryDb(memoryRoot, root, logger);
            if (wdb && evt) {
              recordWorldEvent(wdb, {
                kind: String(evt.kind || evt.name || "mc"),
                severity: /death|hurt|lowhp|lava|RESPAWN/i.test(String(evt.kind || evt.name || evt.why || "")) ? "P0" : "P1",
                text: String(evt.text || evt.why || evt.kind || "").slice(0, 200),
                atMs: Number(evt.t || Date.now()),
              });
            }
          } catch {
            /* 记不上不影响主流程 */
          }
          const severity = MC_CHAT.inbox.push(evt);
          const busy = agentIsBusy(MC_CHAT.sessionId);
          const decision = decideDispatch({
            severity,
            busy,
            lastWakeAt: MC_CHAT.lastEventWakeAt,
            singleFlightMs: MC_CHAT.singleFlightMs,
          });

          MC_CHAT.stats.lastEventReason = decision.reason;
          if (decision.action === "inject") {
            scheduleInject();
            return;
          }
          if (decision.action === "wake") {
            wakeBodyEvents("P0 立刻");
            return;
          }
          if (decision.action === "context") {
            MC_CHAT.stats.eventSkipped["context-only"] = (MC_CHAT.stats.eventSkipped["context-only"] || 0) + 1;
            return;
          }
          // hold：P1 等窗口 / P0 被单飞挡住
          if (severity === "P1") scheduleP1();
          else MC_CHAT.stats.eventSkipped["single-flight"] = (MC_CHAT.stats.eventSkipped["single-flight"] || 0) + 1;
        };

        if (MC_CHAT.stream) MC_CHAT.stream.stop();
        MC_CHAT.stream = openChatStream({
          url: MC_CHAT.url,
          onChat: (evt) => {
            const parsedLine = parseChatLine(evt.text);
            feed({ speaker: parsedLine.speaker, text: parsedLine.text, ts: evt.t });
          },
          onOther: (evt) => handleBodyEvent(evt),
          onError: () => {
            MC_CHAT.stats.errors += 1;
          },
        });

        const gateLine = MC_CHAT.replyToAll
          ? "门控：每条都醒（调试模式" + (minutes > 0 ? `，${minutes} 分钟后自动关` : "，记得手动 stop") + "）"
          : "门控：点名立刻醒" +
            (MC_CHAT.names.length ? `（${MC_CHAT.names.join("、")}）` : "（还没定名字，只认 @）") +
            `；否则攒够 ${MC_CHAT.ambientMinNew} 条且间隔 ≥${Math.round(MC_CHAT.ambientCooldownMs / 1000)}s 叫一次`;

        return {
          ok: true,
          text:
            `输入源：模组 SSE ${MC_CHAT.url}\n` +
            gateLine +
            "\n" +
            (MC_CHAT.watchEvents
              ? `身体动作：死亡立刻告你；反射攒摘要（≥${Math.round(MC_CHAT.reflexCooldownMs / 1000)}s 或攒够 ${MC_CHAT.burstThreshold} 条）\n`
              : "身体动作：不转发\n") +
            `回灌到会话：${sessionId.slice(0, 20)}…`,
          sessionId,
          ...MC_CHAT.stats,
        };
      },
    });


    tool({
      name: "mc_chat_status",
      description: "看 MC 聊天通道的状态：收到多少条、唤醒了几次、因为什么被跳过。",
      parameters: {},
      async execute() {
        return {
          ok: true,
          text:
            `监听：${MC_CHAT.stream ? "开" : "关"}　地址 ${MC_CHAT.url}\n` +
            `聊天：收到 ${MC_CHAT.stats.seen} 条，唤醒 ${MC_CHAT.stats.woken} 次，跳过 ${JSON.stringify(MC_CHAT.stats.skipped)}\n` +
            `身体事件：收到 ${MC_CHAT.stats.eventsSeen} 条，转达 ${MC_CHAT.stats.eventWoken} 次，跳过 ${JSON.stringify(MC_CHAT.stats.eventSkipped)}\n` +
            `注入 ${MC_CHAT.stats.injected} 次，错误 ${MC_CHAT.stats.errors} 次\n` +
            `跳过原因：${JSON.stringify(MC_CHAT.stats.skipped)}\n` +
            `门控：${MC_CHAT.replyToAll ? "每句都醒" : "只被点名"}｜名字 ${MC_CHAT.names.join("、") || "（无）"}｜自己 ${MC_CHAT.selfNames.join("、") || "（无）"}`,
          ...MC_CHAT.stats,
          listening: Boolean(MC_CHAT.stream),
        };
      },
    });
  }

  tool({
    name: "memory_episodes",
    // 传 day 时改为"取那一天的素材"，而不是列事件骨架
    description:
      "列出底仓里的事件骨架（按硬边界与 idle gap 切出来的话题段）：每段带锚点 seq_start..seq_end、所属会话、轮次范围、事件数与字符量。想看『最近都聊了哪些事』或定位该下钻哪一段时用它。",
    parameters: {
      sessionId: { type: "string", description: "限定某个会话（省略则跨会话按最近摄取排序）" },
      day: { type: "string", description: "按本地日期取那天的素材（YYYY-MM-DD）。补写某天的日记时用它" },
      limit: { type: "integer", description: "返回条数，默认 20" },
    },
    async execute(args) {
      const db = memoryDb(memoryRoot, root, logger);
      if (!db) throw new Error("记忆库不可用（检查 soul-core.log）");
      ensureIngested(db, root, logger, MEMORY.ingestOptions);
      // 给 day 就改成"取那天的素材"：补写某天日记时唯一可靠的原料来源
      if (args.day) {
        const mat = materialsForDay(db, { day: args.day, maxChars: args.maxChars ?? 12000 });
        if (mat.error) throw new Error(mat.error);
        if (mat.messages.length === 0) {
          return {
            ok: true,
            text: `${args.day}：底仓里没有那天的记录（不是"忘了"，是真的没有）。`,
            day: args.day,
            messages: [],
          };
        }
        const lines = mat.messages.map(
          (m) => `[${m.role}] ${String(m.text).replace(/\s+/g, " ").slice(0, 200)}`,
        );
        return {
          ok: true,
          text:
            `${args.day}：${mat.sessions.length} 个会话、${mat.total} 条消息` +
            `（取 ${mat.messages.length} 条，${mat.chars} 字符）\n` +
            lines.join("\n"),
          day: args.day,
          sessions: mat.sessions,
          messages: mat.messages,
        };
      }
      const rows = listEpisodes(db, { sessionId: args.sessionId || undefined, limit: args.limit ?? 20 });
      if (rows.length === 0) return { ok: true, text: "（底仓里还没有事件骨架）", episodes: [] };
      const text = rows
        .map(
          (e, i) =>
            `${i + 1}. ${e.session_id} #${e.seq_start}-${e.seq_end}｜${e.reason}｜${e.event_count} 事件｜${e.chars} 字符`,
        )
        .join("\n");
      return { ok: true, text, episodes: rows };
    },
  });

  tool({
    name: "memory_expand",
    description:
      "按锚点下钻回原始对话：给 sessionId + seq，取回该事件附近的原文（只解所在的那个日志帧）。摘要不够确定、需要原话措辞、或用户质疑记忆时用它。",
    parameters: {
      sessionId: { type: "string", required: true, description: "会话 id（来自 memory_episodes）" },
      seq: { type: "integer", required: true, description: "事件序号（锚点）" },
      before: { type: "integer", description: "往前多取几个事件，默认 2" },
      after: { type: "integer", description: "往后多取几个事件，默认 2" },
      maxChars: { type: "integer", description: "字符预算，默认 4000" },
    },
    async execute(args) {
      const db = memoryDb(memoryRoot, root, logger);
      if (!db) throw new Error("记忆库不可用（检查 soul-core.log）");
      ensureIngested(db, root, logger, MEMORY.ingestOptions);
      const r = expandAnchor(db, args.sessionId, args.seq, {
        before: args.before ?? 2,
        after: args.after ?? 2,
        maxChars: args.maxChars ?? 4000,
      });
      // 下钻是"摘要不够用"的最强信号：落在某条摘要区间内就给它记一笔
      try {
        const covering = db
          .prepare("SELECT episode_id FROM episode_notes WHERE session_id = ? AND seq_start <= ? AND seq_end >= ?")
          .all(args.sessionId, args.seq, args.seq);
        for (const row of covering) recordUsage(db, row.episode_id, "expanded");
      } catch { /* 软信号 */ }
      const text = r.events
        .filter((e) => e.text)
        .map((e) => `[${e.seq}｜${e.type}] ${e.text}`)
        .join("\n");
      return { ok: true, text: text || "（该锚点附近没有正文）", ...r };
    },
  });

  tool({
    name: "memory_annotate",
    description:
      "给一段事件骨架写摘要（带强制锚点）。anchors 用文本给出，每行 `seq|原文片段`，至少一行；服务端机械校验：seq 必须落在该段范围内、片段必须能在该 seq 的原文里原样命中，否则整条拒收。同一段再写会生成新版本（旧版保留）。",
    parameters: {
      episodeId: { type: "string", description: "事件骨架 id（与 sessionId+seq 二选一）" },
      sessionId: { type: "string", description: "会话 id" },
      seq: { type: "integer", description: "落在这段范围内的任意 seq" },
      title: { type: "string", required: true, description: "≤30 字的段名" },
      summary: { type: "string", required: true, description: "≤400 字：发生了什么 + 结论" },
      anchors: { type: "string", required: true, description: "每行 `seq|原文片段`（片段至少 4 字且必须原样存在）" },
      entities: { type: "string", description: "逗号分隔的专有名词（可选）" },
      evidence: { type: "string", description: "directive|explicit|inferred|uncertain，默认 inferred" },
    },
    async execute(args) {
      const db = memoryDb(memoryRoot, root, logger);
      if (!db) throw new Error("记忆库不可用（检查 soul-core.log）");
      ensureIngested(db, root, logger, MEMORY.ingestOptions);
      const result = saveNote(db, {
        episodeId: args.episodeId,
        sessionId: args.sessionId,
        seq: args.seq,
        title: args.title,
        summary: args.summary,
        anchors: parseAnchors(args.anchors),
        entities: String(args.entities || "")
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
        evidence: args.evidence,
      });
      return {
        ok: true,
        text: `已写入 ${result.episodeId}（v${result.version}，${result.anchors} 锚点，段 ${result.seqRange[0]}-${result.seqRange[1]}）`,
        ...result,
      };
    },
  });

  tool({
    name: "memory_search",
    description:
      "检索事件摘要（不是原文）。遇到『上次那个方案』『我们聊过的 XX』这类问题先查这里，再按锚点用 memory_expand 下钻原文。",
    parameters: {
      query: { type: "string", required: true, description: "检索词（中文可）" },
      limit: { type: "integer", description: "返回条数，默认 8" },
    },
    async execute(args) {
      const db = memoryDb(memoryRoot, root, logger);
      if (!db) throw new Error("记忆库不可用（检查 soul-core.log）");
      ensureIngested(db, root, logger, MEMORY.ingestOptions);
      const notes = searchNotes(db, args.query, {
        limit: args.limit ?? 8,
        venue: domainName === "persona" ? "chat" : domainName,
      });
      const full = searchMessages(db, args.query, { limit: args.limit ?? 8, roles: ["user", "assistant"] });
      const blocks = [];
      if (notes.hits.length) {
        blocks.push(
          "## 事件摘要命中\n" +
            notes.hits
              .map(
                (h, i) =>
                  `${i + 1}. [${h.score}] ${h.title}（${h.sessionId} #${h.seqStart}-${h.seqEnd}）\n   ${h.summary.slice(0, 200)}`,
              )
              .join("\n"),
        );
      }
      if (full.hits.length) {
        blocks.push(
          "## 原文命中\n" +
            full.hits
              .map((h, i) => `${i + 1}. [${h.score}] ${h.sessionId} seq=${h.seq}（${h.role}）\n   ${h.text.slice(0, 200)}`)
              .join("\n"),
        );
      }
      if (notes.hits.length > 0) {
        // 检索命中记一笔（决定 hot/warm/cold），失败不影响返回
        try {
          for (const hit of notes.hits) recordUsage(db, hit.episodeId, "hit");
        } catch { /* 反馈记账是软信号 */ }
      }
      if (blocks.length === 0) {
        return { ok: true, text: "（没有命中；可以先用 memory_episodes 看看有哪些段）", notes: [], messages: [] };
      }
      return { ok: true, text: blocks.join("\n\n"), notes: notes.hits, messages: full.hits };
    },
  });

  tool({
    name: "skill_list",
    description:
      "列出我学过的技巧（按域）。每条带置信度与练习次数；置信度 = 成功次数/总次数，靠真实实践涨落，不是靠自我感觉。",
    parameters: {
      domain: { type: "string", description: "域（mc / qq / persona），默认当前域" },
    },
    async execute(args) {
      const domain = args.domain || domainName;
      const rows = listSkills(root, domain);
      if (rows.length === 0) return { ok: true, text: `（${domain} 域还没有学过的技巧）`, skills: [] };
      const text = rows
        .map((s) => `- ${s.name}（置信 ${s.confidence.toFixed(2)}，${s.successes}/${s.attempts} 次）｜触发：${s.trigger || "-"}`)
        .join("\n");
      return { ok: true, text, skills: rows };
    },
  });

  tool({
    name: "skill_read",
    description: "读一条技能的全文（步骤 + 教训 + 实践记录）。name 就是 skill_list 里那个名字。",
    parameters: {
      name: { type: "string", required: true, description: "技能名" },
      domain: { type: "string", description: "域，默认当前域" },
    },
    async execute(args) {
      const found = readSkill(root, { domain: args.domain || domainName, slug: args.name });
      if (!found) throw new Error(`没有这条技能：${args.name}（先 skill_list 看看）`);
      return { ok: true, text: found.text, name: found.meta.name, confidence: found.meta.confidence };
    },
  });

  tool({
    name: "skill_recall",
    description: "按当前情境检索技能（触发词权重最高）。要做某件事之前，先看自己有没有学过。",
    parameters: {
      query: { type: "string", required: true, description: "情境或动作关键词，如『挖矿』『被玩家打』『过岩浆』" },
      domain: { type: "string", description: "域，默认当前域" },
      limit: { type: "integer", description: "返回条数，默认 5" },
    },
    async execute(args) {
      const hits = recallSkills(root, { domain: args.domain || domainName, query: args.query, limit: args.limit ?? 5 });
      if (hits.length === 0) return { ok: true, text: "（没有相关技能；这次实践完记得 skill_learn 记下来）", hits: [] };
      const text = hits
        .map((s, i) => `${i + 1}. ${s.name}（置信 ${s.confidence.toFixed(2)}，${s.successes}/${s.attempts} 次）｜触发：${s.trigger || "-"}`)
        .join("\n");
      return { ok: true, text, hits };
    },
  });

  tool({
    name: "skill_learn",
    description:
      "学/更新一条技巧，写进 skills/<域>/<名字>.md。evidence 必填：写清是哪次实践（会话锚点、步骤号、现象）。result=worked/failed 会累加成功率——失败也要记，失败比成功值钱。同名技能再写一次等于追加一条实践记录并更新置信度。",
    parameters: {
      name: { type: "string", required: true, description: "技能名（≤40 字，就是文件名）" },
      when: { type: "string", required: true, description: "什么时候用（一句话）" },
      steps: { type: "string", required: true, description: "步骤，一行一步（写可执行的动作，不要写感想）" },
      evidence: { type: "string", required: true, description: "证据：哪次实践得出的（会话锚点/步骤号/现象）" },
      lessons: { type: "string", description: "教训（坑在哪、为什么）" },
      trigger: { type: "string", description: "触发词，逗号分隔，供以后检索" },
      result: { type: "string", enum: ["worked", "failed"], description: "这次实践成功了还是失败了（会更新置信度）" },
      note: { type: "string", description: "这次实践的一句话备注" },
      domain: { type: "string", description: "域，默认当前域" },
    },
    async execute(args) {
      const saved = saveSkill(root, {
        name: args.name,
        when: args.when,
        steps: args.steps,
        lessons: args.lessons,
        trigger: args.trigger,
        evidence: args.evidence,
        result: args.result,
        note: args.note,
        domain: args.domain || domainName,
      });
      return {
        ok: true,
        text: `${saved.created ? "已新建" : "已更新"}技能「${args.name}」（置信 ${saved.confidence}，${saved.successes}/${saved.attempts} 次）→ skills/${args.domain || domainName}/${saved.slug}.md`,
        ...saved,
      };
    },
  });

  tool({
    name: "soul_digest",
    description:
      "蒸馏提案：从人格库的全文里抽出『反复出现的偏好』和『最近常聊的事』，带锚点与出现次数。只出提案，不写文件——要不要写进 USER.md / MEMORY.md 由你判断（写入走 soul_remember / soul_update，仍然要 why 与预算校验）。",
    parameters: {
      maxItems: { type: "integer", description: "最多几条候选，默认 8" },
    },
    async execute(args) {
      const db = memoryDb(memoryRoot, root, logger);
      if (!db) throw new Error("记忆库不可用（检查 soul-core.log）");
      ensureIngested(db, root, logger, MEMORY.ingestOptions);
      const digest = buildDigest(db, { maxItems: args.maxItems ?? 8 });
      const lines = [];
      if (digest.candidates.length === 0) {
        lines.push("（还没有反复出现的偏好；再多聊一阵）");
      } else {
        lines.push("## 反复出现的偏好（候选）");
        for (const c of digest.candidates) {
          lines.push(`- ${c.text}（出现 ${c.count} 次，锚点 ${c.anchors.map((a) => `${a.sessionId.slice(0, 18)}#${a.seq}`).join("、")}）`);
        }
      }
      if (digest.recentNotes.length > 0) {
        lines.push("", "## 最近常聊的（摘要档位）");
        for (const n of digest.recentNotes) {
          lines.push(`- 〔${n.tier} ${n.score}〕${n.title}：${n.summary.slice(0, 100)}`);
        }
      }
      return { ok: true, text: lines.join("\n"), ...digest };
    },
  });

  tool({
    name: "soul_update",
    description:
      "整体改写一个可写人格文件（RULES.md 只读）。超预算会被拒——先压缩旧内容，不要追加成流水账。why 必填。",
    parameters: {
      name: { type: "string", required: true, description: "文件名" },
      content: { type: "string", required: true, description: "新的完整文件内容" },
      why: { type: "string", required: true, description: "为什么这样改" },
    },
    async execute(args) {
      const r = updateFile(root, { name: args.name, content: args.content, why: args.why });
      return { ok: true, text: `已写入 ${args.name}（${r.chars}/${r.budget} 字符）`, ...r };
    },
  });

  return ok;
}

function textOf(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value.text === "string") return value.text;
  return JSON.stringify(value, null, 2);
}

/* --------------------------------------------------------------- 记忆库 */

/** 进程级句柄：底仓只开一个连接（SQLite 单写者）。 */
const MEMORY = { db: null, dbPath: "", ingested: false, lastIngest: null, personaPresets: null };

function memoryDb(memoryRoot, root, logger) {
  const dbPath = join(memoryRoot, "memory.db");
  if (MEMORY.db && MEMORY.dbPath === dbPath) return MEMORY.db;
  try {
    MEMORY.db = openStore(dbPath);
    MEMORY.dbPath = dbPath;
    MEMORY.ingested = false;
    debugLog(root, `memory store opened: ${dbPath}`);
    return MEMORY.db;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[soul] 记忆库打开失败（${dbPath}）：${msg}`);
    debugLog(root, `memory store FAILED: ${msg}`);
    MEMORY.db = null;
    return null;
  }
}

/**
 * 首次触达时摄取一次（懒惰 + 时间预算）。
 * 不放在 apply 里：启动阶段不该被 29 个会话、几十 MB 日志拖住。
 */
function ensureIngested(db, root, logger, options = {}) {
  if (options.skip) return MEMORY.lastIngest;
  const denySessionIds = options.denySessionIds ?? [];
  if (!db || MEMORY.ingested) return MEMORY.lastIngest;
  MEMORY.ingested = true;
  try {
    const sessionRoot = join(resolveDshHome(), "sessions");
    const result = ingestAll(db, [sessionRoot], {
      budgetMs: 8000,
      limitFiles: 40,
      personaPresets: MEMORY.personaPresets || undefined,
      denySessionIds,
    });
    MEMORY.lastIngest = result;
    logger?.info?.(`[soul] 底仓摄取：${JSON.stringify(result)}`);
    debugLog(root, `ingest: ${JSON.stringify(result)}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[soul] 底仓摄取失败：${msg}`);
    debugLog(root, `ingest FAILED: ${msg}`);
  }
  return MEMORY.lastIngest;
}

/* ------------------------------------------------------------------- HTTP */

const JSON_HEADERS = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };

function send(response, status_, payload) {
  response.writeHead(status_, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * 同源判定（比裸 `origin.host === host` 宽一档，但不放宽跨站）。
 *
 * 实测踩坑：桌面壳里页面 Origin 与请求 Host 可能不是逐字节相同——
 * `localhost` vs `127.0.0.1`、端口省略、或页面跑在自定义 scheme（dsh-app:）下。
 * 裸比较会把**自己的 UI** 判成跨站，症状就是设置页一保存就 `untrusted origin`。
 *
 * 放行条件（任一）：
 *   1. 无 Origin 头 —— 同源 GET / 地址栏访问
 *   2. Origin.host 与 Host 完全一致
 *   3. 两边都是回环地址且端口一致或其中一边省略（localhost ↔ 127.0.0.1）
 *   4. 自定义 / 本地 scheme（dsh-app:、file:）——只有本地壳会用它
 * 其余一律拒（含任意公网 Origin、null、畸形 URL）。
 */
function originAllowed(request) {
  const origin = request.headers.origin;
  if (origin === undefined) return { ok: true, reason: "no-origin" };

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: `malformed origin: ${origin}` };
  }

  if (parsed.protocol === "dsh-app:" || parsed.protocol === "file:") return { ok: true, reason: "local-scheme" };

  const host = request.headers.host;
  if (host === undefined) return { ok: false, reason: "missing host header" };

  if (parsed.host === host) return { ok: true, reason: "exact" };

  const hostName = host.split(":")[0];
  const hostPort = host.includes(":") ? host.split(":")[1] : "";
  if (LOOPBACK.has(parsed.hostname) && LOOPBACK.has(hostName)) {
    if (!parsed.port || !hostPort || parsed.port === hostPort) return { ok: true, reason: "loopback-alias" };
  }

  return { ok: false, reason: `origin=${origin} host=${host}` };
}

async function readJson(request, maxBytes = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("请求体过大");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

function mountRoutes(ctx, root, memoryRoot, logger, domainName = "persona") {
  ctx.inject(["webServer"], (scope) => {
    const server = scope.webServer;
    if (!server || typeof server.register !== "function") {
      logger?.warn?.("[soul] webServer 不可用：人格视图取不到数据");
      return;
    }
    const dispose = server.register({
      kind: "prefix",
      path: "/dsh-soul",
      handler: async (request, response) => {
        const url = new URL(request.url || "/", "http://x");
        const route = url.pathname.replace(/^\/dsh-soul/, "").replace(/\/+$/, "") || "/";
        const isPost = (request.method || "GET") === "POST";

        // POST 必须过同源判定；GET 放松（地址栏 / 同源 fetch 不带 Origin）。
        const gate = originAllowed(request);
        if (!gate.ok) {
          // 把真实取值记下来——下次再被拒，日志里就是答案，不用猜
          debugLog(root, `403 ${request.method || "GET"} ${route} :: ${gate.reason}`);
          return send(response, 403, { ok: false, error: "untrusted origin", detail: gate.reason });
        }

        try {
          if (isPost) {
            // 写操作只接受 JSON——挡住表单式 CSRF（表单 POST 不触发预检，但 content-type 不是 json）
            const ctype = String(request.headers["content-type"] || "");
            if (!ctype.includes("application/json")) {
              return send(response, 415, { ok: false, error: "content-type 必须是 application/json" });
            }
            const body = await readJson(request);
            if (route === "/api/journal") return send(response, 200, { ok: true, ...appendJournal(root, body.text, { kind: body.kind }) });
            if (route === "/api/remember") return send(response, 200, { ok: true, ...remember(root, body) });
            if (route === "/api/update") return send(response, 200, { ok: true, ...updateFile(root, body) });
            if (route === "/api/config") {
              const next = writeConfig(body);
              debugLog(root, `config written: ${JSON.stringify(next)}`);
              return send(response, 200, {
                ok: true,
                config: next,
                // root / memoryRoot / injectBudget 在 apply 时已固化，改完必须重启才生效
                restartRequired:
                  body.root !== undefined || body.memoryRoot !== undefined || body.injectBudget !== undefined,
              });
            }
            return send(response, 404, { ok: false, error: `unknown route ${route}` });
          }
          if (route === "/api/state") {
            return send(response, 200, {
              ok: true,
              status: status(root),
              files: FILES,
              dims: DIMS,
              injectBudget: injectBudget(),
              journal: readJournal(root),
              memoryRoot: memoryRoot,
              memoryRootSource: resolveMemoryRootSource(),
              toolsAvailable: defineTool !== null,
              toolsSource: defineToolSource,
            });
          }
          if (route === "/api/config") {
            return send(response, 200, {
              ok: true,
              root: root,
              rootSource: resolveRootSource(),
              memoryRoot: memoryRoot,
              memoryRootSource: resolveMemoryRootSource(),
              configPath: configPath(),
              injectBudget: injectBudget(),
              config: readConfig(),
            });
          }
          if (route === "/api/block") {
            return send(response, 200, { ok: true, block: safeBlock(root, memoryRoot, logger, domainName) });
          }
          if (route === "/api/file") {
            const fileName = url.searchParams.get("name") || "SOUL.md";
            return send(response, 200, { ok: true, name: fileName, content: readFile(root, fileName) });
          }
          if (route === "/api/journal") {
            return send(response, 200, { ok: true, date: url.searchParams.get("date") || "", content: readJournal(root, url.searchParams.get("date") || undefined) });
          }
          if (route === "/api/recall") {
            const q = url.searchParams.get("q") || "";
            const limit = Number(url.searchParams.get("limit") || 8);
            return send(response, 200, { ok: true, ...recall(root, q, { limit }) });
          }
          if (route.startsWith("/api/memory/")) {
            const db = memoryDb(memoryRoot, root, logger);
            if (!db) return send(response, 503, { ok: false, error: "记忆库不可用（见日志）" });
            ensureIngested(db, root, logger, MEMORY.ingestOptions);

            if (route === "/api/memory/state") {
              return send(response, 200, {
                ok: true,
                memoryRoot,
                dbPath: MEMORY.dbPath,
                ...memoryStats(db),
                tiers: tierSummary(db, {}).counts,
                ingest: MEMORY.lastIngest,
              });
            }
            if (route === "/api/memory/messages") {
              const sessionId = url.searchParams.get("sessionId") || "";
              if (!sessionId) return send(response, 400, { ok: false, error: "需要 sessionId" });
              return send(response, 200, {
                ok: true,
                messages: listMessages(db, sessionId, { limit: Number(url.searchParams.get("limit") || 200) }),
              });
            }
            if (route === "/api/memory/sessions") {
              return send(response, 200, { ok: true, sessions: listSessions(db, Number(url.searchParams.get("limit") || 20)) });
            }
            if (route === "/api/memory/episodes") {
              return send(response, 200, {
                ok: true,
                episodes: listEpisodes(db, {
                  sessionId: url.searchParams.get("sessionId") || undefined,
                  limit: Number(url.searchParams.get("limit") || 30),
                }),
              });
            }
            if (route === "/api/memory/tiers") {
              const summary = tierSummary(db, {});
              return send(response, 200, {
                ok: true,
                counts: summary.counts,
                total: summary.total,
                ranked: summary.ranked.slice(0, Number(url.searchParams.get("limit") || 20)),
              });
            }
            if (route === "/api/memory/digest") {
              return send(response, 200, { ok: true, ...buildDigest(db, { maxItems: Number(url.searchParams.get("maxItems") || 8) }) });
            }
            if (route === "/api/memory/notes") {
              return send(response, 200, {
                ok: true,
                notes: listNotes(db, {
                  sessionId: url.searchParams.get("sessionId") || undefined,
                  limit: Number(url.searchParams.get("limit") || 30),
                }),
              });
            }
            if (route === "/api/memory/search") {
              return send(response, 200, {
                ok: true,
                ...searchNotes(db, url.searchParams.get("q") || "", {
                  limit: Number(url.searchParams.get("limit") || 8),
                }),
              });
            }
            if (route === "/api/memory/expand") {
              const sessionId = url.searchParams.get("sessionId") || "";
              const seq = Number(url.searchParams.get("seq"));
              if (!sessionId || !Number.isFinite(seq)) {
                return send(response, 400, { ok: false, error: "需要 sessionId 与 seq" });
              }
              return send(response, 200, {
                ok: true,
                ...expandAnchor(db, sessionId, seq, {
                  before: Number(url.searchParams.get("before") || 2),
                  after: Number(url.searchParams.get("after") || 2),
                  maxChars: Number(url.searchParams.get("maxChars") || 4000),
                }),
              });
            }
            return send(response, 404, { ok: false, error: `unknown route ${route}` });
          }
          return send(response, 404, { ok: false, error: `unknown route ${route}` });
        } catch (error) {
          return send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    });
    logger?.info?.("[soul] 已挂载 /dsh-soul/api/*");
    return () => {
      try {
        dispose();
      } catch {
        /* 已释放 */
      }
    };
  });
}

/* -------------------------------------------------------------------- 入口 */

/** 自诊断日志：宿主进程的 stdout 我们看不到，所以关键步骤落一份文件到人格目录。 */
function debugLog(root, line) {
  try {
    appendFileSync(join(root, "soul-core.log"), `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    /* 日志绝不能影响加载 */
  }
}

/**
 * 入口按 `config.mode` 分工——同一个包被挂两次，各干各的：
 *
 *   mode: "ui"      → 只挂 /dsh-soul/api/*（profile 级实例）
 *   mode: "persona" → 只挂提示词变量 + soul_* 工具（preset 内实例）
 *   mode: "full"（缺省） → 两者都挂（本地调试 / 单实例场景）
 *
 * 为什么必须拆：客户端 bundle 的发现和宿主插件是两条线。UI（设置页 / 对话视图环）
 * 属于客户端 bundle，而它是否被扫描取决于包有没有作为**profile 级插件条目**存在；
 * 只挂在 preset 里的话，工作态没问题，但设置页可能根本看不到这个插件。
 * 反过来，如果为了 UI 把整个包挂到 profile 级，soul_* 工具就会出现在**工作会话**里
 * ——那正好违反"工作态零人格"。
 *
 * 所以：profile 级挂 ui 实例（只提供 HTTP），preset 内挂 persona 实例（只给那个人格会话
 * 提供变量与工具）。两个实例各自无状态，状态都在磁盘。
 *
 * 另外：**整个入口保持同步**。之前用 `await import(...)` 在宿主进程里会挂住，
 * 导致后面的工具注册永不执行（现象：人格注入正常但 tool/call 报 UNKNOWN_TOOL）。
 */
export function apply(ctx, config) {
  const root = resolveRoot(config?.root);
  const memoryRoot = resolveMemoryRoot(root, config?.memoryRoot);
  MEMORY.personaPresets = Array.isArray(config?.personaPresets) && config.personaPresets.length > 0 ? config.personaPresets : null;
  const logger = ctx.logger;
  const mode = ["ui", "persona", "prompt", "full"].includes(config?.mode) ? config.mode : "full";
  const wantRoutes = mode === "ui" || mode === "full";
  const wantPersona = mode === "persona" || mode === "full";
  /** prompt 模式：只出提示词变量（给"工作模式"复用她的身份，但不带 soul_* 工具）。 */
  const wantVariable = wantPersona || mode === "prompt";
  /** 当前实例所属的"域"：persona / mc / qq。技能与记忆注入都按它分栏。 */
  const domainName = String(config?.domain || "persona").trim() || "persona";
  /**
   * 场景名（venue）：persona → chat，mc → mc，qq → qq。
   * **同一个库**，只用来标注"这话是在哪儿说的"，以及给同场景的记忆轻微加权——
   * 不把别的场景排除：她在哪儿都是同一个人。
   */
  const venueName = domainName === "persona" ? "chat" : domainName;
  /** 额外要禁的工具名（config.denyTools）。联网类默认按名字特征已经禁掉。 */
  const denyExtra = Array.isArray(config?.denyTools) ? config.denyTools.filter((n) => typeof n === "string") : [];
  SAFE_BLOCK_DENY_EXTRA = denyExtra;
  MODULE_ROOT = root;
  const testMode = config?.testMode === true;
  /** false = 不搞脾气（工作模式/测试模式）：不拦活、不加起床气、不注入反助手腔。 */
  const moodful = config?.moodful !== false;
  /** 这个实例带不带通用工具（读写/终端）。只有工作模式为 true。 */
  const handTools = config?.handTools === true;
  /** 永不入库的会话 id（测试对话）。文件在人格目录，人类可编辑。 */
  const denyPath = join(root, "ingest-deny.json");
  let denySessionIds = [];
  try {
    if (existsSync(denyPath)) {
      const parsed = JSON.parse(readFileSync(denyPath, "utf8"));
      if (Array.isArray(parsed)) denySessionIds = parsed.map(String);
    }
  } catch {
    denySessionIds = [];
  }
  MEMORY.ingestOptions = { skip: testMode, denySessionIds };
  debugLog(root, `testMode=${testMode} denySessions=${denySessionIds.length}`);

  // code= 是本文件的修改时间：重启后拿它和 lib/index.js 的 mtime 比，一眼看出加载的是哪版代码
  let codeStamp = "?";
  try {
    codeStamp = statSync(new URL(import.meta.url)).mtime.toISOString();
  } catch {
    codeStamp = "?";
  }
  debugLog(
    root,
    `apply() root=${root} memoryRoot=${memoryRoot} mode=${mode} domain=${domainName} venue=${venueName} code=${codeStamp} pid=${process.pid}`,
  );

  // 记忆库目录（默认就在人格目录里面）先建好，底仓接进来时直接可用
  try {
    mkdirSync(memoryRoot, { recursive: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[soul] 记忆库目录创建失败（${memoryRoot}）：${msg}`);
    debugLog(root, `memoryRoot mkdir FAILED: ${msg}`);
  }

  try {
    const seeded = ensureSeed(root);
    if (seeded.created.length) {
      logger?.info?.(`[soul] 已播种人格文件：${seeded.created.join(", ")}（${root}）`);
      debugLog(root, `seeded: ${seeded.created.join(",")}`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger?.warn?.(`[soul] 人格目录初始化失败：${msg}`);
    debugLog(root, `seed FAILED: ${msg}`);
  }

  if (wantVariable) {
    mountAgents(ctx);
    mountVariable(ctx, root, memoryRoot, logger, domainName, testMode, handTools, wantPersona, moodful, config);
    debugLog(root, "mountVariable done");
  }

  if (wantRoutes) {
    // 定时行为挂在 ui 实例上：全进程只有一份，不会每个 preset 各起一个定时器
    startIngestLoop(root, memoryRoot, logger, config);
    startDiaryScheduler(ctx, root, memoryRoot, logger, config);
    mountRoutes(ctx, root, memoryRoot, logger, domainName);
    debugLog(root, "mountRoutes done");
  }

  if (wantPersona) {
    ctx.inject(["tools"], (scope) => {
      if (!scope.tools || typeof scope.tools.register !== "function") {
        logger?.warn?.("[soul] tools 服务不可用：soul_* 工具未注册");
        debugLog(root, "mountTools SKIPPED: no tools service");
        return;
      }
      try {
        const count = mountTools(scope, root, memoryRoot, logger, domainName, denyExtra, testMode, moodful);
        logger?.info?.(`[soul] 已注册 ${count} 个人格/记忆/技能工具（域 ${domainName}，defineTool=${defineToolSource}）`);
        debugLog(root, `mountTools done: ${count} tools, defineTool=${defineToolSource}, domain=${domainName}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger?.warn?.(`[soul] 工具挂载失败：${msg}`);
        debugLog(root, `mountTools FAILED: ${msg}`);
      }
    });
    debugLog(root, "ctx.inject(tools) registered");
  }
}

export default { name, apply };

/** 测试用：清掉「当前会话」解析缓存（TTL 内的缓存会串测试）。 */
export function __resetSessionCache() {
  PREFETCH.sessionId = "";
  PREFETCH.sessionIdAt = 0;
}

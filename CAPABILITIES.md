# 她的能力边界

> 2026-10-29 定：**不给能跑系统命令的手，也不给联网。**
> 理由：进别人的服务器 / 误操作的成本太高，宁可让她笨一点。

## 装了什么

| 插件 | 给的工具 | 有风险吗 |
|---|---|---|
| `agent-instructions` | 读 `AGENTS.md` | 读 |
| `tool-fs` | `read` / `write` / `edit` | **写文件**（受沙箱约束） |
| `tool-fs-search` | `glob` / `grep` | 读 |
| `skill-filesystem` + `tool-skill` | 技能目录 | 读 |
| `command-goal` + `tool-goal` | 长期目标 | 状态 |
| `soul-core` | `soul_*` / `memory_*` / `skill_*` / `mc_chat_*` | 她的记忆 |

## 没装什么（故意的）

| 插件 | 为什么不给 |
|---|---|
| `tool-pwsh` / `tool-bash` | 能跑任意系统命令、起进程、删文件。**这是最危险的一类** |
| `tool-jobs` | 后台任务的目的是跑命令；没有 shell 它没用，留着只是多一个入口 |
| `plan-mode` | 她不需要"计划模式"，她要的是"边做边说" |

## 兜底：运行时也拦

preset 层面已经不装 shell，但万一别的全局扩展（比如 qqbot 的 `expose:'all'`）提供了
跑命令的工具，插件会在 **per-agent 范围**里再封一次：

```js
agent.ctx.tools.restrict({ deny: [...] })
```

匹配：`/(bing|web|search|crawl|fetch|browse|bash|pwsh|powershell|shell|exec|spawn|terminal)/i`
排除：`soul_*` / `memory_*` / `skill_*` / `mc_chat_*`（`memory_search`、`skill_recall` 名字里带 search，绝不能误伤）

两个时机：**提示词组装时**（早于任何工具调用）+ 工具调用兜底。

## 还剩什么风险（说实话）

她能**写文件**——这是"改 dsh-mc-client 代码"的代价。风险取决于沙箱策略：

| 沙箱模式 | 她能写哪里 | 要审批吗 |
|---|---|---|
| `workspace-write` | 只在她 workspace 内 | 工作区外要审批 |
| `danger-full-access` | **任何地方** | 不审批 |

她的 workspace 是 `<你的工作区>`，而 MC 插件在 `<你的 dsh-mc-client 目录>`——**在工作区外**。
所以只要沙箱是 `workspace-write`，她改 MC 插件就必然弹审批，那正是我们要的摩擦。

⚠️ **如果 profile 的沙箱是 `danger-full-access`，她能静默改任何文件。** 想彻底放心就把沙箱
调回 `workspace-write`（设置页 → 沙箱）。这条我改不了她的行为，只能靠策略。

## 她还不能做的事

- 跑命令、装包、启服务、看进程 → **没 shell**
- 上网搜/抓网页 → **没联网工具**
- 改 `RULES.md` → 插件拒写（只读锚点）
- 绕过人格文件预算 → 纪律要求走 `soul_update`，但没有机制强制（`write` 能绕过）

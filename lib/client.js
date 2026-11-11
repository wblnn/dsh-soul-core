/**
 * dsh-soul-core / 浏览器端
 *
 * CJS factory 包装（宿主注入 require，只 require("react")，无构建步骤）。
 * 数据全走同源 /dsh-soul/api/*，不轮询。
 *
 * 两个入口，同一个文件两种形态：
 *   - conversation.view  → 轻量状态面板（跟 Chat / Trajectory 并列）
 *   - settings.section   → 完整设置（改记忆库位置、注入预算、直接编辑人格文件）
 */
window.__ModuleLoader__.load({
  id: "dsh-soul-core",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const API = "/dsh-soul/api";
    const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

    const C = {
      text: "var(--dsw-alias-label-primary, #1f2328)",
      text2: "var(--dsw-alias-label-secondary, #57606a)",
      text3: "var(--dsw-alias-label-tertiary, #818b98)",
      border: "var(--dsw-alias-border-l1, rgba(0,0,0,0.08))",
      card: "var(--dsw-alias-bg-layer-1, #ffffff)",
      card2: "var(--dsw-alias-bg-layer-2, #f6f7f9)",
      brand: "var(--dsw-alias-brand-primary, #3964fe)",
      ok: "var(--dsw-alias-state-success-primary, #17a34a)",
      warn: "var(--dsw-alias-state-warn-primary, #d97706)",
      err: "var(--dsw-alias-state-error-primary, #dc2626)",
    };

    const s = {
      root: { display: "flex", flexDirection: "column", gap: "14px", padding: "16px 18px", height: "100%", overflowY: "auto", color: C.text, fontSize: "13px", lineHeight: 1.55 },
      h1: { fontSize: "15px", fontWeight: 600, margin: 0 },
      sub: { fontSize: "11px", color: C.text3, fontFamily: MONO, wordBreak: "break-all" },
      row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
      card: { border: `1px solid ${C.border}`, borderRadius: "10px", background: C.card, padding: "12px 14px" },
      cardTitle: { fontSize: "12px", fontWeight: 600, color: C.text2, marginBottom: "8px" },
      bar: { height: "5px", borderRadius: "3px", background: C.card2, overflow: "hidden", marginTop: "4px" },
      fill: (pct, over) => ({ height: "100%", width: `${Math.min(100, pct)}%`, background: over ? C.err : C.brand, transition: "width .25s ease" }),
      mono: { fontFamily: MONO, fontSize: "11px", color: C.text2 },
      btn: { border: `1px solid ${C.border}`, background: C.card, color: C.text, borderRadius: "7px", padding: "4px 10px", fontSize: "12px", cursor: "pointer" },
      btnPrimary: { border: `1px solid ${C.brand}`, background: C.brand, color: "#fff", borderRadius: "7px", padding: "4px 10px", fontSize: "12px", cursor: "pointer" },
      btnOn: { border: `1px solid ${C.brand}`, background: C.brand, color: "#fff", borderRadius: "7px", padding: "4px 10px", fontSize: "12px", cursor: "pointer" },
      input: { flex: 1, minWidth: "120px", border: `1px solid ${C.border}`, background: C.card, color: C.text, borderRadius: "7px", padding: "5px 9px", fontSize: "12px", outline: "none" },
      textarea: { width: "100%", minHeight: "180px", border: `1px solid ${C.border}`, background: C.card, color: C.text, borderRadius: "8px", padding: "10px", fontSize: "12px", lineHeight: 1.6, fontFamily: MONO, outline: "none", resize: "vertical", marginTop: "8px" },
      pre: { whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: MONO, fontSize: "11px", color: C.text2, margin: 0, maxHeight: "260px", overflowY: "auto" },
      pill: (color) => ({ display: "inline-flex", alignItems: "center", gap: "5px", height: "20px", padding: "0 8px", borderRadius: "999px", border: `1px solid ${C.border}`, fontSize: "11px", color: color || C.text3 }),
      err: { color: C.err, fontSize: "12px" },
      okMsg: { color: C.ok, fontSize: "12px" },
    };

    async function api(path, options) {
      const opts = options || {};
      const res = await fetch(API + path, {
        ...opts,
        headers: { "x-dsh-soul": "1", ...(opts.headers || {}) },
      });
      const body = await res.json().catch(() => ({ ok: false, error: "响应不是 JSON" }));
      if (!res.ok || body.ok === false) {
        const detail = body.detail ? `（${body.detail}）` : "";
        throw new Error(`${body.error || `HTTP ${res.status}`}${detail}`);
      }
      return body;
    }

    function post(path, payload) {
      return api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    /* ------------------------------------------------------------ 共用 */

    function Head({ st, toolsSource, onRefresh, busy }) {
      return h("div", { style: s.row },
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { style: s.h1 }, "人格"),
          h("div", { style: s.sub }, st ? st.root : "（未连接）")
        ),
        st ? h("span", { style: s.pill(C.ok) }, `人格块 ${st.totalChars}/${st.injectBudget}`) : null,
        toolsSource ? h("span", { style: s.pill() }, `工具 ${toolsSource}`) : null,
        h("button", { style: s.btn, onClick: onRefresh, disabled: busy }, "刷新")
      );
    }

    function FileBars({ files }) {
      if (!files || files.length === 0) return h("div", { style: s.sub }, "还没有初始化");
      return h("div", null, files.map((f) => {
        const pct = f.budget ? (f.chars / f.budget) * 100 : 0;
        return h("div", { key: f.name, style: { marginBottom: "10px" } },
          h("div", { style: s.row },
            h("span", { style: { fontFamily: MONO, fontSize: "12px" } }, f.name),
            h("span", { style: s.sub }, f.title),
            h("span", { style: { marginLeft: "auto", ...s.mono, color: f.overBudget ? C.err : C.text3 } }, `${f.chars}/${f.budget}`),
            f.writable ? null : h("span", { style: s.pill() }, "只读")
          ),
          h("div", { style: s.bar }, h("div", { style: s.fill(pct, f.overBudget) }))
        );
      }));
    }

    /* -------------------------------------------------- 轻量面板（对话视图） */

    function ChatPanel() {
      const [state, setState] = useState(null);
      const [block, setBlock] = useState("");
      const [err, setErr] = useState("");
      const [busy, setBusy] = useState(false);
      const alive = useRef(true);

      const load = useCallback(async () => {
        try {
          const body = await api("/state");
          if (!alive.current) return;
          setState(body);
          setErr("");
        } catch (e) {
          if (alive.current) setErr(e.message);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        load();
        return () => { alive.current = false; };
      }, [load]);

      const run = async (fn) => {
        setBusy(true);
        try { await fn(); setErr(""); } catch (e) { setErr(e.message); } finally { if (alive.current) setBusy(false); }
      };

      const st = state && state.status;
      return h("div", { style: s.root },
        h(Head, { st, toolsSource: state && state.toolsSource, onRefresh: load, busy }),
        err ? h("div", { style: s.err }, err) : null,
        h("div", { style: s.card }, h("div", { style: s.cardTitle }, "人格文件（每轮注入，改文件立刻生效）"), h(FileBars, { files: st && st.files })),
        h("div", { style: s.card },
          h("div", { style: s.row },
            h("div", { style: s.cardTitle }, "本轮模型看到的完整人格块"),
            h("button", { style: { ...s.btn, marginLeft: "auto" }, onClick: () => run(async () => setBlock((await api("/block")).block || "")), disabled: busy }, block ? "重新渲染" : "预览")
          ),
          block ? h("pre", { style: s.pre }, block) : h("div", { style: s.sub }, "点「预览」看 complete:true 下真正的系统提示词。要改内容去设置页。")
        ),
        h("div", { style: s.card },
          h("div", { style: s.cardTitle }, `今日日记${st ? `（${st.journalToday} 条）` : ""}`),
          state && state.journal ? h("pre", { style: s.pre }, state.journal) : h("div", { style: s.sub }, "今天还没写。")
        )
      );
    }

    /* ------------------------------------------------------- 记忆库面板 */

    /**
     * 「记忆」独立设置入口：底仓 / 事件树 / 锚点索引的落点。
     * 默认跟人格库同目录（`<人格目录>/memory-tree`），也可以单独指到别处。
     */
    function MemoryPanel() {
      const [cfg, setCfg] = useState(null);
      const [mem, setMem] = useState(null);
      const [memErr, setMemErr] = useState("");
      const [draft, setDraft] = useState("");
      const [err, setErr] = useState("");
      const [msg, setMsg] = useState("");
      const [busy, setBusy] = useState(false);
      const alive = useRef(true);

      const load = useCallback(async () => {
        try {
          const cf = await api("/config");
          if (!alive.current) return;
          setCfg(cf);
          setDraft(cf.config && cf.config.memoryRoot ? cf.config.memoryRoot : "");
          setErr("");
        } catch (e) {
          if (alive.current) setErr(e.message);
        }
        try {
          const st = await api("/memory/state");
          if (!alive.current) return;
          setMem(st);
          setMemErr("");
        } catch (e) {
          if (alive.current) setMemErr(e.message);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        load();
        return () => { alive.current = false; };
      }, [load]);

      const save = async () => {
        setBusy(true);
        setErr("");
        setMsg("");
        try {
          await post("/config", { memoryRoot: draft.trim() });
          setMsg("已保存。记忆库目录在重启 DSH 后生效。");
          await load();
        } catch (e) {
          setErr(e.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      return h("div", { style: s.root },
        h("div", { style: s.row },
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { style: s.h1 }, "记忆库"),
            h("div", { style: s.sub }, cfg ? cfg.memoryRoot : "（未连接）")
          ),
          h("span", { style: s.pill() }, `来源 ${cfg ? cfg.memoryRootSource : "?"}`),
          h("button", { style: s.btn, onClick: load, disabled: busy }, "刷新")
        ),

        err ? h("div", { style: s.err }, err) : null,
        msg ? h("div", { style: s.okMsg }, msg) : null,

        h("div", { style: s.card },
          h("div", { style: s.cardTitle }, "落点"),
          h("div", { style: s.row },
            h("span", { style: { ...s.mono, width: "72px" } }, "记忆库目录"),
            h("input", { style: s.input, value: draft, onChange: (e) => setDraft(e.target.value), placeholder: "留空 = <人格目录>/memory-tree" })
          ),
          h("div", { style: { ...s.row, marginTop: "8px" } },
            h("button", { style: s.btnPrimary, onClick: save, disabled: busy }, "保存目录"),
            h("span", { style: s.sub }, cfg ? `人格目录 ${cfg.root}` : "")
          ),
          h("div", { style: { ...s.sub, marginTop: "6px" } },
            "默认跟人格库放在一起（一个自我一个文件夹，备份/迁移只拷一个目录）。改成其他路径就是独立落点，重启生效。")
        ),

        h("div", { style: s.card },
          h("div", { style: s.cardTitle }, "底仓 / 事件树（已接入）"),
          memErr ? h("div", { style: s.err }, memErr) : null,
          mem
            ? h("div", { style: s.row },
                h("span", { style: s.pill(C.ok) }, `会话 ${mem.sessions}`),
                h("span", { style: s.pill() }, `事件 ${mem.events}`),
                h("span", { style: s.pill() }, `事件骨架 ${mem.episodes}`),
                h("span", { style: s.pill() }, `全文 ${mem.messages} 条 / ${mem.messageChars} 字`),
                h("span", { style: s.pill() }, `帧 ${mem.frames}`)
              )
            : h("div", { style: s.sub }, "读取中…"),
          mem && mem.tiers
            ? h("div", { style: { ...s.row, marginTop: "6px" } },
                h("span", { style: s.pill(C.ok) }, `常驻 hot ${mem.tiers.hot}`),
                h("span", { style: s.pill() }, `常提 warm ${mem.tiers.warm}`),
                h("span", { style: s.pill() }, `偶及 cold ${mem.tiers.cold}`),
                h("span", { style: s.sub }, "频率只决定注入优先级，不决定真值")
              )
            : null,
          h("div", { style: { ...s.mono, marginTop: "6px" } }, mem ? `数据库 ${mem.dbPath}` : ""),
          mem && mem.ingest
            ? h("div", { style: { ...s.sub, marginTop: "4px" } },
                `最近摄取：扫 ${mem.ingest.scanned} 个会话，新增 ${mem.ingest.ingested}，跳过 ${mem.ingest.skipped}，${mem.ingest.events} 事件 / ${mem.ingest.episodes} 段${mem.ingest.timedOut ? "（达到时间预算，下次继续）" : ""}`)
            : null,
          h("div", { style: { ...s.sub, marginTop: "6px" } },
            "原始日志不复制：真源仍是 DSH 的 session.v4.jsonl.zstd，这里只建索引与骨架；人格里说『记得』时按锚点 (sessionId, seq) 只解所在那一帧回读原文。")
        )
      );
    }

    /* ------------------------------------------------------- 设置面板 */

    function SettingsPanel() {
      const [state, setState] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [rootDraft, setRootDraft] = useState("");
      const [budgetDraft, setBudgetDraft] = useState("");
      const [name, setName] = useState("SOUL.md");
      const [draft, setDraft] = useState("");
      const [why, setWhy] = useState("");
      const [block, setBlock] = useState("");
      const [err, setErr] = useState("");
      const [msg, setMsg] = useState("");
      const [busy, setBusy] = useState(false);
      const alive = useRef(true);

      const load = useCallback(async () => {
        try {
          const [st, cf] = await Promise.all([api("/state"), api("/config")]);
          if (!alive.current) return;
          setState(st);
          setCfg(cf);
          setRootDraft(cf.root || "");
          setBudgetDraft(String(cf.injectBudget || ""));
          setErr("");
        } catch (e) {
          if (alive.current) setErr(e.message);
        }
      }, []);

      const openFile = useCallback(async (fileName) => {
        try {
          const body = await api(`/file?name=${encodeURIComponent(fileName)}`);
          if (!alive.current) return;
          setName(fileName);
          setDraft(body.content || "");
          setWhy("");
          setMsg("");
          setErr("");
        } catch (e) {
          if (alive.current) setErr(e.message);
        }
      }, []);

      useEffect(() => {
        alive.current = true;
        load().then(() => openFile("SOUL.md"));
        return () => { alive.current = false; };
      }, [load, openFile]);

      const run = async (fn, okText) => {
        setBusy(true);
        setErr("");
        setMsg("");
        try {
          const r = await fn();
          if (alive.current && okText) setMsg(typeof okText === "function" ? okText(r) : okText);
          return r;
        } catch (e) {
          if (alive.current) setErr(e.message);
        } finally {
          if (alive.current) setBusy(false);
        }
      };

      const saveCfg = () => run(async () => {
        const r = await post("/config", {
          root: rootDraft.trim(),
          injectBudget: budgetDraft.trim() === "" ? undefined : Number(budgetDraft.trim()),
        });
        setCfg((c) => ({ ...c, config: r.config }));
        return r;
      }, (r) => (r && r.restartRequired ? "已保存。记忆库位置 / 注入预算在重启 DSH 后生效。" : "已保存。"));

      const saveFile = () => run(async () => {
        const r = await post("/update", { name, content: draft, why });
        await load();
        return r;
      }, (r) => (r ? `已写入 ${name}（${r.chars}/${r.budget} 字符）` : "已保存。"));

      const showBlock = () => run(async () => {
        const r = await api("/block");
        setBlock(r.block || "");
        return r;
      });

      const st = state && state.status;
      const files = (st && st.files) || [];
      const current = files.find((f) => f.name === name);
      const over = current ? draft.length > current.budget : false;

      return h("div", { style: s.root },
        h(Head, { st, toolsSource: state && state.toolsSource, onRefresh: load, busy }),

        err ? h("div", { style: s.err }, err) : null,
        msg ? h("div", { style: s.okMsg }, msg) : null,

        h("div", { style: s.card },
          h("div", { style: s.cardTitle }, "记忆库位置与注入预算"),
          h("div", { style: s.row },
            h("span", { style: { ...s.mono, width: "72px" } }, "人格目录"),
            h("input", { style: s.input, value: rootDraft, onChange: (e) => setRootDraft(e.target.value), placeholder: "留空 = ~/.dsh/soul" })
          ),
          h("div", { style: { ...s.row, marginTop: "8px" } },
            h("span", { style: { ...s.mono, width: "72px" } }, "注入上限"),
            h("input", { style: { ...s.input, maxWidth: "140px" }, value: budgetDraft, onChange: (e) => setBudgetDraft(e.target.value), placeholder: "11000" }),
            h("span", { style: s.sub }, "字符"),
            h("button", { style: { ...s.btnPrimary, marginLeft: "auto" }, onClick: saveCfg, disabled: busy }, "保存配置")
          ),
          h("div", { style: { ...s.row, marginTop: "8px" } },
            h("span", { style: s.pill() }, `来源 ${cfg ? cfg.rootSource : "?"}`),
            h("span", { style: s.sub }, cfg ? `配置文件 ${cfg.configPath}` : "")
          ),
          h("div", { style: { ...s.sub, marginTop: "6px" } }, "这两项需要重启 DSH 才生效（插件在启动时固化目录）。人格文件本身的修改不需要重启。")
        ),

        h("div", { style: s.card },
          h("div", { style: s.row },
            h("div", { style: s.cardTitle }, "编辑人格文件"),
            h("div", { style: { marginLeft: "auto", display: "flex", gap: "6px", flexWrap: "wrap" } },
              files.map((f) => h("button", {
                key: f.name,
                style: f.name === name ? s.btnOn : s.btn,
                onClick: () => openFile(f.name),
                disabled: busy,
              }, f.name.replace(".md", "")))
            )
          ),
          h("div", { style: { ...s.row, marginTop: "4px" } },
            h("span", { style: { ...s.mono, color: current && current.writable ? C.text3 : C.warn } },
              current ? (current.writable ? "可写" : "只读（agent 改不了，你可以直接编辑）") : ""),
            h("span", { style: { ...s.mono, marginLeft: "auto", color: over ? C.err : C.text3 } },
              current ? `${draft.length} / ${current.budget}` : "")
          ),
          h("textarea", {
            style: s.textarea,
            value: draft,
            spellCheck: false,
            onChange: (e) => setDraft(e.target.value),
          }),
          h("div", { style: { ...s.row, marginTop: "8px" } },
            h("input", { style: s.input, value: why, placeholder: "为什么这样改（保存必填，会记进当日日记）", onChange: (e) => setWhy(e.target.value) }),
            h("button", { style: s.btnPrimary, onClick: saveFile, disabled: busy || !why.trim() || draft.length === 0 }, "保存文件")
          ),
          over ? h("div", { style: { ...s.err, marginTop: "6px" } }, "超出预算会被拒——先压缩旧内容，别把人格写成流水账。") : null
        ),

        h("div", { style: s.card },
          h("div", { style: s.row },
            h("div", { style: s.cardTitle }, "接管式提示词预览（complete:true 下的唯一系统提示词）"),
            h("button", { style: { ...s.btn, marginLeft: "auto" }, onClick: showBlock, disabled: busy }, block ? "重新渲染" : "预览")
          ),
          block ? h("pre", { style: s.pre }, block) : h("div", { style: s.sub }, "渲染结果由上面几个文件拼成；改哪个文件都会变。")
        ),

        h("div", { style: s.card }, h("div", { style: s.cardTitle }, "各文件用量"), h(FileBars, { files }))
      );
    }

    const inject = ["slots"];

    /** 每个注册独立兜住：一处被 slot 账本拒绝，不影响其他入口。 */
    function tryRegister(ctx, slot, id, order, label, Component, tag) {
      try {
        ctx.slots.inject(slot, () =>
          ctx.slots.register({ name: slot, id, order, label: () => label }, () => h(Component, null))
        );
      } catch (error) {
        console.warn(`[soul] ${tag} 注册失败：`, error && error.message ? error.message : error);
      }
    }

    function apply(ctx) {
      // 对话视图环：和 Chat / Trajectory 并列
      tryRegister(ctx, "conversation.view", "soul", 20, "人格", ChatPanel, "conversation.view");
      // 设置页两个独立入口：人格（文件/预算/预览）、记忆（底仓/事件树落点）
      tryRegister(ctx, "settings.section", "soul", 26, "人格", SettingsPanel, "settings.section[人格]");
      tryRegister(ctx, "settings.section", "soul-memory", 27, "记忆", MemoryPanel, "settings.section[记忆]");
    }

    exports.name = "dsh-soul-core";
    exports.inject = inject;
    exports.apply = apply;

    module.exports = exports;
    return module.exports;
  },
});

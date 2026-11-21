import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * @yg/dsh-private-stats
 *
 * 把已经存在的两份数据读出来给模型看：
 *   1. ctx.sessionProjections.snapshot(session, ["sessionStats"])
 *      —— 轮数/步数/LLM 耗时/工具耗时/首 token/解码 token（dsh-session-stats 提供）
 *   2. ctx.tokenMeter.measure(session, requestHeader)
 *      —— 当前上下文的 token 估算（dsh-token-meter 提供）
 *
 * 注意 sessionStats **不含输入 token**，只有 decodeTokens（输出侧）。
 * 输入侧只能靠 tokenMeter 的启发式估算（CHARS_PER_TOKEN = 4），所以它叫"估算"。
 *
 * @module @yg/dsh-private-stats
 */

const name = "private-stats";
const inject = ["tools", "sessionProjections", "tokenMeter", "webServer", "sessions"];

const Config = z.object({
  /** 是否在结果里显示分段耗时，默认开 */
  showTimings: z.boolean().default(true),
});

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${rest}s`;
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function apply(ctx, config) {
  /** 把一次 stats 计算抽出来，tool 和 HTTP 端点共用。 */
  async function collect(session) {
    const out = [];
    let turns = 0, steps = 0, decodeTokens = 0, contextTokens = 0;
    let llmMs = 0, toolMs = 0, ttftMs = 0, ttftSteps = 0, decodeMs = 0;
    let usage = null;
    let breakdown = null;

    try {
      const snap = ctx.sessionProjections.snapshot(session, ["sessionStats"]);
      const st = (snap && snap.values && snap.values.sessionStats) || null;
      if (st) {
        turns = st.turns || 0;
        steps = st.steps || 0;
        llmMs = st.llmMs || 0;
        toolMs = st.toolMs || 0;
        ttftMs = st.ttftMs || 0;
        ttftSteps = st.ttftSteps || 0;
        decodeMs = st.decodeMs || 0;
        decodeTokens = st.decodeTokens || 0;
        out.push("会话累计");
        out.push(`  轮数     ${turns}`);
        out.push(`  步数     ${steps}`);
        out.push(`  LLM 耗时 ${fmtMs(llmMs)}`);
        out.push(`  工具耗时 ${fmtMs(toolMs)}`);
        const avgTtft = ttftSteps > 0 ? ttftMs / ttftSteps : 0;
        out.push(`  首 token ${fmtMs(avgTtft)}/步（${ttftSteps} 步有采样）`);
        out.push(`  解码     ${fmtNum(decodeTokens)} tokens / ${fmtMs(decodeMs)}`);
      } else {
        out.push("会话累计：投影里没有 sessionStats（可能刚开没跑过）");
      }
    } catch (e) {
      out.push(`会话累计读取失败: ${e.message}`);
    }

    // ── contextBreakdown 投影：三段构成（system / tools / message）──
    // 这是 TUI 五段 bar 的真实数据源，和 sessionStats 一样是投影。
    // 注意：它的 view 是 `(state) => state.breakdown`，所以 values.contextBreakdown
    // 拿到的**就是** { systemTokens, toolsTokens, messageTokens }，不要再套一层。
    try {
      const bsnap = ctx.sessionProjections.snapshot(session, ["contextBreakdown"]);
      const bd = (bsnap && bsnap.values && bsnap.values.contextBreakdown) || null;
      if (bd && typeof bd.systemTokens === "number") {
        breakdown = {
          systemTokens: Math.round(bd.systemTokens || 0),
          toolsTokens: Math.round(bd.toolsTokens || 0),
          messageTokens: Math.round(bd.messageTokens || 0),
        };
        out.push("");
        out.push("上下文构成");
        out.push(`  system  ${fmtNum(breakdown.systemTokens)}`);
        out.push(`  tools   ${fmtNum(breakdown.toolsTokens)}`);
        out.push(`  message ${fmtNum(breakdown.messageTokens)}`);
      }
    } catch { /* 老版本 Host 没这个投影就算了 */ }

    try {
      let header;
      try { header = session.requestHeader ? session.requestHeader() : undefined; } catch { /* ignore */ }
      const m = await ctx.tokenMeter.measure(session, header);
      const total = m && typeof m.totalTokens === "number" ? m.totalTokens : null;
      const kind = m && m.baseline ? m.baseline.kind : "?";
      const u = m && m.baseline ? m.baseline.usage : null;
      if (u) usage = u;
      if (total !== null) {
        contextTokens = total;
        out.push("");
        out.push("当前上下文");
        const kindText =
          kind === "usage" ? "按上游上报的 usage 计" :
          kind === "estimated" ? "启发式估算（CHARS_PER_TOKEN=4）" :
          kind === "none" ? "空" : kind;
        out.push(`  合计 ${fmtNum(total)} tokens（${kindText}）`);
        if (usage) {
          const parts = [];
          for (const [k, v] of Object.entries(usage)) {
            if (typeof v === "number") parts.push(`${k}=${fmtNum(v)}`);
          }
          if (parts.length) out.push("  usage: " + parts.join("  "));
        }
        if (typeof m.surfaceDeltaTokens === "number" && m.surfaceDeltaTokens > 0) {
          out.push(`  自上次锚点增量 +${fmtNum(m.surfaceDeltaTokens)}`);
        }
      } else {
        out.push("");
        out.push("当前上下文：measure 返回未识别结构");
      }
    } catch (e) {
      out.push(`上下文估算失败: ${e.message}`);
    }

    return { out, turns, steps, contextTokens, decodeTokens, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, usage, breakdown };
  }

  // ── HTTP 端点：给侧栏小卡片用 ──────────────────────────────────
  // GET /private/stats?session=<id>
  // 不传 session 就用最近活跃的那个。
  ctx.webServer.register({
    kind: "exact",
    path: "/private/stats",
    handler: async (req, res) => {
      const send = (code, obj) => {
        if (res.headersSent) return;
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(obj));
      };

      const addr = String((req.socket && req.socket.remoteAddress) || "");
      const loopback =
        addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
      if (!loopback) { send(403, { ok: false, error: "loopback only" }); return; }

      try {
        const url = new URL(req.url || "/", "http://dsh.invalid");
        const sid = url.searchParams.get("session");
        let session = null;
        if (sid) {
          session = ctx.sessions.get(sid) || null;
        } else {
          const all = ctx.sessions.list();
          // 简单取最后一个（最近创建的）
          session = all.length ? all[all.length - 1] : null;
        }
        if (!session) { send(404, { ok: false, error: "找不到会话" }); return; }

        const r = await collect(session);

        let provider = "?", model = "?";
        try {
          const h = session.requestHeader ? session.requestHeader() : null;
          const cfg = (h && h.config) || {};
          provider = cfg.provider || "?";
          model = cfg.model || "?";
        } catch { /* ignore */ }

        // 给 UI 的结构化数据（不用解析文本）
        const u = r.usage || {};
        const cacheRead = Math.round(u.cacheReadTokens || 0);
        const inputTok = Math.round(u.inputTokens || 0);
        const decMs = Math.max(1, Math.round(r.decodeMs));
        // TPS：解码 token / 解码耗时（秒），参考 dsh-TUI 的仪表口径
        const tps = r.decodeTokens > 0 ? +(r.decodeTokens / (decMs / 1000)).toFixed(1) : 0;
        // 缓存命中率：缓存读 / (缓存读 + 新增输入)
        const cacheDenom = cacheRead + inputTok;
        const cacheHitRate = cacheDenom > 0 ? +(cacheRead / cacheDenom * 100).toFixed(1) : 0;

        send(200, {
          ok: true,
          sessionId: session.id || sid || "",
          turns: r.turns,
          steps: r.steps,
          llmMs: Math.round(r.llmMs),
          toolMs: Math.round(r.toolMs),
          ttftMs: Math.round(r.ttftMs),
          ttftSteps: r.ttftSteps,
          decodeMs: decMs,
          decodeTokens: Math.round(r.decodeTokens),
          contextTokens: Math.round(r.contextTokens),
          inputTokens: inputTok,
          outputTokens: Math.round(u.outputTokens || 0),
          cacheReadTokens: cacheRead,
          cacheWriteTokens: Math.round(u.cacheWriteTokens || 0),
          tps,
          cacheHitRate,
          // 三段构成（TUI 五段 bar 的真实数据源）
          breakdown: r.breakdown,
          provider,
          model,
        });
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    },
  });

  // ── 自检端点：确认服务端读到的 client 插件文件是哪一版 ──
  // GET /private/verify
  ctx.webServer.register({
    kind: "exact",
    path: "/private/verify",
    handler: async (req, res) => {
      const send = (code, obj) => {
        if (res.headersSent) return;
        res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(obj, null, 2));
      };
      const addr = String((req.socket && req.socket.remoteAddress) || "");
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr)) { send(403, { ok: false }); return; }

      try {
        const { readFileSync, statSync } = await import("node:fs");
        const p = "C:\\Users\\KonomiHasu\\.dsh\\profiles\\web\\node_modules\\@yg\\dsh-client-ui-private-settings\\lib\\client.js";
        const st = statSync(p);
        const txt = readFileSync(p, "utf8");
        send(200, {
          ok: true,
          processPid: process.pid,
          processStart: process.uptime ? new Date(Date.now() - process.uptime() * 1000).toISOString() : null,
          file: p,
          fileMtime: st.mtime.toISOString(),
          fileBytes: st.size,
          hasV2Marker: txt.includes("lcs-ver"),
          hasFiveSegBar: txt.includes("lcs-cbar"),
          hasConsoleProbe: txt.includes("LCS_VER"),
        });
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    },
  });

  ctx.tools.register(
    defineTool({
      name: "stats",
      description:
        "查看当前会话的用量统计：轮数、步数、LLM/工具耗时、首 token 延迟、解码 token 数、" +
        "以及当前上下文的 token 估算。数据来自 dsh-session-stats 投影和 dsh-token-meter，" +
        "不发起任何模型调用。用于「这个会话用了多少 token」「现在上下文多大」「哪个模型费时」这类问题。",
      parameters: {
        detail: {
          type: "boolean",
          description: "true = 显示分段耗时明细（默认 false，只给汇总）",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            text: { type: "string", required: true },
            turns: { type: "number" },
            steps: { type: "number" },
            contextTokens: { type: "number" },
            decodeTokens: { type: "number" },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.text }],
      },
      async execute(args, exec) {
        const session = exec && exec.agent ? exec.agent.session : null;
        if (!session) {
          return { ok: false, text: "拿不到当前会话（exec.agent.session 为空）" };
        }

        const r = await collect(session);
        const out = [...r.out];

        if (config.showTimings && args.detail) {
          out.push("");
          out.push("明细");
          out.push(`  llmMs=${Math.round(r.llmMs)} toolMs=${Math.round(r.toolMs)} ttftMs=${Math.round(r.ttftMs)} decodeMs=${Math.round(r.decodeMs)}`);
        }

        try {
          const h = session.requestHeader ? session.requestHeader() : null;
          const cfg = (h && h.config) || {};
          const provider = cfg.provider || (exec.agent.options && exec.agent.options.provider) || "?";
          const model = cfg.model || (exec.agent.options && exec.agent.options.model) || "?";
          out.push("");
          out.push(`模型  ${provider}/${model}`);
        } catch { /* 拿不到就算了 */ }

        if (!out.length) out.push("没有可显示的统计");
        return {
          ok: true,
          text: out.join("\n"),
          turns: r.turns,
          steps: r.steps,
          contextTokens: r.contextTokens,
          decodeTokens: r.decodeTokens,
        };
      },
      presentCall: () => ({
        card: "generic",
        title: "stats",
        kind: "read",
        rawInput: "会话用量",
      }),
    }),
  );
}

export { Config, apply, inject, name };

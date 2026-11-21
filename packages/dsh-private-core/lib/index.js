import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * @yg/dsh-private-core
 *
 * Private fork layer. Two responsibilities:
 *   1. own prompt sections the official packages do not ship (private SOP)
 *   2. register private tools the model can call
 *
 * Identity takeover lives in ./cordis.patch.yml, because config patches replace
 * a row's whole `config` and are reviewable without JS.
 *
 * @module @yg/dsh-private-core
 */

/** Cordis plugin name. */
const name = "private-core";

/**
 * Services this row consumes.
 *
 * `workingDirectory` is required: the workspace root of a call comes from
 * `ctx.workingDirectory.ensure(agent, signal)`, NOT from a property chain on
 * `exec.agent`. `@deepseek-ai/dsh-tool-fs` computes its own cwd this exact way
 * (lib/index.js sessionResolveOptions) but does not export that helper, so the
 * service is the only correct public seam.
 */
const inject = ["tools", "systemPrompt", "workingDirectory"];

/**
 * Runtime schema; every key has a default so the row can be mounted bare.
 *
 * houseRulesOrder default 9500: SECTION_ORDERS puts DELIVERABLE_FILE_REFERENCES
 * at 9000 and STRUCTURED_OUTPUT at 9900, so 9500 is an unoccupied slot between
 * them — after all tool guidance blocks (max 5000-3100), before deliverable
 * refs and structured output.
 */
const Config = z.object({
  operatorName: z.string().default("YG"),
  /** Extra house rules appended to the prompt. Empty string disables the section. */
  houseRules: z.string().default(""),
  /** Section order; see the SECTION_ORDERS note above. */
  houseRulesOrder: z.number().default(9500),
  /** Notebook path, relative to the session working directory. */
  notebookPath: z.string().default(".yg-private/notes.md"),
  /**
   * 后台 spawn 子代理默认路由（解决 Gemini 主会话未显式传 provider/model 时默认继承 Gemini 慢且贵的问题）。
   * 仅当 provider === "spawn" 且未显式传 agentOptions.provider/model 时生效；
   * subagent_fork (provider === "fork") 不改，避免打穿父会话 KV Cache。
   */
  spawnDefaultProvider: z.string().default("deepseek-account"),
  spawnDefaultModel: z.string().default("deepseek-flash"),
  spawnDefaultEffort: z.string().default("high"),
  spawnDefaultEnabled: z.boolean().default(true),
});

/**
 * Mount the private layer.
 * @param ctx - registrant context carrying the tool, prompt, and cwd services.
 * @param config - this deployment's private parameters.
 */
function apply(ctx, config) {
  const operator = config.operatorName;

  // ── private prompt section ────────────────────────────────────────────
  if (config.houseRules.trim().length > 0) {
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: "private:house-rules",
          order: config.houseRulesOrder,
          text: config.houseRules.trim(),
        }),
      "private-core.houseRules()",
    );
  }

  // ── private tool: durable notebook ────────────────────────────────────
  // Appends into the session working directory so notes survive compaction,
  // session rewind, and a model swap. Read back with the ordinary fs tools.
  //
  // No ctx.effect wrapper here: `ctx.tools.register` is the registry's own
  // disposal seam (dsh-tool-todo registers the same bare way), so wrapping it
  // would double-dispose on reload.
  ctx.tools.register(
    defineTool({
      name: "yg_note",
      description:
        `Append a durable note to ${config.notebookPath} in the session working directory. ` +
        `Use for facts that must survive context compaction: decisions, credential locations, ` +
        `open threads, standing preferences. One line per call, timestamped.`,
      parameters: {
        text: {
          type: "string",
          required: true,
          description: "The note body. One line, no newlines required.",
        },
        tag: {
          type: "string",
          description: "Optional short tag, e.g. decision | preference | credential | todo.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            line: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: `Noted → ${value.path}` }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error("yg_note requires an owning agent session");
        }

        // Resolve the session working directory through its owning service.
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
        const root = resolve(cwd ?? process.cwd());
        const path = resolve(root, config.notebookPath);

        // A patch layer can set notebookPath to anything, including "../../".
        // Contain it: a tool must not be a write primitive outside the workspace.
        const rel = relative(root, path);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error(
            `notebookPath escapes the workspace: ${JSON.stringify(config.notebookPath)}`,
          );
        }

        const stamp = new Date().toISOString();
        const tag = args.tag ? `[${args.tag}] ` : "";
        const line = `- ${stamp} ${tag}${args.text.replace(/\r?\n/g, " ")}`;

        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${line}\n`, { encoding: "utf8", signal: exec.signal });

        return { path, line };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Note to ${operator}`,
        kind: "other",
        rawInput: args.text,
      }),
    }),
  );

  // ── 代码级 spawn 子代理默认路由 ──────────────────────────────────────
  // 不改原厂 preset-cordis.config.plugins 数组（避免覆盖丢掉工具和 dsh-purge），
  // 通过包装 ctx.subagents.startActivation 在未显式指定模型时补默认路由。
  if (config.spawnDefaultEnabled && config.spawnDefaultProvider && config.spawnDefaultModel) {
    ctx.inject(["subagents"], (sCtx) => {
      const subagents = sCtx.subagents;
      if (!subagents || typeof subagents.startActivation !== "function") return;
      const origStart = subagents.startActivation;

      const wrappedStart = async function (spec) {
        let nextSpec = spec;
        try {
          const req = spec?.request;
          const opts = req?.agentOptions;
          const hasExplicitRoute = Boolean(opts?.provider || opts?.model);

          if (spec?.provider === "spawn" && req && !hasExplicitRoute) {
            const candidate = {
              provider: config.spawnDefaultProvider,
              model: config.spawnDefaultModel,
              ...(config.spawnDefaultEffort ? { reasoningEffort: config.spawnDefaultEffort } : {}),
            };
            let routeValid = true;
            const llm = sCtx.get("llm") ?? ctx.get("llm");
            if (llm && typeof llm.resolveCallConfig === "function") {
              try {
                await llm.resolveCallConfig(candidate, spec.signal);
              } catch (err) {
                routeValid = false;
                console.warn(
                  `[private-core] spawn 默认路由 ${candidate.provider}/${candidate.model} 校验未过，回退原路由: ${err?.message || err}`,
                );
              }
            }
            if (routeValid) {
              nextSpec = {
                ...spec,
                request: {
                  ...req,
                  agentOptions: {
                    ...(opts || {}),
                    ...candidate,
                  },
                },
              };
            }
          }
        } catch (err) {
          console.warn(`[private-core] spawn 默认路由构造异常，回退原参数: ${err?.message || err}`);
          nextSpec = spec;
        }
        // origStart 放在 try 外面：一旦调用真实 spawn，抛错必须原样上抛，绝不二次重试造成重复派发
        return await origStart.call(this, nextSpec);
      };

      sCtx.effect(
        () => {
          subagents.startActivation = wrappedStart;
          return () => {
            if (subagents.startActivation === wrappedStart) {
              subagents.startActivation = origStart;
            }
          };
        },
        "private-core.spawnDefaultRoute()",
      );
    });
  }
}

export { Config, apply, inject, name };

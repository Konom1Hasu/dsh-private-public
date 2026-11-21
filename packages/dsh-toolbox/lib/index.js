import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * @yg/dsh-toolbox — 工具网关
 *
 * 问题：工具定义每步随请求全量发出，200~400 tokens/个。四十个工具就是两三万，
 * 而其中大半九成时间用不上。
 *
 * 做法：用 ctx.tools.restrict({ deny }) 把「重的组」从模型视野里挡掉。
 * 工具本身仍在注册表里（插件照常加载），只是不出现在 schemas() 投影里，
 * 也就不占工具表。需要时调用本工具 open，下一步的 assembly 重新投影就能看见。
 *
 * 依据（都写在 dsh 的 d.ts 里，不是猜的）：
 *   - tools.restrict(filter) 对调用方 scope 过滤全局工具，返回撤销器；多个限制取交集
 *   - tools.schemas(scope) 只投影「可见」的工具
 *   - 'tools/change' 事件在注册/注销/限制变化时发出，注释原文：
 *     "a global change concerns every agent's next assembly"
 *   - agent-loop 每 step 从 decision.assembly 取工具表，并有 toolsChanged() 比较
 *
 * 已知边界：
 *   - 打开/关闭是进程级的，影响本 profile 的所有会话（单用户环境下可接受）
 *   - 重启后回到 config 里的默认开关状态
 *   - restrict 传未注册的工具名会失败，所以 sync() 只 deny 实际存在的名字，
 *     并监听 tools/change 在工具晚注册时补上
 */

export const name = "dsh-toolbox";
export const inject = ["tools"];

export const Config = z.object({
  groups: z
    .array(
      z.object({
        name: z.string().required(),
        title: z.string().default(""),
        tools: z.array(z.string()).default([]),
        open: z.boolean().default(false),
      }),
    )
    .default([]),
});

export function apply(ctx, config) {
  const groups = (config.groups || []).map((g) => ({
    name: g.name,
    title: g.title || "",
    tools: [...(g.tools || [])],
    open: g.open === true,
  }));
  if (!groups.length) return;

  /** name -> { open, dispose, key } */
  const state = new Map();
  for (const g of groups) state.set(g.name, { open: g.open, dispose: null, key: "" });

  const visible = () => {
    try {
      return new Set(ctx.tools.schemas().map((s) => s.name));
    } catch {
      return new Set();
    }
  };

  function sync() {
    const names = visible();
    for (const g of groups) {
      const st = state.get(g.name);
      const present = g.tools.filter((n) => names.has(n));
      const key = `${st.open ? 1 : 0}:${present.join(",")}`;
      if (key === st.key) continue; // 没有变化，别反复重建限制
      st.key = key;
      try {
        st.dispose?.();
      } catch {
        /* 旧限制可能已被别处撤掉 */
      }
      st.dispose = null;
      if (!present.length || st.open) continue;
      try {
        st.dispose = ctx.tools.restrict({ deny: present });
      } catch {
        st.dispose = null;
      }
    }
  }

  sync();
  try {
    ctx.on("tools/change", () => {
      try {
        sync();
      } catch {
        /* 事件期间不能抛 */
      }
    });
  } catch {
    /* 没有事件绑定能力时退化成启动时同步一次 */
  }

  function report() {
    const names = visible();
    return groups
      .map((g) => {
        const st = state.get(g.name);
        const present = g.tools.filter((n) => names.has(n)).length;
        const flag = st.open ? "○ 已打开" : "● 已隐藏";
        return `${flag}  ${g.name}${g.title ? `（${g.title}）` : ""}  ${present}/${g.tools.length} 个已注册`;
      })
      .join("\n");
  }

  ctx.tools.register(
    defineTool({
      name: "toolbox",
      description:
        "按需开关工具组。重的工具组平时是隐藏的——模型看不见、不占工具表；需要时 open 打开，" +
        "下一步即可调用。action=list 看有哪些组，open/close 开关一组（group 填组名）。" +
        "用户让你处理视频、音频、图片、幻灯片这类平时用不到的能力时，先 list 再 open。",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "open", "close"],
          description: "list 查看；open 打开一组；close 关闭一组",
        },
        group: { type: "string", description: "组名，list 的输出里能看到" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            ok: { type: "boolean", required: true },
            text: { type: "string", required: true },
          },
        },
        render: (_a, v) => [{ type: "text", text: v.text }],
      },
      async execute(args) {
        const act = String(args.action || "list");
        if (act === "list") {
          return { ok: true, text: `${report()}\n\n打开后下一步生效；关闭立刻生效。重启回到默认状态。` };
        }
        const g = groups.find((x) => x.name === args.group);
        if (!g) {
          return {
            ok: false,
            text: `没有 "${args.group || "(空)"}" 这一组。现有：${groups.map((x) => x.name).join("、")}`,
          };
        }
        const st = state.get(g.name);
        st.open = act === "open";
        sync();
        return { ok: true, text: `toolbox: ${g.name} → ${st.open ? "打开" : "关闭"}\n\n${report()}` };
      },
      presentCall: (a) => ({
        card: "generic",
        title: "toolbox",
        kind: "read",
        rawInput: `${a.action || "list"}${a.group ? " " + a.group : ""}`,
      }),
    }),
  );
}

你是 Argon，独立技术审核方。任务：对抗性审核下面这套 DeepSeek Harness (dsh) 私有化方案与骨架代码，专门找错，不做捧场，不复述我的方案。

# 已核实的机制（作为你推理的公理，来自真实源码阅读）

1. 一个 profile 目录 = `package.json`（含 `dsh.profile.bundles` 数组）+ 同目录 `cordis.patch.yml`。
2. 配置树 = 空根 → 各 bundle 的 `dsh.bundle.patch` 文件按序叠加 → `profile/cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → 命令行 `--patch`。
3. patch 文件是一个顶层 YAML 数组，条目形状：`{id, name, config, disabled}` 或 `{insert: [行...]}`；值支持 `!!js` 表达式（例：`disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`）。
4. **一条 patch 整体替换目标行的 `config`，不深合并**：未重述的键回落该插件 schema 默认值。
5. 插件 = ESM 模块，具名导出 `name`（字符串）、`inject`（服务名数组）、`Config`（schemastery schema）、`apply(ctx, config)`。
6. 工具注册 = `ctx.tools.register(defineTool({ name, description, parameters, output, execute, presentCall }))`。
7. 提示词 = `ctx.systemPrompt.section({ name, order, text })`；`order` 为有限数，相等时按 name 字典序；`complete: true` 可整份接管；`ctx.systemPrompt.getSectionOrder('NAME')` 取内部中央分配位。
8. 身份接管官方开关在 `system-prompt` 行：`includeHarnessIdentity` / `includeRuntimeContext` / `personaPrefix`（order 0） / `personaSuffix`（order 10200） / `toolOrder`。
9. 工具 `execute(args, exec)` 的第二参类型为 `ToolExecution`，已知字段：`readonly callId`、`readonly name`、`readonly arguments`、`readonly agent?: Agent`、`readonly signal: AbortSignal`、`readonly token`、`deferContext()`、以及 `ToolRunContext` 上的 `concludesTurn` 标记。另存在 `sessionResolveOptions(ctx, exec) => Promise<{cwd?, signal?}>`，用于解析本次调用的工作目录。**`Agent` 接口的具体字段我未读到**。

# 骨架代码（待审）

## 文件 1：packages/dsh-private-core/package.json

```json
{
  "name": "@yg/dsh-private-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "files": ["lib/index.js", "cordis.patch.yml"],
  "engines": { "dsh": "0.2.1-rc.2" },
  "dsh": { "bundle": { "patch": ["./cordis.patch.yml"] } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.5",
    "@deepseek-ai/dsh-system-prompt": "0.2.1-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.1-rc.2",
    "@deepseek-ai/schemastery": "~3.18.5"
  }
}
```

## 文件 2：packages/dsh-private-core/cordis.patch.yml（节选，去掉注释）

```yaml
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: true
    personaPrefix: |-
      你是 YG 的私有部署实例……（多行私有规则）
    personaSuffix: "Your working directory is provided by the session runtime context."

- insert:
    - id: private-core
      name: '@yg/dsh-private-core'
      config:
        operatorName: YG
        houseRules: ''
        houseRulesOrder: 9000
        notebookPath: .yg-private/notes.md
```

## 文件 3：packages/dsh-private-core/lib/index.js（核心部分）

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const name = "private-core";
const inject = ["tools", "systemPrompt"];

const Config = z.object({
  operatorName: z.string().default("YG"),
  houseRules: z.string().default(""),
  houseRulesOrder: z.number().default(9000),
  notebookPath: z.string().default(".yg-private/notes.md"),
});

function apply(ctx, config) {
  if (config.houseRules.trim().length > 0) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: "private:house-rules",
      order: config.houseRulesOrder,
      text: config.houseRules.trim(),
    }), "private-core.houseRules()");
  }

  ctx.tools.register(defineTool({
    name: "yg_note",
    description: "Append a durable note to the workspace notebook...",
    parameters: {
      text: { type: "string", required: true, description: "The note body." },
      tag:  { type: "string", required: false, description: "Optional tag." },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: { path: { type: "string", required: true }, line: { type: "string", required: true } },
      },
      render: (_args, value) => [{ type: "text", text: `Noted → ${value.path}` }],
    },
    async execute(args, exec) {
      const root = exec.agent?.session?.workspace?.root ?? process.cwd();
      const path = join(root, config.notebookPath);
      const stamp = new Date().toISOString();
      const tag = args.tag ? `[${args.tag}] ` : "";
      const line = `- ${stamp} ${tag}${args.text.replace(/\r?\n/g, " ")}`;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${line}\n`, "utf8");
      return { path, line };
    },
    presentCall: (args) => ({ card: "generic", title: "Note", kind: "other", rawInput: args.text }),
  }));
}

export { Config, apply, inject, name };
```

# 请审核（按此顺序输出）

## A. 致命问题
会导致加载失败或运行崩溃的。逐条给：错在哪 → 为什么 → 正确写法。

## B. 语义错误
不崩溃但行为与意图不符。特别看：
- patch 整体替换 config 的规则下，我上面 `system-prompt` 那条会不会把官方默认键写残（我漏了哪些键？）
- `houseRules: ''` 与 `if (config.houseRules.trim().length > 0)` 的组合在热重载时是否有坑
- `order: 9000` 与官方 section（order 0 / 10200 / 内部 getSectionOrder 分配的位）是否会撞

## C. API 误用
- `exec.agent?.session?.workspace?.root` 这条取值链：基于我给的类型信息判断是否可能存在。若不存在，给出基于 `sessionResolveOptions` 或其他已知 API 的正确替代，并说明为什么那样更稳。
- `parameters` 里 `required: true/false` 的写法：注意 `required: false` 与"省略该键"语义是否等价，哪个更安全。
- `output.render` 返回 `[{type:'text',text}]` 是否是合法 ContentBlock 形状。
- `presentCall` 里 `card:'generic'`、`kind:'other'` 是否有枚举风险。
- `ctx.tools.register` 不包 `ctx.effect` 时，插件 dispose 后工具会不会残留。给判断依据。

## D. 架构漏洞
作为"私有化系统"，这套分层还缺什么维度？至少覆盖：凭据与密钥、多用户/对外服务鉴权、会话数据归属与迁移、插件来源可信（私有 registry）、上游升级后的漂移检测、审计日志。指出哪些层我不该用 patch 层实现而必须写 host 侧代码，并说明判断标准。

## E. 修正清单
只列必须改的行，用 diff 风格，不要重贴整个文件。

约束：不要客套，不要总结我的方案，不要给"建议进一步考虑"这种空话。每条结论必须能落到具体的行或具体的键。不确定的标【存疑】并给验证命令。

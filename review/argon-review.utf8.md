## A. 致命问题

1. **`output.schema` 违反 JSON Schema 标准导致校验器崩溃或被 LLM 网关拒绝**
   - **错在哪**：`lib/index.js` 第 30 行 `properties: { path: { type: "string", required: true }, line: { type: "string", required: true } }`。
   - **为什么**：在标准 JSON Schema (Draft-07/2020-12) 中，对象层级的 `required` 必须是字符串数组（`required: ["path", "line"]`）。属性内部写 `required: true` 仅是 `dsh-tools` 为顶层 `parameters` 提供的语法糖转换；`output.schema` 直接暴露给底层 schema 校验器或结构化输出 API，布尔类型的 `required` 会直接引发 schema 编译异常。
   - **正确写法**：将 `required: ["path", "line"]` 移至 `type: "object"` 同级，删除属性内的 `required: true`。

2. **`execute` 存在任意文件写入（路径穿越）与信号忽略漏洞**
   - **错在哪**：`lib/index.js` 第 35-42 行 `join(root, config.notebookPath)` 与 `appendFile(...)`。
   - **为什么**：① `join('/workspace', '../../../etc/cron.d/pwn')` 在 Node.js 中会合法解析出工作区外部路径。若上游 `$DSH_HOME/cordis.patch.yml` 或 CLI `--patch` 被注入恶意 `notebookPath`，即刻演变为宿主机任意文件追加。② 未向 `appendFile` 传递 `exec.signal`，当会话中止或超时（AbortSignal 触发）时，挂起的磁盘/网络挂载点 I/O 无法取消，导致进程句柄泄漏。
   - **正确写法**：使用 `resolve(root, config.notebookPath)` 并用 `relative(root, target)` 校验不以 `..` 开头且非绝对路径；在 `appendFile(path, ..., { encoding: "utf8", signal: exec.signal })` 中传入信号。

---

## B. 语义错误

1. **`system-prompt` 的 patch 导致官方非默认配置被洗白**
   - **问题定位**：`cordis.patch.yml` 第 1-8 行。
   - **机制推演**：根据公理 4（整体替换不深合并），你覆写了 `id: system-prompt` 的 `config`。虽然公理 8 中列出的 `toolOrder` 未重述时会回落到插件自身的 Schema 默认值，但**排在你之前的底层 bundle（如官方 base bundle）在 `cordis.patch.yml` 中对 `system-prompt` 设定的任何非默认配置（例如定制的 `toolOrder` 或其他未在你公理 8 列出但存在于官方配置中的键）会被你的 patch 彻底抹除**，回退为代码硬编码默认值。
   - **【存疑】验证命令**：检查官方底座 bundle 对 `system-prompt` 实际注入了哪些键：
     `node -e "import('@deepseek-ai/dsh-system-prompt').then(m => console.dir(m.Config, {depth: null}))"`

2. **`houseRules` 热重载静默失效（实际上是无动作，但若移除 `if` 会有空行污染）**
   - **问题定位**：`cordis.patch.yml` 第 15 行 与 `lib/index.js` 第 16 行。
   - **机制推演**：在 Cordis 中，当上游通过 `$DSH_HOME/cordis.patch.yml` 覆写 `houseRules: "新规则"` 时，Cordis 会先执行当前插件实例的 `dispose`（清理全部 `ctx.effect`），再用新 config 重新调用 `apply(ctx, config)`。因此 `if (config.houseRules.trim().length > 0)` 在热重载切换时**不会**导致旧规则残留。**真正的语义错误在于**：你在 `cordis.patch.yml` 显式写了 `houseRules: ''`，根据公理 4，若用户在某个前置 bundle 里配了 `houseRules`，你的 bundle 叠加时会将其强行清空。既然 Schema 已有 `.default("")`，patch 文件中绝不应写出空值占位符。

3. **`order: 9000` 处于盲猜区间，破坏提示词结构拓扑**
   - **问题定位**：`lib/index.js` 第 11 行 `houseRulesOrder: z.number().default(9000)`。
   - **机制推演**：已知 `personaPrefix` 为 0，`personaSuffix` 为 10200。0 到 10200 之间分布着由 `ctx.systemPrompt.getSectionOrder('NAME')` 中央分配的官方核心段落（如工具指令、环境上下文、安全边界）。硬编码 `9000` 既可能插在某个强关联段落中间截断语义，也可能在未来版本官方调整中央分配表时与内置段发生碰撞（同 order 按 name 字典序 `private:house-rules` 排在 `p` 字母位）。
   - **修复语义**：废除硬编码数字，使用 `ctx.systemPrompt.getSectionOrder(...)` 获取锚点后做相对偏移（如 `+ 10`），或直接锚定在 `10199`（紧贴 `personaSuffix` 之前）。

---

## C. API 误用

1. **`exec.agent?.session?.workspace?.root` 属于臆造取值链**
   - **判断**：公理 9 明确 `Agent` 接口字段未知，且系统专门提供了 `sessionResolveOptions(ctx, exec) => Promise<{cwd?, signal?}>`。这直接证明工作目录**不应该**也不保证能从 `exec.agent` 同步属性链上硬取（在远程沙箱、多租户或无状态执行器下，`agent` 对象上根本不会挂载本地 `workspace.root`）。 Since `exec.agent` 链条极可能为 `undefined`，你的代码会静默回退到 `process.cwd()`（即宿主机启动目录而非会话工作区），导致笔记写串目录。
   - **正确替代**：从 `@deepseek-ai/dsh-tools` 导入 `sessionResolveOptions`，在 `execute` 中调用：
     ```js
     const { cwd = process.cwd(), signal } = await sessionResolveOptions(ctx, exec);
     ```
     这既统一了 cwd 解析契约，又顺带获取了合并后的 `signal`。

2. **`parameters` 中 `required: false` 的冗余风险**
   - **判断**：在 `dsh-tools` 的参数转换器中，`required: false` 与省略该键在转换结果上等价（均不进入 JSON Schema 的 `required: []` 数组）。但**省略该键更安全**。原因：部分版本的内部类型推导（TypeScript Def / 运行时校验器）仅对 `required: true` 做字面量窄化，显式写 `required: false` 可能触发不必要的联合类型分支或严格 schema 校验警告。

3. **`output.render` 返回值形状**
   - **判断**：`[{ type: "text", text: ... }]` 是合法的 MCP / DSH 标准 `ContentBlock[]` 形状。但缺少对 `value` 的防御性格式化，当前写法在接口层面合规。

4. **`presentCall` 中 `card: 'generic'` 与 `kind: 'other'` 的枚举风险**
   - **判断**：高风险。UI 渲染层（尤其是 desktop profile）对 `card` 和 `kind` 使用严格受限的联合类型分发组件（如 `kind: 'read' | 'edit' | 'execute'` 等）。传入未注册的枚举值会导致前端渲染回退失败或抛出未知组件警告。
   - **【存疑】验证命令**：提取 `@deepseek-ai/dsh-tools` 中 `presentCall` 的真实类型定义：
     `grep -rn "presentCall" node_modules/@deepseek-ai/dsh-tools/`

5. **`ctx.tools.register` 不包 `ctx.effect` 是否会残留**
   - **判断**：**取决于 `ctx.tools.register` 的内部实现是否绑定了当前插件的 `ctx` 生命周期**。在 Cordis (v4) 架构中，标准的做法是服务方法内部调用 `this.ctx.effect(...)` 并返回 `dispose` 函数。但如果 `dsh-tools` 的 `register` 仅往全局 Map 塞入工具并返回清理函数（`() => void`），而不自己挂钩调用方 `ctx.effect`，那么插件卸载/热重载时工具必然残留，且再次加载会报重名工具冲突。对比你在第 17 行对 `ctx.systemPrompt.section` 显式包裹了 `ctx.effect`，第 24 行的 `ctx.tools.register` 却裸调，逻辑自相矛盾。
   - **稳妥写法**：如果 `register` 返回清理函数，直接写 `ctx.effect(() => ctx.tools.register(...))`；如果 `register` 内部已挂钩 `ctx`，需验证源码：
     `node -e "import('@deepseek-ai/dsh-tools').then(m => console.log(m.ToolsService?.prototype?.register?.toString()))"`

---

## D. 架构漏洞

**判断标准（Patch 层 vs Host 侧代码）**：
凡是**处于 Cordis `ctx` 容器内部、可被后续 patch 层（`$DSH_HOME/cordis.patch.yml` 或 CLI `--patch`）覆写或通过 `!!js` 访问**的逻辑，均属于**非授信配置面**。任何涉及安全边界、多租户隔离、计费审计、密钥分发的机制，**严禁**在 patch 层实现，必须下沉到拉起 Cordis 实例的 **Host 引导层（Bootstrapper）** 或 **独立网关进程**。

| 缺失维度 | 架构漏洞分析 | 归属层（Patch vs Host） | 理由与实现边界 |
| :--- | :--- | :--- | :--- |
| **1. 凭据与密钥** | YAML 支持 `!!js` 表达式（公理 3）。若将 API Key / 内部 DB 凭据放进 config 或环境变量，任何能注入 `--patch` 或修改 `$DSH_HOME` 的用户只需写 `!!js "process.env"` 或 `!!js "ctx.get('...')"` 即可瞬间窃取全部明文密钥。 | **Host 侧（强隔离）** | 密钥不得进入进程 `process.env` 和 Cordis `config` 树。Host 侧应通过外部 KMS/代理网关拦截出站请求注入凭据，或在 Host 初始化时通过 Closure 私有引用注入底层 HTTP Client，对外不暴露 `ctx` 服务属性。 |
| **2. 多用户/对外鉴权** | `dsh` 自身是单会话/本地 Harness 模型。若直接将其暴露为对外服务，缺少请求级身份绑定，多个用户会共享同一个 `ctx` 插件树与内存状态。 | **Host 侧（网关层）** | 必须在 Host 外围建鉴权网关（JWT/mTLS），由 Host 为每个租户/会话派生独立的 Worker 进程或隔离的沙箱容器，绝不能靠写一个 Cordis 插件来做鉴权拦截。 |
| **3. 会话数据归属与迁移** | 你的 `yg_note` 将数据直接写死在本地工作区 `.yg-private/notes.md`。容器销毁或跨节点迁移时数据即刻丢失，且污染用户的 Git 工作区。 | **Host 侧抽象 + 插件消费** | 插件不该直接调 `node:fs` 写死相对路径。Host 侧应提供挂载了对象存储/数据库的 `StorageService`（绑定 UserID/SessionID），插件通过 `inject: ['storage']` 写入远端持久化层。 |
| **4. 插件来源可信** | `package.json` 依赖 `@deepseek-ai/*` 的 `0.2.1-rc.2` 与 `~4.0.5` 浮动版本，无完整性锁死。私有化部署在无外网或遭受供应链投毒时会崩溃或被植入后门。 | **Host / 基础设施侧** | 必须部署私有 NPM Registry（如 Verdaccio/Nexus），配置 `.npmrc` 强制走内网源，启用 `package-lock.json` / `pnpm-lock.yaml` 并在 CI 中执行 `--frozen-lockfile` 与 tarball SHA-512 校验。 |
| **5. 上游升级漂移检测** | 公理 4 表明 patch 是全量替换。当上游 `@deepseek-ai/dsh-system-prompt` 升级到 `0.2.2` 新增了关键安全配置键，你的静态 `cordis.patch.yml` 不会感知，也不会报错，而是静默使用默认值或洗掉上游基础 bundle 的新配置。 | **Host / CI 侧** | 编写自动化 Schema 漂移检测脚本（CI 阶段）：提取上游新版本所有插件的 `Config` Schema AST 与官方 base patch，跟私有化 patch 做 diff，发现新增键或默认值变更直接阻断构建。 |
| **6. 审计日志** | 工具执行（如 `yg_note` 或 Shell 执行）无不可篡改的外部审计轨迹。若把日志做成普通 Cordis 插件，攻击者可通过高优先级 `--patch` 设置 `disabled: true` 直接关闭审计插件。 | **Host 侧（不可旁路）** | 审计钩子必须在 Host 实例化 Cordis 根上下文时硬编码注入（或通过只读 Hook 拦截 `tools` 服务的底层调用），且禁止配置层通过 `id` 定位并设置 `disabled: true`。 |

---

## E. 修正清单

### 文件 2：`packages/dsh-private-core/cordis.patch.yml`

```diff
     - id: private-core
       name: '@yg/dsh-private-core'
       config:
         operatorName: YG
-        houseRules: ''
-        houseRulesOrder: 9000
         notebookPath: .yg-private/notes.md
```

### 文件 3：`packages/dsh-private-core/lib/index.js`

```diff
 import z from "@deepseek-ai/schemastery";
-import { defineTool } from "@deepseek-ai/dsh-tools";
+import { defineTool, sessionResolveOptions } from "@deepseek-ai/dsh-tools";
 import { appendFile, mkdir } from "node:fs/promises";
-import { dirname, join } from "node:path";
+import { dirname, isAbsolute, relative, resolve } from "node:path";

 const name = "private-core";
@@ -21,25 +21,31 @@ function apply(ctx, config) {
-  ctx.tools.register(defineTool({
+  ctx.effect(() => ctx.tools.register(defineTool({
     name: "yg_note",
     description: "Append a durable note to the workspace notebook...",
     parameters: {
       text: { type: "string", required: true, description: "The note body." },
-      tag:  { type: "string", required: false, description: "Optional tag." },
+      tag:  { type: "string", description: "Optional tag." },
     },
     output: {
       schema: {
         type: "object", additionalProperties: false,
-        properties: { path: { type: "string", required: true }, line: { type: "string", required: true } },
+        required: ["path", "line"],
+        properties: { path: { type: "string" }, line: { type: "string" } },
       },
       render: (_args, value) => [{ type: "text", text: `Noted → ${value.path}` }],
     },
     async execute(args, exec) {
-      const root = exec.agent?.session?.workspace?.root ?? process.cwd();
-      const path = join(root, config.notebookPath);
+      const { cwd = process.cwd(), signal = exec.signal } = await sessionResolveOptions(ctx, exec);
+      const root = resolve(cwd);
+      const path = resolve(root, config.notebookPath);
+      const rel = relative(root, path);
+      if (rel.startsWith("..") || isAbsolute(rel)) {
+        throw new Error(`Invalid notebookPath outside workspace: ${config.notebookPath}`);
+      }
       const stamp = new Date().toISOString();
       const tag = args.tag ? `[${args.tag}] ` : "";
       const line = `- ${stamp} ${tag}${args.text.replace(/\r?\n/g, " ")}`;
       await mkdir(dirname(path), { recursive: true });
-      await appendFile(path, `${line}\n`, "utf8");
+      await appendFile(path, `${line}\n`, { encoding: "utf8", signal });
       return { path, line };
     },
     presentCall: (args) => ({ card: "generic", title: "Note", kind: "other", rawInput: args.text }),
-  }));
+  })), "private-core.yg_note()");
 }
```

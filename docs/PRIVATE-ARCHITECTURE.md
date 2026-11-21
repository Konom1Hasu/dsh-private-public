# dsh 私有化技术文档

> 目标：把本地 DeepSeek Harness 改造成一套自有系统，且在上游升级时改造不丢。
> 基线：`@deepseek-ai/dsh` 0.2.1-rc.2 ｜ 编写 2026-11-12 ｜ 基线数据取自同日 `--dump-config` 实测
> 审核：Gemini Argon（`gemini-4-argon`）+ 源码级 Argon（子代理逐行核对）+ 作者源码实测

---

## 0 阅读约定

### 0.1 证据等级

全文每个结论都带标记，不要混读：

| 标记 | 含义 | 可信度 |
|---|---|---|
| 【实测】 | 我在本机跑过命令并拿到输出，附关键数据 | 可直接依赖 |
| 【源码】 | 读了安装目录实现，附 `文件:行号` | 可直接依赖 |
| 【推断】 | 从源码推出，未运行验证 | 当假设用 |
| 【未验证】 | 尚未确认，附验证方法 | 不要当结论 |

### 0.2 三条铁律

1. **关于 dsh 行为的断言，只有两种合法来源**：读源码拿 `文件:行号`，或跑命令拿输出。其余一律标【推断】。
   —— 这条来自本次双审的教训：Gemini Argon 7 条技术判断错 4 条，错法全是"套通用规范而不读仓库实现"。
2. **改完必须 `--dump-config`**。patch 未命中只 warn 不报错（`dsh-app-boot:97`），启动成功不代表改对了。
3. **区分"写了"和"生效了"**。没拿到验证输出，就只能说"写入了，未验证"。

---

## 1 环境盘点【实测】

| 项 | 值 |
|---|---|
| dsh 版本 | 0.2.1-rc.2 |
| CLI 安装根 | `C:\Users\KonomiHasu\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| Home | `C:\Users\KonomiHasu\.dsh` |
| 活动 profile | `web`（GUI `http://127.0.0.1:3080`） |
| 组合后配置树 | 104,168 字节 / 1393 行（含 warn 输出） |
| 配置条目 | 202 个 id（含嵌套） |
| 已禁用条目 | 33 个 |
| 工具类插件 | 74 个（`name: '@deepseek-ai/dsh-tool-*'` 计数） |
| 第三方 bundle | 11 个（dshmarket / dsh-purge / dsh-wechat / dsh-ppt / modlens / wallpaper-engine / session-mention / prompt-setting / whale-widget-bowl 等） |
| 已改宿主文件 | **是** —— `dsh-purge` patch 了多个 `@deepseek-ai/dsh-*` 的 `lib/*.js`，留 `.dshpurge.bak` |

### 1.1 dsh-purge 已造成的既成变更【源码】

diff `dsh-system-prompt/lib/index.js` 与其 `.dshpurge.bak`：

| 上游原值 | 本机现值 |
|---|---|
| `includeHarnessIdentity: z.boolean().default(true)` | `default(false)` |
| identity section `text: "You are an AI agent powered by DeepSeek Harness."` | `text: ""`（注释 `[dsh-purge] identity stripped`） |
| `section.text` 直接取用 | 增加 `typeof text === "string"` 防御 |
| 装配时 `filter(t => t.length > 0)` | 增加 undefined 段文本守卫 |

**推论【源码】**：在本机写 `includeHarnessIdentity: false` 是幂等确认——官方开场早已被剥离，不是"摘掉"。

**风险【推断】**：这些 patch 活在 `node_modules` 里。`npm i -g @deepseek-ai/dsh` 升级时文件被整体替换，purge 补丁全部消失，人格基线静默回退到上游状态。这是三个独立漂移源之一（见 §8）。

### 1.2 当前生效的身份配置【实测】

`--dump-config` 里 `system-prompt` 行的实际值（line 457）：

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    includeHarnessIdentity: false
    personaPrefix: ''
    personaSuffix: Your working directory is provided by the session runtime context.
```

**`personaPrefix` 是空字符串。** 也就是说 dsh 的部署级人格一直没设过；当前那套身份来自 `~/.dsh/prompt-inject.md`（10KB）经插件注入。

**这个事实决定身份层的改造策略**：直接填 `personaPrefix` 会和现有注入 **叠加**，不是替换。两套并存的结果是模型收到两份互相矛盾的自我描述，行为不可预测。要么把 `prompt-inject.md` 那条链路关掉，要么就别动 `personaPrefix`。

### 1.3 当前生效的策略配置【实测】

```yaml
- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'
    workspaceRoot: !!js process.cwd()
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js >-
      (process.env.DSH_PERMISSION_MODE ?? 'danger-full-access') === 'danger-full-access' ? 'never' : 'ask'
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:        { sandbox: read-only,        approval: ask }
      workspace-write:  { sandbox: workspace-write,  approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

三个必须知道的技术事实：

1. **策略层由一个环境变量驱动**：`DSH_PERMISSION_MODE`。未设置时 fallback `danger-full-access`（本机当前状态：未设置）。想切模式，改环境变量即可，**不必改 patch**。
2. **审批行的真实 id 是 `approval`，不是 `user-approval`**。写错 id 只会静默跳过。
3. **`workspaceRoot: !!js process.cwd()`** —— 沙箱的 workspace 根是**启动 dsh 时的当前目录**，不是你在 GUI 里切换到的目录。这两个概念在 dsh 里是分开的：`sandbox-policy.workspaceRoot` 管沙箱边界，`workingDirectory` 服务管工具的工作目录（见 §2.7）。

---

## 2 架构模型

### 2.1 启动链【源码】

```
dsh CLI (lib/bin.js)
 → profile-boot：定位 $DSH_HOME/profiles/<name>，读 package.json 的 dsh.profile.bundles
 → app-boot：按层序组装配置树，起 cordis loader
 → cordis：按配置树挂载插件，插件通过 inject 互相取服务
 → 具体表面：dsh-web-app（HTTP+WS+前端产物）/ headless / sdk / acp
```

### 2.2 配置层序【源码】

```
空根
 → dsh.profile.bundles 各 bundle 的 dsh.bundle.patch 文件（按数组顺序）
 → <profile>/cordis.patch.yml
 → $DSH_HOME/cordis.patch.yml
 → 命令行 --patch
```

证据：`dsh-app-boot/lib/index.js:1128-1133`。

**实操含义（最容易踩）**：私有包的 patch 排在 `<profile>/cordis.patch.yml` **之前**。你 profile 那份里已写了 `system-prompt`（第 66-71 行），它会压过私有包的同名条目。改私有包身份却没删 profile 那条，就是"改了没反应且不报错"。

`dsh-hmr` 监视 profile manifest、profile patch、home patch 三层，改动触发热重组；`lib/*.js` 改动要重启。

### 2.3 patch 语义【源码】

```yaml
- id: <目标行 id>        # 覆盖已存在的行
  name: '<断言插件名>'    # truthy 时校验既有行确实是该插件，不改名
  config: {...}          # 整体替换，不深合并
  disabled: true

- insert:                # 追加新行，可挂进 group
    - id: ...
      name: ...
      config: ...
```

两个反直觉点，都会让人误判"已生效"：

1. **`config` 整体替换**。`dsh-app-boot:3044` schema 原文：`config is replaced wholesale, not deep-merged`。
   只写一个键 → 该行其余键回落该插件 schema 默认值，**不是保留原值**。
2. **未知 id 只 warn 并跳过**。`:97` `warn("patch: entry %C not found", id)`；schema 原文：
   `Unknown targets and non-insert patches without a nonempty id are warned and skipped.`
   **不阻断启动。** 配错了从启动成功里看不出任何异常。

### 2.4 插件契约【源码】

ESM 模块，具名导出：

```js
const name = "private-core";                // 插件名
const inject = ["tools", "systemPrompt"];   // 依赖的服务名
const Config = z.object({ ... });           // schemastery schema
function apply(ctx, config) { ... }
export { Config, apply, inject, name };
```

形状与 `dsh-persona`、`dsh-tool-todo` 完全一致。生命周期：`apply` 内用 `ctx.effect()` 注册的东西在 dispose 时自动清理；热重载 = dispose 旧实例 + 用新 config 重新 `apply`。

### 2.5 系统提示装配【源码】

一次模型请求只发**一份**有序系统提示 + 全部工具 schema。

**段落（section）**：`ctx.systemPrompt.section({ name, order, text })`
- `order` 只校验有限数；**同 order 不报错**，按 name 的 code-unit 字典序插位（`dsh-system-prompt/lib/index.js:254`）
- 同名重复才 throw（`:248`）
- `section()` 内部已 `this.layers.effect(...)`（`:255`），外层再包 `ctx.effect` 多余但无害
- `complete: true` 表示"装配后这就是完整提示词"，多于一个生效的 complete 段会让装配失败

**官方 section order 全表**（`SECTION_ORDERS`，`:10-43`）：

```
-1000  HARNESS_IDENTITY
    0  DEPLOYMENT_PERSONA_PREFIX
  500  PLAN_POLICY
  600  TEAM_POLICY
  800  PTC_ONLY
  900  FILE_REFERENCE
 1000  TOOL_BASH          1010 TOOL_PWSH
 1100  TOOL_READ          1200 TOOL_WRITE
 1300  TOOL_EDIT          1400 TOOL_GLOB
 1500  TOOL_GREP          1600 TOOL_JOBS
 1700  TOOL_PTY
 2000  TOOL_WEB_SEARCH    2100 TOOL_WEB_FETCH
 2200  TOOL_LSP           2300 TOOL_SESSION_QUERY
 2400  TOOL_GOAL          2600 TOOL_WORKFLOW
 2700  TOOL_RALPH         2800 TOOL_SUBAGENT
 2900  TOOL_REPORT        3000 TOOL_COMPUTER_USE
 3100  MCP_SERVERS
 5000  TOOLS_SDK
 9000  DELIVERABLE_FILE_REFERENCES
 9900  STRUCTURED_OUTPUT
10000  HARNESS_SOURCE
10100  WEB_SURFACE
10200  DEPLOYMENT_PERSONA_SUFFIX
```

自建段落选 **9500**（9000 与 9900 之间的空档，落在全部工具指导段之后）。

**动态上下文（context）** 是另一条通道，order 表在 `CONTEXT_ORDERS`（`:44-52`）：

```
100 WORKING_DIRECTORY   110 SANDBOX_POLICY   115 APPROVAL_POLICY
120 SUBAGENT_DELEGATION 125 TEAM_IDENTITY
200 HARNESS_SOURCE      210 WEB_SURFACE
```

**变量插值**：段文本里可出现 `{{变量}}`，宿主只注册少数变量（`provider` / `model` 等）。
插值是**严格**的——出现未注册变量会让**整轮在发出请求前失败**。
你 profile patch 第 57-65 行那条注释记录过真实事故：`{{cwd}}` 未注册 → `unknown prompt variable "{{cwd}}"`。

### 2.6 工具执行管线【源码】

```
defineTool({...})
  ├─ parameterSchemaSpecToJsonSchema(options.parameters)   :848   ← 在 defineTool 内，加载时执行
  ├─ valueSchemaSpecToJsonSchema(options.output.schema)   :849
  └─ ctx.tools.register(...)  :2982（内部已 effect）
        ↓ 模型调用
  registry：解析参数 → policy 管线 → execute(args, exec) → validateJsonSchemaValue(output.schema) :3639 → render → tool/result
```

关键约束：

- **`required` 只允许 `true`**。写 `required: false` → `:603` `required must be true when present` → `authorError` 抛 `JsonSchemaError`。因为校验发生在 `defineTool()` 内，所以是**模块加载即死**，不是运行时。
- **`output.schema` 与 `parameters` 同一套语法糖**（`:849` `valueSchemaSpecToJsonSchema`，`schema.d.ts:60` 里 `properties?: ParameterSchemaSpec`）。所以 `output.schema` 属性级 `required: true` **合法**——这一点 Gemini Argon 判错了。
- `render` 返回 `ContentBlock[]`，`[{type:'text', text}]` 合法。
- `presentCall` 返回 `{card, title, kind?, rawInput?}`：`card:'generic'` 合法（`presentation.d.ts:48`），`ToolCallKind` 枚举为 `'read'|'edit'|'delete'|'move'|'search'|'execute'|'fetch'|'other'`（`:13`），`kind` 可省略，默认 `other`。

### 2.7 关键服务【源码】

| 服务 | 用途 | 拿法 |
|---|---|---|
| `tools` | 工具注册表 | `ctx.tools.register(defineTool(...))` |
| `systemPrompt` | 提示词段/上下文/变量注册 | `ctx.systemPrompt.section(...)` |
| `workingDirectory` | **会话工作目录** | `await ctx.workingDirectory.ensure(agent, signal)` → `Promise<string>` |
| `fs` | 受沙箱约束的文件系统 | `ctx.fs.resolve(path, {cwd, signal})` |
| `sessionProjections` | 会话投影（UI 状态） | `ctx.sessionProjections.register({...})` |

**`workingDirectory` 是最容易写错的一个**。`exec.agent` 上**只有 `id`**（`dsh-agent/lib/types/types.d.ts:11-14`），没有 `session`、没有 `workspace`。
工作目录只能通过服务取，官方两个工具的原样写法：

```js
const cwd = exec.agent === void 0 ? void 0 : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
```

证据：`dsh-tool-fs/lib/index.js:172`、`dsh-tool-pwsh/lib/index.js:636`、签名 `dsh-working-directory/lib/types/index.d.ts:73`。

**注意 `@deepseek-ai/dsh-tool-fs` 不导出自己的 `sessionResolveOptions` 辅助函数**（`lib/index.js:1231` 只导出 `{Config, apply, inject, name}`），所以别想着复用，直接用服务。

---

## 3 私有化七层（技术落点）

### 3.1 身份层

**落点**：`system-prompt` 行的 `personaPrefix` / `personaSuffix`；或用 `persona` 行设 `complete: true` 整份接管。

`system-prompt` 的 Config 只有 5 个键（`:214-219`）：`includeHarnessIdentity` / `includeRuntimeContext` / `personaPrefix` / `personaSuffix` / `toolOrder`。整体替换时重述这 5 个就够，没有隐藏键。

⚠️ 本机 `personaPrefix` 是空的，身份来自 `prompt-inject.md`（§1.2）。改之前先决定谁负责身份。
⚠️ 与 `dsh-purge` 争抢同一行：它的 `overlayOfficialIdentity` 会在运行时回写 `personaSuffix`。给一个不含 `{{变量}}` 的非空后缀可以挡住它。

### 3.2 品牌层

**落点**：`ui-settings-general`（`welcomeNoticeVersion`）、`dsh-client-ui-brand-official`、`host-frontend-static`（前端产物）。

技术细节【推断】：brand 包的可配粒度未核实。验证法：`--dump-config | Select-String 'brand'`。
改前端产物还要重新构建 `dsh-web-frontend`，只改配置不换静态资源。

### 3.3 模型层

**落点**：`llm-pi-ai` 的 `providers`（OpenAI 兼容自定义网关）。你已有 `acme-gateway` 示例。

每个 provider 可配：`displayName` / `apiKeyEnv` / `api`（如 `openai-completions`）/ `baseURL` / `models[]`，模型可配 `id` / `name` / `contextWindow` / `maxTokens`。

**密钥纪律**：用 `apiKeyEnv` 指向环境变量，不写进 config。但注意 patch 支持 `!!js`，能读 `process.env` —— 凡是能改 patch 的人就能读全部密钥（§9 R3）。

### 3.4 工具层

**落点**：自写插件 `ctx.tools.register`；官方工具按组 `disabled: true` 瘦身。

你当前 74 个工具类插件、33 个条目被禁用。禁工具的收益是**每步固定开销下降**（工具 schema 每次请求整份发出，且在提示词靠前位置），不是一次性收益。

### 3.5 策略层

**落点（已实测）**：不要改 patch，改环境变量。

| 变量 | 作用 | 未设时 |
|---|---|---|
| `DSH_PERMISSION_MODE` | `read-only` / `workspace-write` / `danger-full-access` | `danger-full-access`（= sandbox 全开 + approval never） |

真实 id 对照（务必用这些，写错静默跳过）：

| id | 插件 |
|---|---|
| `sandbox` | `dsh-sandbox-local` |
| `sandbox-policy` | `dsh-sandbox-policy` |
| `bash-sandbox` / `pwsh-sandbox` | 按平台二选一，另一个 `disabled` |
| `approval` | `dsh-user-approval` ← **不是 `user-approval`** |
| `permission` | `dsh-permission-presets` |

### 3.6 数据层

**落点（已实测）**：

| id | 插件 | 当前配置 |
|---|---|---|
| `session-persistence-jsonl` | 会话 JSONL | `root: !!js dshHomePath('sessions')` |
| `session-query-sqlite` | 全文检索索引 | `path: ':memory:'`、`openAt: never`（不建索引） |
| `session-log-deepseek` | 会话日志 | — |
| `attachment-local` | 附件 | — |

你另外通过 patch 的 `insert` 挂了 `optional-session-search`（`openAt: first-search`，`:memory:`），实测**已生效**（dump line 1381-1387）。所以检索能力是有的，首次搜索时才建索引。

### 3.7 分发层

`dsh --profile <new> --from-default-profile web` 克隆模板；bootstrap 脚本一键装 profile + 私有包。

---

## 4 各层改装的直观效果

这一节回答"改完我能看到什么"。技术文档最容易缺这层，结果改了一堆却不知道生效没有。

### 4.1 效果矩阵

| 层 | 改什么 | 看得见的变化 | 生效时机 | 一眼验证 |
|---|---|---|---|---|
| 身份 | `personaPrefix` / `persona` | 模型的自称、称呼、语气、拒绝方式 | **新会话**（系统提示在会话开始时定型，老会话不变） | 开新会话问"你是谁" |
| 品牌 | 欢迎语、brand 包、favicon | GUI 标题、欢迎弹窗、图标、配色 | 刷新页面 | 刷新即见 |
| 模型 | `llm-pi-ai.providers` | 模型下拉多一项、显示名、上下文窗口数字 | 重启或 HMR | 模型选择器 |
| 工具 | 加自写工具 / 禁官方工具 | ① 多出工具调用卡片 ② 少一堆无用卡片、每步 prompt 变短 | 重启（新工具）/ HMR（禁用户） | 让它干一件事，看调不调得动 |
| 策略 | `DSH_PERMISSION_MODE` | 审批弹窗消失或出现；原来写不了的路径突然能写 | 重启 | 让它改仓外文件 |
| 数据 | 存储 / 检索配置 | 重启后历史在不在、搜索快不快 | 重启 | 搜一条旧会话 |
| 分发 | `--from-default-profile` | 多一个干净实例 | 启动即见 | 两边的 `--dump-config` 对比 |

### 4.2 三类"生效"的落差（最重要的一节）

**① 立刻可见**：品牌、模型下拉、审批弹窗、工具卡片。
这些是 UI 层，刷新就有。最容易让人产生"改造成功了"的错觉。

**② 要新会话才可见**：人格、提示词段、工具 schema 顺序。
系统提示在**会话开始那一刻**装配定型。改完在旧会话里试，看到的永远是旧人格。
这是"我明明改了它没反应"的第一大来源。

**③ 看不见，只能验证**：patch 是否命中、config 键是否被整体替换、依赖是否解析到。
这一层没有任何视觉反馈，只有 `--dump-config` 能抓。

所以正确的验收顺序是：**UI 层看刷新 → 语义层看新会话 → 配置层看 dump**。
缺任一层，你都会得出错误结论。

### 4.3 三个真实案例（本机实测）

**案例 A：`tool-schedule` —— 结果正确，因果错误**

你 profile patch 里写了顶层条目：

```yaml
- id: tool-schedule
  disabled: true
```

loader 报：`[profiles\web\cordis.patch.yml] patch: entry "tool-schedule" not found`。

原因：配置树里 `tool-schedule` 是**嵌套行**（dump line 743，缩进 6 格，属于某个 group），顶层 patch 匹配不到，跳过。

**但它的 `disabled: true` 现在确实存在** —— 那是上游 bundle 自己设的。也就是说：
- 你以为是"我禁掉的"，实际是上游早就禁了
- 你的条目是冗余的，而且**静默失效**
- 哪天上游解禁，你这条也不会补上

这类"结果对、因果错"最危险，因为它骗过了所有基于结果的验证。

**案例 B：`session-mention` —— 整个插件没加载**

`dsh-client-ui-session-mention@0.1.0` 与 dsh 0.2.1-rc.2 不兼容（要求 `@deepseek-ai/dsh-client-*` 为 `^0.1.0-rc.6`），启动时：

```
dsh: skipping profile bundle "dsh-client-ui-session-mention": ... incompatible ...
```

它提供的 UI 功能现在是坏的，而 GUI 里**看不出任何报错**。bundle 级失效是最彻底的"静默"——整个插件树不存在。

**案例 C：`optional-session-search` —— 真正生效的对照组**

你 patch 里那段 `insert` group（149-163 行）实测生效：dump line 1381-1387 有 `optional-session-search`、`sessionQuery: true`、`optional-session-query-sqlite`。

这说明 insert group 语法的用法是对的，可以和 A、B 对照着看差别在哪：**insert 追加新行不依赖已有 id**，所以不会遇到"未命中"；而覆盖已有行必须 id 完全对、层级完全对。

### 4.4 成本视角的直观效果

你的 `~/.dsh/.dshw-usage.json` 实测：今日 `todayUsage` 0.01，余额 19.97；历史日花费从 0.02 到 26 元不等。

这给私有化一个**可量化的验收指标**：

| 改动 | 可测效果 | 性质 | 怎么测 |
|---|---|---|---|
| 禁工具组 | 每步 prompt 固定开销下降 | **每步成本** × 步数 | 同一任务改造前后各跑一次，对比 usage 增量 |
| 压缩阈值 | 长会话不再一路涨到几十万上下文 | 每步成本随会话长度 | 看每步 token 是否稳定在阈值附近 |
| 人格/提示词段长度 | 每会话固定多付 N token | **每会话固定成本** | personaPrefix 每 1000 字 ≈ 每会话固定开销 |
| 数据层配置 | 几乎无 token 成本 | — | 只影响延迟与功能 |

**结论【推断】**：要省钱优先动工具层（按步计费），要改气质只能动身份层（按会话计费），两者收益性质不同、不可互换。
一个常见误判是"加了一大段私有人格还想着省钱"——方向相反。

### 4.5 按感知强度排序

只做三件事的话：

1. **身份层** —— 感知最强，一句话改变整个说话方式。但先解决与 `prompt-inject.md` 的叠加（§1.2），二选一。
2. **工具层瘦身** —— 感知第二，且直接省钱。已禁 33 个条目，剩余收益按"每步固定开销 × 步数"算。
3. **品牌层** —— 感知最直接、成本最低，但纯装饰，不影响能力。

**最不直观的是策略层**：它改变的是"能做/不能做"的边界，正常操作下你根本注意不到——直到某次该被拦的没被拦，或该能写的写不进去。

---

## 5 私有核心包

代码在 `packages/dsh-private-core/`。三个关键设计决策，每个都对应上面一条源码事实：

| 决策 | 原因 | 对应事实 |
|---|---|---|
| `inject` 含 `workingDirectory` | 工作目录只能从服务取 | `exec.agent` 上只有 `id`（§2.7） |
| `order: 9500` | 避开官方 9000 / 9900 | `SECTION_ORDERS`（§2.5） |
| 写入路径做穿越校验 | patch 层能改 `notebookPath`，工具不能成为任意文件追加原语 | §2.3 `!!js` 可被注入 |

机械验证【实测】：`node --check lib/index.js` → `JS syntax OK`；YAML 解析 → `OK, entries: 2 (system-prompt, insert:1)`；`required: false` 无残留。

**未验证**：没装进 profile、没启动、没跑 `--dump-config`。装完必须补。

---

## 6 双审裁决

两份审核在 7 个点上冲突。逐条以源码裁决：

| # | 议题 | Gemini Argon | 源码 Argon | 裁决 | 证据 |
|---|---|---|---|---|---|
| 1 | 拿工作目录 | 臆造，改用 `sessionResolveOptions` 从 `dsh-tools` 导入 | 臆造，改用 `ctx.workingDirectory.ensure` | **源码 Argon 对**；Gemini 连替代方案都错 | `dsh-tool-fs:1231` 只导出 `{Config,apply,inject,name}`；ensure 见 `dsh-working-directory/.../index.d.ts:73` |
| 2 | `output.schema` 属性级 `required: true` | 「违反规范会崩，改 `required:["path"]`」 | 合法 | **Gemini 错** | `dsh-tools:849` 走 `valueSchemaSpecToJsonSchema`；`schema.d.ts:60` properties 类型是 `ParameterSchemaSpec`；官方 tool-todo 同款 |
| 3 | `card:'generic'` / `kind:'other'` | 「高风险，枚举可能不认」 | 合法 | **Gemini 错** | `presentation.d.ts:48` / `:13` / `:55` |
| 4 | `required: false` | 「与省略等价，只是冗余」 | 会抛异常，加载即失败 | **源码 Argon 对** | `dsh-tools:603` + `:848` 在 `defineTool()` 内执行 |
| 5 | `order: 9000` | 撞车，改锚点 | 撞 `DELIVERABLE_FILE_REFERENCES:9000`，改 9500 | **两家都对** | `dsh-system-prompt:38` |
| 6 | 安装方式 | 「走 pnpm workspace」 | 必须 `file:` 硬拷贝 | **源码 Argon 对** | 【实测】`profiles\web\node_modules\@deepseek-ai` = 0 项；`profiles\node_modules\@deepseek-ai` = 195 项，`dsh-tools` 是 Junction |
| 7 | 未知 patch id 后果 | （未涉及） | 只 warn 跳过 | **源码 Argon 对** | `dsh-app-boot:97` + `:3044` |

### 6.1 对 Gemini Argon 的评价

**架构判断有价值**（已并入 §9）：patch 层与 host 层的信任边界、会话数据归属、供应链私有 registry、升级漂移检测——四条都是真问题。

**具体 API 判断 7 条错 4 条**，错误方向高度一致：套用通用 JSON Schema / MCP / Cordis 的教科书画像，不读这个仓库的实现。
识别特征：凡是出现"标准规定 / 通常 / 高风险 / 可能 / 一般会"的，一律不可采信，必须落到 `文件:行号`。

这条经验已提升为 §0.2 铁律 1。

---

## 7 安装与验证

### 7.1 安装

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add file:C:/Users/KonomiHasu/dsh-private/packages/dsh-private-core
```

再把 `"@yg/dsh-private-core"` 加进该 `package.json` 的 `dsh.profile.bundles`（官方 bundle 之后）。

**为什么必须 `file:`**【实测】：

- `profiles\web\node_modules\@deepseek-ai` 是**空目录**（0 项）
- 真正能解析到的那层在上一级 `profiles\node_modules\@deepseek-ai`（195 项），`dsh-tools` 是指向全局安装的 **Junction**
- 所以包体必须**物理落在 profiles 树内**，`import '@deepseek-ai/dsh-tools'` 才能顺 realpath 向上找到
- `link:` 与 pnpm workspace 成员都是 symlink，realpath 落在 profiles 树外 → `ERR_MODULE_NOT_FOUND`
- pnpm 12.x 的 `pnpm add file:<dir>` 是硬拷贝，所以这条路能活

### 7.2 验证（强制三步）

```powershell
# 1) 组合后的配置树
dsh --profile web --dump-config | Select-String -Context 2,10 'private-core|system-prompt'

# 2) schema 是否接受私有插件 config
dsh --profile web --dump-config-schema | Select-String 'private-core'

# 3) 运行时确认工具注册
dsh web   # 新会话里让模型调用 yg_note
```

判定标准：`private-core` 出现在组合树 **且** `personaPrefix` 是私有文本 **且** `yg_note` 可调用。三者缺一不算生效。

### 7.3 生效边界

| 改动 | 生效方式 |
|---|---|
| `cordis.patch.yml` | HMR 热重组，不必重启 |
| `lib/index.js` | 必须重启 |
| `package.json` 的 bundles | 必须重启 |
| 环境变量（`DSH_PERMISSION_MODE` 等） | 必须重启（进程启动时读取） |

---

## 8 升级与漂移

三个**互不覆盖**的漂移源，必须分开盯：

1. **私有包 vs 上游**：`peerDependencies` 写死 `0.2.1-rc.2`，dsh 升版后不满足。
   `dsh-plugin-manager:276-284` 用 `semver.satisfies(..., {includePrerelease:true})`；有 `engines.dsh` 就由它单独决定。
2. **dsh-purge 的 patch**：活在 `node_modules` 里，`npm i -g` 后全部丢失 → 身份基线静默回退。
3. **config 整体替换**：上游给某行新增配置键，你的 patch 会把它抹成默认值，且不报错。

对策：

- 升级流程固定为 `--dump-config` 前后 diff：升级前存基线，升级后比对差异清单
- 私有包用 `engines.dsh` 声明可接受范围
- 需要 fork 引擎行为时 clone 仓库自己 build，不要靠改 `node_modules`

---

## 9 风险登记

| # | 风险 | 性质 | 对策 |
|---|---|---|---|
| R1 | 工具直接用 `node:fs` 写盘，绕过 `dsh-fs` 与 sandbox policy | 沙箱后门：切到 workspace-write/只读后仍可写 | 走 `ctx.fs` 服务，或显式声明 |
| R2 | 私有包靠上层 Junction 才解析到 `@deepseek-ai/*` | profile 重建或升级即断 | 装完跑回归；或自带 pinned 依赖 |
| R3 | patch 支持 `!!js`，能读 `process.env` | 密钥隔离失效：能改 patch 就能读全部环境变量 | 密钥不进 `process.env`；由外部网关注入。**密钥/审计/多租户逻辑都不该放在可被 `--patch` 覆盖的层** |
| R4 | 与 dsh-purge 争抢 `system-prompt` | 运行时双向回写，冲突静默 | 身份只在一处定义；后缀非空且不含 `{{变量}}` |
| R5 | 未知 id 只 warn | 静默失败，最易误认为已生效 | 每次改 patch 必跑 `--dump-config` |
| R6 | 会话数据写死在 workspace 内 | 容器销毁/迁移即丢失，污染工作区 | 需要持久化时改走对象存储 |
| R7 | 与 `prompt-inject.md` 身份叠加 | 模型收到两份自我描述 | 二选一（§1.2） |
| R8 | bundle 版本不兼容被整体跳过 | 整个插件树不存在，UI 无提示 | 看启动日志的 `skipping profile bundle` |

---

## 10 未验证清单

| 项 | 状态 | 验证方法 |
|---|---|---|
| loader 能否 import 裸包名 `@yg/dsh-private-core` | 未验证 | 装完跑 `--dump-config` 看有无 import 失败；反证是本 profile 已有 11 个第三方裸名 bundle 正常加载 |
| `engines.dsh: "0.2.1-rc.2"` 精确 prerelease 能否过校验 | 未验证 | `dsh plugin --profile web list` 看是否标 incompatible |
| 私有包在 `workspace-write` / 只读模式下 `yg_note` 的行为 | 未验证 | 切 `DSH_PERMISSION_MODE` 后调用一次 |
| brand 包可替换粒度 | 未验证 | `--dump-config | Select-String 'brand'` |

**已由此轮实测解决**：`approval` / `sandbox-policy` 的确切 id 已确认（原来文档里猜的 `user-approval` 是错的）。

---

## 11 更正记录

本文档纠正了此前对话中的三处错误，保留原文以便追溯：

1. **「id 写错 = 启动失败」→ 错。** 实际只 warn 并跳过（`dsh-app-boot:97`、`:3044`）。
   性质相反：不是会炸，而是静默无效。见 §2.3、§9 R5。
2. **「走 pnpm workspace」→ 错。** workspace 成员是 symlink，realpath 落在 profiles 树外，必 `ERR_MODULE_NOT_FOUND`。必须 `file:` 硬拷贝。见 §7.1。
3. **「`user-approval` 是审批行 id」→ 错。** 实际 id 是 `approval`。见 §1.3、§3.5。

另记录一次**未遂误判**：核验 `optional-session-search` 是否生效时，第一次 grep 只取前两条匹配就差点判成"未生效"；实际数据在 dump 第 1381-1387 行，**是生效的**。
教训：证据纪律要求看到 `truncated` / 只取到部分匹配时，必须先读全再下结论。

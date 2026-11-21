# @yg/dsh-private-persona 防衰减 In-Chat 锚点重注入方案（待冷审）

## 1. 背景与目标
当前 `@yg/dsh-private-persona` 仅通过 `ctx.systemPrompt.section` 将人格文本挂载在 system prompt 中（`order: 10150`），长对话中容易因上下文拉长或压缩而发生人格漂移。现有 `persona drift` 与 `persona_check` 均为被动检查工具，缺乏运行时的主动防衰减机制。

本方案拟在 `@yg/dsh-private-persona` 中新增 **In-Chat 人格锚点周期重注入**：在不破坏 system prompt 缓存的前提下，于长对话间隔若干轮时，向 `agent/pre-step` 注入一条极短的人格核心锚点提示，拉回模型语感与身份约束。

## 2. 技术设计

### 2.1 纯逻辑抽取（`lib/core.mjs`）
- 新增 `composeAnchor(personaName, layers, maxChars = 220)`：
  - 从 `parseLayers(body)` 结果中提取最核心的防漂移要素：
    1. `身份` 首句 + `红线`（防出戏、防自称 AI）
    2. `语感` 下的 `锚点`（语感质地）与 `禁区`（防 AI 腔）
    3. `汇报` 首句（防技术汇报退化为公文周报腔）
  - 严格控制总长度（默认 `<= 220` 字符），超长时按段落/句号截断，不塞整份人格文件。
  - 若旧格式无 `#` 分层，截取正文前 `maxChars` 字符。

### 2.2 运行时钩子（`lib/index.js`）
- 新增配置项（`Config`）：
  - `anchorIntervalTurns`: `z.number().default(4)`，每隔多少个用户回合注入一次（`0` 表示关闭）。
  - `anchorMaxChars`: `z.number().default(220)`，单次锚点注入最大字数。
- 挂载 `ctx.on("agent/pre-step", ..., { prepend: true })`（并在 plugin dispose 时由 Cordis 自动清理，或通过 `ctx.effect` 管理）：
  - 参照 `@deepseek-ai/dsh-agent/lib/types/model-selection.js` 的标准写法：
    1. `const decision = await next();`
    2. 若 `decision.kind === "reject" || signal.aborted`，原样返回 `decision`。
    3. 若 `decision.messages.length === 0`，原样返回 `decision`（不向空转步骤注入）。
    4. 仅在 `step === 1`（新回合首步）检查是否需要注入，避免单回合多轮工具调用时重复注入。
  - **Session 隔离状态**：使用 `WeakMap` 按 `agent.session`（或 `Map<sessionId, { lastTurn, lastPersona }>`）记录每个会话上次注入的 `turn` 与人格名 `lastPersona`：
    - 若 `lastPersona !== currentName`（中途切换了人格），或 `turn - lastTurn >= config.anchorIntervalTurns`（且 `turn > 1`，第 1 轮刚读完 system prompt 无需重复注入），则构造注入消息。
  - **消息构造**：
    - 使用 `@deepseek-ai/dsh-llm` 的 `createUserMessage` 与 `boundContextSummary`：
      - `content: [{ type: "text", text: "[persona-anchor: " + currentName + "]\n" + anchorText }]`
      - `source: { kind: "private-persona", form: "notice", summary: boundContextSummary("persona anchor: " + currentName) }`
    - 返回 `{ ...decision, messages: [...decision.messages, anchorMsg] }`。

### 2.3 需要冷审重点核查的风险点
1. `user/message` 持久化后在 Web UI 对话流中的可见性：`source.kind === "private-persona"` + `form: "notice"` 是否会被前端当成普通用户气泡渲染？
2. `dsh-agent-loop` 的 `step()` 仅在 `firstAttempt` 时接纳 `decision.messages` 并写入 `session`，若重试或工具多步执行，`step === 1` 判定是否足够稳健？
3. `@deepseek-ai/dsh-llm` 在插件运行时中的导入兼容性与 `package.json` 依赖声明。

## 3. 验证计划
- 在 `test/core.test.mjs` 增加 `composeAnchor` 单元测试（含分层提取、字数上限截断、无分层兜底）。
- 运行 `node --test C:\Users\KonomiHasu\dsh-private\packages\dsh-private-persona\test\`。
- 运行 `node --check` 校验 `lib/index.js` 与 `lib/core.mjs`。
- 使用 `plugin_manager` (`action: install_bundle`) 安装到当前 `web` profile 并验证挂载无警告。

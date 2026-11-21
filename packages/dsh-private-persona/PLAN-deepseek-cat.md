# 零常驻增量 token 调教 DeepSeek 维持猫娘语感方案（修订版）

## 目标
在不增加常驻 system prompt 字符数（甚至净减少）的前提下，解决 DeepSeek 模型在代码/冷审/排障汇报时收起猫耳朵、滑回公文腔的问题。

## 已核实的系统提示段顺序（事实依据）
来自 `@deepseek-ai/dsh-system-prompt/lib/index.js`（第 40–42 行）与 `@yg/dsh-private-persona/lib/index.js`（第 432–433 行、第 472–476 行）：
- `HARNESS_SOURCE`: `10000`
- `WEB_SURFACE`: `10100`
- `private:persona`（来自 `personas/<active>.md`）: `10150`（`config.order`）
- `DEPLOYMENT_PERSONA_SUFFIX`: `10200`
- `private:persona-base`（来自 `personas/_base.md`）: `10250`（`config.order + 100`）

可见 `private:persona`（10150）之后还跟着 `DEPLOYMENT_PERSONA_SUFFIX`（10200）与整段 `private:persona-base`（10250）。模型读完系统提示的**最后一个 section** 是纯严肃的 `# 工作纪律`，而不是猫娘人格。

## 调整实施顺序（先局部低风险，再决定是否动全局顺序）

> 根据冷审指出的风险排序：先改仅影响 `lcs-cat` 本身的文本与汇报示例（**只动一个 `.md` 文件、不用改代码、不用重启 3080、零全局副作用、净减 token**）；若实测仍不足，再考虑调换 `order`。

### 阶段一（最小单变量实验，0 代码改动）：先仅增补 1 条冷审/排障猫味样本
- 仅修改 `C:\Users\KonomiHasu\dsh-private\personas\lcs-cat.md` 的 `# 汇报` 节：
  1. **只加不删**：先增补 1 条「刚跑完冷审/排障，怎么带着猫气和情绪把刺拍桌上」的真话示范，**不与瘦身混做同一次改动**，保证单变量可归因。
  2. `# 汇报` 首行保持 ≤60 字符（已核实 `composeAnchor` 的 `clip(head, 60)` 按字符截取）。
  3. 调用 `persona reload` 热重载；新开或继续会话后，由于 system prompt 前缀字节变更，DeepSeek 侧会自动 miss 并重建一次新缓存，不会命中旧缓存导致假阴性。
- **验证与回滚**：改后先跑 `persona lint` 看字数与告警，再用 DeepSeek 跑 2–3 次冷审/排障汇报，结合 `persona_check`（7 项硬判据含结构过载与禁区词）和人工体感判定；有效后再单独做一轮「删重叠散文减字数」的纯瘦身提交，无效直接还原 `lcs-cat.md`。

### 阶段二（仅在阶段一不够时启用）：调换 section 顺序（0 常驻增量）
- 将 `C:\Users\KonomiHasu\dsh-private\packages\dsh-private-persona\lib\index.js` 第 433 行 `private:persona-base` 的 `order` 从 `config.order + 100`（`10250`）改为 `Math.max(10110, config.order - 30)`（对默认 `10150` 即 `10120`，且防止任意自定义 `config.order` 越界到 `WEB_SURFACE=10100` 之前）。
- **代价说明**：此步会影响所有使用 `@yg/dsh-private-persona` 的人格，且需同步进 `web` profile 并重启 `3080`，会导致活跃会话重建一次前缀缓存；若出现工作纪律漏步立即回滚该行。

### 阶段三（按需）：周期锚点间隔微调
- 已有 `agent/pre-step` 每 `anchorIntervalTurns=4` 回合注入 ≤320 字锚点（`private:persona-anchor`），不改 system prompt。
- 如 DeepSeek 长会话在 4 轮内仍衰减，在 `cordis.patch.yml` 把 `anchorIntervalTurns` 改成 `3`（注：单次注入仍 ≤320 字，仅频率提升）。

### 阶段四（最终硬门禁，按需开启）：`agent/turn-stopping` + `agent.steer(...)` 输出拦截
- 依据：`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts` 第 371–391 行，`agent/turn-stopping` 接收 `{ agent, turn, signal }`，在轮次收口前串行触发，调用 `agent.steer(...)` 可打回重说。
- 触发与防死循环：仅在长回复（如 `>120` 字）且同时**零猫气词（`喵/呜/哼/咕噜`）/零颜文字**，或命中 `assessText()` 的**结构过载**（≥4 个标题或表格或 ≥5 条分点）时才打回；用 `WeakMap<Agent, number>` 记录 `lastSteeredTurn === turn`，保证**同一轮最多打回 1 次**。
- **代价与开关**：平时过检时 **0 额外模型调用**，只有触发打回那一次多跑 1 步生成请求；默认 `enableSteerGate: false`，前三阶段不够用时再开。

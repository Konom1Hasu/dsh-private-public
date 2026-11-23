## Standards

# 规范审计（Standards 轴）

**无法核验**：仓库规范文件未提供，以下仅按坏味道基线 + 代码内自述约束判断。

---

**[事实错] `_consume` 中 `turn.text` 与 `textStarted` 不一致导致 block-end 缺失**
`_consume` 里 `suppressRelayText` 为真时 `filtered.text` 被丢弃，但 `turn.text` 已在别处累积；park 分支 `if (textStarted) yield block-end` 用的是 `turn.text`，若文本被抑制而 `textStarted` 仍为 false，则 `turn.text` 有值却无 block-end。行：`if (filtered.text && !turn.suppressRelayText)` 与 `if (textStarted) yield { type:'block-end'... text: turn.text }`。

**[边界漏洞] `_needsRelayAutoContinue` 依赖 `turn.client`，但 `_startPump` 才赋值**
`_startPump` 内 `turn.client = client` 在 pump 启动后设置；`_consume` 首次进入时若 pump 尚未执行到该行（异步竞态），`turn.client` 为 undefined，自动继续永不触发。行：`if (!turn?.client) return false`。

**[边界漏洞] `_streamAuxiliary` 的 `holder = { key: null }` 传给 `_newClient`**
`_newClient` 内 `binding.client = client`，`holder` 无 `agySessionId` 等字段，`_persistBinding` 因 `!binding?.key` 跳过——但 `_newClient` 的 `permissionPolicy` 闭包读 `this.turns`，辅助 turn 的 `acpSessionId` 与 `holder` 无关联，权限校验对辅助会话恒 false（可能符合预期，但无注释说明）。

**[实操风险] `_disposeTurn` 中 `this.turns.delete(turn.sessionKey)` 与 `_finishTurn` 的 `parked` 早退**
`_finishTurn` 在 `parked` 时 `return` 不 dispose，但 `_disposeTurn` 被 `onEvict` 回调调用时 `turn.sessionKey` 可能已被 `turns.delete` 过（`TurnStateStore` 内部删除后再回调），二次 delete 无害但语义冗余。

**[坏味道/建议] `_abortBinding` 与 `stream` 内两处 `parked.binding` 清理逻辑重复**
`stream` 中 handover 与 superseded 两段几乎逐行相同（`client=null; agySessionId=null; syncedMsgsCount=0; lastReply=''; stopClient`），应抽 `_resetBinding(binding)`。行：`if (parked.binding) { const staleClient = ... }` 出现两次。

**[坏味道/建议] `ROTATE_TOKEN_THRESHOLD` 导出但未使用**
`session-tokens.mjs` 为单一真值，此常量仅注释锚点，导出会误导调用方以为可调。行：`export { ..., ROTATE_TOKEN_THRESHOLD, ... }`。

**[坏味道/建议] `DEFAULT_ALLOWED_TOOLS` 定义但 `allowedTools` 默认 null**
`constructor` 中 `this.allowedTools = Array.isArray(opts.allowedTools) ? ... : null`，`DEFAULT_ALLOWED_TOOLS` 从未被引用，死代码。行：`const DEFAULT_ALLOWED_TOOLS = ['read']`。

**[规范违规] `apply` 中 `AGY_ROOT_FALLBACK` 硬编码 Windows 绝对路径**
`'C:/Users/KonomiHasu/.dsh/profiles/web/agy-runtime'` 含用户名，跨机不可用；应走 config 或环境变量，缺失时 fail-fast 而非静默回落。行：`const AGY_ROOT_FALLBACK = ...`。

**[坏味道/建议] `_buildToolBundle` 的 `overBudgetSignature` 实例字段无声明**
`this.overBudgetSignature` 首次在方法内赋值，构造函数未初始化，类型不稳定。

## Spec

[遗漏/部分实现]

- A1「全局复用 agy acp --process-per-session --gemini-dir … --include-default-customizations=false --agent dsh_bridge」：交付物仅把 `bin/home/agent` 传给 clientFactory，未见 `--process-per-session`、`--include-default-customizations=false` 的构造证据（agy-acp-client.mjs 未提供，无法核验）。
- A2「动态代理 … 内置 3s TTL 缓存，并在空闲期或握手 ETIMEDOUT 后自动重读刷新」：交付物 `proxy: config.proxy ?? 'http://127.0.0.1:8868'` 为静态常量，无 TTL 缓存/重读逻辑；`NO_PROXY` 保底注入无法核验。
- A3「gate-tools.cjs 异步读 stdin + 4s 超时拒绝，仅放行 mcp_dsh_*」与 hooks.json 具名组形状：交付物无对应文件，无法核验。
- A4「双路径 settings.json 写入 contextWindow:900K、toolPermission:request-review；tmp+rename 原子写」：交付物仅 `seed` 透传，无播种实现，无法核验。
- A5「stdout 单行超 64 MiB 立即截断重启；stop() 关 stdin(3s)→kill(1.5s)→taskkill /F /T /PID」：`stopClient` 仅调用 `client.stop()`，具体时序无法核验。
- B1「initialize 与 session/new 独立 120,000ms 预算；并发冷启动共用 initPromise；重连清空 agentCapabilities」：交付物 `await client.initialize()` 无预算参数，无法核验。
- B2「session/prompt 180s Idle 空闲超时 + 40 分钟硬超时；超时先 _cancel 再抛 ETIMEDOUT」：交付物 `_startPump` 无空闲/硬超时逻辑，无法核验。
- B4「session/resume 遇 -32601 自动回退 session/load（屏蔽重放 session/update）」：`_resumeSession` 仅 catch 后全量重建，未见 -32601 回退 session/load 分支。
- C2「sanitizeToolSchema 解引用 $ref、折叠 anyOf/oneOf、剥离元字段、限深 16 层」：交付物未实现，仅调用 `buildMcpToolBundle`，无法核验。
- C4「parkExit 先 bindings.commit() 再 yield finish；挂 30 分钟孤儿回收定时器」：交付物 `_consume` 在 park 分支直接 `yield finish`，未见 `bindings.commit()` 调用，也未见 orphanTimer。
- C4「85s dsh_await_result 最多 8 轮接力等待」：交付物仅 `relayAfterMs` 透传与 `MAX_RELAY_AUTO_CONTINUES = 1`，未见 8 轮上限与 `dsh_await_result` 中继实现。
- D1「boundToolResult 严格收敛单条回执 <= 9,600 字节（read 类保头附分页续读提示，其余头 70%+尾 30%）」：交付物 `_toolResultPayload` 直接 `toolResultText(result)`，无 9,600B 收敛逻辑。
- D3「GIF 用 sharp 提取首帧转 PNG」：交付物仅降级文本占位，未实现转码兜底（Spec 允许无转码器时降级，但未检测转码器可用性）。
- D5「slot.wait(signal) 排队竞速快退且不断链」：交付物无 streamGate 串行锁实现，无法核验。

[越界/Scope Creep]

- `MAX_LIVE_SESSIONS = 4` 与 `evictOldestLive()`：Spec 未要求限制同时存活 agy 子进程数或按 LRU 淘汰活会话；Spec 仅要求「单账号固定独立 <AGY_ISOLATED_HOME>」。
- `MAX_PROMPT_CHARS = 60_000` 自行截断 prompt：Spec 未要求适配器侧截断 prompt，仅要求增量发送避免撞 65,000 字符线。
- `MAX_IMAGES_PER_REQUEST = 8`、`MAX_IMAGE_BYTES = 4MB`：Spec 未给出图片数量/体积上限。
- `AGYCLI_TRACE` 诊断探针落盘：Spec 未要求。
- `providerRetryPolicy` / `imageRequestPricing` 返回 undefined：Spec 未要求。
- `MAX_RELAY_AUTO_CONTINUES = 1`：Spec 要求「自动触发 mcp-relay-auto-continue 补发一轮提醒」，未限定只补一次。

[实现偏差]

- Spec「resolveModel() 必须显式声明 ['low','medium','high','xhigh'] 全集以放行校验」：交付物 `reasoning: { efforts: EFFORTS, defaultEffort: 'medium' }` 结构正确，但 `context: { contextWindow: 40_000 }` 与 Spec「contextWindow="900K"（实测硬顶 786,432）」不符，且注释称「别让 compaction 按 786K 的假窗口定阈值」——Spec 明确要求按 `Math.min(contextWindow, 786432) * 0.84` 计算轮换阈值。
- Spec「22 模型目录」：交付物 `MODELS` 为 23 条，且含 `gemini-4-neon-*`、`claude-opus-5-5-*`、`claude-sonnet-5-5-*`、`gpt-oss-120b-medium` 等 Spec 未列出的模型 ID；Spec 列出的 `gemini-4-carbon-high`、`gemini-4-hydrogen-xhigh`、`gemini-3.8-flash-high`、`gemini-pro-orchestrator` 中 `gemini-4-carbon-*` 与无后缀 `gemini-pro-orchestrator` 缺失。
- Spec「inputModalities 对 Gemini 4 全系（carbon/argon/hydrogen 各档）及 gemini-3.8-flash 各档返回 ['text','image']」：交付物 `MULTIMODAL_MODEL_PATTERNS` 含 `neon`、不含 `carbon`，与 Spec 白名单不一致。
- Spec「tools/list 只报裸名（agy 会自动加 mcp_dsh_ 前缀）」：交付物 `_mountTools` 用 `replace(/^mcp_dsh_/, '')` 过滤，但 `_buildToolBundle` 直接传 `mountTools` 给 `buildMcpToolBundle`，是否剥前缀无法核验。
- Spec「parkExit 必须先 bindings.commit() 固化会话绑定」：交付物 `_finishTurn` 在 `status === 'parked'` 时更新 `syncedMsgsCount` 并 `_persistBinding`，但 `_consume` 的 park 分支在 `yield finish` 前未显式调用 commit；`_finishTurn` 在 finally 中执行，时序上晚于 `yield finish`，与 Spec「先 commit 再 yield finish」语义不符。
- Spec「session/cancel 设 3,000ms 超时判 unacked」：交付物 `_abortBinding` 直接 `stopClient`，未见 `_cancel()` 3s 超时与 unacked 处理。
- Spec「-32603: the running prompt is being cancelled 退避重试」：交付物未见该错误码识别与退避逻辑。
- Spec「isCancelLeak()（全局剔除特征串与空白后剩余字符 <= 16）」：交付物仅 `isCancelLeak(c.text)` 调用，实现无法核验。
- Spec「TosWindow 首 4,000 + 尾 4,000 双窗口」：交付物实现符合，但 `TOS_PATTERNS` 含 `/TOS_VIOLATION/i` 等三条，与 Spec 一致；无偏差。
- Spec「辅助请求 … 分配一次性 tenantKey = __ephemeral__-<epoch>」：交付物 `__ephemeral__-${Date.now()}-${++this.turnSeq}` 符合。
- Spec「辅助请求 … 退出即 closeQuietly(ephemeralSessionId)」：交付物 `stopClient(client)` 符合，但 `_newClient(holder)` 中 `holder.key = null`，`_persistBinding` 因 `!binding?.key` 跳过，符合旁路要求。

无法核验项：agy-acp-client.mjs、mcp-bridge.mjs、park.mjs、binding-store.mjs、session-tokens.mjs 均未提供，A1/A2/A3/A4/A5/B1/B2/B4/C2/C4/D1/D5 中依赖这些模块的实现细节无法核验。

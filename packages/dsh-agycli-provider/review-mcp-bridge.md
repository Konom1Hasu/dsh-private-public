## Standards

[事实错] `_handleCall` 中 `call.callKey` 的生成逻辑（`request.id === null || request.id === undefined`）与 `_handle` 中 `id === undefined` 直接返回 202 冲突：`id === null` 的请求会走到这里，但 JSON-RPC 2.0 规定 `id: null` 是合法请求 id，`callKey` 却退化为 `auto-N`，而 `resolveParkedCall` 用 DSH 侧回传的 `callKey` 匹配——若 DSH 侧按 `id` 回填 `null`，`String(null)` 得到 `"null"`，与 `auto-N` 不匹配，挂起调用永远无法回填。无法核验 DSH 侧回填契约，但此处键不一致是硬风险。

[边界漏洞] `_relayCall` 中 `entry.relays = 1`，而 `_handleAwait` 在 `entry.relays >= MAX_TOOL_RELAYS` 时直接过期。首轮 relay 已消耗 1，实际最多再等 `MAX_TOOL_RELAYS - 1` 轮，与注释「最多接力 8 轮」不符（少一轮）。

[边界漏洞] `_handleAwait` 的 `waiter.timer` 回调里 `entry.content !== null` 分支调用 `_deliverAwait(entry)` 未传 `extraCall`，但该 waiter 仍在 `entry.waiters` 中，`_deliverAwait` 会遍历并交付它——逻辑正确，但 `_deliverAwait` 内 `targets.length > 0` 才 `delete`，若 `extraCall` 与 waiters 都为空则 entry 残留，`awaitingCountFor` 会虚高。`resolveParkedCall` 在无人 await 时保留 entry 是设计意图，但 `_deliverAwait` 的删除条件与「结果先到、没人 await 时必须留着」注释矛盾：`resolveParkedCall` 调 `_deliverAwait(entry)` 无 waiter 时 `targets` 为空，不删——符合注释；但 `_handleAwait` 的 `_deliverAwait(entry, call)` 有 extraCall 会删。两处语义不一致，易误用。

[坏味道/建议] `_handleCall` 中 `call.name` 已 `replace(/^mcp_dsh_/, '')`，但 `_tryPark`/`_shouldPark` 传出的 `name` 是裸名；`PROTECTED_FROM_DEMOTION` 与 `AWAIT_RESULT_TOOL` 比较也用裸名——一致，但 `buildMcpToolBundle` 内 `source[i].name` 又重复 `replace` 一次（`toWireShape` 也 replace），三处重复剥离前缀，属 Duplicated Code。

[坏味道/建议] `_finishCall` 中 `if (payload && !call.disconnected)` 静默丢弃结果帧，但 `resolveParkedCall` 已把 entry 从 `parked` 删除并 `_promoteWaiting`，若此时 `disconnected` 为真，结果丢失且无日志——[实操风险] 断线重连场景下 DSH 结果被吞，agy 侧无感知。

[坏味道/建议] `boundReadResult` 的 `offsetMatch` 只匹配 `offset\s*[=:：]`，但 `READ_PAGING_WARNING` 文案是 `offset/limit`，若工具回执用 `offset/limit` 形式则匹配不到，续读行号从 0 起算——[边界漏洞] 行号错位。

[规范违规] 文件头注释称「协议层原样复制，source of truth 已移到本包」，但 `MAX_SCHEMA_DEPTH`、`collapseUnion` 等与 `sanitizeToolSchema` 的 `seen` 集合仅按 `$ref` 字符串去重，不区分引用上下文，循环引用检测可能误杀合法复用——无法核验上游实现是否一致。

[坏味道/建议] `_handle` 中 `tools/list` 分支重复了 `toWireShape` 的 name/description/inputSchema 组装逻辑（未复用 `toWireShape`），且未走 `buildMcpToolBundle` 的压缩闸——若 `getTools` 返回超预算工具表，此处直接全量下发，绕过 54KB 闸。

## Spec

[遗漏/部分实现]
- C1「路径 /mcp/<128bit-token>/<tenantKey> + Bearer 校验」：实现为「header 有则必须对，没有也放行」的软校验，Bearer 校验未按 Spec 强制。Spec 原句：「通过 128-bit 随机路径段与 Bearer 令牌实现进程级防误连与多租户路由」。
- C2「tools/call 立即刷 200 text/event-stream 与 :\n\n，每 15s 发 notifications/progress 或 : keepalive\n\n」：已实现；但 Spec 要求 `res.on('close', () => abort.abort(...))` 以在客户端断开时中止工具，交付物改为仅置 `disconnected = true`，未 abort。属实现偏差（见下）。
- C4「_resumeMcp 仅提取最新 delta 工具结果唤醒对应 CallRecord（不重发 session/prompt），对宿主漏回项补齐错误回执」：本文件为 McpBridge，`_resumeMcp`/`CallRecord`/`parkExit`/`bindings.commit`/`finish(tool-calls)` 均不在交付材料内，无法核验。
- D1「boundToolResult 严格收敛单条回执 <= 9,600 字节」：已实现；但 Spec 要求「read 类保头附分页续读提示，其余头 70% + 尾 30%」，交付物 read 分支在单行超预算时用 `sliceByBytes` 截半行，与「按完整行对齐」略有出入，属实现偏差。
- D5「TosWindow 首尾双 4,000 字窗口、consumeNotice、isCancelLeak、slot.wait(signal) 快退、aborted 后零 yield」：本文件不含这些逻辑，无法核验。
- A1~A5、B1~B4、D2~D4：均不在本文件范围，无法核验。

[越界/Scope Creep]
- `tools/list` 无条件追加 `AWAIT_RESULT_TOOL_DEF`（dsh_await_result），且注释称「不过 allowedTools 白名单」。Spec 要求 `_authorizePermission` 三重交集含「裸名存在于 turn.allowedTools 或等于 dsh_await_result」，即白名单仍应校验；此处桥层直接注入，绕过白名单语义。
- `_handleCall` 中 `if (this.parked.size > 0) this.waiting.push(call)` 的串行排队机制，Spec 未要求桥层串行化 tools/call；Spec 的并发收齐由 `collectParkBatch(250ms 滑动窗)` 在适配器侧完成。桥层额外串行可能改变并发工具调用的时序。
- `onCall`/`onRelay` 回调、`awaitingCountFor`/`awaitingCallIdsFor`/`failWaitingFor` 等 API 为 Spec 未列出的新增接口（可能为适配器所需，但 Spec 未定义）。

[实现偏差]
- Spec：「res.on('close', () => abort.abort(new Error('client-disconnected')))」；交付物：「res.on?.('close', () => { call.disconnected = true })」，未 abort，工具执行不会因客户端断开而中止。
- Spec：「tools/call 收到请求立即刷出 200 text/event-stream 响应头与首帧 :\n\n」——已符合；但 Spec 示例中 `_handleCall` 的 `finally` 必 `clearInterval(timer); res.end()`，交付物将收尾拆到 `_finishCall`，语义等价，不判偏差。
- Spec：「read 类保头附分页续读提示」要求按完整行对齐；交付物 `boundReadResult` 在 `!body.length` 时 `sliceByBytes(lines[start], bodyBudget)` 截半行，与「完整行」不符。
- Spec：「MAX_TOOL_RESULT_BYTES = 9,600」且「截断提示中的行号/字节数字按 10 位宽 9999999999 预留空间」——已实现（NUMBER_PAD）。
- Spec：「tools/list 只报裸名」——已实现（`replace(/^mcp_dsh_/, '')`）。
- Spec：「sanitizeToolSchema 解引用本地 $ref、折叠 anyOf/oneOf、剥离 $schema/$defs 元字段并限深 16 层」——已实现；但 `META_KEYS` 额外剥离 `title`、`examples`、`$anchor`、`$dynamicRef`、`$dynamicAnchor`，Spec 未列 `title`/`examples`，属轻微越界（不阻塞）。
- Spec：「三个 HTTP 超时全置 0」——已实现。
- Spec：「initialize 回传 protocolVersion: params.protocolVersion || "2024-11-05"」——已实现。

无法核验项：AgyAcpClient 全部（A1~A5、B1~B4）、AgyCliAdapter 全部（C3、C4、D2~D5）、`_resumeMcp`/`parkExit`/`bindings.commit`/`finish` 时序、`collectParkBatch`、`dsh_await_result` 85s 接力在适配器侧的 `suppressRelayText` 与 `mcp-relay-auto-continue`、图片顶层提权与 `mcp-image-handover-rebuild`、`isAuxiliaryRequest` 分流、`TosWindow`/`consumeNotice`/`isCancelLeak`、`slot.wait(signal)` 与 aborted 零 yield、`resolveModel` 22 模型与 `inputModalities`、`ctx.effect` 销毁联动、`ensureIsolatedGeminiDir` 播种与原子写盘、`gate-tools.cjs`/`hooks.json`/`dsh_bridge.md` 形状、`stop()` 三级停机与 taskkill。

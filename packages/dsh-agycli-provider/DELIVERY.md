## 项目概述

`@yg/dsh-agycli-provider` 用于将 Antigravity CLI（`agy.exe` 1.5.11，通过 `agy acp` 暴露的 ACP JSON-RPC 协议）接入 DSH，作为一条名为 `agycli` 的 LLM 渠道使用。

这个项目与常规“转发 HTTP 请求”的 provider 有本质区别：DSH 本身是一个 agent harness，而 agy 同样是一个具备工具调用能力的 agent。双方各自维护独立的推理循环，都要决定“何时结束当前轮次”以及“何时继续下一轮”。因此，整个适配器的核心工程难点不在于协议字段映射，而在于将两个异构的 agent 生命周期缝合在一起，使 DSH 能够接管工具执行权，同时让 agy 的长程推理状态不被打断。

---

## 架构与文件职责

项目代码分布在 `lib/` 目录下的 7 个核心文件中，总计约 4,101 行：

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/index.js` | 1657 | `AgyCliAdapter` 主体，向 `ctx.llm.registerAdapter(['agycli'], adapter)` 注册渠道；负责模型目录、请求分流、会话绑定自愈、park-and-resume 主循环、工具体积闸以及流内通知剥离 |
| `lib/agy-acp-client.mjs` | 633 | ACP JSON-RPC 客户端：拉起 agy 子进程、完成握手、`session/new`、`session/resume` 到 `load` 的回退、`set_model`、`promptStream` 以及权限应答 |
| `lib/mcp-bridge.mjs` | 1043 | 回环 MCP 桥（基于 `node:http` 绑定 `127.0.0.1:0`）：处理 `initialize` / `ping` / `tools/list` / `tools/call`、schema 净化、三级压缩、SSE 保活与结果收敛 |
| `lib/park.mjs` | 94 | `TurnStateStore`（LRU）与 `newTurnState`，维护会话级的流状态 |
| `lib/binding-store.mjs` | 285 | 会话绑定持久化，采用 `tmp + rename` 原子替换落盘 |
| `lib/session-tokens.mjs` | 209 | token 用量估算与主动轮换判据 |
| `lib/isolated-home.mjs` | 180 | 独立 `AGY_ISOLATED_HOME` 目录播种：生成 `settings.json`、agent 定义、hooks 与 gate 脚本 |

测试方面共包含 20 套脚本，全部通过 `node test-*.mjs` 直接运行，无外部依赖。其中 15 套自带断言计数，合计 251 条断言；其余 5 套为流程型验证，覆盖 `apply` 冒烟、真机端到端 park、环境播种、代理发现以及插件装载。

---

## 关键设计

### 1. park-and-resume 生命周期缝合

在 agy 的视角里，一整轮包含多次工具调用的推理只是一次尚未结束的 `session/prompt`；而在 DSH 的视角里，每次工具调用都必须结束当前的 `stream()`，向宿主吐出 `tool-call`，待宿主执行完毕后，再由下一轮 `stream()` 携带 `tool-result` 回来。

为了解决这个模型冲突，适配器在 `lib/park.mjs` 中引入了 Per-Session 的 `TurnState`，配合一个跨步存活的后台泵：
- 当后台泵检测到 agy 发起工具调用时，并不结束底层的 `session/prompt`，而是先将该调用挂起（park），随后向 DSH 吐出 `finish: tool-calls` 结束当前轮次。
- 当 DSH 带着工具执行结果进入下一轮 `stream()` 时，适配器只从增量（delta）中提取工具结果并回填给挂起的调用，**绝不重发 `session/prompt`**，从而让 agy 的推理流无缝续接。

### 2. 权限三重交集

agy 发起的每一次工具调用都必须经过 `_authorizePermission` 的校验，只有同时满足以下三条才允许放行：
1. **归属活跃 Turn**：该调用能够按 `acpSessionId` 找到对应的活跃 Turn，且该 Turn 未被放弃或退役。
2. **来源合法**：工具名带有 `mcp_dsh_` 前缀，或明确来自名为 `dsh` 的 MCP server。
3. **当轮白名单命中**：工具裸名位于当轮允许列表内（内部中继工具豁免）。

三条条件取交集，任意一条不满足即返回 `{ outcome: { outcome: "cancelled" } }`。这样做的取舍是：适配器本身不再对工具做二次静态裁剪，而是把真正的授权边界交给 DSH 宿主沙箱与运行时的三重交集校验。

### 3. 工具 Schema 归一化与两级体积闸

DSH 定义工具时采用扁平映射格式（`parameters: { file_path: { type, required: true } }`），`required` 写在属性内部；而 MCP/ACP 协议要求标准的 JSON Schema 形态（`{ type: 'object', properties: {...}, required: [...] }`）。

`lib/mcp-bridge.mjs` 通过 `toolSchemaOf()` 将 `inputSchema`、`parameters`、`schema` 三种来源统一归一化，把属性内部的 `required: true` 提取到顶层 `required` 数组中。

在此基础上，针对协议与模型的承载上限，桥接层设置了两级体积闸：
- **整包工具表压缩**：上限压至 ≤ 54,000 字节，采用三级递进压缩（单工具预压 → 描述裁剪 → 仅保留属性名、类型与 `required`）。被降级的工具会写入 `systemPromptAppend` 补偿段（≤ 16 条、≤ 6000 字），避免模型完全丢失工具语义。
- **单条回执收敛**：单条工具返回结果收敛至 ≤ 9,600 字节，刻意避开 10,240 字节的协议悬崖。

### 4. 隔离 Home 与零凭据原则

每个账号固定分配一个独立的 `AGY_ISOLATED_HOME` 目录，由 `lib/isolated-home.mjs` 在其中播种运行环境：
- `settings.json`：配置 `contextWindow` 为 900K，`toolPermission` 为 `request-review`。
- agent 定义：开启 `inheritMcp: true`。
- `PreToolUse` 钩子：只放行 `mcp_dsh_*` 前缀的工具调用，且设置 4 秒超时即拒的硬限制。

整个隔离机制不读写任何 OAuth token 或系统凭据，确保多账号与宿主环境之间的状态隔离。

### 5. 主动轮换机制

实测表明，agy 单会话在累积约 469 个内部步骤后会永久卡死。为了避免触及这条死线，`lib/session-tokens.mjs` 与主循环配合实施主动轮换：当单会话满 200 轮，或会话 token 用量达到 660,602（即 `786,432 × 0.84`）时，适配器会平滑切换至新会话，并重发全量历史以维持上下文连续性。

---

## 踩坑复盘

### 坑 1：新建会话面板里看不到新增的 preset
- **现象**：配置文件中已经写入了自定义 preset，但 DSH 的新建会话 UI 列表中完全不显示。
- **根因**：DSH 的 loader patch 语法中，顶层 `- id: xxx` 的语义是**覆盖已有 entry**。若要新增 entry，必须将其包裹在 `- insert:` 下，且同时提供 `name` 和 `description`。写在顶层会被系统判定为“覆盖一个不存在的 entry”并静默丢弃。
- **修法**：将配置改为 `- insert:` 嵌套结构，并补齐 `name`、`description` 与 `order` 字段。

### 坑 2：模型只收到时间戳，用户输入凭空消失
- **现象**：前台反馈模型回复“等了半天只收到一串时间戳和空消息”。
- **根因**：`contentText()` 原本只处理 `string` 和 `Array` 两种消息内容形态。但 DSH 某些代码路径传给 adapter 的 `content` 是**单个 block 对象**（`{ type: 'text', text: '...' }`），导致整条用户消息被渲染为空字符串。
- **修法**：在 `contentText()` 中增加分支判断，单对象形态也统一走 `blockText()` 提取文本。

### 坑 3：工具全部挂不上，模型只能纯文本对话
- **现象**：preset 中配置了 `fs-search`、`subagent`、`todo` 等工具，但模型侧完全不可见。
- **根因**：代码中存在硬编码常量 `DEFAULT_ALLOWED_TOOLS = ['read']`，导致 `_mountTools()` 在挂载阶段把除 `read` 之外的所有工具静默过滤掉。
- **修法**：将默认行为改为“不额外过滤”（`allowedTools` 为 `null` 时全量接收），将权限边界交还给 DSH 沙箱与 `_authorizePermission` 三重交集。代价是 adapter 层不再掌握静态的工具全貌，排查权限问题时需结合宿主配置一起看。

### 坑 4：修改源码后，运行时行为没有任何变化
- **现象**：反复修改源码并重启，日志和行为始终停留在旧版本。
- **根因**：DSH 实际加载的是 profile 目录下 `node_modules` 中的**拷贝副本**，而非开发源码目录。当时两个 `index.js` 的文件体积相差 6 倍（9,647 字节 vs 62,438 字节）。
- **修法**：建立“修改源码后必须同步到 profile”的固定操作规范，并补充了插件装载冒烟测试用于核验。

### 坑 5：渠道从模型下拉列表消失，但插件状态显示“启用中”
- **现象**：插件在 UI 中显示绿色“启用中”，但模型列表里找不到 `agycli` 渠道。
- **根因**：cordis 框架中，未在 `inject` 中声明的服务**直接读取就会抛出异常**。代码中存在一行裸读 `ctx.attachments ?? ctx.get?.('attachments')`，触发了 `cannot get property "attachments" without inject` 错误，直接炸断了整个 `ctx.inject(['llm'], cb)` 回调，导致渠道压根没有注册。而 cordis 将此类异常视为软失败，插件状态依然维持正常。
- **修法**：在 `apply()` 中通过环境变量开关 `AGYCLI_TRACE=<file>` 落盘诊断堆栈才定位到该问题。修法不是给 `attachments` 补一个 `inject` 声明（那会变成"缺服务就让整个渠道挂起"），而是**把 `??` 左边那半行删掉**——可选服务统一走 `ctx.get('attachments')`，服务没装时它老实返回 `undefined`，不会抛异常。关键在于运算符求值顺序：`??` 左边先求值、先炸，右边的 `ctx.get()` 根本轮不到执行。

### 坑 6：工具声明只剩占位字段，真实参数全部丢失
- **现象**：模型反馈“工具声明里只剩一个 `toolSummary` 字段”；调用时不传 `file_path` 报错 `missing required property "file_path"`，传了又报错 `additional properties 'file_path' not allowed`。
- **根因**：如关键设计第 3 节所述，桥接层原本只识别 `inputSchema`，遇到 DSH 的 `parameters` 格式便将其当作“无参数”处理，导致生成的参数表为空。
- **修法**：引入 `toolSchemaOf()` 做统一归一化，确保 `tools/list`、线上形状构造与压缩闸三处全部走同一套解析逻辑，并新增了包含 23 条断言的 schema 专项测试（专门验证胖工具被压到只剩属性名时 `file_path` 依然保留）。

### 坑 7：冷审工具无法运行
- **现象**：执行冷审时返回 `HTTP 402 Insufficient Balance`。
- **根因**：凭证文件中排在前面的官方 DeepSeek key 余额为 -0.02 元（已欠费），而同一文件内的另一个 key 仍有 6.34 元余额，审查工具默认优先读取了欠费的 key。
- **修法**：编写换 key 的变体脚本跑通了规范/规格两轴审查。审查共发现并当场修复了 2 条真实问题（见坑 8 补充的绑定固化与硬编码路径问题），同时驳回了 4 条误判（例如“tools/list 绕过体积闸”并不成立，因为 `getTools` 返回的本就是压缩后的工具表）。

### 坑 8：验收清单中的三项历史遗留未落实
- **现象**：`preTurn` 预登记、`pinFirstSegment` 首段保护以及 GIF 转码三项机制一直停留在待办状态；此外还存在 park 退出前未固化绑定、agy 运行时根目录写死绝对路径的问题。
- **根因与修法**：
  1. **preTurn 预登记**：原本 Turn 在 `session/new` 之后才创建，若 agy 在建会话瞬间抢先发起工具调用会查无此 Turn。现将建 Turn 提前到 `session/new` 之前，先入册再建会话，成功后再将 `acpSessionId` 就地回填给同一个对象，失败路径则删除预登记。
  2. **pinFirstSegment**：漂移重建时未开启首段保护。现于 `session/new` 的 `_meta.antigravity` 下挂载 `pinFirstSegment: true`（不放在顶层，避免陌生字段触发 `-32602` 错误）。
  3. **GIF 转码**：原本动图一律降级为文字占位。现改为先动态 `import('sharp')` 尝试抽取首帧转 PNG，探测结论只计算一次，若无转码器则降级。
  4. **绑定固化与路径推导**：park 退出前先将绑定固化落盘再吐出 `finish`；agy 运行时根目录改为按环境推导，不再写死单机绝对路径。

---

## 上线后补的两处暗礁

### 坑 9：只守字符顶，撞上 ACP 的 192KB 字节墙

- **现象**：短会话一切正常，长会话或多模态会话发不出去，底层直接挡回请求。
- **根因**：`MAX_PROMPT_CHARS = 60_000` 是**按字符**算的，但 ACP 请求体是 192KB **字节**墙。中文一个字 3 字节，六万字符就是 180KB，再叠一张图的 base64 立刻越线。轮换重建时重发全量历史最容易踩这条——恰恰是最需要稳定的时刻。
- **修法**：双顶守护。`renderPrompt()` 里同时守 `MAX_PROMPT_CHARS` 和 `MAX_PROMPT_BYTES`（176,000，给 ContentBlock 包装与 JSON 转义留 16KB），截断走 `truncateToBytes()` 按 UTF-8 边界切，绝不切断多字节字符（切出半个汉字会让整包 JSON 变形）。图片 base64 的字节通过 `reserveBytes` 从正文预算里**提前扣掉**，而不是事后补救。
- **代价**：图片越多，正文被压得越狠。这是对的取舍——宁可少喂点历史，也不要把整轮对话弄失败。

### 坑 10：并发 stream 没有串行槽，中止还可能把锁焊死

- **现象**：同一会话两个请求同时进来会互相踩状态；用户中途点中止后，后续请求可能永远等不到。
- **根因**：原先只做了"辅助请求旁路"，没有做"主请求串行化"。教程要求的 `slot.wait(signal)` 排队竞速一直缺席。
- **修法**：新增 `StreamGate`，按会话粒度串行。两个细节比排队本身更要紧：① 排队期间被中止，必须**当场从队列里摘掉**并抛 `ABORTED`，否则被弃的请求会一直占位，槽变成僵尸锁；② 释放时把锁**直接过继给队首**（不下沉 `holders`），避免"释放—重新抢占"的窗口被新来的插队。释放函数幂等，`finally` 里多调一次也不会放掉别人的锁。辅助请求（标题生成、压缩）仍然不占槽——它基本瞬间结束，排队只会把标题生成拖到超时。

### 附：模型表不再是纯静态

不同账号的 agy 模型池本来就不一样（同一个版本，有的号是 `gemini-4-neon-*`，有的是 `gemini-4-carbon-*`）。现在启动时异步跑一次 `agy models` 与静态表取并集：静态表打底（顺序和标签自己维护）、实测表补齐。拉表是联网操作，**绝不 `await` 在插件装载路径上**，失败就静默退回静态表——宁可少几个模型，也不能因为拉表失败让渠道起不来。

---

## 给 agy acp 同行的三条协议层硬坑

这三条不是自家实现的选择问题，而是**任何把 `agy acp` 长会话通道接进 agent harness 都会撞**的协议层特性。抄过去能省一周抓狂。

### 一、盯死 mcp-resume 之后的「静默掉思考链」，别只盯报错

走 session-reuse + 反复 mcp-park / mcp-resume 的组合时，底层上下文很容易悄无声息滚到 25–30 万 token。整个过程 **0 报错、0 降档**，然后在某次 mcp-resume 之后突然出现 `reasonChars: 0`——明明开着 high/xhigh，却只吐几十个思考 token。

监控层必须加一条异常规则：**开了高思考档 + 单轮思考量骤降 + 同轮带写工具调用**，三个条件同时成立直接标红。只看报错是抓不到的，它压根不报错。

对应到本实现：`_consume` 里已经接住了 `reasoning` 事件，接下来要补的是"本轮 reasonChars 与上一轮比对"的埋点，以及触发时的显式告警（当前只记录了思考档位，没有做骤降判定）。

### 二、在 agent_message_chunk 和 request_permission 之间焊一道保留字熔断

这是最阴的一条。agy 把历史多轮和系统回调**拍平进纯文本**投给模型，Gemini 一旦掉了思考链，就会在 `agent_message_chunk` 里自导自演续写系统回执——例如 `Background subagent ... finished`、`[assistant]`、`</USER_REQUEST>`——而且紧接着**在同一次 `session/prompt` 里发起真实 tool_call**。自动权限回调只要一放行，它就直接真改盘、真写记忆。

最稳的防法不是"检测到就重试"，而是**当场掐停**：

1. 流式扫到系统保留句式 → 立刻 `session/cancel` 结束本轮；
2. 同时给这一轮打上标记，后续所有 `session/request_permission` 一律拒绝；
3. 外加单条 ACP 会话过 18–20 万 token 就主动轮换新会话，别硬顶到 30 万（顶到那儿时模型已经在梦游了）。

本实现已落地：`detectSystemEcho()` 按行匹配 `Background subagent ... finished` / `[assistant]` / `[user]` / `USER_REQUEST` / `tool_result` / `function_calls` 等句式，命中即标 `turn.echoDetected`、调 `cancel()`、跳出消费循环；`_authorizePermission()` 在 `turn.echoDetected` 为真时**直接返回 false**，不给人任何"放行一次试试"的机会。

### 三、重建历史时，旧用户附图必须按热窗切掉

重启后冷建新 ACP session 重放历史（`isRebuild`）时，如果只跳过"旧轮的工具图"、漏拦**早先用户消息里的旧附图引用**，远古截图会被重新打包塞进重启首轮——上游 `antigravity-cli` 会给它盖上**最新时间戳**，标成「用户刚上传了 1 张图」，模型就信以为真当成这轮的新图。

本实现原先只按"最后一条带图消息"保留图片，这是个隐蔽的错：重启后的第一轮往往是纯文本，所谓"最后一条带图消息"其实是远古截图，照样被重发。现已改成**按热窗保留**（`REBUILD_IMAGE_HOT_WINDOW = 6`）——只有最近 6 条消息里的图才进包，热窗外的一律折叠成 `[历史工具图片已折叠]`，连字节都不读。

---

## 验收结果

- **自动化测试**：20 套 `test-*.mjs` 脚本全部以退出码 0 通过，其中 15 套带计数测试合计 251 条断言全部通过。
- **插件装载**：profile 已完成同步，装载冒烟实测输出 `registered route "agycli" (23 models)`，且 `listProviders -> ["agycli"]`，`apply()` 全程无异常告警。
- **真机链路**：端到端验证确认用户消息不再丢失，工具调用可完整走通“MCP 桥接 → DSH 执行 → 结果回填”的闭环。

---

## 已知限制与后续

1. **GIF 转码依赖 `sharp`**：当前运行环境未安装 `sharp`，因此动图仍会降级为文字占位。代码中探测逻辑已就位（动态 `import('sharp')` 抽首帧转 PNG，探测结论只算一次），安装 `sharp` 后即可自动生效。
2. **模型表并集依赖 `agy models` 可连通**：拉表要过代理，若启动时网络不通就退回静态的 23 条——那一刻账号池里多出来的模型（例如 `carbon` 系列）在本次进程生命周期内不可见。重启一次即可恢复。

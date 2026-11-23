// McpBridge —— 零依赖 Loopback Streamable-HTTP MCP 桥。
// 源头：profiles/web/agy-runtime/mcp-bridge.mjs（协议层原样复制，source of truth 已移到本包）。
// 本包 fork 的差异只有 Park-and-Resume：
//   - tools/call 不再一律内联 await，可挂起（park）等 DSH 执行完再回填
//   - Bearer 改软校验：路径里的 32hex token 已是能力密钥，header 有则必须对，没有也放行
//   - stop() 会把所有挂起/排队响应收干净，不留 dangling socket
//
// 绑定 127.0.0.1:0，路由 /mcp/<32hex token>/<tenantKey>。
// 实现 initialize / ping / tools/list / tools/call + 三个空列表兼容方法。
import http from 'node:http'
import crypto from 'node:crypto'

export const MAX_SCHEMA_DEPTH = 16

const META_KEYS = new Set([
  '$schema', '$id', '$defs', 'definitions', '$ref', '$comment', 'not',
  '$anchor', '$dynamicRef', '$dynamicAnchor', 'examples', 'title',
])

// ---- 展平 anyOf/oneOf 的 null 分支，多对象分支合并 properties ----
function collapseUnion(branches) {
  const nonNull = []
  let nullable = false
  for (const b of branches) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'null') { nullable = true; continue }
    nonNull.push(b)
  }
  if (nonNull.length === 1) {
    const only = { ...nonNull[0] }
    if (nullable) only.nullable = true
    return only
  }
  if (nonNull.length === 0) return { nullable: true }

  const props = {}
  let requiredIntersection = null
  const types = []
  for (const b of nonNull) {
    if (b.type && typeof b.type === 'string' && !types.includes(b.type)) types.push(b.type)
    if (b.properties && typeof b.properties === 'object') Object.assign(props, b.properties)
    if (Array.isArray(b.required)) {
      requiredIntersection = requiredIntersection === null
        ? new Set(b.required)
        : new Set([...requiredIntersection].filter((k) => b.required.includes(k)))
    }
  }
  const out = {}
  if (types.length === 1) out.type = types[0]
  else if (types.length > 1) out.type = types
  if (Object.keys(props).length) out.properties = props
  if (requiredIntersection && requiredIntersection.size) out.required = [...requiredIntersection]
  if (nullable) out.nullable = true
  return out
}

// ---- 工具表三级 Schema 压缩闸（教程 §5.1 / Checklist D1）----
// 两条 agy 侧隐式硬悬崖：
//   tools/list 总包 > ~54KB  → agy 静默丢弃部分工具
//   单次工具回执 > 10,240B    → agy 中段硬切，行号错位 / JSON 损坏
export const MAX_MCP_TOOLS_TOTAL_BYTES = 54_000
export const MAX_TOOL_RESULT_BYTES = 9_600
// 单工具预压目标（§5.1 第 1 条）
export const TOOL_PRE_COMPACT_BYTES = 1_350
// 补偿段上限（§5.1 第 3 条）
export const MAX_COMPENSATION_ENTRIES = 16
export const MAX_COMPENSATION_CHARS = 6_000

// 各 Stage 的描述预算：主描述，以及子属性描述（0 = 全删）
const STAGE_MAIN_DESC_LIMIT = [1_024, 220, 140, 48]
const STAGE_CHILD_DESC_LIMIT = [Infinity, 90, 0, 0]

// read / view 类工具：Stage 0 自动追加分页警示；回执走「保头 + 续读提示」分支
const READ_LIKE_RE = /(^|_)(read|view)(_|$)/
const READ_PAGING_WARNING = '\n\n分页读取：大文件请务必带 offset/limit 分页，单次回执超 9,600 字节会被截断。'

// 关键内置工具：任何闸都不许降级（降了模型就调不动中继）
export const PROTECTED_FROM_DEMOTION = new Set(['dsh_await_result'])

// ---- C4 接力中继（教程 §4.2 最后两条）----
/** 挂起 85 秒还没跑完：先给 agy 一段「还在跑」提示，让它改用 await 工具接着等。 */
export const RELAY_AFTER_MS = 85_000
/** 最多接力 8 轮；超了就不再吊着 agy，回硬失败让它自己收尾。 */
export const MAX_TOOL_RELAYS = 8
/** 内置中继工具的裸名（agy 侧会加 mcp_dsh_ 前缀）。 */
export const AWAIT_RESULT_TOOL = 'dsh_await_result'

/** 内置中继工具定义：永远挂在 tools/list 末尾，且不受压缩闸约束。 */
export const AWAIT_RESULT_TOOL_DEF = {
  name: AWAIT_RESULT_TOOL,
  description:
    '等待一个仍在 DSH 侧执行的工具调用返回结果。某个 MCP 工具回「still running」并给出 call_id 时，'
    + '立刻用同一个 call_id 调本工具：结果若已就绪会零延迟返回，否则继续等下一轮。',
  inputSchema: {
    type: 'object',
    properties: {
      call_id: { type: 'string', description: '上一次「still running」提示里给出的 call_id' },
    },
    required: ['call_id'],
  },
}

export function relayNoticeText(name, callId, round) {
  return (
    `Tool ${name} is still running in the harness (call_id: ${callId}, round ${round}/${MAX_TOOL_RELAYS}). `
    + `Call mcp_dsh_${AWAIT_RESULT_TOOL} with {"call_id": "${callId}"} immediately to keep waiting; `
    + 'do not end the turn.'
  )
}

export function relayExpiredText(name, callId, round) {
  return (
    `Tool ${name} (call_id: ${callId}) still has not returned after ${round} relay rounds. `
    + 'Stop waiting for it and explain to the user that the tool appears stuck.'
  )
}

export function relayUnknownText(callId) {
  return `没有 call_id=${callId} 的待接力调用（可能已经返回、已过期，或 call_id 写错）。`
}

// 截断提示里的行号 / 字节数按 10 位宽预留，防止提示自身二次超限
const NUMBER_PAD = '9999999999'

const byteLen = (s) => Buffer.byteLength(String(s ?? ''), 'utf8')

function truncateChars(text, limit) {
  const s = String(text ?? '')
  if (!Number.isFinite(limit) || s.length <= limit) return s
  if (limit <= 3) return s.slice(0, Math.max(0, limit))
  return s.slice(0, limit - 3) + '...'
}

export function isReadLikeTool(name) {
  return READ_LIKE_RE.test(String(name || '').toLowerCase().replace(/^mcp_dsh_/, ''))
}

// 只保留顶层属性名 + 基础类型 + required（Stage 3 专用）
export function stripSchemaForStage3(schema) {
  const clean = sanitizeToolSchema(schema || {})
  const properties = {}
  for (const [key, value] of Object.entries(clean.properties || {})) {
    if (!value || typeof value !== 'object') { properties[key] = {}; continue }
    const slim = {}
    if (typeof value.type === 'string') slim.type = value.type
    else if (Array.isArray(value.type)) slim.type = value.type
    properties[key] = slim
  }
  const out = { type: 'object', properties }
  if (Array.isArray(clean.required) && clean.required.length) out.required = [...clean.required]
  return out
}

// 工具定义理论上都是 JSON 可克隆的；万一带函数 / 循环引用，别让整包构建炸掉
function cloneTool(tool) {
  try {
    return structuredClone(tool)
  } catch {
    return JSON.parse(JSON.stringify(tool ?? {}))
  }
}

function limitChildDescriptions(schema, limit, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > MAX_SCHEMA_DEPTH) return
  if (schema.properties && typeof schema.properties === 'object') {
    for (const child of Object.values(schema.properties)) {
      if (child && typeof child === 'object' && typeof child.description === 'string') {
        child.description = truncateChars(child.description, limit)
      }
      limitChildDescriptions(child, limit, depth + 1)
    }
  }
  if (schema.items && typeof schema.items === 'object') limitChildDescriptions(schema.items, limit, depth + 1)
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) for (const branch of schema[key]) limitChildDescriptions(branch, limit, depth + 1)
  }
}

function removeChildDescriptions(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > MAX_SCHEMA_DEPTH) return
  if (schema.properties && typeof schema.properties === 'object') {
    for (const child of Object.values(schema.properties)) {
      if (child && typeof child === 'object') {
        delete child.description
        removeChildDescriptions(child, depth + 1)
      }
    }
  }
  if (schema.items && typeof schema.items === 'object') removeChildDescriptions(schema.items, depth + 1)
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) for (const branch of schema[key]) removeChildDescriptions(branch, depth + 1)
  }
}

/**
 * 单工具分级压缩。纯函数，不污染入参。
 * stage 0：完整 Schema + 主描述 <= 1,024 字（read/view 类追加分页警示）
 * stage 1：主描述 <= 220 字、子属性描述 <= 90 字，参数结构完整保留
 * stage 2：主描述 <= 140 字、子属性描述全删，属性名与 required 一个不动
 * stage 3：主描述 <= 48 字，Schema 只留顶层属性名 / 基础类型 / required
 */
export function compactBridgeTool(tool, stage) {
  const s = Math.max(0, Math.min(3, Number(stage) || 0))
  // cloneTool 避免引用污染
  const clone = cloneTool(tool)
  const name = String(clone.name || '')

  // Stage 0 的 read/view 分页警示：先给警示留位，再截正文（幂等，重复压缩不会叠两遍）
  if (s === 0 && isReadLikeTool(name) && !String(clone.description || '').includes('offset/limit')) {
    const room = Math.max(0, STAGE_MAIN_DESC_LIMIT[0] - READ_PAGING_WARNING.length)
    clone.description = truncateChars(clone.description || '', room) + READ_PAGING_WARNING
  } else {
    clone.description = truncateChars(clone.description || '', STAGE_MAIN_DESC_LIMIT[s])
  }

  const schema = clone.inputSchema
  if (schema && typeof schema === 'object') {
    if (s === 1) limitChildDescriptions(schema, STAGE_CHILD_DESC_LIMIT[1])
    else if (s === 2) removeChildDescriptions(schema)
    else if (s >= 3) clone.inputSchema = stripSchemaForStage3(schema)
  }
  if (s < 3 && (!clone.inputSchema || typeof clone.inputSchema !== 'object')) {
    clone.inputSchema = { type: 'object', properties: {} }
  }
  return clone
}

/**
 * 从 DSH 的工具定义里取出参数 schema，并归一化成标准 JSON Schema。
 *
 * DSH 的 defineTool 用的是 `parameters: { file_path: { type, required: true, ... } }`
 * —— 扁平映射，`required` 写在属性内部。而 MCP/ACP 要的是
 * `{ type:'object', properties:{...}, required:[...] }`。
 * 以前只认 `inputSchema`，于是每个工具都被当成「无参数」，模型只能瞎传：
 * 要么漏 required 报 missing，要么被 additional properties 拒掉。
 */
export function toolSchemaOf(tool) {
  const src = tool && typeof tool === 'object' ? tool : {}
  const raw = src.inputSchema ?? src.parameters ?? src.schema ?? null
  if (!raw || typeof raw !== 'object') return { type: 'object', properties: {} }
  // 已经是标准 schema（带 type 或 properties）就直接用
  if (raw.type === 'object' || (raw.properties && typeof raw.properties === 'object')) return raw
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      properties[key] = value
      continue
    }
    const { required: isRequired, ...rest } = value
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  const out = { type: 'object', properties }
  if (required.length > 0) out.required = required
  return out
}

// 线上真正发给 agy 的形状：裸名 + 描述 + 净化后的 Schema
function toWireShape(tool) {
  const source = tool && typeof tool === 'object' ? tool : {}
  return {
    name: String(source.name ?? '').replace(/^mcp_dsh_/, ''),
    description: String(source.description ?? ''),
    inputSchema: sanitizeToolSchema(toolSchemaOf(source)),
  }
}

function wireTool(tool, stage) {
  return toWireShape(compactBridgeTool(tool, stage))
}

/** 单个工具的真实 UTF-8 字节数（按发出去的 JSON 形状算，不是字符数） */
export function wireToolBytes(tool) {
  return byteLen(JSON.stringify(toWireShape(tool)))
}

/** 整张工具表的真实 UTF-8 字节数（按发出去的 JSON 形状算，不是字符数） */
export function wireToolsBytes(tools) {
  const wire = (Array.isArray(tools) ? tools : []).map(toWireShape)
  return byteLen(JSON.stringify({ tools: wire }))
}

function describeParams(schema) {
  if (!schema || typeof schema !== 'object') return ''
  const props = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : []
  if (!props.length) return ''
  const required = (Array.isArray(schema.required) ? schema.required : []).filter((k) => props.includes(k))
  const optional = props.filter((k) => !required.includes(k))
  const parts = []
  if (required.length) parts.push(`必填 ${required.slice(0, 8).join(', ')}${required.length > 8 ? ' …' : ''}`)
  if (optional.length) parts.push(`可选 ${optional.slice(0, 6).join(', ')}${optional.length > 6 ? ' …' : ''}`)
  return parts.length ? `（${parts.join('；')}）` : ''
}

/**
 * 补偿段生成器：纯文本函数，只负责排版，不碰 systemPromptAppend。
 * 收集 demoted 工具 → 按压缩等级倒序取前 16 条 → 总长硬控 <= 6,000 字符。
 */
export function buildCompensationSection(tools) {
  const demoted = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== 'object') continue
    const stage = Number(tool.demoteStage ?? tool.stage ?? 0) || 0
    if (tool.demoted === true || stage > 0) demoted.push({ tool, stage })
  }
  if (!demoted.length) return ''

  demoted.sort((a, b) => (b.stage - a.stage) || String(a.tool.name).localeCompare(String(b.tool.name)))
  const picked = demoted.slice(0, MAX_COMPENSATION_ENTRIES)

  const header = '## 被压缩 MCP 工具的完整说明'
  const intro = '（下列工具的 Schema 描述已被压缩；参数结构与 required 未改动，按以下说明传参。）'

  const build = (descLimit) => {
    const lines = picked.map(({ tool }) => {
      const description = truncateChars(String(tool.fullDescription || tool.description || ''), descLimit)
        .replace(/\s+/g, ' ')
        .trim()
      const params = describeParams(tool.inputSchema)
      return `- ${tool.name}${params}${description ? ': ' + description : ''}`
    })
    return [header, intro, ...lines].join('\n')
  }

  let descLimit = 400
  let text = build(descLimit)
  while (text.length > MAX_COMPENSATION_CHARS && descLimit > 40) {
    descLimit = Math.floor(descLimit / 2)
    text = build(descLimit)
  }
  // 极端兜底：整条整条往下砍，绝不切碎标题；两行都不够时最后硬截一次
  if (text.length > MAX_COMPENSATION_CHARS) {
    const lines = text.split('\n')
    while (lines.length > 2 && lines.join('\n').length > MAX_COMPENSATION_CHARS) lines.pop()
    text = lines.join('\n')
  }
  if (text.length > MAX_COMPENSATION_CHARS) {
    let cut = MAX_COMPENSATION_CHARS
    if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut -= 1 // 别切碎代理对
    text = text.slice(0, cut)
  }
  return text
}

/**
 * 全包预算闸：单工具先预压到 1,350 字节以内（stage 0→1→2），
 * 再按 sanitizeToolSchema 之后的真实 UTF-8 总字节数压总包 <= 54,000。
 * Stage 3 是包级紧急手段（只留属性名 / 基础类型 / required），只由总预算闸触发。
 */
export function buildMcpToolBundle(tools) {
  const source = (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: String(tool?.name || '').replace(/^mcp_dsh_/, ''),
    description: String(tool?.description || ''),
    inputSchema: toolSchemaOf(tool),
  }))
  const stages = new Array(source.length).fill(0)

  // 1) 单工具预压：目标 1,350 字节，0 → 1 → 2（关键内置工具原样放行）
  for (let i = 0; i < source.length; i++) {
    const name = String(source[i].name || '').replace(/^mcp_dsh_/, '')
    if (PROTECTED_FROM_DEMOTION.has(name)) continue
    while (stages[i] < 2) {
      const current = wireToolBytes(wireTool(source[i], stages[i]))
      if (current <= TOOL_PRE_COMPACT_BYTES) break
      const next = wireToolBytes(wireTool(source[i], stages[i] + 1))
      // 降了不省字节就别白降
      if (next >= current) break
      stages[i] += 1
    }
  }

  // 保护工具免的是「降级」（Stage 1/2/3），Stage 0 的基线裁剪仍生效：
  // 否则一条超长描述能顶爆 54KB 总预算，而总闸又压不动它
  const materialize = () => source.map((tool, i) => wireTool(tool, stages[i]))
  let wire = materialize()
  let totalBytes = wireToolsBytes(wire)

  // 2) 全包总预算闸：跳过关键内置工具，其余按字节数从大到小依次降级
  //    降级时只做增量记账，不重算整包（工具多时全量重算会卡秒级）
  if (totalBytes > MAX_MCP_TOOLS_TOTAL_BYTES) {
    const order = wire
      .map((tool, index) => ({ index, bytes: byteLen(JSON.stringify(tool)), name: tool.name }))
      .filter((entry) => !PROTECTED_FROM_DEMOTION.has(entry.name))
      .sort((a, b) => b.bytes - a.bytes)
    for (const target of [2, 3]) {
      if (totalBytes <= MAX_MCP_TOOLS_TOTAL_BYTES) break
      for (const entry of order) {
        if (totalBytes <= MAX_MCP_TOOLS_TOTAL_BYTES) break
        const i = entry.index
        if (stages[i] >= target || stages[i] >= 3) continue
        const before = byteLen(JSON.stringify(wire[i]))
        stages[i] = target
        wire[i] = wireTool(source[i], stages[i])
        const after = byteLen(JSON.stringify(wire[i]))
        totalBytes += after - before
        entry.bytes = after
      }
    }
    // 收口复核：增量记账万一漂了，以真实序列化结果为准
    totalBytes = wireToolsBytes(wire)
  }

  // 3) 落 demoted / demoteStage 留痕；原始描述留在 fullDescription 里供补偿段用。
  //    复用第 2 步已经压好的 wire，不再重算一遍（工具多时那是纯浪费）。
  const out = wire.map((tool, i) => ({
    ...tool,
    demoted: stages[i] > 0,
    demoteStage: stages[i],
    fullDescription: source[i]?.description || '',
  }))

  return {
    tools: out,
    systemPromptAppend: buildCompensationSection(out),
    totalBytes,
    overBudget: totalBytes > MAX_MCP_TOOLS_TOTAL_BYTES,
  }
}

// ---- 工具回执硬收敛（<= 9,600 字节）----
function sliceByBytes(text, maxBytes) {
  const s = String(text ?? '')
  if (maxBytes <= 0) return ''
  if (byteLen(s) <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (byteLen(s.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let end = lo
  if (end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1])) end -= 1 // 不切断代理对
  return s.slice(0, end)
}

function sliceTailByBytes(text, maxBytes) {
  const s = String(text ?? '')
  if (maxBytes <= 0) return ''
  if (byteLen(s) <= maxBytes) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (byteLen(s.slice(s.length - mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  let startIdx = s.length - lo
  if (startIdx < s.length && /[\uDC00-\uDFFF]/.test(s[startIdx])) startIdx += 1
  return s.slice(startIdx)
}

// 从头部累计整行（不含被截断的半行）
function headLines(lines, start, endExclusive, budgetBytes) {
  const out = []
  let used = 0
  for (let i = start; i < endExclusive; i++) {
    const add = byteLen(lines[i]) + (out.length ? 1 : 0)
    if (used + add > budgetBytes) break
    out.push(lines[i])
    used += add
  }
  return out
}

// 从尾部倒着累计整行
function tailLines(lines, start, endExclusive, budgetBytes) {
  const out = []
  let used = 0
  for (let i = endExclusive - 1; i >= start; i--) {
    const add = byteLen(lines[i]) + (out.length ? 1 : 0)
    if (used + add > budgetBytes) break
    out.unshift(lines[i])
    used += add
  }
  return out
}

// read / view 类：保 <content> 信封头 + 从头对齐的完整行 + 精确续读提示
function boundReadResult(rawText) {
  const lines = rawText.split('\n')
  let header = ''
  let closing = ''
  let start = 0
  let end = lines.length
  if (end > 0 && /^\s*<content>\s*$/i.test(lines[0])) { header = lines[0]; start = 1 }
  if (end > start && /^\s*<\/content>\s*$/i.test(lines[end - 1])) { closing = lines[end - 1]; end -= 1 }

  // 原始回执若在信封头带了 offset，续读行号接着它走。
  // 只看正文之前的那一行，防止正文内容里的 offset= 数字把行号带偏。
  const headArea = lines.slice(0, Math.max(1, start)).join('\n')
  const offsetMatch = headArea.match(/offset\s*[=:：]\s*["']?(\d+)/i)
  const baseOffset = offsetMatch ? Math.max(0, Number(offsetMatch[1]) - 1) : 0

  const reservedHint = `显示第 ${NUMBER_PAD}–${NUMBER_PAD} 行，请用 offset=${NUMBER_PAD} limit=${NUMBER_PAD} 继续分页读取`
  const fixedBytes = (header ? byteLen(header) + 1 : 0) + (closing ? byteLen(closing) + 1 : 0) + byteLen(reservedHint) + 1
  const bodyBudget = Math.max(1, MAX_TOOL_RESULT_BYTES - fixedBytes)

  const body = headLines(lines, start, end, bodyBudget)
  // 单行就超预算（压缩过的 JS / 单行 JSON）：截一行出来，别吐空页「第 1–0 行」
  if (!body.length && start < end) body.push(sliceByBytes(lines[start], bodyBudget))
  const hintFor = (shown) => {
    if (shown <= 0) return '本页没有可显示的完整行，请调大 limit 或换 offset 重新读取'
    const from = baseOffset + 1
    const to = baseOffset + shown
    return `显示第 ${from}–${to} 行，请用 offset=${to + 1} limit=${shown} 继续分页读取`
  }
  const compose = (kept) => {
    const parts = []
    if (header) parts.push(header)
    parts.push(...kept)
    if (closing) parts.push(closing)
    parts.push(hintFor(kept.length))
    return parts.join('\n')
  }

  let out = compose(body)
  let guard = 0
  while (byteLen(out) > MAX_TOOL_RESULT_BYTES && body.length > 1 && guard < 4096) {
    guard += 1
    body.pop()
    out = compose(body)
  }
  return out
}

// 其它工具：按完整行对齐保头 70% + 尾 30%，中间插省略说明
function boundGenericResult(rawText) {
  const lines = rawText.split('\n')
  const rawBytes = byteLen(rawText)
  const reservedNotice = `…（已省略 ${NUMBER_PAD} 字节 / ${NUMBER_PAD} 行）…`
  const reservedBytes = byteLen(reservedNotice) + 2 // 前后各一个换行
  const bodyBudget = Math.max(1, MAX_TOOL_RESULT_BYTES - reservedBytes)

  if (lines.length <= 1) {
    const half = Math.max(1, Math.floor(bodyBudget / 2))
    const head = sliceByBytes(rawText, half)
    const tail = sliceTailByBytes(rawText.slice(head.length), bodyBudget - byteLen(head) - 2)
    const omittedBytes = Math.max(0, rawBytes - byteLen(head) - byteLen(tail))
    return `${head}\n…（已省略 ${omittedBytes} 字节 / 1 行）…\n${tail}`
  }

  const headBudget = Math.floor(bodyBudget * 0.7)
  const tailBudget = bodyBudget - headBudget
  const head = headLines(lines, 0, lines.length, headBudget)
  const tail = tailLines(lines, head.length, lines.length, tailBudget)

  const compose = () => {
    const headText = head.join('\n')
    const tailText = tail.join('\n')
    const omittedLines = Math.max(0, lines.length - head.length - tail.length)
    const omittedBytes = Math.max(0, rawBytes - byteLen(headText) - byteLen(tailText))
    return `${headText}\n…（已省略 ${omittedBytes} 字节 / ${omittedLines} 行）…\n${tailText}`
  }

  let out = compose()
  let guard = 0
  while (byteLen(out) > MAX_TOOL_RESULT_BYTES && (head.length > 1 || tail.length > 1) && guard < 4096) {
    guard += 1
    if (head.length >= tail.length && head.length > 1) head.pop()
    else if (tail.length > 1) tail.shift()
    else break
    out = compose()
  }
  return out
}

/**
 * 工具回执硬收敛：总输出严格 <= 9,600 字节（距 agy 10,240B 悬崖留 640B 安全垫）。
 * read / view 类保头 + 续读提示；其余头 70% + 尾 30%。
 */
export function boundToolResult(toolName, rawText) {
  const text = typeof rawText === 'string' ? rawText : String(rawText ?? '')
  if (byteLen(text) <= MAX_TOOL_RESULT_BYTES) return text
  return isReadLikeTool(toolName) ? boundReadResult(text) : boundGenericResult(text)
}

/**
 * 清洗工具 inputSchema：解引用、折叠联合类型、剥离元关键字、限制深度。
 * 不删除属性名，不删 required 结构。
 */
export function sanitizeToolSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const root = schema
  const seen = new Set()

  const walk = (node, depth) => {
    if (depth > MAX_SCHEMA_DEPTH) return { type: 'object' }
    if (!node || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map((n) => walk(n, depth + 1))

    let cur = node
    if (typeof cur.$ref === 'string' && cur.$ref.startsWith('#')) {
      if (seen.has(cur.$ref)) return { type: 'object' }
      seen.add(cur.$ref)
      const target = cur.$ref
        .replace(/^#\//, '')
        .split('/')
        .reduce((acc, k) => (acc && typeof acc === 'object' ? acc[k] : undefined), root)
      cur = target === undefined ? { type: 'object' } : target
    }

    if (Array.isArray(cur.anyOf) || Array.isArray(cur.oneOf)) {
      const branches = (cur.anyOf || cur.oneOf).map((b) => walk(b, depth + 1))
      return collapseUnion(branches)
    }

    const out = {}
    for (const [k, v] of Object.entries(cur)) {
      if (META_KEYS.has(k)) continue
      if (k === 'anyOf' || k === 'oneOf') continue
      if (k === 'properties' && v && typeof v === 'object') {
        const props = {}
        for (const [pk, pv] of Object.entries(v)) props[pk] = walk(pv, depth + 1)
        out.properties = props
        continue
      }
      if (k === 'additionalProperties' && v && typeof v === 'object') {
        out.additionalProperties = walk(v, depth + 1)
        continue
      }
      if (k === 'items' && v && typeof v === 'object') {
        out.items = walk(v, depth + 1)
        continue
      }
      out[k] = v
    }
    return out
  }

  const clean = walk(schema, 0)
  if (!clean.type && !clean.properties) clean.type = 'object'
  if (!clean.properties) clean.properties = {}
  return clean
}

export class McpBridge {
  /**
   * @param {object} opts
   * @param {(tenantKey: string) => Array<{name: string, description?: string, inputSchema?: object}>} opts.getTools
   * @param {(args: {tenantKey: string, name: string, arguments: object, signal: AbortSignal}) => Promise<any>} opts.callTool
   * @param {(call: {tenantKey: string, name: string, arguments: object, id: unknown}) => boolean} [opts.shouldPark]
   * @param {(entry: object) => void} [opts.onPark]
   * @param {string} [opts.instructions]
   * @param {number} [opts.keepaliveMs]
   */
  constructor(opts = {}) {
    this.getTools = opts.getTools || (() => [])
    this.callTool = opts.callTool || (async () => ({
      content: [{ type: 'text', text: '工具执行失败: 当前没有活跃的 DSH turn' }],
      isError: true,
    }))
    this.shouldPark = opts.shouldPark || (() => false)
    this.onPark = opts.onPark || null
    this.onRelay = opts.onRelay || null
    this.onCall = opts.onCall || null
    this.instructions = opts.instructions || 'DSH tool bridge. Tool names are reported without prefix; agy adds mcp_dsh_.'
    this.keepaliveMs = opts.keepaliveMs ?? 15_000
    this.token = crypto.randomBytes(16).toString('hex')
    this.server = null
    this.port = 0
    // 已挂起、等 DSH 回填结果的调用：callKey -> call
    this.parked = new Map()
    // agy 串行发起的后续调用：先在这里排队（心跳照跑），前一个 resolve 后放出来
    this.waiting = []
    // C4 接力：85 秒还没跑完的挂起调用转到 here，等 DSH 真结果到了再交给 dsh_await_result
    this.awaiting = new Map()
    this.relayAfterMs = opts.relayAfterMs ?? RELAY_AFTER_MS
    // 客户端不发 id 时给个本地唯一键，免得多个 null 互相覆盖
    this.autoSeq = 0
  }

  get urlBase() {
    return `http://127.0.0.1:${this.port}/mcp/${this.token}`
  }

  // 供 session/new 的 mcpServers 直接使用
  mcpServerEntry(tenantKey) {
    return {
      type: 'http',
      name: 'dsh',
      url: `${this.urlBase}/${encodeURIComponent(tenantKey)}`,
      headers: [{ name: 'Authorization', value: `Bearer ${this.token}` }],
    }
  }

  async start() {
    if (this.server) return this
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(err?.message || err) } }))
        } else if (!res.writableEnded) {
          res.end()
        }
      })
    })
    // C1：三个超时全部清零，防长耗时工具被 Node 掐断
    this.server.keepAliveTimeout = 0
    this.server.requestTimeout = 0
    this.server.headersTimeout = 0

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve()
      })
    })
    return this
  }

  async stop() {
    // 先把挂起/排队的响应收干净，否则 closeAllConnections 之后 agy 侧永远等不到结果
    for (const key of [...this.parked.keys()]) this.abortParkedCall(key)
    for (const [key, entry] of [...this.awaiting]) {
      for (const waiter of entry.waiters) {
        if (waiter.timer) clearTimeout(waiter.timer)
      }
      entry.waiters.clear()
      this.awaiting.delete(key)
    }
    for (const call of this.waiting.splice(0)) {
      try { call.abort.abort(new Error('bridge stopped')) } catch {}
      this._finishCall(call, null)
    }
    if (!this.server) return
    const s = this.server
    this.server = null
    await new Promise((resolve) => {
      s.close(() => resolve())
      // keep-alive 连接不断开会让 close 回调永不触发
      s.closeAllConnections?.()
    })
  }

  _parsePath(url) {
    const u = new URL(url, 'http://127.0.0.1')
    const m = u.pathname.match(/^\/mcp\/([0-9a-f]{32})\/(.+)$/)
    if (!m) return null
    return { token: m[1], tenantKey: decodeURIComponent(m[2]) }
  }

  async _readBody(req) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw.trim()) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  async _handle(req, res) {
    const route = this._parsePath(req.url || '')
    if (!route || route.token !== this.token) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    // Bearer 软校验：路径里的 32hex token 本身就是能力密钥（loopback + 随机端口 + 每次启动重生成）。
    // ACP 的 mcpServers schema 未必认 headers 字段，所以 header「有则必须对，没有也放行」。
    const auth = req.headers.authorization
    if (auth !== undefined && auth !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }

    const body = await this._readBody(req)
    if (!body) {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('bad request')
      return
    }

    const { id, method, params } = body

    // Notification：无 id，直接 202
    if (id === undefined) {
      res.writeHead(202, { 'content-type': 'text/plain' })
      res.end()
      return
    }

    // tools/call 走 SSE，特殊处理
    if (method === 'tools/call') {
      await this._handleCall(res, body, route.tenantKey)
      return
    }

    let result
    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-mcp-bridge', version: '1.0.0' },
          instructions: this.instructions,
        }
        break
      case 'ping':
        result = {}
        break
      case 'tools/list': {
        // C1：只报裸名，agy 会自动加 mcp_dsh_ 前缀
        const tools = (this.getTools(route.tenantKey) || []).map((t) => ({
          name: String(t.name).replace(/^mcp_dsh_/, ''),
          description: t.description || '',
          inputSchema: sanitizeToolSchema(toolSchemaOf(t)),
        }))
        // C4：内置接力工具永久挂在末尾——它不过压缩闸、不过 allowedTools 白名单
        if (!tools.some((t) => t.name === AWAIT_RESULT_TOOL)) tools.push({ ...AWAIT_RESULT_TOOL_DEF })
        result = { tools }
        break
      }
      case 'resources/list':
        result = { resources: [] }
        break
      case 'resources/templates/list':
        result = { resourceTemplates: [] }
        break
      case 'prompts/list':
        result = { prompts: [] }
        break
      default:
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }))
        return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
  }

  // C2：立即刷 SSE 头 + 15s 心跳（心跳对挂起/排队同样有效，agy 侧 180s 空闲超时不会掐）
  async _handleCall(res, request, tenantKey) {
    const params = request.params || {}
    const call = {
      id: request.id ?? null,
      callKey: request.id === null || request.id === undefined ? `auto-${++this.autoSeq}` : String(request.id),
      tenantKey,
      name: String(params.name || '').replace(/^mcp_dsh_/, ''),
      arguments: params.arguments || {},
      progressToken: params._meta?.progressToken,
      res,
      abort: new AbortController(),
      timer: null,
      tick: 0,
      disconnected: false,
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(':\n\n') // 顶出响应头，跨过 agy 60s 首包死线

    // 断开只做标记：park 场景下 DSH 的结果还要写回，不能在这里 abort 掉 agy 那一侧
    res.on?.('close', () => { call.disconnected = true })

    call.timer = setInterval(() => this._heartbeat(call), this.keepaliveMs)
    call.timer.unref?.()

    // 每一次 tools/call 都吱一声：接力间隙的文字抑制到这里结束（模型已经动了）
    try {
      this.onCall?.({ tenantKey: call.tenantKey, name: call.name, callKey: call.callKey })
    } catch {}

    // C4 内置接力工具：不 park、不进 DSH 工具链，直接在桥内部等结果
    if (call.name === AWAIT_RESULT_TOOL) {
      this._handleAwait(call)
      return
    }

    if (this._tryPark(call)) return

    // 不该 park（没有活跃 turn / 状态已结束）：要么内联执行，要么排队等前一个 resolve
    if (this.parked.size > 0) {
      this.waiting.push(call)
      return
    }
    this._inlineCall(call)
  }

  _heartbeat(call) {
    const { res, progressToken } = call
    if (!res || res.writableEnded || res.destroyed) return
    call.tick += 1
    try {
      if (progressToken !== undefined) {
        const frame = JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { progressToken, progress: call.tick, message: 'DSH is executing tool' },
        })
        res.write(`event: message\ndata: ${frame}\n\n`)
      } else {
        res.write(': keepalive\n\n')
      }
    } catch {
      call.disconnected = true
    }
  }

  _shouldPark(call) {
    try {
      return Boolean(this.shouldPark({
        tenantKey: call.tenantKey,
        name: call.name,
        arguments: call.arguments,
        id: call.id,
      }))
    } catch {
      return false
    }
  }

  _tryPark(call) {
    // 一次只挂一个：agy 串行发起的后续调用留在 waiting 里排队，前一个 resolve 后放出
    if (this.parked.size > 0) return false
    if (!this._shouldPark(call)) return false
    this.parked.set(call.callKey, call)
    // C4：挂满 85 秒还没结果就转接力，别让 agy 在一条 SSE 上干等几分钟
    if (this.relayAfterMs > 0 && this.relayAfterMs < Infinity) {
      call.relayTimer = setTimeout(() => this._relayCall(call), this.relayAfterMs)
      call.relayTimer.unref?.()
    }
    try {
      this.onPark?.(call)
    } catch (err) {
      this.rejectParkedCall(call.callKey, err)
    }
    return true
  }

  // C4 接力第一跳：把「还在跑」写回 agy，同时把这条调用转进 awaiting 等 DSH 的真结果。
  // 注意要从 parked 里摘掉：agy 拿到提示后会立刻发起 dsh_await_result，那条 tools/call 不能被
  // 「一次只挂一个」挡住。
  _relayCall(call) {
    if (!this.parked.has(call.callKey)) return false
    this.parked.delete(call.callKey)
    call.relayTimer = null
    const entry = {
      callKey: call.callKey,
      tenantKey: call.tenantKey,
      name: call.name,
      arguments: call.arguments,
      content: null,
      isError: false,
      relays: 1,
      waiters: new Set(),
    }
    this.awaiting.set(call.callKey, entry)
    try {
      this.onRelay?.(entry)
    } catch {
      // 回调出错不影响接力本身
    }
    this._finishCall(call, {
      jsonrpc: '2.0',
      id: call.id,
      result: { content: [{ type: 'text', text: relayNoticeText(call.name, call.callKey, entry.relays) }] },
    })
    this._promoteWaiting()
    return true
  }

  // dsh_await_result 的实际执行：结果已在 → 零延迟；没到 → 再等一轮（最多 MAX_TOOL_RELAYS 轮）
  _handleAwait(call) {
    const args = call.arguments ?? {}
    const callId = String(args.call_id ?? args.callId ?? '').trim()
    const entry = callId ? this.awaiting.get(callId) : null
    if (!entry) {
      this._finishTextResult(call, relayUnknownText(callId || '(空)'), true)
      return
    }
    if (entry.content !== null) {
      this._deliverAwait(entry, call)
      return
    }
    if (entry.relays >= MAX_TOOL_RELAYS) {
      // 已经接力够多轮：不再吊着 agy，回硬失败并把这条调用收掉（迟到的结果直接丢弃）
      this.awaiting.delete(callId)
      this._finishTextResult(call, relayExpiredText(entry.name, callId, entry.relays), true)
      return
    }
    entry.relays += 1
    const waiter = { call, timer: null }
    const waitMs = this.relayAfterMs > 0 && this.relayAfterMs < Infinity ? this.relayAfterMs : RELAY_AFTER_MS
    waiter.timer = setTimeout(() => {
      // 结果在这轮等待里到了：连它一起交付（不能先把自己从 waiters 里摘掉，否则会吊着不返回）
      if (entry.content !== null) {
        this._deliverAwait(entry)
        return
      }
      entry.waiters.delete(waiter)
      this._finishTextResult(call, relayNoticeText(entry.name, entry.callKey, entry.relays), false)
    }, waitMs)
    waiter.timer.unref?.()
    entry.waiters.add(waiter)
  }

  // 真结果到了才允许「交付」：交付即从 awaiting 摘掉，后续 await 一律走「没有这个 call_id」
  _deliverAwait(entry, extraCall = null) {
    const targets = []
    if (extraCall) targets.push(extraCall)
    for (const waiter of entry.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      targets.push(waiter.call)
    }
    entry.waiters.clear()
    const content = Array.isArray(entry.content)
      ? entry.content
      : [{ type: 'text', text: String(entry.content ?? '') }]
    for (const target of targets) {
      const result = { content }
      if (entry.isError) result.isError = true
      this._finishCall(target, { jsonrpc: '2.0', id: target.id, result })
    }
    // 只有真交付出去才摘掉；结果先到、没人 await 时必须留着，等下一次 await 零延迟取走
    if (targets.length > 0) this.awaiting.delete(entry.callKey)
  }

  _finishTextResult(call, text, isError) {
    const result = { content: [{ type: 'text', text: String(text ?? '') }] }
    if (isError) result.isError = true
    this._finishCall(call, { jsonrpc: '2.0', id: call.id, result })
  }

  async _inlineCall(call) {
    try {
      const result = await this.callTool({
        tenantKey: call.tenantKey,
        name: call.name,
        arguments: call.arguments,
        signal: call.abort.signal,
      })
      this._finishCall(call, { jsonrpc: '2.0', id: call.id, result })
    } catch (err) {
      // 工具业务错误仍回 200 + isError
      this._finishCall(call, {
        jsonrpc: '2.0',
        id: call.id,
        result: {
          content: [{ type: 'text', text: `工具执行失败: ${err?.message || err}` }],
          isError: true,
        },
      })
    }
  }

  // 写 SSE 结果帧并收尾（payload=null 表示只关连接，不写结果）
  _finishCall(call, payload) {
    if (call.timer) clearInterval(call.timer)
    call.timer = null
    if (call.relayTimer) clearTimeout(call.relayTimer)
    call.relayTimer = null
    const { res } = call
    try {
      if (res && !res.writableEnded && !res.destroyed) {
        if (payload && !call.disconnected) res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
        res.end()
      }
    } catch {
      // 连接早断了，忽略
    }
  }

  /** DSH 把工具结果交回来：写 SSE result 帧 + 收尾，然后放出排队中的下一个调用。 */
  resolveParkedCall(callKey, { content, isError } = {}) {
    const key = String(callKey)
    const call = this.parked.get(key)
    if (call) {
      this.parked.delete(key)
      const result = { content: Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }] }
      if (isError) result.isError = true
      this._finishCall(call, { jsonrpc: '2.0', id: call.id, result })
      this._promoteWaiting()
      return true
    }
    // 已经接力出去（SSE 早就用「still running」收过）：把真结果存住，交给 await 工具交付
    const entry = this.awaiting.get(key)
    if (!entry) return false
    entry.content = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }]
    entry.isError = Boolean(isError)
    this._deliverAwait(entry) // 有 await 正在等就零延迟唤醒，没人等就先存着
    return true
  }

  /** 工具执行抛错：照样回结果 + isError，让 agy 自己决定怎么继续。 */
  rejectParkedCall(callKey, err) {
    const key = String(callKey)
    const call = this.parked.get(key)
    if (call) {
      this.parked.delete(key)
      this._finishCall(call, {
        jsonrpc: '2.0',
        id: call.id,
        result: {
          content: [{ type: 'text', text: `工具执行失败: ${err?.message || err}` }],
          isError: true,
        },
      })
      this._promoteWaiting()
      return true
    }
    const entry = this.awaiting.get(key)
    if (!entry) return false
    entry.content = [{ type: 'text', text: `工具执行失败: ${err?.message || err}` }]
    entry.isError = true
    this._deliverAwait(entry)
    return true
  }

  /** 中止挂起调用：不写结果直接关流（DSH 取消/会话淘汰时用），agy 侧会拿到断线。 */
  abortParkedCall(callKey) {
    const key = String(callKey)
    const call = this.parked.get(key)
    if (call) {
      this.parked.delete(key)
      try { call.abort.abort(new Error('parked call aborted')) } catch {}
      this._finishCall(call, null)
      this._promoteWaiting()
      return true
    }
    const entry = this.awaiting.get(key)
    if (!entry) return false
    this.awaiting.delete(key)
    for (const waiter of entry.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer)
      this._finishTextResult(waiter.call, `工具调用 ${entry.name}（call_id: ${key}）已被中止。`, true)
    }
    entry.waiters.clear()
    return true
  }

  // agy 一次 prompt 里串行发起多个 tools/call：前一个 resolve 后放出一个排队项
  _promoteWaiting() {
    if (this.parked.size > 0) return
    const idx = this.waiting.findIndex((c) => this._shouldPark(c))
    if (idx < 0) return
    const [call] = this.waiting.splice(idx, 1)
    this._tryPark(call)
  }

  parkedCallKeys() {
    return [...this.parked.keys()]
  }

  /** 该 tenant 还有几条调用在接力中（等 DSH 真结果）——C4 自动继续要靠它判断。 */
  awaitingCountFor(tenantKey) {
    let n = 0
    for (const entry of this.awaiting.values()) {
      if (entry.tenantKey === tenantKey) n += 1
    }
    return n
  }

  awaitingCallIdsFor(tenantKey) {
    const out = []
    for (const entry of this.awaiting.values()) {
      if (entry.tenantKey === tenantKey) out.push(entry.callKey)
    }
    return out
  }

  /** DSH 侧 turn 没了：把该 tenant 还在排队的调用一律回错误，别让 agy 干等。 */
  failWaitingFor(tenantKey, message) {
    const keep = []
    let failed = 0
    for (const call of this.waiting) {
      if (call.tenantKey !== tenantKey) { keep.push(call); continue }
      failed += 1
      try { call.abort.abort(new Error(message)) } catch {}
      this._finishCall(call, {
        jsonrpc: '2.0',
        id: call.id,
        result: { content: [{ type: 'text', text: message }], isError: true },
      })
    }
    this.waiting = keep
    // 接力中的调用也一并收掉：turn 都没了，它们的真实结果不会再有人回填
    for (const [key, entry] of [...this.awaiting]) {
      if (entry.tenantKey !== tenantKey) continue
      failed += 1
      this.awaiting.delete(key)
      for (const waiter of entry.waiters) {
        if (waiter.timer) clearTimeout(waiter.timer)
        this._finishTextResult(waiter.call, message, true)
      }
      entry.waiters.clear()
    }
    return failed
  }
}

export default McpBridge

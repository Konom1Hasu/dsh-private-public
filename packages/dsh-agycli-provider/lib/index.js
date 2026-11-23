// dsh-agycli-provider —— 把 Antigravity CLI (`agy acp`) 接成 DSH 的一条 LLM 渠道。
//
// 三层：
//   1. 会话绑定（SessionBindingStore）：按 bindingKey 各养一条 ACP 会话，增量发送，满 200 轮轮换
//   2. 工具挂载（McpBridge + TurnState）：agy 通过 loopback MCP 桥发 tools/call，
//      adapter 吐一个 tool-call block 就 park，下一轮带着 tool-result 回来 resume
//   3. 模型透传：prepareCall(provider, model) → stream(options, model) → client.setModel()
//
// 硬约束（guide-extracted.txt + research-agycli-step2.md）：
//   - 单次请求约 65,000 字符截断线 → MAX_PROMPT_CHARS 留 5k 余量自行截断
//   - 单会话累积约 469 步永久 502 → 满 MAX_SESSION_TURNS 主动换会话
//   - 账号风控：不能并发多进程烧号 → MAX_LIVE_SESSIONS 限制同时存活的 agy 子进程
//   - StreamChunk 没有 type:'tool-call'；tool-call 是 block（block-start.blockType + block-end.block）
//   - park 只能发 finish:{kind:'tool-calls'}；max-tokens 会把 tool-call 从消息里剔掉
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { AgyAcpClient, isCancelLeak } from './agy-acp-client.mjs'
import { McpBridge, buildMcpToolBundle, buildCompensationSection, MAX_MCP_TOOLS_TOTAL_BYTES, AWAIT_RESULT_TOOL, boundToolResult } from './mcp-bridge.mjs'
import { TurnStateStore, MAX_TURN_STATES, newTurnState, trailingToolResults, toolResultText } from './park.mjs'
import { PersistedBindingStore, defaultBindingPath, MAX_PERSISTED_BINDINGS } from './binding-store.mjs'
import { readEstimatedTokens, shouldRotate } from './session-tokens.mjs'

const SELF = path.dirname(fileURLToPath(import.meta.url))

export const name = 'dsh-agycli-provider'
export const PROVIDER = 'agycli'

// 没配 bin/home 时的回落：本机 agy-runtime 的默认位置
// agy 运行时根目录。以前写死了本机绝对路径（含用户名），换机就废；
// 现在按「<DSH_HOME>/profiles/<profile>/agy-runtime」推导，config.bin/home 仍可覆盖。
function resolveAgyRoot() {
  const envRoot = process.env.AGYCLI_ROOT
  if (envRoot) return envRoot
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'web'
  return path.join(home, 'profiles', profile, 'agy-runtime')
}
const AGY_ROOT_FALLBACK = resolveAgyRoot()

const MAX_PROMPT_CHARS = 60_000
// ACP 请求体 192KB(196,608B) 是字节硬墙，不是字符线。留 16KB 给 ContentBlock 包装、
// JSON 转义和 systemPromptAppend，正文按 176KB 收。（中文一字 3 字节，只守字符会撞墙）
const MAX_PROMPT_BYTES = 176_000
// agy 单会话消息条数过 ~500 会卡死；轮数判据看不出来（工具密集时一轮能带好几条 message），
// 所以单独守一条，撞 400 就主动轮换。
const MAX_SESSION_MESSAGES = 400
const MAX_SESSION_TURNS = 200
const MAX_BINDINGS = 50
// 账号风控：同一个号不并发烧多进程。同时存活的 agy 子进程最多 4 条，
// 超了按 LRU 淘汰最老的一条并优雅 stop()（stdin.end → kill → taskkill /F /T）。
const MAX_LIVE_SESSIONS = 4
const CHARS_PER_TOKEN = 1.6
// 660,602 = floor(786,432 * 0.84)（教程 §3.3 的保守死线）。单一真值在 session-tokens.mjs，
// 这里只留个注释锚点：真机 usage_update 报的窗口是 1,048,576，教程那个 786,432 硬顶
// 可能是老版本口径，阈值暂时不动（宁可早换，不要撞 502）。
const ROTATE_TOKEN_THRESHOLD = 660_602
const FIRST_USER_PREFIX_CHARS = 512

// C4 接力：模型无视「still running」提示、没吐正文就收尾时补一轮提醒；只补一次，别死循环
const MAX_RELAY_AUTO_CONTINUES = 1
const RELAY_AUTO_CONTINUE_TEXT =
  '[mcp-relay-auto-continue] 你还有工具调用没拿到结果。请立刻调用 mcp_dsh_'
  + `${AWAIT_RESULT_TOOL}（call_id 见上一条 still running 提示），不要结束本轮，也不要用自然语言解释。`

// 前台只放只读工具；白名单外的工具声明会被过滤掉，不挂进 agy。
const DEFAULT_ALLOWED_TOOLS = ['read']

// 主循环请求的 purpose 白名单；其它非空字符串（session-title / compaction / …）一律算辅助请求。
// 缺省 purpose 的调用方是老的直接调用路径，必须走主路径。
export const MAIN_REQUEST_PURPOSES = new Set(['assistant', 'agent-loop'])

export function isAuxiliaryRequest(options) {
  if (typeof options?.purpose !== 'string') return false
  const purpose = options.purpose.trim().toLowerCase()
  return Boolean(purpose) && !MAIN_REQUEST_PURPOSES.has(purpose)
}

// 图片能力只按真机验过的家族声明，别按名字正则去猜别的模型
const MULTIMODAL_MODEL_PATTERNS = [
  /^gemini-4-(hydrogen|neon|argon|carbon)-/,
  /^gemini-3\.8-flash-/,
]

// 不同账号的 agy 模型池不一样（同一个版本，有的号是 gemini-4-neon-*，有的是 gemini-4-carbon-*），
// 静态表只是兜底。启动时异步跑一次 `agy models` 与静态表取并集，失败就纯静态表——
// 绝不能因为拉表失败把渠道搞挂，也绝不阻塞启动。
function runAgyModels(bin, home, proxy, timeoutMs = 15_000) {
  // agy 1.5.10+ 把 models 子命令的参数收干净了，只留 -h/--help：
  // 再传 --gemini-dir 会直接 "flags provided but not defined: -gemini-dir" 空手退出，
  // 模型表就永远退回静态化石，DSH 选中的 id 到 agy 那边全成了 invalid。
  // 先按带 home 的老姿势试，拿不到就退成裸调用再试一次。
  return runAgyModelsOnce(bin, home, proxy, timeoutMs).then((rows) => {
    if (rows.length > 0) return rows
    return runAgyModelsOnce(bin, null, proxy, timeoutMs)
  })
}

function runAgyModelsOnce(bin, home, proxy, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    if (!bin) return resolve([])
    const env = {
      ...process.env,
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      AGY_CLI_DISABLE_SAFETY_FILTERING: '1',
      NO_PROXY: process.env.NO_PROXY || '127.0.0.1,localhost,::1',
    }
    // models 子命令没有 --gemini-dir（agy 1.5.10+ 收掉了），它只认 USERPROFILE / HOME。
    // 不把这两个指到隔离 home，它会去读真机默认目录——那里没登录，直接回
    // "Please sign in to view available models"，模型表永远空手而归，DSH 菜单里全是化石 id。
    if (home) {
      env.USERPROFILE = home
      env.HOME = home
    }
    if (proxy) {
      env.HTTP_PROXY = proxy
      env.HTTPS_PROXY = proxy
    }
    const args = ['models']
    if (home) args.push('--gemini-dir', home)
    let buf = ''
    let done = false
    let child = null
    const finish = (rows) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child?.kill() } catch {}
      resolve(rows)
    }
    const timer = setTimeout(() => finish([]), timeoutMs)
    timer.unref?.()
    try {
      child = spawn(bin, args, { env, windowsHide: true })
    } catch {
      return finish([])
    }
    child.stdout?.on('data', (d) => { buf += d })
    child.on('error', () => finish([]))
    child.on('close', () => {
      // 输出是 "id<TAB>显示名"，退出码不可靠（stderr 里那行 Fetching 会让它非 0）
      const rows = []
      for (const line of buf.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9._-]+)\s*\t\s*(\S.*)$/)
        if (m) rows.push([m[1], m[2].trim()])
      }
      finish(rows)
    })
  })
}

export function inputModalitiesFor(modelId) {
  const id = String(modelId ?? '')
  for (const re of MULTIMODAL_MODEL_PATTERNS) if (re.test(id)) return ['text', 'image']
  return ['text']
}

// aborted 之后一个 yield 都不许留：生成器会永久悬停在该 yield 点，
// 外层 finally 里的锁释放永远执行不到，会话锁就此焊死。
export function abortError(message = 'aborted by caller') {
  const err = new Error(message)
  err.code = 'ABORTED'
  return err
}

// session 串行槽的租约上限：超过这个时长还没释放就认定泄漏，强制松锁。
// 取值要大于 agy 侧单轮硬顶（40min），否则正常长任务会被误放。
const GATE_LEASE_MS = 45 * 60 * 1000

// Per-session 串行槽：同一会话同一时刻只放一条 stream 进去，其余排队。
// 两个约束比"排好队"本身更重要：
//  ① 排队期间被中止，必须当场从队列里摘掉并抛 ABORTED —— 否则被弃的请求会一直占着位置，
//     后面的人永远等不到，槽就成了僵尸锁；
//  ② 释放时把锁直接交给队首（不下沉 holders），避免"释放-重新抢占"之间的空窗被别人插队。
class StreamGate {
  constructor() {
    this.holders = new Set()
    this.queues = new Map()
  }

  acquire(key, signal) {
    if (signal?.aborted) return Promise.reject(abortError())
    if (!this.holders.has(key)) {
      this.holders.add(key)
      return Promise.resolve(this._releaseFn(key))
    }
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(key) ?? []
      this.queues.set(key, queue)
      const waiter = {
        grant: () => { cleanup(); resolve(this._releaseFn(key)) },
        abort: () => {
          const i = queue.indexOf(waiter)
          if (i >= 0) queue.splice(i, 1)
          if (queue.length === 0) this.queues.delete(key)
          cleanup()
          reject(abortError())
        },
      }
      const onAbort = () => waiter.abort()
      const cleanup = () => signal?.removeEventListener?.('abort', onAbort)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      queue.push(waiter)
    })
  }

  _releaseFn(key) {
    let released = false
    return () => {
      if (released) return
      released = true
      const queue = this.queues.get(key) ?? []
      const next = queue.shift()
      if (next) {
        // 锁直接过继给队首：holders 不收，避免中间被新来的插队
        if (queue.length === 0) this.queues.delete(key)
        next.grant()
      } else {
        this.holders.delete(key)
        this.queues.delete(key)
      }
    }
  }

  /** 供测试观察：某 key 当前是否被占、还有几个人排队 */
  stats(key) {
    return { held: this.holders.has(key), queued: (this.queues.get(key) ?? []).length }
  }
}

// 系统回执保留句式。agy 把历史多轮和系统回调拍平成纯文本投给模型，Gemini 一旦掉思考链，
// 就会在 agent_message_chunk 里自导自演续写系统回执，紧接着在同一次 session/prompt 里
// 发起真实 tool_call —— 自动权限回调一放行就直接真改盘/真写记忆。
const SYSTEM_ECHO_PATTERNS = [
  /^\s*Background subagent\b[^\n]*\b(finished|completed|done)\b/i,
  /^\s*\[\s*assistant\s*\]\s*$/i,
  /^\s*\[\s*user\s*\]\s*$/i,
  /<\/?\s*USER_REQUEST\s*>/i,
  /^\s*<\/?\s*(system|tool_result|function_results|function_calls)\s*>/i,
]

/** 扫到系统回执句式就返回该行（截断 120 字），否则 null。 */
export function detectSystemEcho(text) {
  const raw = String(text ?? '')
  if (!raw) return null
  for (const line of raw.split(/\r?\n/)) {
    for (const re of SYSTEM_ECHO_PATTERNS) {
      if (re.test(line)) return line.trim().slice(0, 120)
    }
  }
  return null
}

// agy 会把上游重试 / 安全过滤 / 额度告警当普通正文吐出来。按行缓冲剥掉，
// 并把它们转译成可重试的结构化失败码，交给 llm-retry。
const NOTICE_RULES = [
  { re: /^\s*⚠\s*API error\b[^\n]*\b429\b/i, code: 'RATE_LIMIT', message: 'agy 上游 429 限流' },
  // 单会话约 469 步后永久 502 unreachable —— 这类必须换会话，重试同一个只会一直卡
  {
    re: /^\s*⚠\s*API error\b[^\n]*\b(500|502|503)\b[^\n]*(unreachable|internal|unavailable)?/i,
    code: 'SERVER',
    message: 'agy 上游 5xx',
  },
  {
    re: /^\s*⚠\s*[^\n]*\bcurrently unreachable\b/i,
    code: 'DEAD_SESSION',
    message: 'agy 会话已死锁（unreachable），下次进入将重建会话',
  },
  { re: /^\s*⚠\s*Model produced invalid output/i, code: 'SERVER', message: 'agy 模型输出非法' },
  { re: /^\s*⚠\s*improperly formatted function call/i, code: 'SERVER', message: 'agy 工具调用格式非法' },
  { re: /^\s*⚠\s*[^\n]*safety filter[^\n]*$/i, code: 'SERVER', message: 'agy 安全过滤拦截' },
  { re: /^\s*Your AI credits balance is too low/i, code: 'QUOTA_EXCEEDED', message: 'agy 额度不足' },
]
const CREDIT_PREFIX = 'your ai credits balance is too low'
// 这些失败码意味着 agy 会话本身已经废了，重试同一个会话没有意义，只能重建
const DEAD_SESSION_CODES = new Set(['DEAD_SESSION'])

function classifyNotice(line) {
  for (const rule of NOTICE_RULES) if (rule.re.test(line)) return { code: rule.code, message: rule.message }
  return null
}

// 未闭合的行有可能是通知被 chunk 切断的前缀，先扣住不吐（只扣可疑前缀，正常正文立刻放行）
function couldBeNoticePrefix(text) {
  const t = text.trimStart()
  if (!t) return true
  if (t.startsWith('⚠')) return true
  const lower = t.toLowerCase()
  return CREDIT_PREFIX.startsWith(lower) || lower.startsWith('your ai credits')
}

export class NoticeFilter {
  constructor() {
    this.buffer = ''
  }

  push(chunk) {
    this.buffer += String(chunk ?? '')
    const notices = []
    let text = ''
    for (;;) {
      const nl = this.buffer.indexOf('\n')
      if (nl < 0) break
      const line = this.buffer.slice(0, nl + 1)
      this.buffer = this.buffer.slice(nl + 1)
      const notice = classifyNotice(line)
      if (notice) notices.push(notice)
      else text += line
    }
    if (this.buffer && !couldBeNoticePrefix(this.buffer)) {
      text += this.buffer
      this.buffer = ''
    }
    return { text, notices }
  }

  flush() {
    const rest = this.buffer
    this.buffer = ''
    if (!rest) return { text: '', notices: [] }
    const notice = classifyNotice(rest)
    return notice ? { text: '', notices: [notice] } : { text: rest, notices: [] }
  }
}

// 风控提示同样以普通正文送达，且 stopReason 仍是 end_turn。
// 只看首 4,000 + 尾 4,000 字符，每个 chunk O(1)（禁止每 chunk 重扫全文变 O(n²)）。
// 模式表只许精确匹配：裸写 /Terms of Service/i 会在模型写合规文档时把自己误杀。
const TOS_HEAD_CHARS = 4_000
const TOS_TAIL_CHARS = 4_000
const TOS_PATTERNS = [
  /TOS_VIOLATION/i,
  /violation of Terms of Service/i,
  /service has been disabled in this account/i,
]

export class TosWindow {
  constructor(headChars = TOS_HEAD_CHARS, tailChars = TOS_TAIL_CHARS) {
    this.headChars = headChars
    this.tailChars = tailChars
    this.head = ''
    this.tail = ''
    this.total = 0
    this.hit = null
  }

  push(text) {
    if (this.hit) return this.hit
    let rest = String(text ?? '')
    if (!rest) return null
    this.total += rest.length
    if (this.head.length < this.headChars) {
      const take = Math.min(this.headChars - this.head.length, rest.length)
      this.head += rest.slice(0, take)
      rest = rest.slice(take)
    }
    if (rest) {
      this.tail += rest
      if (this.tail.length > this.tailChars) this.tail = this.tail.slice(this.tail.length - this.tailChars)
    }
    for (const re of TOS_PATTERNS) {
      if (re.test(this.head) || re.test(this.tail)) {
        this.hit = re.source
        return this.hit
      }
    }
    return null
  }
}

// agy models 实测可拉的 23 个 id，档位已固化在后缀里。
const MODELS = [
  ['gemini-4-neon-low', 'Gemini 4 Neon (Low)'],
  ['gemini-4-neon-medium', 'Gemini 4 Neon (Medium)'],
  ['gemini-4-neon-high', 'Gemini 4 Neon (High)'],
  ['gemini-4-neon-xhigh', 'Gemini 4 Neon (XHigh)'],
  ['gemini-4-argon-low', 'Gemini 4 Argon (Low)'],
  ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)'],
  ['gemini-4-argon-high', 'Gemini 4 Argon (High)'],
  ['gemini-4-hydrogen-low', 'Gemini 4 Hydrogen (Low)'],
  ['gemini-4-hydrogen-medium', 'Gemini 4 Hydrogen (Medium)'],
  ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)'],
  ['gemini-4-hydrogen-xhigh', 'Gemini 4 Hydrogen (XHigh)'],
  ['gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'],
  ['gemini-pro-orchestrator-g1-pro', 'Orchestrator (Argon)'],
  ['gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'],
  ['gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'],
  ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
  ['claude-opus-5-5-low', 'Claude Opus 5.5 (Low)'],
  ['claude-opus-5-5-medium', 'Claude Opus 5.5 (Medium)'],
  ['claude-opus-5-5-high', 'Claude Opus 5.5 (High)'],
  ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low)'],
  ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)'],
  ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)'],
  ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
]

// 档位全集：agy 把档位写死在 modelId 后缀里，这里只是放行 DSH 的校验，
// 不参与请求（stream 里忽略 options.reasoningEffort）。
const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'xhigh', name: 'XHigh' },
]

function blockText(block) {
  if (typeof block === 'string') return block
  if (!block || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'reasoning':
      return ''
    case 'tool-call':
      return `[tool-call ${block.name}] ${block.arguments ?? ''}`
    case 'tool-result':
      return `[tool-result] ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')}`
    default:
      // 未知 type 也不能当空气：只要带 text / content 就交出去。
      // 真机上"用户提问凭空消失"就是这类块被 default 吞掉造成的。
      if (typeof block.text === 'string') return block.text
      if (typeof block.content === 'string') return block.content
      return ''
  }
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('\n')
  if (content && typeof content === 'object') {
    const direct = blockText(content)
    if (direct) return direct
    // 外面又包了一层的形态（blocks / parts / content / items）也要拆开认
    for (const key of ['blocks', 'parts', 'content', 'items']) {
      if (content[key] !== undefined && content[key] !== content) {
        const inner = contentText(content[key])
        if (inner) return inner
      }
    }
    // 最后的兜底：宁可把结构原样交给模型，也不能让用户那句话变成一团空气。
    try {
      const json = JSON.stringify(content)
      if (json && json !== '{}' && json !== '[]') return json
    } catch { /* 循环引用等异常形态，按空处理 */ }
    return ''
  }
  return ''
}

function collectSystem(options) {
  if (typeof options?.system === 'string' && options.system.length > 0) return options.system
  for (const m of options?.messages ?? []) {
    if (m?.role === 'system') {
      const t = contentText(m.content)
      if (t) return t
    }
  }
  return ''
}

// 按 UTF-8 字节截断，且绝不切断多字节字符（切出半个汉字会让整包 JSON 变形）。
// from='head' 保留头部；from='tail' 保留尾部（丢最老的内容时用）。
function truncateToBytes(text, maxBytes, from = 'head') {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return text
  if (maxBytes <= 0) return ''
  if (from === 'head') {
    let end = maxBytes
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    return buf.subarray(0, end).toString('utf8')
  }
  let start = buf.byteLength - maxBytes
  while (start < buf.byteLength && (buf[start] & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}

function byteLen(text) {
  return Buffer.byteLength(text ?? '', 'utf8')
}

// 把消息按角色拼成一段文本；超预算时先丢最老的对话。
// system 不拼进 prompt（它走 session/new 的 systemPromptAppend），也不占这里的预算。
// 单条消息本身就超预算时截断这条本体，而不是事后把整段文本的开头切掉
// （切开头会连 role 标签一起削，产生半截 prompt）。
//
// 双顶守护：agy 那条 65,000 字符线是**字符**算的，但 ACP 请求体是 192KB **字节**墙。
// 中文一字 3 字节，光守字符会写出 180KB 的包，再叠一张图就撞墙被底层挡回来 ——
// 所以两个顶都得守，且图片 base64 的字节要提前从预算里扣掉（reserveBytes）。
function renderPrompt(options, { reserveBytes = 0, onEmptyMessage = null } = {}) {
  const turns = []
  const all = options?.messages ?? []
  for (let mi = 0; mi < all.length; mi++) {
    const m = all[mi]
    if (m?.role === 'system') continue
    const body = contentText(m.content)
    if (!body) {
      // 取不到文本就跳过，但要把原始结构报出去 —— 静默跳过就是"用户消息凭空消失"。
      // 只报最后几条，避免历史垃圾反复刷屏。
      if (onEmptyMessage && mi >= all.length - 3) {
        try { onEmptyMessage({ index: mi, role: m?.role, content: m?.content }) } catch { /* 诊断不许影响主流程 */ }
      }
      continue
    }
    const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : String(m.role ?? 'User')
    turns.push({ role, body })
  }

  // 不再逐个列工具名：那串名单要吃掉 ~700 字符预算，而且在真机上会被模型误读成
  // 「这些工具不可用」。工具本身已经过 MCP 桥挂进 tools/list，不需要在正文里复述。
  const toolsNote = options?.tools?.length
    ? `[说明] 工具通过 MCP 桥挂载（mcp_dsh_*），按 tools/list 里的定义直接调用。`
    : ''
  const toolsBytes = toolsNote ? byteLen(toolsNote) + 2 : 0
  const cap = Math.min(
    MAX_PROMPT_CHARS,
    Math.max(0, MAX_PROMPT_BYTES - Math.max(0, reserveBytes) - toolsBytes),
  )
  let used = 0
  const kept = []
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const overhead = byteLen(t.role) + 4
    const room = cap - used - overhead
    if (room <= 0) break
    const body = byteLen(t.body) > room ? truncateToBytes(t.body, room, 'tail') : t.body
    used += overhead + byteLen(body)
    kept.unshift({ role: t.role, body })
    if (body !== t.body) break
  }

  const parts = []
  for (const t of kept) parts.push(`${t.role}: ${t.body}`)
  if (toolsNote) parts.push(toolsNote)
  const text = parts.join('\n\n')
  // 兜底：预算数学上已经兜住了，真触发时保留头部（role 标签优先），丢尾部
  return byteLen(text) > cap ? truncateToBytes(text, cap, 'head') : text
}

// 取最后一条带文本的用户消息，单条返回；用于增量为空时的兜底重发。
function lastUserTurn(messages) {
  const all = messages ?? []
  for (let i = all.length - 1; i >= 0; i--) {
    const m = all[i]
    if (m?.role !== 'user') continue
    if (contentText(m.content)) return [{ role: 'user', content: m.content }]
  }
  return []
}

function estTokens(chars) {
  return Math.max(0, Math.ceil((chars ?? 0) / CHARS_PER_TOKEN))
}

// 诊断用：把取不到文本的 content 结构截一小段打出来，别打印整个大对象
function safePreview(value, max = 300) {
  try {
    const seen = new WeakSet()
    const json = JSON.stringify(value, (k, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]'
        seen.add(v)
      }
      return v
    })
    return String(json ?? '').slice(0, max)
  } catch (e) {
    return `<无法序列化: ${e?.message ?? e}>`
  }
}

function hashText(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

// ---- 工具表压缩闸接线（教程 §5.1 / D1）----
// 补偿段追加在 system 尾部：原 system 文本必须原样在最前，一个字都不动。
function composeSystemAppend(systemText, compensation) {
  const base = String(systemText ?? '')
  const extra = String(compensation ?? '').trim()
  if (!extra) return base
  return base ? `${base}\n\n${extra}` : extra
}

function safeCompensation(tools) {
  try {
    return buildCompensationSection(tools)
  } catch {
    // 补偿段是锦上添花，算不出来也不能掐掉这一轮
    return ''
  }
}

function firstUserText(messages) {
  for (const m of messages ?? []) {
    if (m?.role !== 'user') continue
    const t = contentText(m.content)
    if (t) return t
  }
  return ''
}

// bindingKey：显式会话标识优先；否则拿「首个 user 消息前缀」当锚点。
// system 文本刻意不进 key —— 一旦它漂移就会换 key、悄悄新建一条绑定，
// 把「漂移要轮换 + 重发全量」这条路径吞掉。systemHash 单独存在绑定里用来判漂移。
function bindingKeyFor(options) {
  const explicit =
    options?.sessionId ?? options?.conversationId ?? options?.sessionKey ?? options?.threadId ?? options?.chatId
  if (explicit) return `s:${explicit}`
  const anchor = firstUserText(options?.messages).slice(0, FIRST_USER_PREFIX_CHARS)
  return `h:${hashText(anchor)}`
}

// 增量：跳过已经同步过的 syncedMsgsCount 条。
// agy 自己上一轮的回复已经在它的会话里，回灌会重复；文本与我们上轮输出一致时丢掉。
// 首条增量是 assistant 且文本对不上 → 上一轮是别的兜底 Provider 答的，调用方应轮换。
function deltaMessages(options, binding) {
  const all = options?.messages ?? []
  const start = Math.max(0, Math.min(binding?.syncedMsgsCount ?? 0, all.length))
  const delta = all.slice(start)
  while (delta.length > 0 && delta[0]?.role === 'assistant' && contentText(delta[0].content) === (binding?.lastReply ?? '')) {
    delta.shift()
  }
  return { delta, foreignReply: delta.length > 0 && delta[0]?.role === 'assistant' }
}

async function stopClient(client) {
  if (!client || typeof client.stop !== 'function') return
  try { await client.stop() } catch {}
}

// ---- 会话绑定表：bindingKey -> { client, agySessionId, systemHash, syncedMsgsCount, modelId, turns } ----
// 容量上限 MAX_BINDINGS 条 LRU；同时存活子进程上限 MAX_LIVE_SESSIONS，超了 stop() 淘汰。
export class SessionBindingStore {
  constructor({ maxBindings = MAX_BINDINGS, maxLive = MAX_LIVE_SESSIONS, onEvict = null } = {}) {
    this.maxBindings = Math.max(1, maxBindings)
    this.maxLive = Math.max(1, maxLive)
    this.onEvict = onEvict
    this.map = new Map()
  }

  get size() {
    return this.map.size
  }

  // 命中即提到队尾（最近使用）
  touch(key) {
    const entry = this.map.get(key)
    if (!entry) return null
    this.map.delete(key)
    this.map.set(key, entry)
    return entry
  }

  create(key, seed = {}) {
    const entry = {
      key,
      client: null,
      agySessionId: null,
      systemHash: '',
      systemText: '',
      syncedMsgsCount: 0,
      modelId: null,
      turns: 0,
      lastReply: '',
      toolsTenant: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...seed,
    }
    this.map.set(key, entry)
    this._evict(key)
    return entry
  }

  delete(key) {
    const entry = this.map.get(key)
    if (!entry) return null
    this.map.delete(key)
    return entry
  }

  liveClients() {
    return [...this.map.values()].filter((e) => e?.client?.sessionId)
  }

  // 给辅助请求腾一个活会话槽位（账号风控：别把并发 agy 进程顶过上限）。
  // isProtected：正在跑主对话的绑定一律不许动 —— 为了给一条自动起标题腾位置就把
  // 主会话的子进程 stop 掉，前端当场看到流被掐断、弹"重新连接中"。腾不出就不腾。
  evictOldestLive(isProtected = null) {
    const victim = this.liveClients().find((e) => !(isProtected && isProtected(e)))
    if (!victim) return null
    this._drop(victim.key)
    return victim.key
  }

  keys() {
    return [...this.map.keys()]
  }

  _evict(keepKey) {
    while (this.map.size > this.maxBindings) {
      const others = this.keys().filter((k) => k !== keepKey)
      if (others.length === 0) break
      const victim = others.find((k) => !this.map.get(k)?.client?.sessionId) ?? others[0]
      this._drop(victim)
    }
    this.enforceLive(keepKey)
  }

  // 账号风控：不并发烧多进程。超出保活上限就按 LRU 干掉最老的（跳过 keepKey）。
  // 注意 create() 时新绑定还没有 client，所以在会话真正建好之后要再调一次。
  enforceLive(keepKey = null) {
    for (;;) {
      const live = this.liveClients()
      if (live.length <= this.maxLive) break
      const victim = live.find((e) => e.key !== keepKey)
      if (!victim) break
      this._drop(victim.key)
    }
  }

  _drop(key) {
    const entry = this.map.get(key)
    if (!entry) return
    this.map.delete(key)
    try { this.onEvict?.(entry) } catch {}
  }

  // 清空并返回所有条目，让调用方去 stop 进程
  clear() {
    const all = [...this.map.values()]
    this.map.clear()
    return all
  }
}

// ---- 多模态投递（教程 §5.2）----
// 图片块只作为锚点留在正文里，真二进制提升到顶层 session/prompt 的 ContentBlock[] 末尾。
const IMAGE_MIME_ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp'])
// agy 单次 prompt 的图片上限没有实测数据，保守取 8 张（base64 体积 + 首包延迟），超出降级成文本占位
const MAX_IMAGES_PER_REQUEST = 8
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const IMAGE_FOLDED_TEXT = '[历史工具图片已折叠]'
// 重建历史时只认最近这么多条消息里的图；更早的附图一律折叠（远古截图不能被当成本轮新图）
const REBUILD_IMAGE_HOT_WINDOW = 6
const GIF_TEXT = '[图片：GIF 动图，当前通道暂不支持直接读帧]'

function isImageBlock(block) {
  return block?.type === 'image'
}

function imageMediaType(block) {
  return String(block?.attachment?.mediaType ?? block?.mediaType ?? block?.mimeType ?? '').toLowerCase()
}

function imageRef(block) {
  return block?.attachment ?? block?.ref ?? null
}

function contentHasImage(content) {
  return Array.isArray(content) && content.some(isImageBlock)
}

// 读图只走 DSH 注入的 attachment store（或 content 里现成的 base64），不自己碰磁盘/凭据
// 从 DSH attachment store（或 content 里现成的 base64）取原始字节，不碰磁盘/凭据
async function readImageBytes(adapter, block, signal) {
  try {
    const inline = typeof block?.data === 'string' ? block.data : null
    if (inline) {
      const bytes = Buffer.from(inline, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null
      return bytes
    }
    const ref = imageRef(block)
    const store = adapter?.opts?.attachments
    if (!ref || typeof store?.readImage !== 'function') return null
    const stored = await store.readImage(ref, signal)
    const raw = stored?.data
    if (!raw || raw.byteLength === 0 || raw.byteLength > MAX_IMAGE_BYTES) return null
    return Buffer.from(raw)
  } catch {
    return null
  }
}

async function loadImageBlock(adapter, block, mediaType, signal) {
  const bytes = await readImageBytes(adapter, block, signal)
  if (!bytes) return null
  return { type: 'image', data: bytes.toString('base64'), mimeType: mediaType }
}

// D3 GIF 兜底：先用 sharp 抽首帧转静态 PNG，环境里没有转码器才降级成文本占位。
// 探测结论只算一次（一次成功定终身、一次失败也定终身），不然每张动图都要白跑
// 一遍 ERR_MODULE_NOT_FOUND；换来的是「以后装了 sharp 自动就能读动图」。
let gifEncoder
let gifEncoderProbed = false
async function gifFirstFramePng(bytes) {
  if (!gifEncoderProbed) {
    gifEncoderProbed = true
    try {
      const mod = await import('sharp')
      gifEncoder = mod?.default ?? mod
    } catch {
      gifEncoder = null
    }
  }
  if (typeof gifEncoder !== 'function') return null
  try {
    const png = await gifEncoder(bytes, { animated: false, page: 0 }).png().toBuffer()
    return png?.byteLength > 0 ? png : null
  } catch {
    return null
  }
}

// 把消息里的 image 块换成文本锚点，同时收集要提升到顶层的 image blocks。
// rebuild：只留最后一条带图消息里的图，更早的历史图折叠（别把旧图塞爆请求）。
async function prepareImages(adapter, messages, { rebuild = false, signal } = {}) {
  const list = Array.isArray(messages) ? messages : []
  let lastImageMsg = -1
  if (rebuild) {
    // 重建时只认「最近热窗」里的图。只按「最后一条带图消息」找是错的：重启后第一轮
    // 往往是纯文本，最后一条带图消息其实是远古截图 —— 它会被重新打包进重启首轮，
    // 上游盖上最新时间戳标成「用户刚上传了 1 张图」，模型就当成本轮新图信了。
    const from = Math.max(0, list.length - REBUILD_IMAGE_HOT_WINDOW)
    for (let i = list.length - 1; i >= from; i--) {
      if (contentHasImage(list[i]?.content)) { lastImageMsg = i; break }
    }
  }

  const prepared = []
  const images = []
  let ordinal = 0

  for (let mi = 0; mi < list.length; mi++) {
    const message = list[mi]
    if (!contentHasImage(message?.content)) { prepared.push(message); continue }
    const blocks = []
    for (const block of message.content) {
      if (!isImageBlock(block)) { blocks.push(block); continue }
      ordinal += 1
      const anchor = `[图片 ${ordinal}]`
      const mediaType = imageMediaType(block)
      if (rebuild && mi !== lastImageMsg) {
        blocks.push({ type: 'text', text: IMAGE_FOLDED_TEXT })
        continue
      }
      if (mediaType === 'image/gif') {
        const raw = await readImageBytes(adapter, block, signal)
        const png = raw ? await gifFirstFramePng(raw) : null
        if (png && images.length < MAX_IMAGES_PER_REQUEST) {
          images.push({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })
          blocks.push({ type: 'text', text: anchor })
        } else {
          blocks.push({ type: 'text', text: `${anchor} ${GIF_TEXT}` })
        }
        continue
      }
      if (!IMAGE_MIME_ALLOWED.has(mediaType)) {
        blocks.push({ type: 'text', text: `${anchor} [图片：不支持的格式 ${mediaType || '未知'}]` })
        continue
      }
      if (images.length >= MAX_IMAGES_PER_REQUEST) {
        blocks.push({
          type: 'text',
          text: `${anchor} [图片：超出单次请求上限 ${MAX_IMAGES_PER_REQUEST} 张，未随请求发送]`,
        })
        continue
      }
      const loaded = await loadImageBlock(adapter, block, mediaType, signal)
      if (!loaded) {
        blocks.push({ type: 'text', text: `${anchor} [图片：当前通道未能读取该附件]` })
        continue
      }
      images.push(loaded)
      blocks.push({ type: 'text', text: anchor })
    }
    prepared.push({ ...message, content: blocks })
  }

  return { messages: prepared, images }
}

class AgyCliAdapter {
  constructor(opts = {}) {
    this.opts = opts
    this.maxSessionTurns = opts.maxSessionTurns ?? MAX_SESSION_TURNS
    // null = 不额外过滤（DSH 传什么挂什么）；传数组才当白名单用
    this.allowedTools = Array.isArray(opts.allowedTools) ? new Set(opts.allowedTools) : null
    // 模型目录先吃静态表，`agy models` 拉回来后再合并（账号池不同，carbon/neon 会不一样）
    this.models = MODELS.map(([id, label]) => [id, label])
    this.modelsProbed = false
    // 同一会话的 stream 串行化（辅助请求不占槽）
    this.gate = new StreamGate()
    this.clientFactory = typeof opts.clientFactory === 'function'
      ? opts.clientFactory
      : (o) => new AgyAcpClient(o)
    this.bridgeFactory = typeof opts.bridgeFactory === 'function'
      ? opts.bridgeFactory
      : (o) => new McpBridge(o)
    this.bridge = null
    this.tenantTools = new Map()
    this.auxClients = new Set()
    this.turnSeq = 0
    this.store = new SessionBindingStore({
      maxBindings: opts.maxBindings ?? MAX_BINDINGS,
      maxLive: opts.maxLiveSessions ?? MAX_LIVE_SESSIONS,
      onEvict: (entry) => { void stopClient(entry.client) },
    })
    this.turns = new TurnStateStore({
      maxEntries: opts.maxTurns ?? MAX_TURN_STATES,
      onEvict: (state) => this._disposeTurn(state, 'turn-evicted'),
    })
    // B4：绑定落盘（进程重启后能接着 resume 只发增量）。
    // 默认关闭：直接 new 适配器的单测会塞假 cwd（C:/fake），不该在磁盘上留东西；
    // 生产入口 apply() 显式打开，路径也由它给（默认 <cwd>/.dsh-agycli/bindings.json）。
    this.bindingsStore = null
    if (opts.persistBindings) {
      try {
        this.bindingsStore = new PersistedBindingStore({
          file: opts.bindingsFile || defaultBindingPath(opts.bindingsDir ?? opts.cwd ?? process.cwd()),
          maxBindings: opts.maxPersistedBindings ?? MAX_PERSISTED_BINDINGS,
          flushDelayMs: opts.bindingsFlushMs,
        })
        this.bindingsStore.load()
      } catch (e) {
        this.bindingsStore = null
        opts.onError?.(e)
      }
    }
  }

  providerInfo(provider) {
    return { id: provider, name: 'Antigravity CLI (agycli)' }
  }

  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  /** 异步与 agy 实测模型池取并集；只跑一次，失败静默退回静态表。 */
  async refreshModels() {
    if (this.modelsProbed) return this.models
    this.modelsProbed = true
    let rows = []
    try {
      rows = await runAgyModels(this.opts.bin, this.opts.home, this.opts.proxy)
    } catch (e) {
      this.opts.onError?.(e)
    }
    if (!Array.isArray(rows) || rows.length === 0) return this.models
    // 静态表打底、实测表补齐：静态表里的顺序和标签是我们自己维护的，别被覆盖
    const merged = new Map(MODELS.map(([id, label]) => [id, label]))
    for (const [id, label] of rows) if (!merged.has(id)) merged.set(id, label)
    this.models = [...merged.entries()]
    return this.models
  }

  async listModels(provider) {
    return (this.models ?? MODELS).map(([id, label]) => ({
      provider,
      id,
      name: label,
      inputModalities: inputModalitiesFor(id),
    }))
  }

  async resolveModel(provider, model) {
    const hit = (this.models ?? MODELS).find(([id]) => id === model)
    return {
      provider,
      id: model,
      name: hit?.[1] ?? model,
      // 只有真机验过能看图的家族才声明 image，其余保守纯文本
      // （DSH 不含 'image' 时会把图片块静默替换成文本占位符）
      inputModalities: inputModalitiesFor(model),
      // agy 单发 65k 字符截断线，按中文 1.6 字符/token 折算约 37k tokens；
      // 对外声明保守值，别让 compaction 按 786K 的假窗口定阈值。
      context: { contextWindow: 40_000 },
      defaultMaxTokens: 8_192,
      reasoning: { efforts: EFFORTS, defaultEffort: 'medium' },
    }
  }

  async prepareCall(provider, model, signal) {
    const info = await this.resolveModel(provider, model, signal)
    const modelId = info?.id ?? model ?? null
    // model 跟着 stream 一起走：stream 建立/切换会话时才知道该不该 setModel
    return { model: info, stream: (options) => this.stream(options, modelId) }
  }

  _newClient(binding) {
    const client = this.clientFactory({
      bin: this.opts.bin,
      home: this.opts.home,
      proxy: this.opts.proxy,
      agent: this.opts.agent,
      cwd: this.opts.cwd,
      // A4 播种：测试传 seed:false 就不许往真机 home 里写东西
      seed: this.opts.seed,
      // B3：权限守门员挂在 client 上，只通过闭包读 adapter 的 turns/allowedTools，不把内部结构递出去
      permissionPolicy: (params) => this._authorizePermission(params),
    })
    client.on?.('error', (e) => {
      // 进程级错误只记录，不打断当前流（流会自行超时/取消）
      this.opts.onError?.(e)
    })
    binding.client = client
    return client
  }

  // 模型透传：优先 session/set_model，-32602 时由 client 内部降级 set_config_option
  async _applyModel(binding, client, modelId) {
    if (!modelId || binding.modelId === modelId) return
    if (typeof client.setModel !== 'function') {
      binding.modelId = modelId
      return
    }
    try {
      await client.setModel(modelId)
      binding.modelId = modelId
    } catch (e) {
      // 切模型失败不该掐掉本轮对话，记下来继续
      this.opts.onError?.(e)
    }
  }

  // ---- B3：权限三重交集（活跃 Turn + dsh 前缀/服务器名 + allowedTools 白名单）----
  // 由 client 通过闭包回调，这里只读 turns / allowedTools，不把内部结构递出去。
  _authorizePermission(params) {
    const sessionId = params?.sessionId ?? params?.toolCall?.sessionId ?? null
    const turn = this._turnForAgySession(sessionId)
    if (!turn) return false
    if (turn.abandoned || turn.retired) return false
    // 熔断后这一轮已经不作数了，后面所有权限请求一律拒（模型可能还在自说自话要动手）
    if (turn.echoDetected) return false
    const tc = params?.toolCall ?? {}
    const rawName = String(tc.name ?? tc.toolName ?? '')
    // 第二条：现有的两层判据（agy 给桥工具加 mcp_dsh_ 前缀，或直接报 mcpServerName === 'dsh'）
    const fromDshServer = tc.mcpServerName === 'dsh'
    if (!rawName.startsWith('mcp_dsh_') && !fromDshServer) return false
    const bare = rawName.replace(/^mcp_dsh_/, '')
    // 第三条：内部中继工具不受 allowedTools 约束；其余必须在白名单里
    if (bare === AWAIT_RESULT_TOOL) return true
    return this._isAllowedToolName(turn, bare)
  }

  _isAllowedToolName(turn, bare) {
    const allowed = turn?.allowedTools
    // null = 未设白名单（DSH 给什么挂什么），此时第三条自动成立
    if (allowed === null || allowed === undefined) return true
    if (typeof allowed.has === 'function') return allowed.has(bare)
    if (Array.isArray(allowed)) return allowed.includes(bare)
    return false
  }

  /** 按 agy 会话 id 找活跃 turn（只读遍历，不动 LRU 顺序）。 */
  _turnForAgySession(sessionId) {
    if (sessionId === undefined || sessionId === null) return null
    const wanted = String(sessionId)
    for (const turn of this.turns.values()) {
      if (turn?.acpSessionId && String(turn.acpSessionId) === wanted) return turn
    }
    return null
  }

  /**
   * 当前正在主对话上跑着的 agy 会话 id 集合（流式中 / park 等工具 / 续跑）。
   * 只有 done / error / disposed 算收工；parked 是"等工具回执"，绝不能当空闲。
   */
  _busyAgySessions() {
    const busy = new Set()
    for (const turn of this.turns.values()) {
      if (!turn) continue
      const status = turn.status
      if (status === 'done' || status === 'error' || status === 'disposed') continue
      if (turn.acpSessionId) busy.add(String(turn.acpSessionId))
      const bound = turn.binding?.agySessionId
      if (bound) busy.add(String(bound))
    }
    return busy
  }

  // ---- B4：绑定落盘 ----
  _persistBinding(binding) {
    if (!this.bindingsStore || !binding?.key || !binding.agySessionId) return
    try {
      this.bindingsStore.set(binding.key, {
        agySessionId: binding.agySessionId,
        systemHash: binding.systemHash ?? '',
        syncedMsgsCount: binding.syncedMsgsCount ?? 0,
        prefixHash: binding.prefixHash ?? '',
        modelId: binding.modelId ?? null,
        provider: PROVIDER,
        turns: binding.turns ?? 0,
        updatedAt: Date.now(),
      })
    } catch (e) {
      this.opts.onError?.(e)
    }
  }

  /** 内存里没有这条绑定时，从盘上认领回来（不改 client，会话靠 session/resume 接）。 */
  _hydrateFromDisk(binding, key) {
    const saved = this.bindingsStore?.get(key)
    if (!saved?.agySessionId) return false
    binding.agySessionId = saved.agySessionId
    binding.systemHash = saved.systemHash || ''
    binding.syncedMsgsCount = saved.syncedMsgsCount || 0
    binding.prefixHash = saved.prefixHash || ''
    binding.turns = saved.turns || 0
    binding.modelId = null
    binding.restored = true
    return true
  }

  // B4：进程重启后接着用旧会话，只发增量。失败不抛——退回全量重建更稳。
  async _resumeSession(binding, client, targetModel, mcpServers) {
    const previous = binding.agySessionId
    if (!previous) return false
    client.start?.()
    try {
      await client.resumeSession({
        sessionId: previous,
        cwd: this.opts.cwd ?? process.cwd(),
        mcpServers,
      })
      binding.agySessionId = client.sessionId ?? previous
      if (targetModel) await this._applyModel(binding, client, targetModel)
      this._persistBinding(binding)
      return true
    } catch (e) {
      this.opts.onError?.(new Error(`agycli: session/resume 失败，退回全量重建（${e?.message || e}）`))
      binding.client = null
      binding.agySessionId = null
      await stopClient(client)
      return false
    }
  }

  // ---- B4：轮换判据（轮数 + token 死线）----
  // token 优先用真机 usage_update 推过来的 used（会话累计），读不到才落回 SQLite 探测
  // （当前 agy 1.5.11 的库结构里没有明文 token 列，那条路恒返回 null，等于不生效）。
  _estimatedTokens(binding) {
    const used = binding?.usageUsed
    if (Number.isFinite(used) && used >= 0) return used
    if (!binding?.agySessionId) return null
    try {
      return readEstimatedTokens(this.opts.home, binding.agySessionId)
    } catch (e) {
      this.opts.onError?.(e)
      return null
    }
  }

  _rotateDecision(binding, messageCount = 0) {
    try {
      // 消息条数顶：agy 单会话消息过 500 会卡死，而轮数判据兜不住它——
      // 工具密集时一轮 turn 能带好几条 message（tool-call / tool-result 各算一条），
      // 200 轮的会话可能已经攒了几千条。留 100 条余量，撞 400 就提前换。
      if (messageCount >= MAX_SESSION_MESSAGES) return { rotate: true, reason: 'messages-cap' }
      return shouldRotate({
        turns: binding?.turns ?? 0,
        estimatedTokens: this._estimatedTokens(binding),
        maxTurns: this.maxSessionTurns,
      })
    } catch (e) {
      this.opts.onError?.(e)
      return { rotate: false, reason: null }
    }
  }

  async _newSession(binding, client, systemText, targetModel, mcpServers = [], toolsTenant = null) {
    client.start?.()
    try {
      await client.initialize()
      await client.newSession({
        cwd: this.opts.cwd ?? process.cwd(),
        systemPromptAppend: systemText || undefined,
        mcpServers,
        // 每次建会话都护住首段（system 指令 + 上下文锚点），教程 C4/B4 要求
        pinFirstSegment: true,
      })
    } catch (e) {
      // 握手/建会话失败：半死的子进程不留，下轮重新拉
      await stopClient(client)
      binding.client = null
      binding.agySessionId = null
      // C3 预登记的 turn 不能留在册上，否则下一轮 _turnForAgySession 会摸到一个死 turn
      if (binding.pendingTurn) {
        this.turns.delete(binding.pendingTurn.sessionKey)
        binding.pendingTurn = null
      }
      throw e
    }
    binding.agySessionId = client.sessionId ?? null
    // C3：预登记的 turn 此刻才拿到真正的 acpSessionId，就地回填（别换对象，_consume 还引用着它）
    if (binding.pendingTurn) binding.pendingTurn.acpSessionId = binding.agySessionId
    // 会话刚建好才算“存活进程”，此刻补一次保活上限检查
    this.store.enforceLive(binding.key)
    binding.systemHash = hashText(systemText)
    binding.systemText = systemText
    binding.syncedMsgsCount = 0
    binding.turns = 0
    binding.lastReply = ''
    binding.modelId = null
    binding.toolsTenant = toolsTenant
    // 新会话 = token 用量从头算；旧的 usage_update 不能带过来
    binding.usageUsed = null
    binding.usageSize = null
    binding.restored = false
    if (targetModel) await this._applyModel(binding, client, targetModel)
    this._persistBinding(binding)
  }

  // ---- 工具挂载 ----
  // allowedTools 为 null 表示「DSH 给什么就挂什么」：真正的授权边界在 DSH 自己的
  // 工具沙箱 + _authorizePermission 三重交集上，adapter 不在这里二次砍。
  // 早期写死 ['read'] 导致 preset 挂的 fs-search / subagent / todo 全被静默滤掉，
  // 模型看到空工具表只能空口聊天。
  _mountTools(options) {
    const all = Array.isArray(options?.tools) ? options.tools : []
    if (!this.allowedTools) return all
    return all.filter((t) => this.allowedTools.has(String(t?.name ?? '').replace(/^mcp_dsh_/, '')))
  }

  async _ensureBridge() {
    if (!this.bridge) {
      this.bridge = this.bridgeFactory({
        getTools: (tenantKey) => this.tenantTools.get(tenantKey) ?? [],
        shouldPark: (call) => this._shouldPark(call),
        onPark: (entry) => this._onPark(entry),
        onRelay: (entry) => this._onRelay(entry),
        onCall: (entry) => this._onCall(entry),
        keepaliveMs: this.opts.keepaliveMs,
        relayAfterMs: this.opts.relayAfterMs,
      })
    }
    await this.bridge.start?.()
    return this.bridge
  }

  // 工具表过闸：单工具 1,350B 预压 + 全包 54,000B 总闸，超限不静默。
  // 桥的 tools/list 只认 name/description/inputSchema，demoted/demoteStage/fullDescription
  // 由桥自然丢弃，不为了这些元数据去动桥。
  _buildToolBundle(tools) {
    const raw = Array.isArray(tools) ? tools : []
    let bundle = null
    try {
      bundle = buildMcpToolBundle(raw)
    } catch (e) {
      this.opts.onError?.(e)
    }
    if (!bundle) {
      // 闸自己挂了也不能把工具丢了：退回原始表，补偿段按原始表兜一次
      return { tools: raw, totalBytes: 0, overBudget: false, systemPromptAppend: safeCompensation(raw) }
    }
    if (bundle.overBudget) {
      // 每轮都会过闸，长期超限同一条告警只留一次，签名变了才再报（别把日志刷成一片）
      const signature = `${raw.length}:${bundle.totalBytes}`
      if (this.overBudgetSignature !== signature) {
        this.overBudgetSignature = signature
        this.opts.onError?.(new Error(
          `agycli: MCP 工具表压到 Stage 3 仍超 ${MAX_MCP_TOOLS_TOTAL_BYTES} 字节`
          + `（实测 ${bundle.totalBytes}B / ${raw.length} 个工具），agy 可能静默丢弃部分工具`,
        ))
      }
    } else {
      this.overBudgetSignature = null
    }
    const compressed = Array.isArray(bundle.tools) ? bundle.tools : raw
    return {
      tools: compressed,
      totalBytes: bundle.totalBytes ?? 0,
      overBudget: Boolean(bundle.overBudget),
      systemPromptAppend: bundle.systemPromptAppend || safeCompensation(compressed) || safeCompensation(raw),
    }
  }

  _shouldPark(call) {
    const turn = this.turns.touch(call?.tenantKey)
    if (!turn) return false
    return turn.status === 'prompting' || turn.status === 'resuming'
  }

  // park 之后新增的**用户/助手**消息里有没有图片（教程 §5.2 的 handover 判据）。
  // tool-result 里的图不算：它们走 _resumeTurn 回填，不该触发重建。
  _hasNewImages(turn, messages) {
    const start = Math.max(0, Math.min(turn?.messagesCount ?? 0, messages.length))
    for (let i = start; i < messages.length; i++) {
      if (messages[i]?.role === 'tool') continue
      if (contentHasImage(messages[i]?.content)) return true
    }
    return false
  }

  // 桥上把 agy 的 tools/call 挂起后回调这里：转成一个待吐给 DSH 的 tool-call
  _onPark(entry) {
    const turn = this.turns.touch(entry?.tenantKey)
    if (!turn || turn.status === 'done' || turn.status === 'aborted' || turn.status === 'error') {
      this.bridge?.abortParkedCall?.(entry?.callKey)
      return
    }
    const callId = `call_${turn.turnSeq}_${turn.pendingCalls.size + 1}`
    const argsJson = JSON.stringify(entry.arguments ?? {})
    turn.pendingCalls.set(callId, { bridgeCallKey: entry.callKey, name: entry.name, argsJson })
    turn.bridgeCallIds.set(entry.callKey, callId)
    turn.updatedAt = Date.now()
    // 拿到真工具调用了：接力间隙的抑制到此为止
    turn.suppressRelayText = false
    turn.client?.setIdlePaused?.(true)
    this._push(turn, { kind: 'park', callId, bridgeCallKey: entry.callKey, name: entry.name, argsJson })
  }

  // C4：每次 tools/call 到达都解除文字抑制——模型已经动了，接着说话就不算碎碎念
  _onCall(entry) {
    const turn = this.turns.touch(entry?.tenantKey)
    if (!turn) return
    turn.suppressRelayText = false
  }

  // C4：桥把「还在跑」接力回 agy 了。模型接下来那段解释性碎碎念不吐给 DSH。
  _onRelay(entry) {
    const turn = this.turns.touch(entry?.tenantKey)
    if (!turn) return
    turn.suppressRelayText = true
    turn.updatedAt = Date.now()
  }

  // ---- 事件队列：后台 pump 往 turn.events 里塞，stream() 取；两者解耦才能「吐完 call 就 return」 ----
  _push(turn, event) {
    const waiter = turn.waiters.values().next().value
    if (waiter) {
      turn.waiters.delete(waiter)
      if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.resolve(event)
      return
    }
    turn.events.push(event)
    // park 期间若 agy 还在吐（正常不会，它卡在工具调用上），别让队列无限长
    if (turn.events.length > 4096) turn.events.shift()
  }

  _nextEvent(turn, signal) {
    if (turn.events.length > 0) return Promise.resolve(turn.events.shift())
    if (turn.pumpDone) {
      return Promise.resolve(turn.pumpError ? { kind: 'error', error: turn.pumpError } : null)
    }
    return new Promise((resolve) => {
      const waiter = { resolve, signal, onAbort: null }
      if (signal) {
        waiter.onAbort = () => {
          turn.waiters.delete(waiter)
          resolve({ kind: 'abort' })
        }
        if (signal.aborted) {
          waiter.onAbort()
          return
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      turn.waiters.add(waiter)
    })
  }

  // 后台消费 promptStream：park 之后不能继续读，否则 adpater 一 return 就把 agy 那侧取消了
  // 顶层 blocks 直接交给 promptStream 的 { blocks } 形态去投递，不再改写 client._write。
  _startPump(turn, client, promptText, promptBlocks = null) {
    const controller = new AbortController()
    turn.pumpAbort = controller
    turn.pumpDone = false
    turn.pumpError = null
    turn.promptChars = promptText.length
    // C4 自动继续要能再起一轮 pump，client 得挂在 turn 上
    turn.client = client
    ;(async () => {
      try {
        for await (const c of client.promptStream(promptText, { signal: controller.signal, blocks: promptBlocks })) {
          if (c?.type === 'usage') {
            this._recordUsage(turn, c)
            continue
          }
          // 思维链单独转发，别当成正文文本（否则会被 NoticeFilter 当正文吞/吐到正文里）
          if (c?.type === 'thought') {
            if (c.text) this._push(turn, { kind: 'thought', text: c.text })
            continue
          }
          if (!c?.text || isCancelLeak(c.text)) continue
          this._push(turn, { kind: 'text', text: c.text })
        }
        turn.pumpDone = true
        for (const w of [...turn.waiters]) w.resolve(null)
        turn.waiters.clear()
      } catch (e) {
        turn.pumpError = e
        turn.pumpDone = true
        this._push(turn, { kind: 'error', error: e })
      }
    })().catch(() => {})
  }

  // B4：真机 usage_update（{used, size}）优先当 token 用量，SQLite 探测只兜底
  _recordUsage(turn, usage) {
    const used = Number(usage?.used)
    if (!Number.isFinite(used) || used < 0) return
    const size = Number(usage?.size)
    const windowSize = Number.isFinite(size) && size > 0 ? size : null
    turn.usageUsed = used
    turn.usageSize = windowSize
    if (turn.binding) {
      turn.binding.usageUsed = used
      // 真机窗口报 1,048,576；教程的 786,432 硬顶大概是老版本口径，阈值仍按保守值走
      turn.binding.usageSize = windowSize
    }
  }

  // C4 自动继续：只有在「没有任何正文」+「桥里还有接力中的调用」+「还没补过」时才补
  _needsRelayAutoContinue(turn, textStarted) {
    if (textStarted || (turn?.text ?? '').length > 0) return false
    if ((turn?.relayAutoContinues ?? 0) >= MAX_RELAY_AUTO_CONTINUES) return false
    if (!turn?.client) return false
    return (this.bridge?.awaitingCountFor?.(turn.sessionKey) ?? 0) > 0
  }

  // 消费队列并吐 chunk。park 时只吐到 tool-call block 就收尾。
  async *_consume(turn, options) {
    const signal = options?.signal
    if (!turn.noticeFilter) {
      turn.noticeFilter = new NoticeFilter()
      turn.tos = new TosWindow()
    }
    // 铁律：aborted 之后任何路径都不许再 yield，直接抛
    const ensureLive = () => {
      if (signal?.aborted) throw abortError()
    }
    let textStarted = false
    // 思维链块单独占 index 2（text 用 0、tool-call 用 0/1），绝不与正文混流：
    // 一是正文被思考污染，二是空窗期前端收不到任何东西就会退避重连。
    let thoughtStarted = false
    let thoughtText = ''
    let parkedAny = false
    let failure = null
    let noticeFailure = null

    for (;;) {
      ensureLive()
      const ev = await this._nextEvent(turn, signal)
      if (signal?.aborted || ev?.kind === 'abort') throw abortError()
      if (!ev) {
        // C4：模型无视「still running」提示、一句正文都没吐就收尾 → 补一轮提醒再消费
        if (this._needsRelayAutoContinue(turn, textStarted)) {
          turn.relayAutoContinues = (turn.relayAutoContinues ?? 0) + 1
          this._startPump(turn, turn.client, RELAY_AUTO_CONTINUE_TEXT, null)
          continue
        }
        break
      }
      // 思维链：单独成块、只走 reasoning-delta，绝不并进正文。
      // 顺带把 agy 的长时间思考变成可见的流 —— 空窗没了，前端就不会退避重连。
      if (ev.kind === 'thought') {
        ensureLive()
        if (ev.text) {
          if (!thoughtStarted) {
            thoughtStarted = true
            yield { type: 'block-start', index: 2, blockType: 'reasoning' }
          }
          thoughtText += ev.text
          yield { type: 'reasoning-delta', index: 2, text: ev.text }
        }
        continue
      }
      if (ev.kind === 'text') {
        // 熔断：agy 把历史和系统回调拍平成纯文本喂模型，掉思考链时模型会自导自演续写
        // 系统回执（"Background subagent ... finished" / "[assistant]" / "</USER_REQUEST>"），
        // 而且紧接着就在同一次 session/prompt 里发起真实 tool_call —— 权限一放行就真落盘。
        // 扫到这类句式：本轮停止吐字、掐停会话、并让后续权限请求一律拒绝。
        const echo = detectSystemEcho(ev.text)
        if (echo && !turn.echoDetected) {
          turn.echoDetected = echo
          this.opts.onError?.(new Error(`agycli: 检测到系统回执续写，本轮熔断（${echo}）`))
          turn.client?.cancel?.().catch?.(() => {})
          break
        }
        const filtered = turn.noticeFilter.push(ev.text)
        const tosHit = turn.tos.push(ev.text)
        if (filtered.notices.length > 0 && !noticeFailure) noticeFailure = filtered.notices[0]
        if (tosHit && !noticeFailure) {
          noticeFailure = { code: 'TOS_VIOLATION', message: 'agy 账号被风控拦截（TOS）' }
        }
        // C4：接力间隙的碎碎念不吐给 DSH——工具还在跑，模型只是在找话说
        if (filtered.text && !turn.suppressRelayText) {
          ensureLive()
          if (!textStarted) {
            textStarted = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          turn.text = (turn.text ?? '') + filtered.text
          yield { type: 'text-delta', index: 0, text: filtered.text }
        }
        if (noticeFailure) break
        continue
      }
      if (ev.kind === 'error') {
        failure = ev.error
        break
      }
      if (ev.kind === 'park') {
        ensureLive()
        const flushed = turn.noticeFilter.flush()
        // park 优先：工具调用不能被一条告警吞掉，只留痕
        if (flushed.notices.length > 0) {
          this.opts.onError?.(new Error(`agycli: park 前收到 ${flushed.notices[0].code} 通知`))
        }
        if (flushed.text) {
          if (!textStarted) {
            textStarted = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          turn.text = (turn.text ?? '') + flushed.text
          yield { type: 'text-delta', index: 0, text: flushed.text }
          ensureLive()
        }
        if (thoughtStarted) {
          yield { type: 'block-end', index: 2, block: { type: 'reasoning', text: thoughtText } }
          thoughtStarted = false
        }
        if (textStarted) {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.text ?? '' } }
        }
        const index = textStarted ? 1 : 0
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: ev.callId, name: ev.name, argumentsDelta: ev.argsJson }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: ev.callId, name: ev.name, arguments: ev.argsJson },
        }
        parkedAny = true
        break
      }
    }

    if (parkedAny) {
      ensureLive()
      turn.status = 'parked'
      turn.updatedAt = Date.now()
      // C4 铁律：先把绑定固化到盘上，再 yield finish。
      // 反过来的话消费方拿到 finish 就可能立刻换下一个 turn（甚至在进程崩掉前），
      // 盘上还记着旧的 syncedMsgsCount，下一轮 delta 会把这段工具结果重发一遍。
      if (turn.binding) {
        turn.binding.syncedMsgsCount = turn.messagesCount ?? turn.binding.syncedMsgsCount
        this._persistBinding(turn.binding)
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    // 行缓冲里剩下的正文吐完（正常结束路径；命了通知就不吐了）
    if (!noticeFailure) {
      const flushed = turn.noticeFilter.flush()
      if (flushed.notices.length > 0) noticeFailure = flushed.notices[0]
      if (flushed.text) {
        ensureLive()
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        turn.text = (turn.text ?? '') + flushed.text
        yield { type: 'text-delta', index: 0, text: flushed.text }
      }
    }

    if (thoughtStarted) {
      ensureLive()
      yield { type: 'block-end', index: 2, block: { type: 'reasoning', text: thoughtText } }
      thoughtStarted = false
    }

    if (textStarted) {
      ensureLive()
      yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.text ?? '' } }
    }

    if (noticeFailure) {
      turn.status = 'error'
      // 会话死锁（unreachable / panic 类）是**永久性**的：重试同一个 agy 会话只会原地卡死。
      // 把绑定标记成需要重建，DSH 下次重试进来就会走 session/new 全量重建。
      if (DEAD_SESSION_CODES.has(noticeFailure.code)) {
        this.opts.onError?.(new Error(`agycli: 会话死锁（${noticeFailure.code}），标记轮换重建`))
        turn.binding.agySessionId = null
        turn.binding.restored = false
      }
      ensureLive()
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: noticeFailure.message, code: noticeFailure.code } },
      }
      return
    }
    if (failure) {
      turn.status = 'error'
      const message = String(failure?.message ?? failure ?? '')
      // 断流（TLS EOF / 代理抖动 / agy 内部报错）之后绝不能复用同一条 agy 会话续发：
      // 那一轮的 delta 已经发出去了，agy 历史里可能已经留着半句话；下一次重试若仍按
      // 旧游标切片，就会把同一段再灌一遍，表现成「agy 历史里同一个问题出现两次」。
      // 标记成待重建，下一轮走 session/new 全量重发（游标此时不提交，见 _finishTurn）。
      if (turn.binding) {
        turn.binding.agySessionId = null
        turn.binding.restored = false
        // 盘上那条也要抹掉，否则下次 _hydrateFromDisk 会把死会话连同旧游标一起捞回来
        try { this.bindingsStore?.delete?.(turn.binding.key) } catch (e) { this.opts.onError?.(e) }
      }
      ensureLive()
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'AGY_STREAM_FAILED' } } }
      return
    }

    // 判据只看"有没有可见正文"，不看 textStarted：agy 吐一行 '\n' 就会把 textStarted 置真，
    // 若把它写进条件，空白回复会直接短路成成功，游标照样被推进。
    if (!String(turn.text ?? '').trim()) {
      // 空回复不塞空 assistant 消息：交给 llm-retry（EMPTY_RESPONSE 在可重试码表里）
      // 状态必须是 error，不能是 done：_finishTurn 只在 done/parked 时提交 syncedMsgsCount，
      // 一旦标成 done，游标就会被推到 messagesCount，而这一轮 agy 实际什么都没收到。
      // 重试时 messages 没变、游标已追平，增量切片变空，只剩"重发最后一条用户消息"兜底，
      // 多轮增量里的工具结果就丢了 —— 表现就是 agy 只收到空串。
      turn.status = 'error'
      ensureLive()
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'agy 返回空内容', code: 'EMPTY_RESPONSE' } },
      }
      return
    }

    turn.status = 'done'

    const inputTokens = estTokens(turn.streamInputChars ?? turn.promptChars ?? 0)
    const outputTokens = estTokens((turn.text ?? '').length)
    ensureLive()
    yield { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
    ensureLive()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  // tool-result 转 MCP 回执：文本放 content[0]，图片按白名单转 image block 追加在后面。
  // 硬收敛：正文先过 boundToolResult（<=9,600B，距 agy 10,240B 悬崖留 640B 垫），
  // 否则一个长 read/view 回执就能把整条 prompt 顶过墙，agy 侧直接断流。
  async _toolResultPayload(result, signal, toolName = null) {
    let text = boundToolResult(toolName, toolResultText(result))
    const blocks = []
    for (const block of Array.isArray(result?.content) ? result.content : []) {
      if (!isImageBlock(block)) continue
      const mediaType = imageMediaType(block)
      if (mediaType === 'image/gif') {
        text += `\n${GIF_TEXT}`
        continue
      }
      if (!IMAGE_MIME_ALLOWED.has(mediaType)) {
        text += `\n[图片：不支持的格式 ${mediaType || '未知'}]`
        continue
      }
      if (blocks.length >= MAX_IMAGES_PER_REQUEST) {
        text += `\n[图片：超出单次回执上限 ${MAX_IMAGES_PER_REQUEST} 张]`
        continue
      }
      const loaded = await loadImageBlock(this, block, mediaType, signal)
      if (!loaded) {
        text += '\n[图片：当前通道未能读取该附件]'
        continue
      }
      blocks.push(loaded)
    }
    // 拼图说明后再收敛一次（前面那刀只兜原始文本）
    text = boundToolResult(toolName, text)
    // content[0].text 为空串在 ACP 侧是非法回执：纯图回执（read_image/截屏）文本为空时必须给占位
    if (!text.trim()) {
      text = blocks.length > 0 ? '[图片回执：内容见附件]' : '[工具回执为空]'
    }
    const payload = { content: [{ type: 'text', text }, ...blocks] }
    if (result?.isError) payload.isError = true
    return payload
  }

  async *_resumeTurn(turn, options, results, targetModel) {
    turn.status = 'resuming'
    turn.updatedAt = Date.now()
    // 工具结果马上回填给 agy，它要接着生成：把 park 期间挂起的空闲计时放行
    turn.client?.setIdlePaused?.(false)
    const binding = turn.binding
    if (binding?.client && targetModel) await this._applyModel(binding, binding.client, targetModel)

    let inputChars = 0
    for (const r of results) {
      const callId = r.toolCallId
      if (!turn.pendingCalls.has(callId) || turn.seenToolResults.has(callId)) {
        // 对不上号的 tool-result（状态被淘汰/跨轮错配）：别静默吞掉，留个痕
        this.opts.onError?.(new Error(`agycli: 未匹配的 tool-result ${callId}`))
        continue
      }
      const call = turn.pendingCalls.get(callId)
      turn.seenToolResults.add(callId)
      // 工具回执可能带图（read_image / 截屏）：转成 image block 推进 mcpResult.content
      const payload = await this._toolResultPayload(r, options?.signal, call?.name ?? null)
      inputChars += payload.content[0]?.text?.length ?? 0
      this.bridge?.resolveParkedCall?.(call.bridgeCallKey, payload)
    }
    // 本轮输入 = 原始 prompt + 回填的工具结果，别只算后者把 usage 报低
    turn.streamInputChars = inputChars + (turn.promptChars ?? 0)

    try {
      for await (const chunk of this._consume(turn, options)) yield chunk
    } catch (e) {
      // aborted：半个会话不要了，作废绑定（下一轮走全量重建），然后把错抛出去
      if (e?.code === 'ABORTED' && binding) await this._abortBinding(binding)
      throw e
    } finally {
      this._finishTurn(turn)
    }
  }

  // 作废一半的绑定：别让下一轮复用被取消过的 agy 会话
  async _abortBinding(binding) {
    if (!binding) return
    this.store.delete(binding.key)
    const client = binding.client
    binding.client = null
    binding.agySessionId = null
    binding.syncedMsgsCount = 0
    binding.lastReply = ''
    await stopClient(client)
  }

  _finishTurn(turn) {
    if (turn.binding && (turn.status === 'done' || turn.status === 'parked')) {
      turn.binding.syncedMsgsCount = turn.messagesCount ?? turn.binding.syncedMsgsCount
      turn.binding.lastReply = turn.text ?? ''
      this._persistBinding(turn.binding)
    }
    if (turn.status === 'parked') return
    this._disposeTurn(turn, turn.status)
  }

  _disposeTurn(turn, reason = 'disposed') {
    if (!turn) return
    // parked 状态下被淘汰，client 还活着：必须把挂起的空闲计时放回去，
    // 否则 _idlePaused 永久为 true，后续所有轮次的空闲检测全部失效
    turn.client?.setIdlePaused?.(false)
    // B3：淘汰过的 turn 不许再放行权限（agy 迟到的 request_permission 一律拒）
    turn.retired = true
    turn.abandoned = true
    for (const bridgeKey of turn.bridgeCallIds.keys()) {
      try { this.bridge?.abortParkedCall?.(bridgeKey) } catch {}
    }
    // 同一个 tenant 还有排在桥里等着放行的调用，turn 没了就别让 agy 干等
    if (this.bridge && turn.binding) {
      try { this.bridge.failWaitingFor?.(turn.sessionKey, '工具执行失败: DSH turn 已结束') } catch {}
    }
    turn.bridgeCallIds.clear()
    turn.pendingCalls.clear()
    // 过滤器跟着 turn 一起扔，别让残留前缀污染下一次 park/resume
    turn.noticeFilter = null
    turn.tos = null
    try { turn.pumpAbort?.abort(new Error(reason)) } catch {}
    for (const w of [...turn.waiters]) w.resolve(null)
    turn.waiters.clear()
    this.turns.delete(turn.sessionKey)
  }

  async *stream(options, modelArg) {
    // 辅助请求（session-title / compaction）不抢主会话的槽：它基本瞬间结束，让它排队
    // 只会把标题生成拖到超时；同时它也绝不能碰主会话的绑定与锁（那份分流在 _streamBody 里）。
    if (isAuxiliaryRequest(options)) {
      yield* this._streamBody(options, modelArg)
      return
    }
    const sessionKey = options?.sessionId !== undefined && options?.sessionId !== null
      ? String(options.sessionId)
      : bindingKeyFor(options)
    const signal = options?.signal
    // 同一会话同一时刻只放一条 stream 进去。并发进来的一律排队，排队期间被中止就
    // 立刻退出队列并抛 ABORTED —— 既不能把后来的请求饿死，也不能让被弃的请求占着槽。
    const slot = await this.gate.acquire(sessionKey, signal)
    // 租约兜底：消费方把生成器丢了又没 abort 时，这把锁会永远钉在 holders 里，
    // 这个会话之后每一次请求都只能排队排到天荒地老（表现就是"卡住不动"）。
    // 超时强制释放并告警——误放的代价是并发进来两条，比永久僵死好。
    const leaseMs = this.opts.gateLeaseMs ?? GATE_LEASE_MS
    const lease = setTimeout(() => {
      this.opts.onError?.(new Error(
        `agycli: 会话槽被占用超过 ${Math.round(leaseMs / 60000)} 分钟，判定为泄漏并强制释放`,
      ))
      try { slot() } catch {}
    }, leaseMs)
    lease.unref?.()
    try {
      if (signal?.aborted) throw abortError()
      yield* this._streamBody(options, modelArg)
    } finally {
      clearTimeout(lease)
      slot()
    }
  }

  async *_streamBody(options, modelArg) {
    const targetModel = modelArg ?? options?.model ?? null

    // 辅助请求（session-title / compaction）带同一个 sessionId 但空工具表、不同 system：
    // 一旦照常走绑定表，就会判定 system-drift 并把主聊天正在 park 的会话活活关掉。
    if (isAuxiliaryRequest(options)) {
      yield* this._streamAuxiliary(options, targetModel)
      return
    }

    const messages = options?.messages ?? []
    const key = bindingKeyFor(options)
    const sessionKey = options?.sessionId !== undefined && options?.sessionId !== null
      ? String(options.sessionId)
      : key

    // ---- resume 判定：末尾 tool-result 的 toolCallId 命中挂起的 pendingCalls ----
    const results = trailingToolResults(messages)
    const parked = this.turns.touch(sessionKey)
    // 教程 §5.2 关键陷阱：park 复用态来了新图，只唤醒旧流没地方投递顶层图片块，
    // 必须淘汰旧 turn、关旧会话，切成全量 rebuild 新建会话重发。
    let handover = false
    if (parked && this._hasNewImages(parked, messages)) {
      handover = true
      this.opts.onError?.(new Error('agycli: 挂起态遇新图，走 mcp-image-handover-rebuild'))
      this._disposeTurn(parked, 'image-handover-rebuild')
      if (parked.binding) {
        const staleClient = parked.binding.client
        parked.binding.client = null
        parked.binding.agySessionId = null
        parked.binding.syncedMsgsCount = 0
        parked.binding.lastReply = ''
        await stopClient(staleClient)
      }
    } else if (parked && results.some((r) => parked.pendingCalls.has(r.toolCallId) && !parked.seenToolResults.has(r.toolCallId))) {
      parked.messagesCount = messages.length
      try {
        for await (const chunk of this._resumeTurn(parked, options, results, targetModel)) yield chunk
      } catch (e) {
        if (e?.code === 'ABORTED' && parked.binding) await this._abortBinding(parked.binding)
        throw e
      }
      return
    }
    if (parked && !handover) {
      // 挂起期间用户直接发了新话：旧会话卡在半截 prompt 上，复用只会串味，
      // 直接淘汰 turn + 关会话，让下面走全量重建。
      this._disposeTurn(parked, 'superseded-by-new-prompt')
      if (parked.binding) {
        const staleClient = parked.binding.client
        parked.binding.client = null
        parked.binding.agySessionId = null
        parked.binding.syncedMsgsCount = 0
        parked.binding.lastReply = ''
        await stopClient(staleClient)
      }
    }

    const systemText = collectSystem(options)

    let binding = this.store.touch(key)
    if (!binding) {
      binding = this.store.create(key)
      // B4：内存里没有但盘上有 → 认领回来，等会儿走 session/resume 只发增量
      this._hydrateFromDisk(binding, key)
    }
    binding.updatedAt = Date.now()
    binding.prefixHash = hashText(firstUserText(messages).slice(0, FIRST_USER_PREFIX_CHARS))

    // 工具挂载：白名单过滤后才有桥，没有工具就退回纯文本模式（Step 1 行为）
    const mountTools = this._mountTools(options)
    const toolsTenant = mountTools.length > 0 ? sessionKey : null
    let bridge = null
    let toolsBundle = { tools: [], totalBytes: 0, overBudget: false, systemPromptAppend: '' }
    if (toolsTenant) {
      bridge = await this._ensureBridge()
      // 压缩闸接线：桥的 getTools 拿到的是压过的表，不是原始表
      toolsBundle = this._buildToolBundle(mountTools)
      this.tenantTools.set(sessionKey, toolsBundle.tools)
    } else {
      this.tenantTools.delete(sessionKey)
    }

    // 补偿段拼在 system 尾部（原 system 原样在前）。
    // 它进 hash：工具表一变、补偿段跟着变，system-drift 就会触发重建并按新表重算，
    // 不会把上一轮的旧补偿段继续发给模型。
    const systemAppend = composeSystemAppend(systemText, toolsBundle.systemPromptAppend)
    const systemHash = hashText(systemAppend)

    const client = binding.client ?? this._newClient(binding)
    await client.initialize()

    // C3 预登记：session/new 之前就把这一轮挂进 turns，agy 在建会话瞬间若抢先发
    // tools/call 或 tools/list，_authorizePermission 也能凭 tenant/binding 找到活跃 turn，
    // 不会因为「查无此 turn」被拒（教程 339 行：消除 session/new 瞬间的空表竞态）。
    // acpSessionId 此时还是上一轮的（可能是 null），_newSession / _resumeSession 成功后回填。
    const turn = newTurnState({
      sessionKey,
      acpSessionId: binding.agySessionId ?? null,
      binding,
      turnSeq: ++this.turnSeq,
    })
    turn.messagesCount = messages.length
    turn.allowedTools = this.allowedTools ? new Set(this.allowedTools) : null
    this.turns.set(sessionKey, turn)
    binding.pendingTurn = turn

    // 复用还是轮换：无会话 / system 漂移 / 历史被压缩 / 轮数或 token 撞死线 / 工具挂载变了 / 别家 Provider 抢答
    let rotateReason = null
    if (!binding.agySessionId) rotateReason = 'new'
    else if (binding.systemHash !== systemHash) rotateReason = 'system-drift'
    else if (messages.length < binding.syncedMsgsCount) rotateReason = 'history-compacted'
    else {
      const decision = this._rotateDecision(binding, messages.length)
      if (decision.rotate) {
        rotateReason = decision.reason === 'tokens'
          ? 'token-deadline'
          : decision.reason === 'messages-cap' ? 'messages-cap' : 'turns-cap'
      }
      else if ((binding.toolsTenant ?? null) !== toolsTenant) rotateReason = 'tools-changed'
    }

    let delta = null
    if (!rotateReason) {
      const probe = deltaMessages(options, binding)
      if (probe.foreignReply) rotateReason = 'foreign-reply'
      else if (probe.delta.length === 0) rotateReason = 'no-delta'
      else if (!probe.delta.some((m) => {
        // 纯图消息（一个字都没有）也是实打实的增量，不能当成漏轮
        if (contentText(m?.content).trim()) return true
        const c = m?.content
        const blocks = Array.isArray(c) ? c : (Array.isArray(c?.blocks) ? c.blocks : [])
        return blocks.some((b) => isImageBlock(b))
      })) {
        // 漏轮（history-missed）：游标说"已经同步到第 N 条"，可切出来的增量里
        // 一条可读文本都没有——上一轮游标被推进了，agy 其实没收到（断流 / 中止 /
        // 子进程被杀）。这时重发最后一条用户消息会把中间整段工具结果丢掉，
        // 所以直接判轮换，走 session/new 全量重建把历史补齐。
        rotateReason = 'history-missed'
        this.opts.onError?.(new Error(
          `agycli: 漏轮（synced=${binding.syncedMsgsCount} total=${messages.length} delta=${probe.delta.length} 条无可读文本），重建会话补齐`,
        ))
      } else delta = probe.delta
    }

    if (rotateReason) {
      if (binding.agySessionId) await stopClient(client)
      binding.agySessionId = null
      await this._newSession(
        binding,
        client,
        systemAppend,
        targetModel,
        bridge ? [bridge.mcpServerEntry(sessionKey)] : [],
        toolsTenant,
      )
    } else if (binding.restored) {
      // 从盘上认领回来的：先把 agy 会话真接上（cwd 必须与创建时一致），接不上就全量重建
      const resumed = await this._resumeSession(
        binding,
        client,
        targetModel,
        bridge ? [bridge.mcpServerEntry(sessionKey)] : [],
      )
      binding.restored = false
      if (!resumed) {
        rotateReason = 'resume-failed'
        await this._newSession(
          binding,
          client,
          systemAppend,
          targetModel,
          bridge ? [bridge.mcpServerEntry(sessionKey)] : [],
          toolsTenant,
        )
        delta = null // 重建后一律重发全量历史
      }
    } else {
      await this._applyModel(binding, client, targetModel)
    }

    // 复用只发增量（增量本身也按 MAX_PROMPT_CHARS 兜一层）；轮换重发全历史 + system。
    // rebuild 时旧图折叠，只留最后一条带图消息里的图；增量路径只处理新增消息。
    const reusing = rotateReason === null
    // 增量算出来可能是空的：重连重试时 messages 没变化、syncedMsgsCount 已追平、
    // 或者上一轮记了数但实际没发出去。空 prompt 发过去 = agy 收到"一团空气"，
    // 模型只会说"没看到你说什么"。这里必须兜住：没增量就重发最后一条用户消息。
    let effectiveDelta = delta
    if (reusing) {
      const hasText = Array.isArray(delta) && delta.some((m) => contentText(m?.content))
      if (!hasText) {
        effectiveDelta = lastUserTurn(messages)
        this.opts.onError?.(new Error(
          `agycli: 增量为空（synced=${binding.syncedMsgsCount} total=${messages.length}），回退到最后一条用户消息重发`,
        ))
      }
    }
    const promptSource = reusing ? effectiveDelta : messages
    const prepared = await prepareImages(this, promptSource, { rebuild: !reusing, signal: options?.signal })
    const promptText = renderPrompt(
      { messages: prepared.messages, tools: mountTools },
      // 图片以 base64 塞进顶层 ContentBlock，字节要提前从正文预算里扣掉，否则文本吃满了图片就撞墙
      {
        reserveBytes: prepared.images.reduce((n, im) => n + byteLen(im.data) + 64, 0),
        onEmptyMessage: ({ index, role, content }) => {
          this.opts.onError?.(new Error(
            `agycli: 消息 ${index}(${role}) 取不到文本，已跳过。content=${safePreview(content)}`,
          ))
        },
      },
    )
    // 最后一道闸：既没字也没图才中止。空 prompt 只会换来"没看到你说什么"，
    // 白白消耗一轮还把 syncedMsgsCount 推进，下一条真消息也会被吃掉。
    // 但纯图消息（截图 / read_image 后不带一个字）是合法的：正文空、images 有内容，
    // 不能连带误杀 —— 只看文本的话，扔张图不带字会被直接判死。
    if (!promptText.trim() && prepared.images.length === 0) {
      this.opts.onError?.(new Error(
        `agycli: prompt 拼出来是空的（reusing=${reusing} source=${promptSource.length} 条），本轮中止不发`,
      ))
      throw new Error('agycli: 空 prompt，已中止本轮（避免模型收到"一团空气"）')
    }
    // 纯图轮次给一句占位正文：text block 是空串时模型会当"对方没说话"，图片本体走 blocks
    const promptBody = promptText.trim() ? promptText : '[图片附件]'
    const promptBlocks = prepared.images.length > 0
      ? [{ type: 'text', text: promptBody }, ...prepared.images]
      : null

    // 提交即计轮：agy 的内部步骤无论成败都在累加，失败轮也算，避免死线前才轮换
    binding.turns += 1

    // turn 就是上面 C3 预登记的那一个，不再新建（否则 acepSessionId 会分裂成两个对象）
    binding.pendingTurn = null
    // 会话可能刚被轮换/接回来，acpSessionId 以 binding 为准；预登记的那个 turn 就地回填
    turn.acpSessionId = binding.agySessionId ?? turn.acpSessionId ?? null
    turn.messagesCount = messages.length
    // B3：权限校验要拿这一轮的白名单比对（裸名），别去翻 adapter 状态
    turn.allowedTools = this.allowedTools ? new Set(this.allowedTools) : null
    this.turns.set(sessionKey, turn)
    this._startPump(turn, client, promptBody, promptBlocks)

    try {
      for await (const chunk of this._consume(turn, options)) yield chunk
    } catch (e) {
      if (e?.code === 'ABORTED') await this._abortBinding(binding)
      throw e
    } finally {
      this._finishTurn(turn)
    }
  }

  // 辅助请求旁路：不读写 SessionBindingStore、不挂 MCP 桥、tenantKey 一次性、退出即关临时会话。
  async *_streamAuxiliary(options, targetModel) {
    const ephemeralTenant = `__ephemeral__-${Date.now()}-${++this.turnSeq}`
    // 辅助请求也会拉起一条 agy 进程：先把活会话压回上限以内，压不动才告警
    const liveCap = this.opts.maxLiveSessions ?? MAX_LIVE_SESSIONS
    if (this.store.liveClients().length >= liveCap) {
      const busy = this._busyAgySessions()
      const evicted = this.store.evictOldestLive((e) => busy.has(String(e.agySessionId ?? '')))
      // 腾不出干净槽位（活会话全在跑主对话）时宁可不腾：多开一个临时进程顶多记账告警，
      // 掐断主对话就是用户可见的断流。临时会话已单独计数，见下面的 auxClients。
      if (!evicted) {
        this.opts.onError?.(new Error('agycli: 活会话已占满且都在跑主对话，辅助请求另开临时会话'))
      }
    }
    const holder = { key: null }
    const client = this._newClient(holder)
    // 辅助会话不在 session store 里，单独计数，防止它把并发子进程顶过账号风控上限
    this.auxClients.add(client)
    const liveTotal = this.store.liveClients().length + this.auxClients.size
    if (liveTotal > (this.opts.maxLiveSessions ?? MAX_LIVE_SESSIONS)) {
      this.opts.onError?.(new Error(`agycli: 并发 agy 进程 ${liveTotal} 条，已超保活上限`))
    }
    let turn = null
    try {
      await client.initialize()
      await client.newSession({
        cwd: this.opts.cwd ?? process.cwd(),
        systemPromptAppend: collectSystem(options) || undefined,
        mcpServers: [],
      })
      if (targetModel) {
        try {
          await client.setModel(targetModel)
        } catch (e) {
          this.opts.onError?.(e)
        }
      }
      turn = newTurnState({
        sessionKey: ephemeralTenant,
        acpSessionId: client.sessionId ?? null,
        binding: null,
        turnSeq: ++this.turnSeq,
      })
      turn.messagesCount = (options?.messages ?? []).length
      // 辅助请求也照 rebuild 规则折叠历史旧图，只装最后一条带图消息
      const auxPrepared = await prepareImages(this, options?.messages ?? [], { rebuild: true, signal: options?.signal })
      const auxText = renderPrompt({ messages: auxPrepared.messages, tools: [] })
      const auxBlocks = auxPrepared.images.length > 0
        ? [{ type: 'text', text: auxText }, ...auxPrepared.images]
        : null
      this._startPump(turn, client, auxText, auxBlocks)
      yield* this._consume(turn, options)
    } finally {
      // 用完即焚：临时会话立刻回收，绑定表一个字节都没动过
      this.auxClients.delete(client)
      if (turn) this._disposeTurn(turn, 'auxiliary-done')
      await stopClient(client)
    }
  }

  async dispose() {
    for (const state of this.turns.clear()) this._disposeTurn(state, 'adapter-dispose')
    this.tenantTools.clear()
    if (this.bridge) {
      try { await this.bridge.stop() } catch {}
      this.bridge = null
    }
    const all = this.store.clear()
    await Promise.all(all.map((entry) => stopClient(entry.client)))
    const aux = [...this.auxClients]
    this.auxClients.clear()
    await Promise.all(aux.map((client) => stopClient(client)))
    // B4：节流器里可能还压着最后一批绑定，停机前强行落盘，别丢
    if (this.bindingsStore) {
      try {
        this.bindingsStore.flush()
        this.bindingsStore.close()
      } catch (e) {
        this.opts.onError?.(e)
      }
      this.bindingsStore = null
    }
  }
}

export function apply(ctx, config = {}) {
  // 诊断探针：cordis 插件状态显示「启用中」但渠道没注册时，异常会被框架吞掉，
  // 所以这里自己落盘。AGYCLI_TRACE=<file> 才写，平时零开销。
  const trace = (msg) => {
    const file = process.env.AGYCLI_TRACE
    if (!file) return
    try {
      appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
    } catch {}
  }
  trace('apply() entered')
  // 用显式注入拿 llm 服务：named export 的 inject 数组在这个 cordis 版本里不被识别
  ctx.inject(['llm'], (ctx) => {
    try {
      trace(`inject(llm) fired; ctx.get=${typeof ctx.get}`)
      // 可选服务一律走 ctx.get：服务没装时老实返回 undefined，不会像裸读 ctx.attachments
      // 那样抛 "cannot get property ... without inject" 把整个注册回调炸掉（渠道整组消失）。
      // 注意 ?? 左边千万别放裸读 —— 它先求值、先炸，右边的 ctx.get 压根没机会跑。
      const attachments = ctx.get?.('attachments') ?? null
      const adapter = new AgyCliAdapter({
        bin: path.resolve(config.bin ?? path.join(AGY_ROOT_FALLBACK, 'bin', 'agy.exe')),
        home: path.resolve(config.home ?? path.join(AGY_ROOT_FALLBACK, 'home')),
        // 代理优先级：显式 config > AGYCLI_PROXY 环境变量 > 遗留默认值。
        // 硬编码只当兜底，不再封死——外部切节点后至少能靠环境变量生效
        // （子进程仍只在 spawn 时取，真正热切换要重启 client，见 noteIdle 那条）。
        proxy: config.proxy || process.env.AGYCLI_PROXY || 'http://127.0.0.1:8868',
        agent: config.agent ?? 'dsh_bridge',
        cwd: config.cwd,
        allowedTools: config.allowedTools,
        // B4：生产入口默认打开绑定落盘（<cwd>/.dsh-agycli/bindings.json），可用 config 覆盖或关掉
        persistBindings: config.persistBindings !== false,
        bindingsFile: config.bindingsFile,
        // 游标必须同步落盘：250ms 节流窗口内进程崩掉或被强杀，盘上还是旧游标，
        // 下一轮增量切片就会错位（重发一段或漏发一段）。绑定文件很小，同步写代价可忽略。
        bindingsFlushMs: config.bindingsFlushMs ?? 0,
        // A4：播种默认开；测试要自己关
        seed: config.seed,
        relayAfterMs: config.relayAfterMs,
        // 图片字节只经 DSH 的 attachment store 读取（没挂就是降级文本占位，不碰磁盘）
        attachments,
        onError: (e) => ctx.logger?.warn?.(`dsh-agycli-provider: ${e?.message ?? e}`),
      })
      trace('adapter constructed')
      // 拉表是联网操作（几秒），绝不能 await 在这里拖慢插件装载；失败也只退回静态表
      void adapter.refreshModels().catch(() => {})

      const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
      trace(`registerAdapter returned ${typeof registration}`)
      try {
        const listed = ctx.llm.listProviders?.()
        trace(`listProviders -> ${JSON.stringify(listed?.map?.((p) => p?.provider ?? p?.id ?? p))}`)
      } catch (e) {
        trace(`listProviders threw: ${e?.message}`)
      }
      ctx.logger?.info?.(
        `dsh-agycli-provider: registered route "${PROVIDER}" (${MODELS.length} models) bin=${adapter.opts.bin}`,
      )
      const release = () => {
        try { registration() } catch {}
        void adapter.dispose()
      }
      if (typeof ctx.effect === 'function') ctx.effect(() => release)
      else ctx.on?.('dispose', release)
    } catch (e) {
      trace(`THREW in inject: ${e?.stack ?? e?.message ?? e}`)
      throw e
    }
  })
}

export {
  AgyCliAdapter,
  MODELS,
  MAX_PROMPT_CHARS,
  MAX_PROMPT_BYTES,
  MAX_SESSION_MESSAGES,
  DEAD_SESSION_CODES,
  blockText,
  renderPrompt,
  lastUserTurn,
  StreamGate,
  MAX_SESSION_TURNS,
  MAX_BINDINGS,
  MAX_LIVE_SESSIONS,
  MAX_TURN_STATES,
  ROTATE_TOKEN_THRESHOLD,
  DEFAULT_ALLOWED_TOOLS,
  MAX_IMAGES_PER_REQUEST,
  bindingKeyFor,
  deltaMessages,
}

export default { name, apply }

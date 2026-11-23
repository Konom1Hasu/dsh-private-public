// AgyAcpClient —— agy acp 进程与 ACP 协议层。
// 按《DSH 接入 Antigravity CLI 实战技术指南》A1/A2/A5 + B1/B2/B3 实现。
//
// 覆盖：
//   - 常驻单进程、隔离 home、环境变量四件套
//   - 120s 独立握手预算 + initPromise 并发冷启动合并
//   - 64 MiB 单行帧上限（超限截断并重启子进程）
//   - 服务端请求必须应答：session/request_permission 双层嵌套、fs/terminal 回 -32601
//   - session/prompt：180s 空闲超时（收到 update 重置）+ 40min 硬超时
//   - session/cancel：3s 预算，无回执视为 unacked 正常放行
//   - 优雅停机：stdin.end(3s) → kill(1.5s) → taskkill /F /T
import { spawn, execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { ensureIsolatedGeminiDir } from './isolated-home.mjs'

const SELF = path.dirname(fileURLToPath(import.meta.url))

const MAX_STDOUT_LINE_BYTES = 64 * 1024 * 1024
const HANDSHAKE_BUDGET_MS = 120_000
const PROMPT_IDLE_MS = 180_000
const PROMPT_HARD_MS = 40 * 60 * 1000
const CANCEL_BUDGET_MS = 3_000
const SET_MODEL_BUDGET_MS = 30_000

// ---- A2 代理动态发现 ----
// _env() 是同步的，读注册表是同步 IO，握手路径上不能每次都付这块钱。
export const PROXY_CACHE_TTL_MS = 3_000
// 无条件保底：agy 访问本机 loopback MCP 桥绝不能走代理出口
export const NO_PROXY_BASE = '127.0.0.1,localhost,::1'
export const REGISTRY_INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const REGISTRY_PROBE_TIMEOUT_MS = 1_200

/**
 * 把注册表 ProxyServer 的几种写法归一成 http://host:port。
 * "127.0.0.1:7890" / "http=127.0.0.1:7890;https=127.0.0.1:7890" / "http://127.0.0.1:7890"
 * 拿不到（或形状不认识的，比如 socks=… / 认证串里带 =）就返回 null：静默回落好过拼出非法值。
 */
export function normalizeProxyServer(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let pick = text
  if (pick.includes('=')) {
    // 多协议写法只认 http/https 两段，其它协议不做降级猜测
    const parts = pick.split(';').map((s) => s.trim()).filter(Boolean)
    const httpLike = parts.find((s) => /^https?=/i.test(s))
    if (!httpLike) return null
    pick = httpLike.slice(httpLike.indexOf('=') + 1).trim()
  } else {
    pick = pick.split(';')[0].trim()
  }
  if (!pick) return null
  // user:pass=… 这类带认证串的，切第一个 = 之后已经不完整，直接放弃
  if (pick.includes('=')) return null
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(pick) ? pick : `http://${pick}`
}

/** 解析 `reg query` 的输出：ProxyEnable 必须是 1，ProxyServer 必须存在。 */
export function parseRegistryProxyDump(text) {
  const body = String(text ?? '')
  if (!body) return null
  // reg query 一般吐 0x1，个别环境/本地化会吐十进制，两种都收
  const enable = /ProxyEnable\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/.exec(body)
  if (!enable) return null
  const on = /^0x/i.test(enable[1])
    ? Number.parseInt(enable[1].slice(2), 16)
    : Number.parseInt(enable[1], 10)
  if (!Number.isFinite(on) || on === 0) return null
  const server = /ProxyServer\s+REG_SZ\s+(\S[^\r\n]*)/.exec(body)
  if (!server) return null
  return normalizeProxyServer(server[1])
}

/**
 * NO_PROXY 保底：loopback 三条永远在最前面，用户原有的条目追加保留（别把内网直连配置弄丢）。
 */
export function mergeNoProxy(existing) {
  const base = NO_PROXY_BASE.split(',')
  const seen = new Set(base.map((s) => s.toLowerCase()))
  const extra = []
  for (const raw of String(existing ?? '').split(',')) {
    const item = raw.trim()
    if (!item) continue
    const key = item.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    extra.push(item)
  }
  return [...base, ...extra].join(',')
}

/**
 * 读 Windows 系统代理。任何异常/超时/非 Windows 一律返回 null，绝不抛。
 * @returns {string|null}
 */
export function readSystemProxyRegistry({ timeoutMs = REGISTRY_PROBE_TIMEOUT_MS } = {}) {
  if (process.platform !== 'win32') return null
  try {
    const r = spawnSync('reg', ['query', REGISTRY_INTERNET_SETTINGS], {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!r || r.status !== 0 || typeof r.stdout !== 'string') return null
    return parseRegistryProxyDump(r.stdout)
  } catch {
    return null
  }
}

// agy 的 modelId 把档位写死在后缀里（gemini-4-neon-low / claude-opus-5-5-xhigh …），
// -32602 降级时要拆回 family + tier 两个 config option。
const TIER_SUFFIX = /-(low|medium|high|xhigh)$/

export function splitModelId(modelId) {
  const raw = String(modelId ?? '')
  const m = TIER_SUFFIX.exec(raw)
  if (!m) return { family: raw, tier: 'medium', rawTier: null }
  return {
    family: raw.slice(0, m.index),
    // guide 234 行：thought_level 的 xhigh 降为 high
    tier: m[1] === 'xhigh' ? 'high' : m[1],
    rawTier: m[1],
  }
}

// 模型协商失败的现场只出现一次，而且 agy 升级后错误码会漂（今天实测就不再是 -32602）。
// 把原始 code/message/data 落到 <agy-runtime>/acp-debug.log，下次一眼能看出 agy 到底要什么。
// 写日志本身绝不许影响主流程。
function debugLog(home, label, payload) {
  try {
    if (!home) return
    const line = JSON.stringify({ t: new Date().toISOString(), label, ...payload }) + '\n'
    fs.appendFileSync(path.join(home, '..', 'acp-debug.log'), line)
  } catch {}
}

// 取消泄漏：agy 会把 "context canceled..." 当普通正文吐出来
const CANCEL_LEAK = /context canceled|The request was cancelled by the client/i
function isCancelLeak(text) {
  if (!text) return false
  if (!CANCEL_LEAK.test(text)) return false
  const rest = text.replace(CANCEL_LEAK, '').replace(/\s+/g, '')
  return rest.length <= 16
}

export class AgyAcpClient extends EventEmitter {
  constructor(opts = {}) {
    super()
    this.bin = opts.bin || path.join(SELF, 'bin', 'agy.exe')
    this.home = opts.home || path.join(SELF, 'home')
    this.cwd = opts.cwd || process.cwd()
    this.agent = opts.agent || 'dsh_bridge'
    // A2：显式传 proxy 永远是最高优先级；未显式指定时才走动态发现（AGY_PROXY → 注册表）。
    this.proxyExplicit = opts.proxy === undefined || opts.proxy === null ? null : String(opts.proxy)
    this.proxyTtlMs = Number.isFinite(opts.proxyTtlMs) ? opts.proxyTtlMs : PROXY_CACHE_TTL_MS
    this.registryProbe = typeof opts.registryProbe === 'function' ? opts.registryProbe : readSystemProxyRegistry
    this._proxyCache = null // { proxy, at }
    this._proxyReads = 0 // 取源次数，单测用来验 TTL
    // A4：拉起子进程前幂等播种隔离 home；opts.seed === false 可关掉（单测友好）。
    this.seed = opts.seed !== false
    this.lastSeed = null
    // 每次工具调用的二次守门员；返回 true 放行。默认只放行 dsh 桥工具。
    this.permissionPolicy = opts.permissionPolicy || defaultPermissionPolicy

    this.child = null
    this.buf = ''
    this.nextId = 0
    this.pending = new Map()
    this.sessionId = null
    this.modelId = null
    this.effectiveModel = null
    this.thoughtLevel = null
    this.closed = false
    this.agentInfo = null
    this.authMethods = []
    this.capabilities = null
    this._initPromise = null
    this._idlePaused = false
    this._idleTimerCtl = null
  }

  /** 在 DSH 侧执行工具调用（park）期间暂停/恢复流空闲计时，避免误判「空闲超时」。 */
  setIdlePaused(paused) {
    const next = Boolean(paused)
    if (this._idlePaused === next) return
    this._idlePaused = next
    if (next) this._idleTimerCtl?.pause?.()
    else this._idleTimerCtl?.resume?.()
  }

  // ---- A2 代理动态发现（3s TTL 缓存） ----
  /** 当前生效的代理（只读视图，兼容旧字段访问）。 */
  get proxy() {
    return this.resolveProxy()
  }

  /**
   * 解析代理。带 TTL 缓存，缓存窗口内不重复取源（注册表是同步 IO）。
   * @param {{force?: boolean}} [opts]
   * @returns {string|null}
   */
  resolveProxy(opts = {}) {
    if (this.proxyExplicit !== null) return this.proxyExplicit || null
    const now = Date.now()
    const c = this._proxyCache
    if (!opts.force && c && now - c.at < this.proxyTtlMs) return c.proxy
    const proxy = this._discoverProxy()
    this._proxyCache = { proxy, at: Date.now() }
    return proxy
  }

  /** 真取源：AGY_PROXY → Windows 系统代理。拿不到静默回落 null。 */
  _discoverProxy() {
    this._proxyReads += 1
    try {
      const fromEnv = String(process.env.AGY_PROXY ?? '').trim()
      if (fromEnv) return fromEnv
    } catch {}
    try {
      const found = this.registryProbe?.()
      if (typeof found === 'string' && found.trim()) return found.trim()
    } catch {
      // 注册表读不到/被策略挡住/没有权限 —— 静默回落，绝不让取代理失败卡死 start()
    }
    return null
  }

  /** 作废缓存，下次 _env() 重新取源（空闲期与握手超时都走这里）。 */
  invalidateProxy() {
    this._proxyCache = null
  }

  /** 握手 ETIMEDOUT 后刷新代理缓存，下一轮建连用新值。 */
  _onHandshakeTimeout(method) {
    this.invalidateProxy()
    this.emit('proxy-refresh', { reason: 'handshake-timeout', method })
  }

  /** 空闲期：本轮结束、进程退出后重新读一次，代理被切走能自愈。 */
  noteIdle(reason = 'idle') {
    this.invalidateProxy()
    this.emit('proxy-refresh', { reason })
  }

  // ---- A2 环境变量四件套 ----
  _env() {
    const env = {
      ...process.env,
      USERPROFILE: this.home,
      HOME: this.home,
      // A2: 自动更新必须精确 "true"，内部做严格字符串比较，"1" 无效
      AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      // A2: 关闭客户端侧额外拦截
      AGY_CLI_DISABLE_SAFETY_FILTERING: '1',
      // A2: 保底，防止访问本机 loopback MCP 桥时被代理劫走；用户已有条目追加保留
      NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
      no_proxy: mergeNoProxy(process.env.no_proxy ?? process.env.NO_PROXY),
    }
    let proxy = null
    try {
      proxy = this.resolveProxy()
    } catch {
      proxy = null // 兜底：取代理绝不允许抛出
    }
    if (proxy) {
      env.HTTP_PROXY = proxy
      env.HTTPS_PROXY = proxy
      env.http_proxy = proxy
      env.https_proxy = proxy
    }
    return env
  }

  // ---- A1 常驻进程拉起 ----
  start() {
    if (this.child && !this.closed) return this
    this.closed = false
    this.buf = ''
    // A4：拉起前幂等播种隔离 home。播种失败不阻断启动，只发事件让上层看见。
    if (this.seed) {
      try {
        this.lastSeed = ensureIsolatedGeminiDir(this.home)
        this.emit('seeded', this.lastSeed)
      } catch (e) {
        this.lastSeed = null
        this.emit('seed-error', e)
      }
    }
    const args = [
      'acp',
      '--process-per-session',
      '--gemini-dir', this.home,
      '--include-default-customizations=false',
      '--agent', this.agent,
    ]
    const child = spawn(this.bin, args, {
      cwd: this.cwd,
      env: this._env(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      if (this.child !== child) return
      this._onStdout(d)
    })
    child.stderr.on('data', (d) => {
      if (this.child !== child) return
      this._onStderr(d)
    })
    child.on('error', (e) => {
      if (this.child !== child) return
      this._reportError(e)
    })
    child.on('close', (code) => {
      if (this.child !== child) return
      this.closed = true
      for (const [, p] of this.pending) {
        clearTimeout(p.t)
        p.reject(new Error(`agy 进程退出 code=${code}`))
      }
      this.pending.clear()
      this.emit('close', code)
    })
    return this
  }

  _onStderr(chunk) {
    // 过滤刷屏的 RAW WS MSG 调试行
    const text = String(chunk)
    if (/^\s*RAW WS MSG:/m.test(text)) return
    this.emit('stderr', text)
  }

  // ---- A5 64 MiB 单行帧上限 ----
  _onStdout(chunk) {
    this.buf += chunk
    if (Buffer.byteLength(this.buf, 'utf8') > MAX_STDOUT_LINE_BYTES) {
      this._reportError(new Error(`stdout 超 ${MAX_STDOUT_LINE_BYTES} 字节，重启子进程`))
      this.buf = ''
      this._hardRestart()
      return
    }
    let i
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim()
      this.buf = this.buf.slice(i + 1)
      if (!line) continue
      let m
      try { m = JSON.parse(line) } catch { continue }
      this._dispatch(m)
    }
  }

  _dispatch(m) {
    // 1) 我方请求的应答
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id)
      if (!p) {
        // 未登记的应答（如 session/prompt 的结束回执）也要能被消费者看到
        this.emit('rpc-response', m)
        return
      }
      this.pending.delete(m.id)
      clearTimeout(p.t)
      if (m.error) {
        p.reject(Object.assign(new Error(m.error.message || 'rpc error'), { rpc: m.error }))
      } else {
        p.resolve(m.result)
      }
      return
    }

    // 2) 服务端发来的请求 —— 必须应答，否则 agy 永久挂起（教程 B3）
    if (m.id !== undefined && typeof m.method === 'string') {
      this._handleServerRequest(m)
      return
    }

    // 3) 通知
    if (typeof m.method === 'string') this.emit('notification', m)
  }

  _reply(id, result) {
    this._write({ jsonrpc: '2.0', id, result })
  }

  _replyError(id, code, message) {
    this._write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  _handleServerRequest(m) {
    const { id, method, params } = m

    if (method === 'session/request_permission') {
      // P0：双层嵌套，少写外层 outcome 会让 agy 死等
      let allow = false
      try {
        allow = Boolean(this.permissionPolicy(params || {}))
      } catch (e) {
        this._reportError(e)
        allow = false
      }
      if (allow) {
        const options = params?.options ?? []
        const pick = options.find((o) => o?.kind === 'allow_once') ?? options.find((o) => o?.kind === 'allow_always')
        if (pick?.optionId) {
          this._reply(id, { outcome: { outcome: 'selected', optionId: pick.optionId } })
        } else {
          this._reply(id, { outcome: { outcome: 'cancelled' } })
        }
      } else {
        this._reply(id, { outcome: { outcome: 'cancelled' } })
      }
      return
    }

    // 4) 其它能力：client 一律声明不支持
    this._replyError(id, -32601, `Client does not support: ${method}`)
  }

  // emit('error') 在没人监听时会被 EventEmitter 原样重抛 → 变成 uncaughtException 掀翻整个 host。
  // 收尾阶段（agy 已退、stdin 已 end）写失败是常态，只能吞，绝不能再抛。
  _reportError(e) {
    if (this.listenerCount('error') > 0) {
      try { this.emit('error', e) } catch {}
    }
  }

  // 返回 true/false 表示这一帧到底写进去没有，调用方据此决定是当场失败还是等回执。
  _write(obj) {
    const stdin = this.child?.stdin
    if (!stdin || this.closed || stdin.destroyed || stdin.writableEnded || !stdin.writable) return false
    let line
    try {
      line = JSON.stringify(obj) + '\n'
    } catch (e) {
      this._reportError(e)
      return false
    }
    try {
      stdin.write(line)
      return true
    } catch (e) {
      // ERR_STREAM_WRITE_AFTER_END / EPIPE：agy 子进程已经走了，写不进去是预期，不是致命错
      this._reportError(e)
      return false
    }
  }

  _rpc(method, params, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('agy 进程已关闭'))
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(Object.assign(new Error(`agy stdin 已关闭，无法发送 ${method}`), { code: 'EPIPE' }))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`rpc 超时: ${method}`), { code: 'ETIMEDOUT' }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, t })
      // 写不进去就别挂着等超时：收计时器、清 pending、当场 reject
      if (this._write({ jsonrpc: '2.0', id, method, params }) === false) {
        clearTimeout(t)
        this.pending.delete(id)
        reject(Object.assign(new Error(`agy stdin 写入失败: ${method}`), { code: 'EPIPE' }))
      }
    })
  }

  // 握手专用：ETIMEDOUT 多半是代理挂了/被换了，刷新缓存后把原错误照原样抛出。
  async _rpcHandshake(method, params) {
    try {
      return await this._rpc(method, params, HANDSHAKE_BUDGET_MS)
    } catch (e) {
      if (e?.code === 'ETIMEDOUT') this._onHandshakeTimeout(method)
      throw e
    }
  }

  // ---- B1 握手：120s 独立预算 + 并发合并 ----
  initialize() {
    if (this._initPromise) return this._initPromise
    this.start()
    this._initPromise = this._rpcHandshake(
      'initialize',
      {
        protocolVersion: 1,
        // 教程要求全 false：不给 agy 走 fs/terminal 的余地
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
    ).then((r) => {
      this.agentInfo = r?.agentInfo ?? null
      this.authMethods = r?.authMethods ?? []
      this.capabilities = r?.agentCapabilities ?? null
      this.emit('initialized', r)
      return r
    }).catch((e) => {
      this._initPromise = null
      throw e
    })
    return this._initPromise
  }

  // ---- B1 session/new 同享握手预算 ----
  async newSession({ cwd = this.cwd, systemPromptAppend, mcpServers = [], pinFirstSegment = false } = {}) {
    const params = { cwd, mcpServers }
    const meta = {}
    if (systemPromptAppend) meta.systemPrompt = { append: systemPromptAppend }
    // B4：重建会话时保护首段指令与上下文锚点（教程 264/452 行）。
    // 放 _meta.antigravity 下而不是顶层 params —— agy 对陌生的顶层字段可能回 -32602，
    // 而 _meta 是 ACP 约定的扩展位，不认就忽略。
    if (pinFirstSegment) meta.pinFirstSegment = true
    if (Object.keys(meta).length > 0) params._meta = { antigravity: meta }
    const r = await this._rpcHandshake('session/new', params)
    // agy 升级后很可能把可用模型 / 配置项放进 session/new 的响应里。留一份骨架当证据，
    // 下次模型协商失败时不用再靠猜字段名。
    debugLog(this.home, 'session-new', {
      sessionId: r?.sessionId ?? null,
      keys: r && typeof r === 'object' ? Object.keys(r) : typeof r,
      configOptions: r?.configOptions ?? r?._meta?.antigravity?.configOptions ?? null,
      models: Array.isArray(r?.models) ? r.models.slice(0, 60) : null,
    })
    this.sessionId = r?.sessionId ?? null
    // 新会话的模型状态是 agy 侧默认值，本地缓存必须清掉
    this.modelId = null
    this.effectiveModel = null
    this.thoughtLevel = null
    return r
  }

  // ---- B1b session/set_model；-32602 降级 session/set_config_option（guide 234 行） ----
  // params: { sessionId, modelId }
  // 代理抖动时 agy 不认带档位的组合 id，会回 -32602 Invalid params；
  // 此时拆成 family + tier，分别走 model / thought_level 两个 config option（xhigh 降为 high）。
  async setModel(modelId) {
    if (!modelId) return { changed: false, modelId: this.modelId, via: 'noop' }
    if (!this.sessionId) throw new Error('setModel 需要先调 newSession()')
    if (this.modelId === modelId) return { changed: false, modelId, via: 'cached' }

    try {
      const result = await this._rpc(
        'session/set_model',
        { sessionId: this.sessionId, modelId },
        SET_MODEL_BUDGET_MS,
      )
      this.modelId = modelId
      return { changed: true, modelId, via: 'set_model', result: result ?? null }
    } catch (e) {
      // 只有「超时 / 管道已断」算硬失败。其余一律试降级：agy 升级之后拒绝 set_model 的
      // 错误码已经不是 -32602 了（实测抛出来的是带 "plan model not specified" 的普通错误），
      // 死守 -32602 会让 DSH 连 executor 都构造不出来，整轮直接报废。
      if (e?.code === 'ETIMEDOUT' || e?.code === 'EPIPE') throw e
      const { family, tier, rawTier } = splitModelId(modelId)
      debugLog(this.home, 'set_model-rejected', {
        sessionId: this.sessionId,
        modelId,
        family,
        tier,
        code: e?.rpc?.code ?? e?.code ?? null,
        message: e?.rpc?.message ?? e?.message ?? String(e),
        data: e?.rpc?.data ?? null,
      })
      try {
        await this._setConfigOption('model', family)
        await this._setConfigOption('thought_level', tier)
      } catch {
        // 降级也走不通：把 agy 对 set_model 的原话抛出去，别让「降级失败」盖掉真因
        throw e
      }
      this.modelId = modelId
      this.effectiveModel = family
      this.thoughtLevel = tier
      return { changed: true, modelId, via: 'set_config_option', family, tier, rawTier }
    }
  }

  // ACP 各实现对配置项的字段名不统一（configId / optionId），两种写法各试一次。
  // 只在「参数形状不对」(-32602/-32600) 时换别名重试；-32601 方法不存在再试也没用，直接抛。
  async _setConfigOption(optionId, value) {
    const attempts = [
      { sessionId: this.sessionId, configId: optionId, value },
      { sessionId: this.sessionId, optionId, value },
    ]
    let lastErr = null
    for (let i = 0; i < attempts.length; i++) {
      try {
        return await this._rpc('session/set_config_option', attempts[i], SET_MODEL_BUDGET_MS)
      } catch (e) {
        if (e?.code === 'ETIMEDOUT') throw e
        lastErr = e
        const code = e?.rpc?.code
        debugLog(this.home, 'set_config_option-rejected', {
          sessionId: this.sessionId,
          optionId,
          value,
          attempt: attempts[i],
          code: code ?? e?.code ?? null,
          message: e?.rpc?.message ?? e?.message ?? String(e),
          data: e?.rpc?.data ?? null,
        })
        if (code !== -32602 && code !== -32600) throw e
        if (i === attempts.length - 1) throw e
      }
    }
    throw lastErr ?? new Error('session/set_config_option 失败')
  }

  // ---- B4 session/resume，遇 -32601 回退 session/load ----
  async resumeSession({ sessionId, cwd = this.cwd, mcpServers = [] } = {}) {
    const id = sessionId || this.sessionId
    if (!id) throw new Error('resumeSession 需要 sessionId')
    const loading = new Set([id])
    const onNote = (m) => {
      if (m.method === 'session/update' && loading.has(m.params?.sessionId)) return
    }
    this.on('notification', onNote)
    try {
      try {
        const r = await this._rpcHandshake('session/resume', { sessionId: id, cwd, mcpServers })
        this.sessionId = r?.sessionId ?? id
        return r
      } catch (e) {
        if (e?.rpc?.code !== -32601) throw e
        const r = await this._rpcHandshake('session/load', { sessionId: id, cwd, mcpServers })
        this.sessionId = r?.sessionId ?? id
        return r
      }
    } finally {
      this.off('notification', onNote)
    }
  }

  // ---- 重构为流式处理：AsyncGenerator，修复 pending 泄漏 ----
  // 两形态（教程 §5.2）：
  //   promptStream(text)                 纯文本，拼单个 text block（向后兼容）
  //   promptStream(text, { blocks })     blocks 存在且非空时优先：直接当顶层 ContentBlock[]
  //                                      投递 [...textBlocks, ...imageBlocks]，text 只作兜底
  async *promptStream(text, { signal, idleMs = PROMPT_IDLE_MS, hardMs = PROMPT_HARD_MS, blocks = null } = {}) {
    if (!this.sessionId) throw new Error('先调 newSession()')
    // 新一轮总从「等 agy 吐字」起手：清掉上一轮可能残留的暂停态，
    // 否则 _idlePaused 卡在 true，空闲检测永久失效，真卡死也没人管
    this._idlePaused = false
    this._idleTimerCtl = null
    const promptPayload = Array.isArray(blocks) && blocks.length > 0
      ? blocks
      : [{ type: 'text', text }]
    
    let idleTimer = null
    let hardTimer = null
    let aborted = false
    let finished = false

    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
    }

    // 只有「真在等 agy 吐字」才该走表：DSH 侧执行工具（park）期间 agy 在等回执，
    // 一条 session/update 都不会来，照旧走表必然误判成空闲超时 → 假 error + 假 cancel，
    // 前端看到的就是一轮好好的对话被砍断然后"重新连接中"。
    const armIdle = () => {
      clearIdle()
      if (finished || aborted || this._idlePaused) return
      idleTimer = setTimeout(() => {
        if (finished || aborted || this._idlePaused) return
        this._reportError(new Error('空闲超时'))
        aborted = true
      }, idleMs)
      idleTimer.unref?.()
    }

    const toucher = () => armIdle()

    // park / resume 从外部暂停、恢复走表（setIdlePaused 转发到这里）
    const idleCtl = {
      pause: () => clearIdle(),
      resume: () => armIdle(),
    }
    this._idleTimerCtl = idleCtl

    const cleanup = () => {
      clearIdle()
      if (hardTimer) clearTimeout(hardTimer)
      if (this._idleTimerCtl === idleCtl) this._idleTimerCtl = null
    }

    const onAbort = () => {
      aborted = true
      cleanup()
    }

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const promptId = ++this.nextId
    const queue = []

    const onUpdate = (m) => {
      if (m.method !== 'session/update') return
      toucher()
      const u = m.params?.update
      // B4：真机推 usage_update（{"used":615,"size":1048576}），会话累计 token 从这里拿，
      // SQLite 那条路在当前 agy 库结构里恒 null。size 是真机窗口（1,048,576）。
      if (u?.sessionUpdate === 'usage_update') {
        const used = Number(u.used)
        const size = Number(u.size)
        if (Number.isFinite(used) && used >= 0) {
          this.lastUsage = { used, size: Number.isFinite(size) && size > 0 ? size : null, at: Date.now() }
          queue.push({ type: 'usage', used, size: this.lastUsage.size })
        }
        return
      }
      // 思维链回显（content 形如 {type:'text',text:'...'}）。以前直接丢掉，导致 agy 在
      // 长时间思考时前端一个字节都收不到 → 无心跳的连接只能退避重连（"重新连接中"）。
      // 现在按 kind:'thought' 吐出去，由 index.js 转成 reasoning-delta；注意别混进正文。
      if (u?.sessionUpdate === 'agent_thought_chunk') {
        const t = typeof u?.content === 'string' ? u.content : u?.content?.text ?? ''
        if (t) queue.push({ type: 'thought', text: t })
        return
      }
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
        queue.push({ type: 'chunk', text: u.content.text ?? '' })
      }
    }
    // session/prompt 是一个 JSON-RPC 请求，它的应答才是本轮生成的结束信号
    // 应答到手就停空闲计时：否则排空剩余 chunk 的时间会被误判成「空闲超时」，
    // 既 emit 假 error，又对已经结束的 prompt 补发一次 cancel。
    const onResponse = (m) => {
      if (m.id !== promptId) return
      finished = true
      clearIdle()
    }
    this.on('notification', onUpdate)
    this.on('rpc-response', onResponse)
    toucher()
    hardTimer = setTimeout(() => { aborted = true }, hardMs)
    hardTimer.unref?.()

    try {
      // 写不进去就别进 while 干等 hardTimer（40 分钟）：当场失败，让上层立刻标 error
      if (this._write({ jsonrpc: '2.0', id: promptId, method: 'session/prompt', params: { sessionId: this.sessionId, prompt: promptPayload } }) === false) {
        throw new Error('agy stdin 已关闭，prompt 未送达')
      }
      while (queue.length > 0 || (!aborted && !finished)) {
        if (queue.length > 0) {
          yield queue.shift()
        } else {
          await new Promise(r => setTimeout(r, 10))
        }
      }
    } finally {
      cleanup()
      this.off('notification', onUpdate)
      this.off('rpc-response', onResponse)
      if (aborted) await this.cancel().catch(() => {})
      if (signal) signal.removeEventListener('abort', onAbort)
      // A2：一轮结束就是空闲期，作废代理缓存，下次建连重新读源
      this.noteIdle('prompt-idle')
    }
  }

  // ---- B3 cancel：3s 预算，无回执视为 unacked ----
  async cancel() {
    if (!this.sessionId) return { unacked: true, sent: false }
    try {
      await this._rpc('session/cancel', { sessionId: this.sessionId }, CANCEL_BUDGET_MS)
      return { unacked: false, sent: true }
    } catch (e) {
      if (e?.code === 'ETIMEDOUT') return { unacked: true, sent: true }
      if (e?.rpc) return { unacked: false, sent: true, error: e.rpc }
      // cancel 是收尾动作，收尾失败不该把异常甩回 pump —— 那会把整轮标成 error，
      // 甚至像 2026-11-23 18:06 那次一样变成 uncaught，直接掀翻 host 让前端"重新连接中"
      return { unacked: true, sent: false, error: e }
    }
  }

  // ---- A5 优雅停机：stdin.end → kill → taskkill /F /T ----
  async stop() {
    const child = this.child
    if (!child || this.closed) return
    const pid = child.pid

    try { child.stdin.end() } catch {}
    const exited = await Promise.race([
      new Promise((r) => child.once('close', () => r(true))),
      new Promise((r) => setTimeout(() => r(false), 3000)),
    ])
    if (!exited) {
      try { child.kill() } catch {}
      const killed = await Promise.race([
        new Promise((r) => child.once('close', () => r(true))),
        new Promise((r) => setTimeout(() => r(false), 1500)),
      ])
      if (!killed && process.platform === 'win32' && pid) {
        await new Promise((resolve) => {
          execFile('taskkill', ['/F', '/T', '/PID', String(pid)], () => resolve())
        })
      }
    }
    this.closed = true
    this.child = null
    this._initPromise = null
    this.sessionId = null
    this.modelId = null
    this.effectiveModel = null
    this.thoughtLevel = null
    // A2：停机后下次拉起重新读一次代理
    this.noteIdle('stopped')
  }

  _hardRestart() {
    const oldPid = this.child?.pid;
    try { this.child?.kill() } catch {}
    if (process.platform === 'win32' && oldPid) {
      execFile('taskkill', ['/F', '/T', '/PID', String(oldPid)], () => {})
    }
    for (const [id, p] of this.pending) {
      p.reject(new Error(`进程重启，请求 ${id} 丢失`));
      clearTimeout(p.t);
    }
    this.pending.clear();
    this.child = null;
    this._initPromise = null;
    this.start();
  }

  close() { void this.stop() }
}

// B3 默认守门员：只放行 dsh 桥工具（mcp_dsh_ 前缀 或 mcpServerName === 'dsh'）
export function defaultPermissionPolicy(params) {
  const tc = params?.toolCall ?? {}
  const name = String(tc.name ?? tc.toolName ?? '')
  if (name.startsWith('mcp_dsh_')) return true
  if (tc.mcpServerName === 'dsh') return true
  return false
}

export { isCancelLeak }
export default AgyAcpClient

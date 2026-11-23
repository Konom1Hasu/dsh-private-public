// Step 3 离线单测：辅助请求旁路（D4）、abort 零 yield（D5）、通知清洗与 TosWindow（D5）、多模态声明（D2）。
// 不碰网络、不拉 agy、不读真实文件。
import assert from 'node:assert/strict'
import {
  AgyCliAdapter,
  MAIN_REQUEST_PURPOSES,
  isAuxiliaryRequest,
  NoticeFilter,
  TosWindow,
  inputModalitiesFor,
} from './lib/index.js'

let pass = 0
const failures = []

async function test(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures.push({ label, e })
    console.log(`  FAIL ${label}\n       ${e?.message ?? e}`)
  }
}

// ---- 脚本化假 client：按 script 吐文本，可选在 abort 后继续吐「迟到」的 chunk ----
class ScriptedClient {
  static seq = 0
  constructor(opts = {}) {
    this.id = ++ScriptedClient.seq
    this.opts = opts
    this.sessionId = null
    this.prompts = []
    this.newSessionCount = 0
    this.newSessionCalls = []
    this.stopCount = 0
  }
  on() {}
  start() {}
  async initialize() { return { agentInfo: { name: 'fake' } } }
  async newSession(params = {}) {
    this.newSessionCount += 1
    this.newSessionCalls.push(params)
    this.sessionId = `sess-${this.id}-${this.newSessionCount}`
    return { sessionId: this.sessionId }
  }
  async setModel() { return { changed: true } }
  async stop() { this.stopCount += 1; this.sessionId = null }
  async *promptStream(text, { signal } = {}) {
    this.prompts.push(text)
    for (const chunk of this.opts.script ?? []) {
      await new Promise((r) => setTimeout(r, 0))
      yield { type: 'chunk', text: chunk }
    }
    if (this.opts.hang) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 800)
        signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        if (signal?.aborted) { clearTimeout(timer); resolve() }
      })
      for (const chunk of this.opts.afterAbort ?? []) yield { type: 'chunk', text: chunk }
    }
  }
}

class FakeBridge {
  constructor(hooks) { this.hooks = hooks; this.entries = []; this.aborted = []; this.resolved = [] }
  async start() { return this }
  async stop() {}
  mcpServerEntry(tenantKey) { this.entries.push(tenantKey); return { type: 'http', name: 'dsh', url: `http://127.0.0.1:1/mcp/${tenantKey}`, headers: [] } }
  getTools() { return [] }
  shouldPark(call) { return Boolean(this.hooks.shouldPark(call)) }
  park(call) {
    this.hooks.onPark({ callKey: String(call.id), tenantKey: call.tenantKey, name: call.name, arguments: call.arguments })
  }
  abortParkedCall(key) { this.aborted.push(key); return true }
  resolveParkedCall(key, payload) { this.resolved.push({ key, payload }); return true }
}

function makeAdapter(scripts = [], extra = {}) {
  const clients = []
  const bridges = []
  const queue = [...scripts]
  const adapter = new AgyCliAdapter({
    cwd: 'C:/fake',
    clientFactory: () => {
      const opts = queue.shift() ?? {}
      const client = new ScriptedClient(opts)
      clients.push(client)
      return client
    },
    bridgeFactory: (hooks) => { const b = new FakeBridge(hooks); bridges.push(b); return b },
    ...extra,
  })
  return { adapter, clients, bridges }
}

function collect(adapter, options) {
  const chunks = []
  let error = null
  const done = (async () => {
    try {
      for await (const c of adapter.stream(options)) chunks.push(c)
    } catch (e) {
      error = e
      throw e
    }
  })()
  return { chunks, done, get error() { return error } }
}

async function waitFor(predicate, { timeoutMs = 1000, label = '条件' } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const READ_TOOL = { name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } }

console.log('辅助请求旁路 / abort 零 yield / 通知清洗 离线单测')

// 1) isAuxiliaryRequest 语义
await test('isAuxiliaryRequest：缺省走主路径，title/compaction 算辅助', async () => {
  assert.equal(isAuxiliaryRequest({}), false)
  assert.equal(isAuxiliaryRequest({ purpose: undefined }), false)
  assert.equal(isAuxiliaryRequest({ purpose: '   ' }), false)
  assert.equal(isAuxiliaryRequest({ purpose: 'assistant' }), false)
  assert.equal(isAuxiliaryRequest({ purpose: 'Agent-Loop ' }), false)
  assert.equal(isAuxiliaryRequest({ purpose: 'session-title' }), true)
  assert.equal(isAuxiliaryRequest({ purpose: 'COMPACTION' }), true)
  assert.deepEqual([...MAIN_REQUEST_PURPOSES], ['assistant', 'agent-loop'])
})

// 2) 辅助请求不建 binding、不碰 store、用完即关
await test('auxiliary 请求不建 binding、不碰 store、临时会话用完即关', async () => {
  const { adapter, clients, bridges } = makeAdapter([{ script: ['会话标题：你好'] }])
  const run = collect(adapter, {
    purpose: 'session-title',
    sessionId: 'S-main',
    system: '你在给会话起标题',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
  })
  await run.done

  assert.equal(adapter.store.size, 0, '辅助请求不许写 SessionBindingStore')
  assert.equal(adapter.turns.size, 0, '辅助请求不许留 TurnState')
  assert.equal(bridges.length, 0, '辅助请求不许挂 MCP 桥')
  assert.equal(clients.length, 1)
  assert.equal(clients[0].stopCount, 1, '临时会话必须 closeQuietly')
  assert.equal(clients[0].newSessionCalls[0].mcpServers.length, 0)
  assert.equal(textOf(run.chunks), '会话标题：你好')
  assert.deepEqual(finishOf(run.chunks).reason, { kind: 'stop' })
  await adapter.dispose()
})

// 3) 辅助请求不许把主聊天 park 的会话杀掉（真实灾难场景）
await test('主聊天 park 期间来一条 auxiliary：主绑定与挂起 turn 原样保留', async () => {
  const { adapter, clients, bridges } = makeAdapter([
    { script: ['我先看一眼'], hang: true },
    { script: ['标题'] },
  ])
  const mainOptions = {
    sessionId: 'S-main',
    system: '主聊天人设',
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: '第一问' }] }],
  }
  const mainRun = collect(adapter, mainOptions)
  await waitFor(() => clients[0]?.prompts.length === 1)
  const bridge = bridges[0]
  bridge.park({ id: 7, tenantKey: 'S-main', name: 'read', arguments: { path: 'a.txt' } })
  await mainRun.done
  assert.deepEqual(finishOf(mainRun.chunks).reason, { kind: 'tool-calls' })

  const binding = adapter.store.touch('s:S-main')
  const before = { session: binding.agySessionId, turns: binding.turns }
  const parkedTurn = adapter.turns.touch('S-main')
  assert.equal(parkedTurn.status, 'parked')
  assert.equal(parkedTurn.acpSessionId, before.session)

  // 同 sessionId、不同 system、空工具表 —— 旧实现会在这里判定 system-drift 并 closeQuietly
  const aux = collect(adapter, {
    purpose: 'session-title',
    sessionId: 'S-main',
    system: '你是标题生成器',
    messages: [{ role: 'user', content: [{ type: 'text', text: '第一问' }] }],
  })
  await aux.done

  const after = adapter.store.touch('s:S-main')
  assert.equal(after.agySessionId, before.session, '主聊天的 agySessionId 不许被动')
  assert.equal(after.systemHash, binding.systemHash, '主聊天的 systemHash 不许被动')
  assert.equal(adapter.turns.touch('S-main')?.status, 'parked', '挂起的 turn 必须还在')
  assert.equal(after.turns, before.turns)
  assert.equal(bridges.length, 1, '不应为辅助请求新建桥')
  assert.equal(bridge.entries.length, 1, '辅助请求不许挂载 MCP')
  await adapter.dispose()
})

// 4) 缺省 purpose 走主路径
await test('purpose 缺失走主路径：正常建 binding', async () => {
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }])
  const run = collect(adapter, {
    sessionId: 'S-old',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  })
  await run.done
  assert.equal(adapter.store.size, 1)
  assert.ok(adapter.store.touch('s:S-old')?.agySessionId)
  assert.equal(clients[0].stopCount, 0)
  await adapter.dispose()
})

// 5) abort 零 yield：abort 后企图再吐的 chunk 不许出现在流里
await test('abort 后零 yield：迟到 chunk 不出现，生成器直接抛 ABORTED', async () => {
  const { adapter, clients } = makeAdapter([{ script: ['先吐一段'], hang: true, afterAbort: ['LATE-1', 'LATE-2'] }])
  const ac = new AbortController()
  const run = collect(adapter, {
    sessionId: 'S-abort',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    signal: ac.signal,
  })
  await waitFor(() => run.chunks.some((c) => c.type === 'text-delta'), { label: '首个 delta' })
  ac.abort()
  await assert.rejects(run.done, (e) => e?.code === 'ABORTED')
  assert.equal(run.chunks.some((c) => c.type === 'finish'), false, 'abort 后一个 finish 都不许吐')
  assert.equal(textOf(run.chunks).includes('LATE'), false, 'abort 后的 chunk 不许进流')
  assert.equal(adapter.store.touch('s:S-abort'), null, 'abort 后半截绑定作废')
  assert.equal(clients[0].stopCount, 1)
  await adapter.dispose()
})

// 6) 上游 429 / 额度告警：正文剥离 + 结构化可重试失败码
await test('⚠ API error 429 被剥离并转成 RATE_LIMIT', async () => {
  const { adapter } = makeAdapter([{ script: ['你好\n', '⚠ API error (attempt 1): 429 Too Many Requests\n', '尾巴'] }])
  const run = collect(adapter, { sessionId: 'S-429', system: 'sys', messages: [{ role: 'user', content: 'hi' }] })
  await run.done
  assert.equal(textOf(run.chunks).includes('429'), false, '通知不许混进正文')
  const finish = finishOf(run.chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'RATE_LIMIT')
  await adapter.dispose()
})

await test('余额不足文案被剥离并转成 QUOTA_EXCEEDED', async () => {
  const { adapter } = makeAdapter([{ script: ['Your AI credits balance is too low\n'] }])
  const run = collect(adapter, { sessionId: 'S-quota', system: 'sys', messages: [{ role: 'user', content: 'hi' }] })
  await run.done
  assert.equal(finishOf(run.chunks).reason.failure.code, 'QUOTA_EXCEEDED')
  assert.equal(textOf(run.chunks), '')
  await adapter.dispose()
})

// 7) NoticeFilter：跨 chunk 切断的通知也能拼回来
await test('NoticeFilter 能拼回被 chunk 切断的通知行', async () => {
  const filter = new NoticeFilter()
  const a = filter.push('⚠ API er')
  assert.equal(a.text, '', '可疑前缀先扣住')
  const b = filter.push('ror (attempt 2): 429 slow down\n')
  assert.deepEqual(b.notices.map((n) => n.code), ['RATE_LIMIT'])
  assert.equal(b.text, '')
  const c = filter.push('正常正文')
  assert.equal(c.text, '正常正文')
})

// 8) TOS：命中首窗 → 结构化失败；埋在 20KB 中段 → 不报
await test('TOS_VIOLATION 命中时转成结构化失败', async () => {
  const { adapter } = makeAdapter([{ script: ['服务提示：TOS_VIOLATION，账号受限\n'] }])
  const run = collect(adapter, { sessionId: 'S-tos', system: 'sys', messages: [{ role: 'user', content: 'hi' }] })
  await run.done
  const finish = finishOf(run.chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TOS_VIOLATION')
  await adapter.dispose()
})

await test('TosWindow 只扫首尾 4KB：20KB 文本中段的 TOS 不报警', async () => {
  const filled = 'A'.repeat(10_000) + 'TOS_VIOLATION violated' + 'B'.repeat(10_000)
  assert.ok(filled.length > 20_000, `样本应 >20KB，实得 ${filled.length}`)
  const w = new TosWindow()
  assert.equal(w.push(filled), null, '中段命中不许报警')
  assert.ok(w.total > 20_000)
  assert.ok(w.head.length <= 4_000)
  assert.ok(w.tail.length <= 4_000)

  const { adapter } = makeAdapter([{ script: [filled] }])
  const run = collect(adapter, { sessionId: 'S-tos-mid', system: 'sys', messages: [{ role: 'user', content: 'hi' }] })
  await run.done
  assert.deepEqual(finishOf(run.chunks).reason, { kind: 'stop' }, '中段 TOS 不得误杀')
  await adapter.dispose()
})

await test('TosWindow：精确匹配生效，裸写 Terms of Service 不误杀', async () => {
  assert.ok(new TosWindow().push('violation of Terms of Service detected'))
  assert.ok(new TosWindow().push('your service has been disabled in this account'))
  assert.equal(new TosWindow().push('本文讨论 Terms of Service 的合规写法，属正常内容'), null)
  assert.equal(new TosWindow().push('Terms of Service'), null, '严禁裸写 /Terms of Service/i')
})

// 9) D2 多模态声明
await test('inputModalities：验过的 Gemini 4 / 3.8-flash 声明 image，其余保守 text', async () => {
  for (const id of ['gemini-4-neon-high', 'gemini-4-hydrogen-xhigh', 'gemini-4-argon-medium', 'gemini-3.8-flash-low']) {
    assert.deepEqual(inputModalitiesFor(id), ['text', 'image'], id)
  }
  for (const id of ['claude-opus-5-5-high', 'gpt-oss-120b-medium', 'gemini-pro-orchestrator-neon']) {
    assert.deepEqual(inputModalitiesFor(id), ['text'], id)
  }
  const { adapter } = makeAdapter()
  const resolved = await adapter.resolveModel('agycli', 'gemini-4-hydrogen-high')
  assert.deepEqual(resolved.inputModalities, ['text', 'image'])
  const models = await adapter.listModels('agycli')
  assert.deepEqual(models.find((m) => m.id === 'gemini-4-neon-low')?.inputModalities, ['text', 'image'])
  assert.deepEqual(models.find((m) => m.id === 'gpt-oss-120b-medium')?.inputModalities, ['text'])
  await adapter.dispose()
})

console.log(`\n${failures.length === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const f of failures) console.error(`- ${f.label}: ${f.e?.stack ?? f.e}`)
  process.exit(1)
}

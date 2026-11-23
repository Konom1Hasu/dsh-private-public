// 离线单测：Park-and-Resume。不碰网络、不拉 agy、不读真实文件。
// 覆盖：park 吐合法 tool-call block 并以 finish:tool-calls 收尾 / 下一轮 resume 不重发 prompt /
//       abort 清理挂起 / turn 淘汰与进程死掉不泄漏 / 空回复 EMPTY_RESPONSE / 工具白名单 /
//       桥侧 park-queue-resolve-abort 与软 Bearer。
import assert from 'node:assert/strict'
import { AgyCliAdapter } from './lib/index.js'
import { McpBridge } from './lib/mcp-bridge.mjs'
import { trailingToolResults, toolResultText, TurnStateStore } from './lib/park.mjs'

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

// ---- 可控的假 ACP client：promptStream 由测试手动喂 chunk / 结束 ----
class ControlledClient {
  constructor(opts = {}) {
    this.sessionId = null
    this.prompts = []
    this.newSessionCount = 0
    this.setModelCalls = []
    this.stopCount = 0
    this.controls = []
    this.opts = opts
  }
  on() {}
  start() {}
  async initialize() { return { agentInfo: { name: 'fake' } } }
  async newSession() {
    this.newSessionCount += 1
    this.sessionId = `fake-sess-${this.newSessionCount}`
    return { sessionId: this.sessionId }
  }
  async setModel(modelId) { this.setModelCalls.push(modelId); return { changed: true } }
  async stop() { this.stopCount += 1; this.sessionId = null }
  async *promptStream(text, { signal } = {}) {
    this.prompts.push(text)
    const queue = []
    let wake = null
    let closed = false
    const enqueue = (v) => {
      if (wake) { const w = wake; wake = null; w(v) } else queue.push(v)
    }
    const control = {
      pushText: (t) => enqueue({ kind: 'chunk', text: t }),
      end: () => { if (!closed) { closed = true; enqueue(null) } },
      fail: (err) => { if (!closed) { closed = true; enqueue({ kind: 'throw', error: err }) } },
      closed: () => closed,
    }
    this.controls.push(control)
    const onAbort = () => { closed = true; enqueue(null) }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      for (;;) {
        const v = queue.length > 0 ? queue.shift() : await new Promise((r) => { wake = r })
        if (v === null) return
        if (v?.kind === 'throw') throw v.error
        if (v?.kind === 'chunk') yield { type: 'chunk', text: v.text }
      }
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      closed = true
    }
  }
}

// ---- 假桥：把 adapter 注入的 hooks 存起来，测试手动触发 park ----
class FakeBridge {
  constructor(hooks) {
    this.hooks = hooks
    this.started = 0
    this.stopped = 0
    this.resolved = []
    this.aborted = []
    this.entries = []
  }
  async start() { this.started += 1; return this }
  async stop() { this.stopped += 1 }
  mcpServerEntry(tenantKey) {
    this.entries.push(tenantKey)
    return { type: 'http', name: 'dsh', url: `http://127.0.0.1:1/mcp/${tenantKey}`, headers: [] }
  }
  getTools(tenantKey) { return this.hooks.getTools(tenantKey) || [] }
  shouldPark(call) { return Boolean(this.hooks.shouldPark(call)) }
  park(call) {
    this.hooks.onPark({
      callKey: String(call.id),
      tenantKey: call.tenantKey,
      name: call.name,
      arguments: call.arguments,
    })
  }
  resolveParkedCall(callKey, payload) { this.resolved.push({ callKey, payload }); return true }
  abortParkedCall(callKey) { this.aborted.push(callKey); return true }
}

function makeAdapter(extra = {}) {
  const clients = []
  const bridges = []
  const adapter = new AgyCliAdapter({
    cwd: 'C:/fake',
    clientFactory: (o) => { const c = new ControlledClient(o); clients.push(c); return c },
    bridgeFactory: (hooks) => { const b = new FakeBridge(hooks); bridges.push(b); return b },
    ...extra,
  })
  return { adapter, clients, bridges }
}

// 后台跑 stream，收集 chunk
function startStream(adapter, options, model) {
  const chunks = []
  let finished = false
  const done = (async () => {
    for await (const c of adapter.stream(options, model)) chunks.push(c)
    finished = true
  })()
  return {
    chunks,
    done,
    get finished() { return finished },
  }
}

async function waitFor(predicate, { timeoutMs = 1000, label = '条件' } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const READ_TOOL = { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } }
const SYS = '你是前台。'

function parkOptions(sessionId, extra = {}) {
  return {
    sessionId,
    system: SYS,
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text: '第一问' }] }],
    ...extra,
  }
}

const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')
const blockEnds = (chunks) => chunks.filter((c) => c.type === 'block-end')
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

console.log('Park-and-Resume 离线单测')

// 1) park：吐合法 tool-call block，以 finish:tool-calls 收尾
await test('park 后 stream 以 finish:tool-calls 结束且吐合法 tool-call block', async () => {
  const { adapter, clients, bridges } = makeAdapter()
  const run = startStream(adapter, parkOptions('S-park'))
  await waitFor(() => clients[0]?.controls.length === 1, { label: 'pump 启动' })
  clients[0].controls[0].pushText('我先看一眼')
  await waitFor(() => run.chunks.some((c) => c.type === 'text-delta'), { label: '首个 text-delta' })

  bridges[0].park({ id: 11, tenantKey: 'S-park', name: 'read', arguments: { path: 'a.txt' } })
  await run.done

  const finishes = run.chunks.filter((c) => c.type === 'finish')
  assert.equal(finishes.length, 1)
  assert.deepEqual(finishes[0].reason, { kind: 'tool-calls' })

  const toolStart = run.chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.ok(toolStart, '缺 tool-call 的 block-start')
  const delta = run.chunks.find((c) => c.type === 'tool-call-delta')
  assert.ok(delta, '缺 tool-call-delta')
  assert.equal(delta.id, 'call_1_1')
  assert.equal(delta.name, 'read')
  assert.equal(JSON.parse(delta.argumentsDelta).path, 'a.txt')

  const toolEnd = blockEnds(run.chunks).find((c) => c.block?.type === 'tool-call')
  assert.ok(toolEnd, '缺 tool-call block-end')
  assert.equal(toolEnd.block.id, 'call_1_1')
  assert.equal(toolEnd.block.name, 'read')
  assert.equal(typeof toolEnd.block.arguments, 'string')
  assert.equal(toolEnd.index, 1, '文本块占了 index 0，工具块应是 1')

  // 每个 block-end 的 index 必须是非负安全整数
  for (const c of blockEnds(run.chunks)) assert.ok(Number.isSafeInteger(c.index) && c.index >= 0)

  const turn = adapter.turns.touch('S-park')
  assert.ok(turn, 'park 后 TurnState 应保留')
  assert.equal(turn.status, 'parked')
  assert.ok(turn.pendingCalls.has('call_1_1'))
  await adapter.dispose()
})

// 2) resume：不重发 session/prompt，结果回填给桥，后续文本继续流
await test('下一轮带 toolCallId 的消息能 resume 且不重发 session/prompt', async () => {
  const { adapter, clients, bridges } = makeAdapter()
  const opts = parkOptions('S-resume')
  const first = startStream(adapter, opts)
  await waitFor(() => clients[0]?.controls.length === 1)
  clients[0].controls[0].pushText('准备读')
  await waitFor(() => first.chunks.some((c) => c.type === 'text-delta'))
  bridges[0].park({ id: 21, tenantKey: 'S-resume', name: 'read', arguments: { path: 'b.txt' } })
  await first.done
  assert.equal(clients[0].prompts.length, 1)
  assert.deepEqual(bridges[0].entries, ['S-resume'])

  const toolCallId = adapter.turns.touch('S-resume').pendingCalls.keys().next().value
  const resumeMessages = [
    ...opts.messages,
    { role: 'assistant', content: [{ type: 'tool-call', id: toolCallId, name: 'read', arguments: '{"path":"b.txt"}' }] },
    { role: 'tool', toolCallId, content: [{ type: 'text', text: '文件内容 ABC' }] },
  ]
  const second = startStream(adapter, { ...opts, messages: resumeMessages })
  await waitFor(() => bridges[0].resolved.length === 1, { label: '桥收到 resolve' })

  assert.equal(clients[0].prompts.length, 1, 'resume 绝不能重发 session/prompt')
  assert.equal(clients[0].newSessionCount, 1)
  assert.equal(bridges[0].resolved[0].callKey, '21')
  assert.equal(bridges[0].resolved[0].payload.content[0].text, '文件内容 ABC')

  clients[0].controls[0].pushText('读到了')
  clients[0].controls[0].end()
  await second.done

  assert.equal(textOf(second.chunks), '读到了')
  assert.deepEqual(finishOf(second.chunks).reason, { kind: 'stop' })
  assert.equal(adapter.turns.touch('S-resume'), null, 'done 之后 TurnState 必须清掉')
  const binding = adapter.store.touch('s:S-resume')
  assert.equal(binding.syncedMsgsCount, resumeMessages.length, 'resume 后同步游标要推进')
  await adapter.dispose()
})

// 3) abort：挂起响应被清理，TurnState 不残留
await test('abort 时挂起的桥调用被 abortParkedCall 清理', async () => {
  const { adapter, clients, bridges } = makeAdapter()
  const ac = new AbortController()
  const opts = parkOptions('S-abort', { signal: ac.signal })
  const run = startStream(adapter, opts)
  await waitFor(() => clients[0]?.controls.length === 1)
  clients[0].controls[0].pushText('想想')
  await waitFor(() => run.chunks.some((c) => c.type === 'text-delta'))
  bridges[0].park({ id: 31, tenantKey: 'S-abort', name: 'read', arguments: {} })
  await run.done
  assert.equal(adapter.turns.touch('S-abort').status, 'parked')

  const resumeMessages = [
    ...opts.messages,
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1_1', name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'call_1_1', content: [{ type: 'text', text: '慢' }] },
  ]
  const second = startStream(adapter, { ...opts, messages: resumeMessages })
  await waitFor(() => bridges[0].resolved.length === 1)
  ac.abort()
  // D5：aborted 之后零 yield，直接抛 ABORTED
  await assert.rejects(second.done, (e) => e?.code === 'ABORTED')
  assert.equal(second.chunks.some((c) => c.type === 'finish'), false, 'abort 后不许再吐 finish')
  assert.ok(bridges[0].aborted.includes('31'), `挂起调用应被 abort，实得 ${JSON.stringify(bridges[0].aborted)}`)
  assert.equal(adapter.turns.touch('S-abort'), null, 'abort 后状态必须清掉')
  assert.equal(adapter.store.touch('s:S-abort'), null, 'abort 后半个绑定必须作废')
  await adapter.dispose()
})

// 4) 淘汰：turn 上限挤掉旧会话时，旧会话的挂起调用要被收掉
await test('turn 淘汰时挂起调用不泄漏（maxTurns=1）', async () => {
  const { adapter, clients, bridges } = makeAdapter({ maxTurns: 1 })
  const runA = startStream(adapter, parkOptions('S-a'))
  await waitFor(() => clients[0]?.controls.length === 1)
  clients[0].controls[0].pushText('A')
  await waitFor(() => runA.chunks.some((c) => c.type === 'text-delta'))
  bridges[0].park({ id: 41, tenantKey: 'S-a', name: 'read', arguments: {} })
  await runA.done
  assert.equal(adapter.turns.size, 1)

  const runB = startStream(adapter, parkOptions('S-b'))
  await waitFor(() => clients.length === 2 && clients[1].controls.length === 1, { label: 'B 会话启动' })
  clients[1].controls[0].pushText('B')
  await waitFor(() => runB.chunks.some((c) => c.type === 'text-delta'))
  bridges[0].park({ id: 42, tenantKey: 'S-b', name: 'read', arguments: {} })
  await runB.done

  assert.equal(adapter.turns.size, 1, 'turn 上限应生效')
  assert.deepEqual(adapter.turns.keys(), ['S-b'])
  assert.ok(bridges[0].aborted.includes('41'), `旧 turn 的挂起调用应被 abort，实得 ${JSON.stringify(bridges[0].aborted)}`)
  await adapter.dispose()
})

// 5) 空回复 → EMPTY_RESPONSE（交给 llm-retry，而不是塞空 assistant 消息）
await test('空回复产出 EMPTY_RESPONSE 的 error finish', async () => {
  const { adapter, clients } = makeAdapter()
  const run = startStream(adapter, { sessionId: 'S-empty', system: SYS, messages: [{ role: 'user', content: 'hi' }] })
  await waitFor(() => clients[0]?.controls.length === 1)
  clients[0].controls[0].end()
  await run.done
  const finish = finishOf(run.chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
  assert.equal(finishOf(run.chunks).reason.kind === 'error' && run.chunks.some((c) => c.type === 'usage'), false, 'error 不该发 usage')
  // 空回复绝不能推进 syncedMsgsCount：推进了的话，llm-retry 重试时增量切片为空，
  // agy 只收到"一团空气"，多轮增量里的工具结果也一起丢。
  const binding = adapter.store.touch('s:S-empty')
  assert.equal(binding?.syncedMsgsCount ?? 0, 0, `空回复后游标必须不动，实得 ${binding?.syncedMsgsCount}`)
  await adapter.dispose()
})

// 5a) 纯空白回复也算空：agy 吐一行 '\n' 时 textStarted 会置真，不能因此当成功
await test('只有空白字符的回复按空回复处理，且不推进游标', async () => {
  const { adapter, clients } = makeAdapter()
  const run = startStream(adapter, { sessionId: 'S-blank', system: SYS, messages: [{ role: 'user', content: 'hi' }] })
  await waitFor(() => clients[0]?.controls.length === 1)
  clients[0].controls[0].pushText('\n \n')
  clients[0].controls[0].end()
  await run.done
  const finish = finishOf(run.chunks)
  assert.equal(finish.reason.failure?.code, 'EMPTY_RESPONSE', `纯空白应判空回复，实得 ${JSON.stringify(finish.reason)}`)
  const binding = adapter.store.touch('s:S-blank')
  assert.equal(binding?.syncedMsgsCount ?? 0, 0, `纯空白回复也不能推进游标，实得 ${binding?.syncedMsgsCount}`)
  await adapter.dispose()
})

// 5b) 进程/流异常：error finish 且 TurnState 不残留
await test('promptStream 抛错时以 error finish 收尾且 TurnState 清掉', async () => {
  const { adapter, clients } = makeAdapter()
  const run = startStream(adapter, parkOptions('S-die'))
  await waitFor(() => clients[0]?.controls.length === 1)
  clients[0].controls[0].fail(new Error('agy 进程退出 code=1'))
  await run.done
  const finish = finishOf(run.chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'AGY_STREAM_FAILED')
  assert.equal(adapter.turns.touch('S-die'), null, '异常结束的 turn 必须清掉')
  await adapter.dispose()
})

// 6) 工具白名单：只把 read 交给桥
await test('显式给 allowedTools 白名单时才过滤，不给就全挂', async () => {
  // 显式白名单：只放 read
  const filtered = makeAdapter({ allowedTools: ['read'] })
  const opts = parkOptions('S-tools')
  opts.tools = [READ_TOOL, { name: 'pwsh', description: 'shell', inputSchema: { type: 'object', properties: {} } }]
  const run = startStream(filtered.adapter, opts)
  await waitFor(() => filtered.clients[0]?.controls.length === 1)
  assert.deepEqual(filtered.bridges[0].getTools('S-tools').map((t) => t.name), ['read'])
  filtered.clients[0].controls[0].end()
  await run.done
  await filtered.adapter.dispose()

  // 不给白名单（默认 null）：DSH 传什么就挂什么——默认值写死 ['read'] 会把
  // preset 挂的 fs-search / subagent / todo 全静默滤掉，模型只能空口聊天
  const open = makeAdapter()
  const opts2 = parkOptions('S-tools-open')
  opts2.tools = [READ_TOOL, { name: 'pwsh', description: 'shell', inputSchema: { type: 'object', properties: {} } }]
  const run2 = startStream(open.adapter, opts2)
  await waitFor(() => open.clients[0]?.controls.length === 1)
  assert.deepEqual(open.bridges[0].getTools('S-tools-open').map((t) => t.name).sort(), ['pwsh', 'read'])
  open.clients[0].controls[0].end()
  await run2.done
  await open.adapter.dispose()
})

// 7) 没有工具时不建桥（Step 1 纯文本模式不受影响）
await test('options.tools 为空时不启动 MCP 桥', async () => {
  const { adapter, clients, bridges } = makeAdapter()
  const run = startStream(adapter, { sessionId: 'S-notools', system: SYS, messages: [{ role: 'user', content: 'hi' }] })
  await waitFor(() => clients[0]?.controls.length === 1)
  clients[0].controls[0].pushText('ok')
  clients[0].controls[0].end()
  await run.done
  assert.equal(bridges.length, 0)
  assert.deepEqual(finishOf(run.chunks).reason, { kind: 'stop' })
  await adapter.dispose()
})

// ---- 桥侧：真实 McpBridge，假 res，不走 HTTP ----
function makeRes() {
  const chunks = []
  const res = {
    status: 0,
    headers: null,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    chunks,
    writeHead(code, headers) { this.status = code; this.headers = headers; this.headersSent = true },
    write(s) { chunks.push(String(s)); return true },
    end(body) { this.writableEnded = true; if (body) chunks.push(String(body)) },
    on() {},
  }
  return res
}

function makeReq(url, headers, body) {
  return {
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
}

await test('桥：park → 排队 → resolve 放出下一个 → abort', async () => {
  const parks = []
  const bridge = new McpBridge({
    getTools: () => [],
    shouldPark: ({ tenantKey }) => tenantKey === 'T1',
    onPark: (entry) => parks.push(entry),
    keepaliveMs: 1000,
  })
  await bridge.start()

  const res1 = makeRes()
  await bridge._handleCall(res1, { id: 1, params: { name: 'read', arguments: { path: 'x' } } }, 'T1')
  assert.equal(res1.status, 200)
  assert.ok(String(res1.headers['content-type']).includes('text/event-stream'))
  assert.equal(res1.chunks[0], ':\n\n', 'SSE 头必须立即顶出')
  assert.equal(res1.writableEnded, false, 'park 不能 end()')
  assert.equal(parks.length, 1)
  assert.equal(parks[0].name, 'read')
  assert.deepEqual(bridge.parkedCallKeys(), ['1'])

  const res2 = makeRes()
  await bridge._handleCall(res2, { id: 2, params: { name: 'read', arguments: { path: 'y' } } }, 'T1')
  assert.equal(parks.length, 1, '一次只挂一个，第二个应排队')
  assert.equal(res2.writableEnded, false)
  assert.equal(bridge.waiting.length, 1)

  assert.equal(bridge.resolveParkedCall('1', { content: [{ type: 'text', text: 'R1' }] }), true)
  assert.equal(res1.writableEnded, true)
  assert.ok(res1.chunks.join('').includes('R1'))
  assert.equal(parks.length, 2, 'resolve 后应放出排队的第二个')
  assert.deepEqual(bridge.parkedCallKeys(), ['2'])

  assert.equal(bridge.abortParkedCall('2'), true)
  assert.equal(res2.writableEnded, true)
  assert.equal(res2.chunks.join('').includes('R1'), false)

  // stop() 也要把剩余挂起收干净
  const res3 = makeRes()
  await bridge._handleCall(res3, { id: 3, params: { name: 'read', arguments: {} } }, 'T1')
  assert.deepEqual(bridge.parkedCallKeys(), ['3'])
  await bridge.stop()
  assert.equal(res3.writableEnded, true)
})

await test('桥：Bearer 软校验（无 header 放行，错 header 401）', async () => {
  const bridge = new McpBridge({ getTools: () => [] })
  await bridge.start()

  const ok = makeRes()
  await bridge._handle(makeReq(`/mcp/${bridge.token}/T1`, {}, { jsonrpc: '2.0', id: 5, method: 'ping' }), ok)
  assert.equal(ok.status, 200)
  assert.ok(ok.chunks.join('').includes('"result":{}'))

  const bad = makeRes()
  await bridge._handle(makeReq(`/mcp/${bridge.token}/T1`, { authorization: 'Bearer nope' }, { jsonrpc: '2.0', id: 6, method: 'ping' }), bad)
  assert.equal(bad.status, 401)

  const wrongToken = makeRes()
  await bridge._handle(makeReq('/mcp/0123456789abcdef0123456789abcdef/T1', {}, { jsonrpc: '2.0', id: 7, method: 'ping' }), wrongToken)
  assert.equal(wrongToken.status, 404)
  await bridge.stop()
})

// ---- 纯函数 ----
await test('trailingToolResults 只取末尾连续 role:tool，并读出文本', async () => {
  const messages = [
    { role: 'user', content: 'q' },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'A' }] },
    { role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'B' }], isError: true },
  ]
  const results = trailingToolResults(messages)
  assert.deepEqual(results.map((r) => r.toolCallId), ['c1', 'c2'])
  assert.equal(toolResultText(results[1]), 'B')
  assert.equal(trailingToolResults([{ role: 'tool', toolCallId: 'x' }, { role: 'user', content: 'y' }]).length, 0)
})

await test('TurnStateStore 超容量按 LRU 淘汰并回调 onEvict', async () => {
  const evicted = []
  const store = new TurnStateStore({ maxEntries: 2, onEvict: (s) => evicted.push(s.sessionKey) })
  store.set('a', { sessionKey: 'a' })
  store.set('b', { sessionKey: 'b' })
  store.touch('a')
  store.set('c', { sessionKey: 'c' })
  assert.deepEqual(store.keys(), ['a', 'c'])
  assert.deepEqual(evicted, ['b'])
})

console.log(`\n${failures.length === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const f of failures) console.error(`- ${f.label}: ${f.e?.stack ?? f.e}`)
  process.exit(1)
}

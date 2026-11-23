// C4 接力中继 + B3 权限三重交集的离线单测。
// 不拉 agy、不碰真机 home：桥在 loopback 上真起 HTTP，接力的时间轴用 relayAfterMs 缩短到几十毫秒。
import assert from 'node:assert/strict'
import http from 'node:http'
import { McpBridge, MAX_TOOL_RELAYS, AWAIT_RESULT_TOOL, PROTECTED_FROM_DEMOTION, buildMcpToolBundle } from './lib/mcp-bridge.mjs'
import { AgyCliAdapter } from './lib/index.js'
import { newTurnState } from './lib/park.mjs'

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

async function waitFor(predicate, { timeoutMs = 2000, label = '条件' } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

// SSE 帧解析：取所有 data: 行里的 JSON
function parseSse(raw) {
  const out = []
  for (const line of String(raw).split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    try { out.push(JSON.parse(t.slice(5).trim())) } catch {}
  }
  return out
}

function postCall(bridge, name, args, id) {
  const url = `${bridge.urlBase}/tenant-x`
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { buf += d })
      res.on('end', () => resolve({ status: res.statusCode, frames: parseSse(buf) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const lastText = (resp) => resp.frames.at(-1)?.result?.content?.[0]?.text ?? ''
const lastIsError = (resp) => resp.frames.at(-1)?.result?.isError === true

const READ = { name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }

function makeBridge({ relayAfterMs = 40, tools = [READ], shouldPark = () => true } = {}) {
  const parks = []
  const relays = []
  const calls = []
  const bridge = new McpBridge({
    getTools: () => tools,
    shouldPark,
    onPark: (c) => parks.push(c),
    onRelay: (e) => relays.push(e),
    onCall: (e) => calls.push(e),
    relayAfterMs,
    keepaliveMs: 5_000,
  })
  return { bridge, parks, relays, calls }
}

console.log('C4 接力中继 + B3 权限三重交集 离线单测')

// ---- A. 桥侧接力 ----
await test('85 秒到点先回 still running，再 await 拿真结果零延迟', async () => {
  const { bridge, relays, calls } = makeBridge()
  await bridge.start()
  const first = postCall(bridge, 'read', { path: 'x.txt' }, 11)
  await waitFor(() => bridge.parked.size === 1, { label: '挂起' })
  assert.equal(relays.length, 0, '刚挂起不该立刻接力')

  await waitFor(() => relays.length === 1, { label: '接力触发' })
  const r1 = await first
  const note = lastText(r1)
  assert.ok(note.includes('still running'), `提示文本不对：${note}`)
  assert.ok(note.includes('call_id: 11'), `call_id 缺失：${note}`)
  assert.ok(note.includes(`mcp_dsh_${AWAIT_RESULT_TOOL}`), `没告诉模型该调哪个工具：${note}`)
  assert.equal(bridge.parked.size, 0, '接力后不该再占着 park 槽')
  assert.equal(bridge.awaiting.size, 1, '应该转到 awaiting')

  // DSH 这时才交回真结果（还没人 await）
  assert.equal(bridge.resolveParkedCall('11', { content: '文件内容：PARK_OK' }), true)
  const t0 = Date.now()
  const r2 = await postCall(bridge, AWAIT_RESULT_TOOL, { call_id: '11' }, 12)
  const elapsed = Date.now() - t0
  assert.equal(lastText(r2), '文件内容：PARK_OK', `await 没拿到真结果：${lastText(r2)}`)
  assert.ok(elapsed < 500, `结果已就绪必须零延迟返回，实测 ${elapsed}ms`)
  assert.equal(bridge.awaiting.size, 0, '交付后应该清掉')
  assert.ok(calls.some((c) => c.name === AWAIT_RESULT_TOOL), 'await 也走 onCall 通知')
  await bridge.stop()
})

await test('模型先 await、结果后到：等待中结果一到立刻返回', async () => {
  const { bridge } = makeBridge({ relayAfterMs: 5000 })
  await bridge.start()
  const first = postCall(bridge, 'read', {}, 21)
  await waitFor(() => bridge.parked.size === 1)
  // 手动接力（等价于 85s 到点）
  bridge._relayCall(bridge.parked.get('21'))
  await first
  const waitResp = postCall(bridge, AWAIT_RESULT_TOOL, { call_id: '21' }, 22)
  await new Promise((r) => setTimeout(r, 30))
  bridge.resolveParkedCall('21', { content: '迟到的结果' })
  const r = await waitResp
  assert.equal(lastText(r), '迟到的结果')
  await bridge.stop()
})

await test(`接力最多 ${MAX_TOOL_RELAYS} 轮，超了回硬失败并清表`, async () => {
  const { bridge } = makeBridge({ relayAfterMs: 20 })
  await bridge.start()
  const first = postCall(bridge, 'read', {}, 31)
  await waitFor(() => bridge.parked.size === 1)
  bridge._relayCall(bridge.parked.get('31'))
  await first
  assert.equal(bridge.awaiting.get('31').relays, 1, '接力第一跳记 1 轮')

  const rounds = []
  let hardFail = null
  for (let i = 0; i < MAX_TOOL_RELAYS + 2; i++) {
    const r = await postCall(bridge, AWAIT_RESULT_TOOL, { call_id: '31' }, 100 + i)
    if (lastIsError(r)) { hardFail = lastText(r); break }
    rounds.push(lastText(r))
  }
  assert.ok(hardFail, '超轮数必须回硬失败')
  assert.ok(hardFail.includes('still has not returned'), `硬失败文案不对：${hardFail}`)
  assert.equal(rounds.length, MAX_TOOL_RELAYS - 1, `应恰好 ${MAX_TOOL_RELAYS - 1} 次 still running，实得 ${rounds.length}`)
  assert.ok(rounds.at(-1).includes(`round ${MAX_TOOL_RELAYS}/${MAX_TOOL_RELAYS}`), `最后一轮标号不对：${rounds.at(-1)}`)
  assert.equal(bridge.awaiting.size, 0, '硬失败后不该再留着')
  await bridge.stop()
})

await test('call_id 对不上时回提示，不炸', async () => {
  const { bridge } = makeBridge()
  await bridge.start()
  const r = await postCall(bridge, AWAIT_RESULT_TOOL, { call_id: 'nope' }, 41)
  assert.equal(lastIsError(r), true)
  assert.ok(lastText(r).includes('没有 call_id=nope'), lastText(r))
  await bridge.stop()
})

await test('内置 dsh_await_result 永挂 tools/list 末尾，且不被压缩闸降级', async () => {
  const { bridge } = makeBridge({ tools: [] })
  await bridge.start()
  const tools = await new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const req = http.request(`${bridge.urlBase}/tenant-y`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = ''
      res.on('data', (d) => { buf += d })
      res.on('end', () => resolve(JSON.parse(buf)?.result?.tools ?? []))
    })
    req.end(body)
  })
  assert.equal(tools.length, 1, '租户没工具时也该有内置那一个')
  assert.equal(tools[0].name, AWAIT_RESULT_TOOL)
  await bridge.stop()

  // 压缩闸：塞一份超大的 await 工具定义，必须原样放行
  const fat = {
    name: AWAIT_RESULT_TOOL,
    description: 'x'.repeat(4000),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, { type: 'string', description: 'd'.repeat(160) }])),
    },
  }
  assert.equal(PROTECTED_FROM_DEMOTION.has(AWAIT_RESULT_TOOL), true)
  const bundle = buildMcpToolBundle([fat])
  const kept = bundle.tools.find((t) => t.name === AWAIT_RESULT_TOOL)
  assert.ok(kept, '内置工具不该消失')
  assert.equal(kept.demoted, false, '内置工具不许被降级')
  assert.equal(kept.demoteStage, 0, '内置工具不许离开 Stage 0')
  // Stage 0 基线裁剪仍生效（教程 §5.1：Stage 0 = 完整 Schema + <= 1,024 字描述），
  // 免的是 Stage 1/2/3 降级，不是基线上限
  assert.ok(kept.description.length <= 1024, `描述该被裁到 Stage 0 上限，实得 ${kept.description.length}`)
  assert.equal(Object.keys(kept.inputSchema.properties).length, 30, 'schema 不许被削')
  assert.equal(bundle.systemPromptAppend.includes(AWAIT_RESULT_TOOL), false, '内置工具不该进补偿段')
})

// ---- B. B3 权限三重交集 ----
await test('权限三重交集：活跃 turn + dsh 前缀 + 白名单', async () => {
  const adapter = new AgyCliAdapter({ cwd: 'C:/fake', seed: false, clientFactory: () => ({ on() {} }), bridgeFactory: () => ({ start() {}, stop() {} }) })
  const turn = newTurnState({ sessionKey: 'S1', acpSessionId: 'acp-1', binding: null, turnSeq: 1 })
  turn.allowedTools = new Set(['read'])
  adapter.turns.set('S1', turn)

  const ask = (params) => adapter._authorizePermission(params)
  // 三条全中 → 放行
  assert.equal(ask({ sessionId: 'acp-1', toolCall: { name: 'mcp_dsh_read' } }), true, '三条全中应放行')
  // 各缺一条 → 拒
  assert.equal(ask({ sessionId: 'acp-404', toolCall: { name: 'mcp_dsh_read' } }), false, '缺活跃 turn 应拒')
  assert.equal(ask({ sessionId: 'acp-1', toolCall: { name: 'read' } }), false, '缺 mcp_dsh_ 前缀应拒')
  assert.equal(ask({ sessionId: 'acp-1', toolCall: { name: 'mcp_dsh_write' } }), false, '不在白名单应拒')
  // 等价写法：mcpServerName === 'dsh' 也算前缀条件
  assert.equal(ask({ sessionId: 'acp-1', toolCall: { name: 'read', mcpServerName: 'dsh' } }), true)
  // 内部中继工具不受白名单约束
  assert.equal(ask({ sessionId: 'acp-1', toolCall: { name: `mcp_dsh_${AWAIT_RESULT_TOOL}` } }), true, 'await 工具应放行')
  // 淘汰过的 turn 一律拒
  turn.retired = true
  assert.equal(ask({ sessionId: 'acp-1', toolCall: { name: 'mcp_dsh_read' } }), false, '淘汰过的 turn 应拒')
  turn.retired = false
  turn.abandoned = true
  assert.equal(ask({ sessionId: 'acp-1', toolCall: { name: 'mcp_dsh_read' } }), false, 'abandoned 的 turn 应拒')
  await adapter.dispose()
})

await test('park 期间（turn 未淘汰）权限照常放行，turn 收尾后立刻拒', async () => {
  const adapter = new AgyCliAdapter({ cwd: 'C:/fake', seed: false, clientFactory: () => ({ on() {} }), bridgeFactory: () => ({ start() {}, stop() {} }) })
  const turn = newTurnState({ sessionKey: 'S2', acpSessionId: 'acp-2', binding: null, turnSeq: 2 })
  turn.allowedTools = new Set(['read'])
  turn.status = 'parked'
  adapter.turns.set('S2', turn)
  assert.equal(adapter._authorizePermission({ sessionId: 'acp-2', toolCall: { name: 'mcp_dsh_read' } }), true)
  adapter._disposeTurn(turn, 'done')
  assert.equal(adapter._authorizePermission({ sessionId: 'acp-2', toolCall: { name: 'mcp_dsh_read' } }), false)
  await adapter.dispose()
})

// ---- C. adapter 侧：抑制碎碎念 + 自动继续 ----
function makeAdapterWithBridge({ awaiting = 0, script = [], onPrompt } = {}) {
  const clients = []
  const bridges = []
  const adapter = new AgyCliAdapter({
    cwd: 'C:/fake',
    seed: false,
    clientFactory: (opts) => {
      const client = new ScriptClient(opts, script, onPrompt, clients.length)
      clients.push(client)
      return client
    },
    bridgeFactory: (hooks) => {
      const b = new FakeBridge(hooks, awaiting)
      bridges.push(b)
      return b
    },
  })
  return { adapter, clients, bridges }
}

class ScriptClient {
  constructor(opts, script, onPrompt, index) {
    this.opts = opts
    this.script = script
    this.onPrompt = onPrompt
    this.index = index
    this.sessionId = null
    this.newSessionCount = 0
    this.prompts = []
  }
  on() {}
  start() {}
  async initialize() { return { agentInfo: { name: 'fake' } } }
  async newSession() { this.newSessionCount += 1; this.sessionId = `sess-${this.index}-${this.newSessionCount}`; return { sessionId: this.sessionId } }
  async resumeSession({ sessionId } = {}) { this.sessionId = sessionId; return { sessionId } }
  async setModel() { return { changed: true } }
  async stop() { this.sessionId = null }
  async *promptStream(text) {
    this.prompts.push(text)
    this.onPrompt?.(text, this)
    for (const item of this.script.shift() ?? []) {
      if (item.hook) { item.hook(); continue }
      yield { type: 'chunk', text: item.text }
    }
  }
}

class FakeBridge {
  constructor(hooks, awaiting) {
    this.hooks = hooks
    this.awaiting = awaiting
  }
  async start() { return this }
  async stop() {}
  mcpServerEntry(tenantKey) { return { type: 'http', name: 'dsh', url: `http://127.0.0.1:1/mcp/${tenantKey}`, headers: [] } }
  getTools() { return [] }
  shouldPark() { return true }
  awaitingCountFor() { return this.awaiting }
  abortParkedCall() { return true }
  resolveParkedCall() { return true }
}

function collect(adapter, options) {
  const chunks = []
  const done = (async () => { for await (const c of adapter.stream(options)) chunks.push(c) })()
  return { chunks, done }
}

const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const TOOL = { name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } }

await test('接力间隙的碎碎念不吐给 DSH（抑制生效，也不当成答复）', async () => {
  const { adapter, clients } = makeAdapterWithBridge({
    awaiting: 0,
    script: [[
      { hook: () => adapter._onRelay({ tenantKey: 'S-sup' }) },
      { text: '我先解释一下现在的情况……' },
    ], [{ text: '' }]],
  })
  const run = collect(adapter, { sessionId: 'S-sup', system: 'sys', tools: [TOOL], messages: [{ role: 'user', content: '跑工具' }] })
  await run.done
  assert.equal(textOf(run.chunks), '', `抑制期间不许吐正文，实得 ${JSON.stringify(textOf(run.chunks))}`)
  const finish = run.chunks.find((c) => c.type === 'finish')
  assert.equal(finish?.reason?.kind, 'error', '全被抑制时不该冒充正常答复')
  assert.equal(clients[0].prompts.length, 1)
  await adapter.dispose()
})

await test('模型不调 await、直接结束回合 → 补一轮 mcp-relay-auto-continue 再收', async () => {
  const { adapter, clients } = makeAdapterWithBridge({
    awaiting: 1,
    script: [[{ text: '' }], [{ text: '好，我等到了' }]],
  })
  const run = collect(adapter, { sessionId: 'S-auto', system: 'sys', tools: [TOOL], messages: [{ role: 'user', content: '跑工具' }] })
  await run.done
  assert.equal(clients[0].prompts.length, 2, `应该补发一轮，实得 ${clients[0].prompts.length}`)
  assert.ok(clients[0].prompts[1].includes('mcp-relay-auto-continue'), `补发内容不对：${clients[0].prompts[1]}`)
  assert.ok(clients[0].prompts[1].includes(AWAIT_RESULT_TOOL), '提醒里要写清调哪个工具')
  assert.equal(textOf(run.chunks), '好，我等到了')
  assert.equal(run.chunks.find((c) => c.type === 'finish')?.reason?.kind, 'stop')
  await adapter.dispose()
})

await test('没有接力中的调用时不乱补发（空回复仍报 EMPTY_RESPONSE）', async () => {
  const { adapter, clients } = makeAdapterWithBridge({ awaiting: 0, script: [[{ text: '' }]] })
  const run = collect(adapter, { sessionId: 'S-empty', system: 'sys', tools: [TOOL], messages: [{ role: 'user', content: 'hi' }] })
  await run.done
  assert.equal(clients[0].prompts.length, 1, '不该补发')
  assert.equal(run.chunks.find((c) => c.type === 'finish')?.reason?.failure?.code, 'EMPTY_RESPONSE')
  await adapter.dispose()
})

console.log(`\n${failures.length === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const f of failures) console.error(`- ${f.label}: ${f.e?.stack ?? f.e}`)
  process.exit(1)
}

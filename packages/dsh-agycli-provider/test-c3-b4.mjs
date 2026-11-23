// C3（preTurn 预登记）+ B4（pinFirstSegment）专项自测。
// 这两条是教程点名的防御性要求，行为看不见，只能钉在「调用时序」上：
//   C3 —— session/new 被调用的那一刻，adapter.turns 里必须已经有本 sessionKey 的 turn；
//   B4 —— session/new 的 params 必须带 pinFirstSegment（放 _meta.antigravity，不污染顶层）。
import assert from 'node:assert'
import { AgyCliAdapter } from './lib/index.js'
import { AgyAcpClient } from './lib/agy-acp-client.mjs'

let pass = 0, fail = 0
async function test(label, fn) {
  try { await fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`); }
}

// ---- B4：newSession 的参数形状 ----
await test('B4 newSession 带 pinFirstSegment，且落在 _meta.antigravity', async () => {
  const client = new AgyAcpClient({ cwd: 'C:/fake', home: 'C:/fake-home', bin: 'C:/fake/agy.exe' })
  let captured = null
  client._rpcHandshake = async (method, params) => {
    captured = { method, params }
    return { sessionId: 'sess-b4' }
  }
  await client.newSession({ cwd: 'C:/fake', systemPromptAppend: 'SYS', mcpServers: [], pinFirstSegment: true })
  assert.equal(captured.method, 'session/new')
  assert.equal(captured.params.pinFirstSegment, undefined, 'pinFirstSegment 不该出现在顶层 params')
  assert.equal(captured.params._meta?.antigravity?.pinFirstSegment, true, '缺 pinFirstSegment')
  assert.equal(captured.params._meta?.antigravity?.systemPrompt?.append, 'SYS', 'systemPrompt 被挤掉了')
})

await test('B4 不给 pinFirstSegment 时不写这个键（默认不干扰 agy）', async () => {
  const client = new AgyAcpClient({ cwd: 'C:/fake', home: 'C:/fake-home', bin: 'C:/fake/agy.exe' })
  let captured = null
  client._rpcHandshake = async (method, params) => { captured = params; return { sessionId: 's' } }
  await client.newSession({ cwd: 'C:/fake' })
  assert.equal(captured._meta, undefined, '没有 system/pin 时不该造空 _meta')
})

// ---- C3：预登记时机 ----
class ProbeClient {
  constructor(onNewSession) { this.onNewSession = onNewSession; this.sessionId = null; this.prompts = [] }
  on() {}
  start() {}
  async initialize() { return {} }
  async newSession(opts) {
    // 就是这一刻：agy 已经拿到会话、可以开始调 tools 了
    this.onNewSession(opts)
    this.sessionId = 'sess-c3'
    return { sessionId: this.sessionId }
  }
  async setModel() { return {} }
  async stop() { this.sessionId = null }
  async *promptStream(text) {
    this.prompts.push(text)
    yield { type: 'chunk', text: 'ok' }
  }
}

await test('C3 session/new 被调用时 turn 已在册（预登记生效）', async () => {
  let seenAtNewSession = null
  let adapter = null
  const client = new ProbeClient(() => {
    seenAtNewSession = adapter.turns.map?.has?.('S-c3') ?? adapter.turns.has?.('S-c3') ?? null
  })
  adapter = new AgyCliAdapter({
    cwd: 'C:/fake',
    clientFactory: () => client,
    bridgeFactory: () => ({ start: async () => {}, stop: async () => {}, mcpServerEntry: (t) => ({ url: t }) }),
    persistBindings: false,
    seed: false,
  })
  const chunks = []
  for await (const c of adapter.stream({
    sessionId: 'S-c3',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  })) chunks.push(c)

  assert.equal(seenAtNewSession, true, 'session/new 之前 turn 就该进 turnsByTenant')
  assert.ok(chunks.length > 0, '流本身要正常出块')
  // 收尾后不该留下 pendingTurn 指针
  assert.equal(adapter.turns.map?.get?.('S-c3')?.binding?.pendingTurn ?? null, null, 'pendingTurn 未清')
  await adapter.dispose()
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

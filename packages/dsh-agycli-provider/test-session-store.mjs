// 离线单测：不碰网络、不拉 agy 子进程。
// 覆盖 SessionBindingStore 多会话隔离 / 增量发送 / setModel 与 -32602 降级 / 200 轮轮换。
import assert from 'node:assert/strict'
import {
  AgyCliAdapter,
  SessionBindingStore,
  MAX_SESSION_TURNS,
  bindingKeyFor,
  deltaMessages,
} from './lib/index.js'
import { AgyAcpClient, splitModelId } from './lib/agy-acp-client.mjs'

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

// ---- 假 ACP client：记录 prompt / 会话创建 / 模型切换，不发一个字节 ----
class FakeClient {
  constructor(opts = {}) {
    this.opts = opts
    this.sessionId = null
    this.modelId = null
    this.nextReply = opts.reply ?? 'ok'
    this.prompts = []
    this.newSessionCount = 0
    this.setModelCalls = []
    this.stopCount = 0
    this.started = 0
  }
  on() {}
  start() { this.started += 1 }
  async initialize() { return { agentInfo: { name: 'fake' } } }
  async newSession({ cwd, systemPromptAppend } = {}) {
    this.newSessionCount += 1
    this.sessionId = `fake-sess-${this.newSessionCount}`
    this.lastSystemAppend = systemPromptAppend ?? ''
    return { sessionId: this.sessionId }
  }
  async setModel(modelId) {
    this.setModelCalls.push(modelId)
    this.modelId = modelId
    return { changed: true, modelId, via: 'set_model' }
  }
  async *promptStream(text) {
    this.prompts.push(text)
    yield { type: 'chunk', text: this.nextReply }
  }
  async stop() {
    this.stopCount += 1
    this.sessionId = null
  }
}

function makeAdapter(extra = {}) {
  const clients = []
  const adapter = new AgyCliAdapter({
    cwd: 'C:/fake',
    clientFactory: (opts) => {
      const c = new FakeClient(opts)
      clients.push(c)
      return c
    },
    ...extra,
  })
  return { adapter, clients }
}

async function drain(adapter, options, model) {
  let text = ''
  for await (const chunk of adapter.stream(options, model)) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

const SYS = '你是测试助手，回答极短。'
const sysMsg = { role: 'system', content: [{ type: 'text', text: SYS }] }

console.log('SessionBindingStore / AgyCliAdapter 离线单测')

// 1) 两个不同会话 key 不串台
await test('两个不同会话 key 各自建会话、prompt 不串台', async () => {
  const { adapter, clients } = makeAdapter()
  await drain(adapter, {
    sessionId: 'conv-A',
    messages: [sysMsg, { role: 'user', content: [{ type: 'text', text: '甲会话第一句' }] }],
  })
  await drain(adapter, {
    sessionId: 'conv-B',
    messages: [sysMsg, { role: 'user', content: [{ type: 'text', text: '乙会话第一句' }] }],
  })
  assert.equal(clients.length, 2, `应各自建一条 client，实得 ${clients.length}`)
  assert.notEqual(clients[0], clients[1])
  assert.equal(clients[0].newSessionCount, 1)
  assert.equal(clients[1].newSessionCount, 1)
  assert.match(clients[0].prompts[0], /甲会话第一句/)
  assert.doesNotMatch(clients[0].prompts[0], /乙会话第一句/)
  assert.match(clients[1].prompts[0], /乙会话第一句/)
  assert.doesNotMatch(clients[1].prompts[0], /甲会话第一句/)
  assert.equal(adapter.store.size, 2)
  await adapter.dispose()
})

// 2) 同会话第二轮只发增量
await test('同会话第二轮只发增量消息（不重发历史）', async () => {
  const { adapter, clients } = makeAdapter()
  const history = [sysMsg, { role: 'user', content: [{ type: 'text', text: '第一问' }] }]
  const first = await drain(adapter, { sessionId: 'conv-delta', messages: history })
  assert.equal(first, 'ok')
  assert.equal(clients.length, 1)
  assert.equal(clients[0].newSessionCount, 1)

  const next = [
    ...history,
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: '第二问' }] },
  ]
  await drain(adapter, { sessionId: 'conv-delta', messages: next })
  assert.equal(clients[0].newSessionCount, 1, '增量复用不该新建会话')
  const last = clients[0].prompts.at(-1)
  assert.match(last, /第二问/)
  assert.doesNotMatch(last, /第一问/, `第二轮不该重发第一问，实际 prompt=${JSON.stringify(last)}`)
  assert.doesNotMatch(last, /Assistant: ok/, '自己上一轮的回复不该回灌')
  assert.equal(adapter.store.touch('s:conv-delta').syncedMsgsCount, next.length)
  await adapter.dispose()
})

// 3) 模型透传：prepareCall 的 model 一路走到 setModel
await test('prepareCall(model) → stream 里 setModel 被调用且只切一次', async () => {
  const { adapter, clients } = makeAdapter()
  const prepared = await adapter.prepareCall('agycli', 'gemini-3.8-flash-low')
  assert.equal(prepared.model.id, 'gemini-3.8-flash-low')
  const options = { sessionId: 'conv-model', messages: [sysMsg, { role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  for await (const _ of prepared.stream(options)) { /* drain */ }
  assert.deepEqual(clients[0].setModelCalls, ['gemini-3.8-flash-low'])

  // 第二轮同模型：不再重复切
  await drain(adapter, {
    sessionId: 'conv-model',
    messages: [...options.messages, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'again' }] }],
  }, 'gemini-3.8-flash-low')
  assert.deepEqual(clients[0].setModelCalls, ['gemini-3.8-flash-low'], '模型没变就不该再发 setModel')
  await adapter.dispose()
})

// 4) 真 client 的 setModel + -32602 降级（stub 掉 _rpc，无网络）
await test('setModel 正常路径走 session/set_model', async () => {
  const c = new AgyAcpClient({})
  c.sessionId = 'sess-x'
  const calls = []
  c._rpc = async (method, params) => { calls.push({ method, params }); return { ok: true } }
  const r = await c.setModel('claude-opus-5-5-high')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'session/set_model')
  assert.deepEqual(calls[0].params, { sessionId: 'sess-x', modelId: 'claude-opus-5-5-high' })
  assert.equal(r.via, 'set_model')
  // 同模型重复调用命中缓存，不再发请求
  const again = await c.setModel('claude-opus-5-5-high')
  assert.equal(again.changed, false)
  assert.equal(calls.length, 1)
})

await test('-32602 降级拆 family + tier 走 set_config_option（xhigh→high）', async () => {
  const c = new AgyAcpClient({})
  c.sessionId = 'sess-y'
  const calls = []
  c._rpc = async (method, params) => {
    calls.push({ method, params })
    if (method === 'session/set_model') {
      throw Object.assign(new Error('Invalid params'), { rpc: { code: -32602, message: 'Invalid params' } })
    }
    return {}
  }
  const r = await c.setModel('gemini-4-neon-xhigh')
  assert.equal(calls[0].method, 'session/set_model')
  const opts = calls.slice(1)
  assert.equal(opts.length, 2, `应发两次 set_config_option，实得 ${opts.length}`)
  assert.ok(opts.every((x) => x.method === 'session/set_config_option'))
  assert.equal(opts[0].params.value, 'gemini-4-neon')
  assert.equal(opts[1].params.value, 'high', 'xhigh 必须降成 high')
  assert.equal(r.via, 'set_config_option')
  assert.equal(r.family, 'gemini-4-neon')
  assert.equal(r.tier, 'high')
  assert.equal(r.rawTier, 'xhigh')
  assert.equal(c.modelId, 'gemini-4-neon-xhigh')
})

await test('splitModelId 覆盖有档位/无档位两种 id', async () => {
  assert.deepEqual(splitModelId('gemini-4-neon-low'), { family: 'gemini-4-neon', tier: 'low', rawTier: 'low' })
  assert.deepEqual(splitModelId('gemini-pro-orchestrator-neon'), {
    family: 'gemini-pro-orchestrator-neon',
    tier: 'medium',
    rawTier: null,
  })
})

// 5) 轮换：满轮数 / system 漂移 / 历史压缩 / 别家抢答
await test('200 轮常量存在且满轮数触发轮换（用 maxSessionTurns=2 小样验证）', async () => {
  assert.equal(MAX_SESSION_TURNS, 200)
  const { adapter, clients } = makeAdapter({ maxSessionTurns: 2 })
  const history = [sysMsg]
  const send = async (text) => {
    history.push({ role: 'user', content: [{ type: 'text', text }] })
    await drain(adapter, { sessionId: 'conv-rotate', messages: [...history] })
    history.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] })
  }
  await send('第1问')   // turn 1 → 新会话
  await send('第2问')   // turn 2 → 复用
  assert.equal(clients[0].newSessionCount, 1)
  await send('第3问')   // turn 3 → turns>=2 轮换
  assert.equal(clients[0].newSessionCount, 2, '满轮数应新建会话')
  const last = clients[0].prompts.at(-1)
  assert.match(last, /第1问/, '轮换后应重发全历史')
  assert.match(last, /第3问/)
  await adapter.dispose()
})

await test('systemHash 漂移触发轮换并重发全量', async () => {
  const { adapter, clients } = makeAdapter()
  const base = [sysMsg, { role: 'user', content: [{ type: 'text', text: '原始问题' }] }]
  await drain(adapter, { sessionId: 'conv-drift', messages: base })
  assert.equal(clients[0].newSessionCount, 1)
  const drifted = [{ role: 'system', content: [{ type: 'text', text: '换了一份系统提示' }] }, ...base.slice(1)]
  await drain(adapter, { sessionId: 'conv-drift', messages: drifted })
  assert.equal(clients[0].newSessionCount, 2, 'system 变了应换会话')
  assert.match(clients[0].lastSystemAppend, /换了一份系统提示/)
  await adapter.dispose()
})

await test('历史被压缩（messages 变短）触发轮换', async () => {
  const { adapter, clients } = makeAdapter()
  const long = [sysMsg, ...Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `Q${i}` }] }))]
  await drain(adapter, { sessionId: 'conv-compact', messages: long })
  assert.equal(clients[0].newSessionCount, 1)
  await drain(adapter, { sessionId: 'conv-compact', messages: [sysMsg, { role: 'user', content: [{ type: 'text', text: '压缩后的一句话' }] }] })
  assert.equal(clients[0].newSessionCount, 2, 'messages 短于 syncedMsgsCount 应重建会话')
  await adapter.dispose()
})

await test('上一轮是别的 Provider 答的 → 轮换（不把外来回复当自己的历史）', async () => {
  const { adapter, clients } = makeAdapter()
  const base = [sysMsg, { role: 'user', content: [{ type: 'text', text: '问题' }] }]
  await drain(adapter, { sessionId: 'conv-foreign', messages: base })
  const withForeign = [...base, { role: 'assistant', content: [{ type: 'text', text: '别家 Provider 的回复' }] }, { role: 'user', content: [{ type: 'text', text: '追问' }] }]
  await drain(adapter, { sessionId: 'conv-foreign', messages: withForeign })
  assert.equal(clients[0].newSessionCount, 2)
  await adapter.dispose()
})

// 6) 容量与保活上限（账号风控：不并发烧号）
await test('保活上限 maxLiveSessions=2：第 3 个会话把最老的 stop 掉', async () => {
  const { adapter, clients } = makeAdapter({ maxLiveSessions: 2 })
  for (const key of ['k1', 'k2', 'k3']) {
    await drain(adapter, { sessionId: key, messages: [sysMsg, { role: 'user', content: [{ type: 'text', text: key }] }] })
  }
  assert.equal(clients.length, 3)
  assert.equal(adapter.store.liveClients().length, 2, `同时存活应 ≤2，实得 ${adapter.store.liveClients().length}`)
  assert.ok(clients.slice(0, 2).reduce((n, c) => n + c.stopCount, 0) >= 1, '被淘汰的会话要 stop 掉')
  await adapter.dispose()
})

await test('SessionBindingStore 容量上限按 LRU 淘汰，且 keepKey 不被自己挤掉', async () => {
  const evicted = []
  const store = new SessionBindingStore({ maxBindings: 3, maxLive: 3, onEvict: (e) => evicted.push(e.key) })
  store.create('a')
  store.create('b')
  store.create('c')
  assert.deepEqual(store.keys(), ['a', 'b', 'c'])
  store.touch('a')            // a 变成最近使用 → 顺序 [b, c, a]
  store.create('d')           // 超容量 → 淘汰最老的 b
  assert.deepEqual(store.keys(), ['c', 'a', 'd'])
  assert.deepEqual(evicted, ['b'])
})

await test('bindingKeyFor 优先显式 id，否则用首个 user 消息前缀', async () => {
  assert.equal(bindingKeyFor({ sessionId: 'x1', messages: [] }), 's:x1')
  const k1 = bindingKeyFor({ messages: [{ role: 'user', content: [{ type: 'text', text: '同一句话' }] }] })
  const k2 = bindingKeyFor({ messages: [{ role: 'user', content: [{ type: 'text', text: '同一句话' }] }, { role: 'assistant', content: 'x' }] })
  assert.equal(k1, k2, '同一会话不同轮次必须落到同一个 key')
  assert.match(k1, /^h:[0-9a-f]{16}$/)
})

await test('deltaMessages 跳过已同步条数并丢弃自己上轮的 assistant 回复', async () => {
  const binding = { syncedMsgsCount: 2, lastReply: '我自己的回答' }
  const options = {
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: '我自己的回答' },
      { role: 'user', content: 'q3' },
    ],
  }
  const { delta, foreignReply } = deltaMessages(options, binding)
  assert.equal(foreignReply, false)
  assert.equal(delta.length, 1)
  assert.equal(delta[0].content, 'q3')
})

console.log(`\n${failures.length === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const f of failures) console.error(`- ${f.label}: ${f.e?.stack ?? f.e}`)
  process.exit(1)
}

// 思维链透出：agy 的 agent_thought_chunk 以前被直接丢弃，导致长时间思考时前端收不到
// 任何字节 → 无心跳的连接只能退避重连（"重新连接中"）。现在转成 reasoning-delta 单独成块。
import assert from 'node:assert'
import { AgyCliAdapter, blockText } from './lib/index.js'

let pass = 0, fail = 0
async function test(label, fn) {
  try { await fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

// 最小可控 client：直接按顺序吐我们指定的 kind
class ScriptClient {
  constructor(events) { this.events = events; this.sessionId = null; this.prompts = [] }
  on() {}
  start() {}
  async initialize() { return {} }
  async newSession() { this.sessionId = 'sess-thought'; return { sessionId: this.sessionId } }
  async setModel() { return {} }
  async stop() { this.sessionId = null }
  async *promptStream(text) {
    this.prompts.push(text)
    for (const ev of this.events) yield ev
  }
}

async function collect(adapter, options) {
  const chunks = []
  for await (const c of adapter.stream(options)) chunks.push(c)
  return chunks
}

function makeAdapter(events) {
  const client = new ScriptClient(events)
  const adapter = new AgyCliAdapter({
    cwd: 'C:/fake',
    clientFactory: () => client,
    bridgeFactory: () => ({ start: async () => {}, stop: async () => {}, mcpServerEntry: (t) => ({ url: t }) }),
    persistBindings: false,
    seed: false,
  })
  return { adapter, client }
}

await test('思考内容走 reasoning-delta，index 2 单独成块', async () => {
  const { adapter } = makeAdapter([
    { type: 'thought', text: '先看看这个文件' },
    { type: 'thought', text: '，再决定怎么改。' },
    { type: 'chunk', text: '改好了' },
  ])
  const chunks = await collect(adapter, {
    sessionId: 'S-thought',
    system: 'sys',
    messages: [{ role: 'user', content: '改一下' }],
  })

  const starts = chunks.filter((c) => c.type === 'block-start')
  const reasonStart = starts.find((c) => c.blockType === 'reasoning')
  assert.ok(reasonStart, '没有 reasoning 块')
  assert.equal(reasonStart.index, 2, 'reasoning 块 index 必须是 2（不能撞 text 的 0 / tool-call 的 1）')

  const rd = chunks.filter((c) => c.type === 'reasoning-delta')
  assert.equal(rd.length, 2, `reasoning-delta 数量不对: ${rd.length}`)
  assert.ok(rd.every((c) => c.index === 2))
  assert.equal(rd.map((c) => c.text).join(''), '先看看这个文件，再决定怎么改。')

  const re = chunks.find((c) => c.type === 'block-end' && c.index === 2)
  assert.ok(re, 'reasoning 块没有收尾')
  assert.equal(re.block.type, 'reasoning')
  assert.equal(re.block.text, '先看看这个文件，再决定怎么改。')

  // 正文不能被思考污染
  const textBlock = chunks.find((c) => c.type === 'block-end' && c.index === 0)
  assert.ok(textBlock, '正文块丢了')
  assert.equal(textBlock.block.text, '改好了', '思考内容混进正文了')
  await adapter.dispose()
})

await test('只有思考没有正文时，也能正常收尾', async () => {
  const { adapter } = makeAdapter([{ type: 'thought', text: '想了半天' }])
  const chunks = await collect(adapter, {
    sessionId: 'S-only-thought',
    system: 'sys',
    messages: [{ role: 'user', content: '嗯' }],
  })
  const re = chunks.find((c) => c.type === 'block-end' && c.index === 2)
  assert.ok(re, '纯思考轮没有收尾块')
  assert.ok(!chunks.some((c) => c.type === 'block-end' && c.index === 0), '不该凭空冒出正文块')
  await adapter.dispose()
})

await test('空思考文本不产生空块', async () => {
  const { adapter } = makeAdapter([{ type: 'thought', text: '' }, { type: 'chunk', text: '好' }])
  const chunks = await collect(adapter, {
    sessionId: 'S-empty-thought',
    system: 'sys',
    messages: [{ role: 'user', content: '嗯' }],
  })
  assert.ok(!chunks.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'), '空思考不该开块')
  await adapter.dispose()
})

await test('思考块不进 prompt 正文（blockText 对 reasoning 返回空）', async () => {
  assert.equal(blockText({ type: 'reasoning', text: '想事情' }), '')
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

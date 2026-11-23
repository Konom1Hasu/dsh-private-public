// Step 4 离线单测：多模态投递（教程 §5.2）。
// 覆盖：图片锚点 + 顶层 ContentBlock 提权 / rebuild 折叠旧图 / tool-result 带图 /
//      park 复用态遇新图触发 handover 全量重建 / GIF 与非法 MIME 降级 / 单请求图片上限。
// 不碰网络、不拉 agy、不读真实文件。
import assert from 'node:assert/strict'
import { AgyCliAdapter, MAX_IMAGES_PER_REQUEST } from './lib/index.js'
import { AgyAcpClient } from './lib/agy-acp-client.mjs'

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

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const PNG_B64 = PNG.toString('base64')

class ImageClient {
  static seq = 0
  constructor(opts = {}) {
    this.id = ++ImageClient.seq
    this.opts = opts
    this.sessionId = null
    this.newSessionCount = 0
    this.stopCount = 0
    this.writes = []
    this.prompts = []
    this.blockCalls = []
    this.newSessionOpts = []
  }
  on() {}
  start() {}
  async initialize() { return { agentInfo: { name: 'fake' } } }
  async newSession(opts = {}) {
    this.newSessionCount += 1
    this.newSessionOpts.push(opts)
    this.sessionId = `sess-${this.id}-${this.newSessionCount}`
    return { sessionId: this.sessionId }
  }
  async setModel() { return { changed: true } }
  async stop() { this.stopCount += 1; this.sessionId = null }
  _write(message) { this.writes.push(message); return true }
  // 与真 client 同形：blocks 存在且非空时优先，否则拼单个 text block
  async *promptStream(text, { signal, blocks = null } = {}) {
    this.prompts.push(text)
    this.blockCalls.push(blocks)
    this.rpcId = (this.rpcId ?? 0) + 1
    const prompt = Array.isArray(blocks) && blocks.length > 0 ? blocks : [{ type: 'text', text }]
    this._write({
      jsonrpc: '2.0',
      id: this.rpcId,
      method: 'session/prompt',
      params: { sessionId: this.sessionId, prompt },
    })
    for (const chunk of this.opts.script ?? []) {
      await new Promise((r) => setTimeout(r, 0))
      yield { type: 'chunk', text: chunk }
    }
    if (this.opts.hang) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 600)
        signal?.addEventListener?.('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        if (signal?.aborted) { clearTimeout(timer); resolve() }
      })
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

// 假 attachment store：只认 attachmentId -> Uint8Array
function makeStore(map = { a1: PNG, a2: PNG, a3: PNG, a4: PNG }) {
  const calls = []
  return {
    calls,
    async readImage(ref) {
      const id = ref?.attachmentId
      calls.push(id)
      const bytes = map[id]
      if (!bytes) throw new Error(`missing attachment ${id}`)
      return { ref, data: bytes }
    },
  }
}

function makeAdapter(scripts = [], attachments = makeStore(), extra = {}) {
  const clients = []
  const bridges = []
  const queue = [...scripts]
  const adapter = new AgyCliAdapter({
    cwd: 'C:/fake',
    attachments,
    ...extra,
    clientFactory: () => {
      const client = new ImageClient(queue.shift() ?? { script: ['ok'] })
      clients.push(client)
      return client
    },
    bridgeFactory: (hooks) => { const b = new FakeBridge(hooks); bridges.push(b); return b },
  })
  return { adapter, clients, bridges, store: attachments }
}

function collect(adapter, options) {
  const chunks = []
  const done = (async () => {
    for await (const c of adapter.stream(options)) chunks.push(c)
  })()
  return { chunks, done }
}

async function waitFor(predicate, { timeoutMs = 1000, label = '条件' } = {}) {
  const t0 = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const lastPrompt = (client) => {
  const writes = client.writes.filter((w) => w?.method === 'session/prompt')
  return writes[writes.length - 1]?.params?.prompt ?? null
}
const imageOf = (id, mediaType = 'image/png') => ({ type: 'image', attachment: { attachmentId: id, mediaType } })
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
const READ_TOOL = { name: 'read', description: 'read', inputSchema: { type: 'object', properties: {} } }

console.log('多模态投递 离线单测')

// 1) 锚点 + 顶层 ContentBlock 提权
await test('图片正文只留 [图片 N] 锚点，base64 追加在 prompt 末尾', async () => {
  const { adapter, clients, store } = makeAdapter([{ script: ['看见了'] }])
  const run = collect(adapter, {
    sessionId: 'S-img',
    system: 'sys',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里有什么' },
        imageOf('a1'),
      ],
    }],
  })
  await run.done

  const prompt = lastPrompt(clients[0])
  assert.ok(Array.isArray(prompt), '应当发出 session/prompt')
  assert.equal(prompt.length, 2, `应是 [text, image]，实得 ${prompt.length}`)
  assert.equal(prompt[0].type, 'text')
  assert.ok(prompt[0].text.includes('[图片 1]'), '正文缺锚点')
  assert.equal(prompt[0].text.includes(PNG_B64), false, 'base64 不许留在正文里')
  assert.deepEqual(prompt[1], { type: 'image', data: PNG_B64, mimeType: 'image/png' })
  assert.deepEqual(store.calls, ['a1'])
  assert.equal(textOf(run.chunks), '看见了')
  await adapter.dispose()
})

// 2) rebuild 折叠旧图
await test('rebuild 只装最后一条带图消息，旧图折叠成占位', async () => {
  const { adapter, clients, store } = makeAdapter([{ script: ['ok'] }])
  const run = collect(adapter, {
    sessionId: 'S-rebuild',
    system: 'sys',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '第一张' }, imageOf('a1')] },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: [{ type: 'text', text: '第二张' }, imageOf('a2')] },
    ],
  })
  await run.done

  const prompt = lastPrompt(clients[0])
  const imageBlocks = prompt.filter((b) => b.type === 'image')
  assert.equal(imageBlocks.length, 1, '重建只许装最后一条带图消息里的图')
  assert.equal(imageBlocks[0].data, PNG_B64)
  assert.ok(prompt[0].text.includes('[历史工具图片已折叠]'), '旧图必须折叠')
  assert.ok(prompt[0].text.includes('[图片 2]'), '最后一条消息的图仍按序编号')
  assert.deepEqual(store.calls, ['a2'], '旧图不许再读一次')
  await adapter.dispose()
})

// 2b) 冷启重建：远古截图不能被当成本轮新图重发
// 上游会把重放的图盖上最新时间戳、标成「用户刚上传了 1 张图」，模型就会信以为真。
await test('重建时热窗外的远古截图一律折叠，不打包进重启首轮', async () => {
  const { adapter, clients, store } = makeAdapter([{ script: ['ok'] }])
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '很久以前的一张图' }, imageOf('ancient')] },
  ]
  // 用纯文本轮次把那唯一一张图挤出热窗（REBUILD_IMAGE_HOT_WINDOW = 6）
  for (let i = 0; i < 8; i++) {
    messages.push({ role: 'user', content: `闲聊 ${i}` })
    messages.push({ role: 'assistant', content: `回应 ${i}` })
  }
  const run = collect(adapter, { sessionId: 'S-ancient', system: 'sys', messages })
  await run.done

  const prompt = lastPrompt(clients[0])
  assert.equal(prompt.filter((b) => b.type === 'image').length, 0, '远古图不许重发')
  assert.deepEqual(store.calls, [], '远古图连字节都不该读')
  assert.ok(!prompt[0].text.includes('[图片 1]'), '远古图的锚点也不该留')
  await adapter.dispose()
})

// 3) 复用路径的增量新图
await test('复用会话时增量里的新图照样提到顶层', async () => {
  const store = makeStore()
  const { adapter, clients, bridges } = makeAdapter([{ script: ['ok'] }, { script: ['图收到'] }], store)
  const base = [
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
  ]
  const first = collect(adapter, { sessionId: 'S-reuse', system: 'sys', messages: base })
  await first.done
  assert.equal(clients[0].newSessionCount, 1)

  const secondMessages = [
    ...base,
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: '再看这张' }, imageOf('a3')] },
  ]
  const second = collect(adapter, { sessionId: 'S-reuse', system: 'sys', messages: secondMessages })
  await second.done

  const prompt = lastPrompt(clients[0])
  assert.equal(clients[0].newSessionCount, 1, '复用不该重建会话')
  assert.equal(prompt.filter((b) => b.type === 'image').length, 1)
  assert.equal(prompt[0].text.includes('[图片 1]'), true, '增量请求内部从 1 重新编号')
  assert.deepEqual(store.calls, ['a3'], '只读增量里的新图')
  assert.equal(bridges.length, 0)
  await adapter.dispose()
})

// 4) tool-result 带图 → mcpResult.content 里带 image block
await test('tool-result 带图转成 image block 回填给桥', async () => {
  const store = makeStore()
  const { adapter, clients, bridges } = makeAdapter([{ script: ['我看看'], hang: true }], store)
  const options = {
    sessionId: 'S-tool-img',
    system: 'sys',
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: '读图' }],
  }
  const first = collect(adapter, options)
  await waitFor(() => clients[0]?.prompts.length === 1)
  const bridge = bridges[0]
  bridge.park({ id: 11, tenantKey: 'S-tool-img', name: 'read', arguments: { path: 'x.png' } })
  await first.done
  const callId = adapter.turns.touch('S-tool-img').pendingCalls.keys().next().value

  const resumeMessages = [
    ...options.messages,
    { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] },
    {
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text: '截到一帧' }, imageOf('a4')],
    },
  ]
  const second = collect(adapter, { ...options, messages: resumeMessages })
  await waitFor(() => bridge.resolved.length === 1, { label: '桥收到回执' })
  clients[0].opts.hang = false
  clients[0].pumpDone = true
  await second.done.catch(() => {})

  const payload = bridge.resolved[0].payload
  assert.equal(payload.content.length, 2, `应是 [text, image]，实得 ${payload.content.length}`)
  assert.equal(payload.content[0].text, '截到一帧')
  assert.deepEqual(payload.content[1], { type: 'image', data: PNG_B64, mimeType: 'image/png' })
  assert.equal(clients[0].newSessionCount, 1, '工具回执不该重建会话')
  await adapter.dispose()
})

// 5) park 复用态遇新图 → handover 全量重建
await test('挂起态遇新图触发 handover：关旧会话 + session/new 全量重建', async () => {
  const store = makeStore()
  const { adapter, clients, bridges } = makeAdapter([{ script: ['先读'], hang: true }, { script: ['重建后看懂了'] }], store)
  const options = {
    sessionId: 'S-handover',
    system: 'sys',
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: '读一下' }],
  }
  const first = collect(adapter, options)
  await waitFor(() => clients[0]?.prompts.length === 1)
  bridges[0].park({ id: 21, tenantKey: 'S-handover', name: 'read', arguments: { path: 'a.txt' } })
  await first.done
  const oldSession = adapter.store.touch('s:S-handover').agySessionId
  const callId = adapter.turns.touch('S-handover').pendingCalls.keys().next().value

  const handoverMessages = [
    ...options.messages,
    { role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }] },
    { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: '文件内容' }] },
    { role: 'user', content: [{ type: 'text', text: '顺便看这张图' }, imageOf('a1')] },
  ]
  const second = collect(adapter, { ...options, messages: handoverMessages })
  await second.done

  assert.equal(clients[0].stopCount, 1, '旧会话必须被 closeQuietly')
  assert.equal(clients.length, 2, 'handover 应新起一条 client')
  assert.equal(clients[1].newSessionCount, 1, '必须走 session/new 全量重建')
  const newSession = adapter.store.touch('s:S-handover').agySessionId
  assert.notEqual(newSession, oldSession)
  assert.equal(bridges[0].resolved.length, 0, 'handover 不许走 _resumeMcp')

  const prompt = lastPrompt(clients[1])
  assert.equal(prompt.filter((b) => b.type === 'image').length, 1, '新图必须随重建的 prompt 投递')
  assert.equal(prompt[0].text.includes('文件内容'), true, '重建要重发全历史')
  await adapter.dispose()
})

// 6) GIF 兜底：先试着用 sharp 抽首帧转 PNG；这台机器没装转码器，所以最终降级成文本占位，
//    但字节该读（有转码器时才能真转），绝不裸传 GIF 上协议。
await test('GIF 走转码兜底：无转码器时降级成文本占位，且绝不裸传 image block', async () => {
  const store = makeStore()
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }], store)
  const run = collect(adapter, {
    sessionId: 'S-gif',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: '动图' }, imageOf('a1', 'image/gif')] }],
  })
  await run.done

  const prompt = lastPrompt(clients[0])
  assert.equal(prompt.length, 1, 'GIF 不许产生 image block')
  assert.equal(prompt[0].type, 'text')
  assert.ok(prompt[0].text.includes('GIF 动图'), '缺降级占位')
  // 读字节是转码的前提：没装 sharp 时白读一次，装了就直接转出 PNG
  assert.ok(store.calls.length >= 1, 'GIF 应该尝试读字节以便转码')
  await adapter.dispose()
})

await test('不支持的 MIME 降级成文本占位', async () => {
  const store = makeStore()
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }], store)
  const run = collect(adapter, {
    sessionId: 'S-bmp',
    system: 'sys',
    messages: [{ role: 'user', content: [imageOf('a1', 'image/bmp')] }],
  })
  await run.done
  const prompt = lastPrompt(clients[0])
  assert.equal(prompt.length, 1)
  assert.ok(prompt[0].text.includes('不支持的格式'), prompt[0].text)
  assert.deepEqual(store.calls, [])
  await adapter.dispose()
})

// 7) 单请求图片上限
await test(`单请求最多 ${MAX_IMAGES_PER_REQUEST} 张图，超出降级占位`, async () => {
  const total = MAX_IMAGES_PER_REQUEST + 2
  const store = makeStore()
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }], store)
  const content = [{ type: 'text', text: '一堆图' }]
  for (let i = 0; i < total; i++) content.push(imageOf('a1'))
  const run = collect(adapter, { sessionId: 'S-many', system: 'sys', messages: [{ role: 'user', content }] })
  await run.done

  const prompt = lastPrompt(clients[0])
  assert.equal(prompt.filter((b) => b.type === 'image').length, MAX_IMAGES_PER_REQUEST)
  assert.ok(prompt[0].text.includes('超出单次请求上限'), '缺超限占位')
  assert.equal(store.calls.length, MAX_IMAGES_PER_REQUEST, '超限图不许读字节')
  await adapter.dispose()
})

// 8) 挂起期间用户直接发新话：不许复用半截会话，走全量重建
await test('挂起态被新 prompt 顶掉时淘汰旧会话并重建', async () => {
  const { adapter, clients, bridges } = makeAdapter([{ script: ['先读'], hang: true }, { script: ['新话题'] }])
  const options = {
    sessionId: 'S-supersede',
    system: 'sys',
    tools: [READ_TOOL],
    messages: [{ role: 'user', content: '读一下' }],
  }
  const first = collect(adapter, options)
  await waitFor(() => clients[0]?.prompts.length === 1)
  bridges[0].park({ id: 31, tenantKey: 'S-supersede', name: 'read', arguments: {} })
  await first.done
  const oldSession = adapter.store.touch('s:S-supersede').agySessionId

  const second = collect(adapter, {
    ...options,
    messages: [...options.messages, { role: 'user', content: '换个话题' }],
  })
  await second.done

  assert.equal(clients[0].stopCount, 1, '半截会话必须关掉')
  assert.equal(clients.length, 2)
  assert.equal(clients[1].newSessionCount, 1)
  assert.notEqual(adapter.store.touch('s:S-supersede').agySessionId, oldSession)
  await adapter.dispose()
})

// 9) 没有 attachment store 时降级，不炸
await test('没有 attachment store 时图片降级成占位而不是崩', async () => {
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }], null)
  const run = collect(adapter, {
    sessionId: 'S-no-store',
    system: 'sys',
    messages: [{ role: 'user', content: [imageOf('a1')] }],
  })
  await run.done
  const prompt = lastPrompt(clients[0])
  assert.equal(prompt.length, 1)
  assert.ok(prompt[0].text.includes('未能读取该附件'), prompt[0].text)
  await adapter.dispose()
})

// ---- 10~13) 正路铺通：promptStream 第二形态 blocks，不再改写 client._write ----
// 真 client 不拉进程：手工给 sessionId，_write 换成捕获器，prompt 结束后补一条 rpc 应答
async function capturePromptFrame(run) {
  const client = new AgyAcpClient({ seed: false, proxy: null })
  client.sessionId = 'sess-unit-prompt'
  const frames = []
  client._write = (m) => {
    frames.push(m)
    if (m?.method === 'session/prompt') {
      setImmediate(() => client.emit('rpc-response', { jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } }))
    }
    return true
  }
  for await (const _chunk of run(client)) { /* 只看发出去的帧 */ }
  return frames
}

await test('真 client：blocks 形态下 params.prompt 是数组且首元素是 text', async () => {
  const blocks = [
    { type: 'text', text: '这张图里有什么' },
    { type: 'image', data: PNG_B64, mimeType: 'image/png' },
  ]
  const frames = await capturePromptFrame((client) => client.promptStream('这张图里有什么', { blocks }))
  const frame = frames.find((m) => m?.method === 'session/prompt')
  assert.ok(frame, '应当发出 session/prompt')
  assert.ok(Array.isArray(frame.params.prompt), 'prompt 必须是数组')
  assert.equal(frame.params.prompt.length, 2, `应是 [text, image]，实得 ${frame.params.prompt.length}`)
  assert.equal(frame.params.prompt[0].type, 'text')
  assert.equal(frame.params.prompt[0].text, '这张图里有什么')
  assert.deepEqual(frame.params.prompt[1], { type: 'image', data: PNG_B64, mimeType: 'image/png' })
})

await test('真 client：旧的纯文本调用仍拼单个 text block', async () => {
  const frames = await capturePromptFrame((client) => client.promptStream('就一句话'))
  const frame = frames.find((m) => m?.method === 'session/prompt')
  assert.ok(frame)
  assert.equal(frame.params.prompt.length, 1)
  assert.deepEqual(frame.params.prompt[0], { type: 'text', text: '就一句话' })
})

await test('真 client：blocks 为空数组时退回单 text block', async () => {
  const frames = await capturePromptFrame((client) => client.promptStream('兜底', { blocks: [] }))
  const frame = frames.find((m) => m?.method === 'session/prompt')
  assert.deepEqual(frame.params.prompt, [{ type: 'text', text: '兜底' }])
})

await test('适配器把 blocks 交给 promptStream，不再改写 client._write', async () => {
  const { adapter, clients } = makeAdapter([{ script: ['看见了'] }])
  const run = collect(adapter, {
    sessionId: 'S-pass-blocks',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, imageOf('a1')] }],
  })
  await run.done
  const client = clients[0]
  assert.equal(client.blockCalls.length, 1, 'promptStream 只该被调用一次')
  const blocks = client.blockCalls[0]
  assert.ok(Array.isArray(blocks) && blocks.length === 2, `实得 ${JSON.stringify(blocks)?.slice(0, 90)}`)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].type, 'image')
  assert.equal(
    Object.prototype.hasOwnProperty.call(client, '_write'),
    false,
    '_write 不许再被临时改写（有了 blocks 形态就该走正路）',
  )

  const { adapter: a2, clients: c2 } = makeAdapter([{ script: ['ok'] }])
  const run2 = collect(a2, { sessionId: 'S-text-only', system: 'sys', messages: [{ role: 'user', content: '纯文字' }] })
  await run2.done
  assert.equal(c2[0].blockCalls[0], null, '无图时必须传 null，让 client 走纯文本形态')
  assert.equal(lastPrompt(c2[0]).length, 1, '无图时只有单个 text block')
  await adapter.dispose()
  await a2.dispose()
})

// ---- 14~17) 工具压缩闸接线（D1）----
function fatTool(name, propCount = 15, { enumValues = null, descLen = 200 } = {}) {
  const properties = {}
  const required = []
  for (let k = 0; k < propCount; k++) {
    const key = `field_${k}`
    properties[key] = {
      type: 'string',
      description: 'd'.repeat(descLen),
      ...(enumValues ? { enum: enumValues } : {}),
    }
    required.push(key)
  }
  return { name, description: 'x'.repeat(300), inputSchema: { type: 'object', properties, required } }
}

await test('工具表压缩闸接线：桥的 getTools 拿到的是压缩后的表', async () => {
  const raw = fatTool('fat')
  const { adapter, bridges } = makeAdapter([{ script: ['ok'] }], makeStore(), { allowedTools: ['fat'] })
  const run = collect(adapter, {
    sessionId: 'S-gate',
    system: 'sys',
    tools: [raw],
    messages: [{ role: 'user', content: '用工具' }],
  })
  await run.done

  const seen = bridges[0].hooks.getTools('S-gate')
  assert.equal(seen.length, 1, `桥必须看到 1 个工具，实得 ${seen.length}`)
  assert.equal(seen[0].name, 'fat')
  assert.equal(seen[0].demoted, true, '肥工具必须被降级')
  assert.ok(seen[0].demoteStage >= 1, `demoteStage=${seen[0].demoteStage}`)
  assert.ok(seen[0].description.length <= 140, `压缩后主描述 ${seen[0].description.length} 字`)
  assert.equal(seen[0].fullDescription.length, 300, '原始描述留在 fullDescription 供补偿段用')
  assert.deepEqual(seen[0].inputSchema.required, raw.inputSchema.required, 'required 一个都不许少')
  assert.equal(Object.keys(seen[0].inputSchema.properties).length, 15, '属性名一个都不许少')
  await adapter.dispose()
})

await test('补偿段拼在 systemPromptAppend 尾部，原 system 原样在最前', async () => {
  const raw = fatTool('fat')
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }], makeStore(), { allowedTools: ['fat'] })
  const run = collect(adapter, {
    sessionId: 'S-append',
    system: 'BASE-SYSTEM-文本',
    tools: [raw],
    messages: [{ role: 'user', content: 'hi' }],
  })
  await run.done

  const append = clients[0].newSessionOpts[0]?.systemPromptAppend ?? ''
  assert.ok(append.startsWith('BASE-SYSTEM-文本'), `原 system 必须在最前，实得：${append.slice(0, 40)}`)
  assert.ok(append.includes('## 被压缩 MCP 工具的完整说明'), '补偿段必须追加在尾部')
  assert.ok(
    append.indexOf('## 被压缩 MCP 工具的完整说明') > append.indexOf('BASE-SYSTEM-文本'),
    '补偿段必须排在 system 之后',
  )
  assert.ok(append.includes('fat'), '补偿段要写明是哪个工具')
  await adapter.dispose()
})

await test('工具表变了：补偿段重算并重建会话，不吃旧补偿段', async () => {
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }, { script: ['ok2'] }], makeStore(), {
    allowedTools: ['fat_a', 'fat_b'],
  })
  const base = [{ role: 'user', content: 'hi' }]
  const first = collect(adapter, { sessionId: 'S-recalc', system: 'sys', tools: [fatTool('fat_a')], messages: base })
  await first.done

  const second = collect(adapter, {
    sessionId: 'S-recalc',
    system: 'sys',
    tools: [fatTool('fat_b')],
    messages: [...base, { role: 'assistant', content: 'ok' }, { role: 'user', content: '继续' }],
  })
  await second.done

  assert.equal(clients.length, 1, '同一 client 复用')
  assert.equal(clients[0].newSessionCount, 2, '工具表变了必须重建会话')
  const append = clients[0].newSessionOpts[1]?.systemPromptAppend ?? ''
  assert.ok(append.includes('fat_b'), '补偿段必须按新表重算')
  assert.equal(append.includes('fat_a'), false, '不许残留旧表的补偿段')
  await adapter.dispose()
})

await test('工具表压不动时 overBudget 留痕，不静默', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `fat_${i}`)
  const tools = names.map((n) => fatTool(n, 80, { enumValues: ['aaa', 'bbb', 'ccc', 'ddd', 'eee'] }))
  const errors = []
  const { adapter, clients } = makeAdapter([{ script: ['ok'] }, { script: ['ok2'] }], makeStore(), {
    allowedTools: names,
    onError: (e) => errors.push(e),
  })
  const base = [{ role: 'user', content: 'hi' }]
  const run = collect(adapter, { sessionId: 'S-over', system: 'sys', tools, messages: base })
  await run.done
  assert.ok(
    errors.some((e) => String(e?.message ?? '').includes('54000')),
    `超预算必须留痕，实得 ${errors.map((e) => e?.message).join(' | ') || '（没有任何 onError）'}`,
  )
  const append = clients[0].newSessionOpts[0]?.systemPromptAppend ?? ''
  assert.ok(append.includes('## 被压缩 MCP 工具的完整说明'), '压不动时补偿段更得给')
  assert.ok(append.length <= 6000 + 200, `补偿段不得失控，实得 ${append.length} 字`)

  // 同一个超限状态每轮都会过闸，但告警只该留一次（别把日志刷成一片）
  const again = collect(adapter, {
    sessionId: 'S-over',
    system: 'sys',
    tools,
    messages: [...base, { role: 'assistant', content: 'ok' }, { role: 'user', content: '继续' }],
  })
  await again.done
  assert.equal(errors.length, 1, `同一超限状态只报一次，实得 ${errors.length} 次`)
  await adapter.dispose()
})

console.log(`\n${failures.length === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${failures.length} 失败`)
if (failures.length > 0) {
  for (const f of failures) console.error(`- ${f.label}: ${f.e?.stack ?? f.e}`)
  process.exit(1)
}

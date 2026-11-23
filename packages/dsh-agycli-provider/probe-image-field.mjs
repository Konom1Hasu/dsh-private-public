// 真机探针：agy 到底认哪个图片块字段名 —— mimeType 还是 mediaType？
// 直接操作 AgyAcpClient，绕开 adapter，单发 session/prompt。
import zlib from 'node:zlib'
import { AgyAcpClient } from './lib/agy-acp-client.mjs'

const AGY_ROOT = 'C:/Users/KonomiHasu/.dsh/profiles/web/agy-runtime'

// ---- 最小 PNG 生成（纯色 8x8）----
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function makePng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type RGB
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const png = makePng(8, [255, 0, 0])
const b64 = png.toString('base64')
console.log(`[png] ${png.length} bytes, base64 ${b64.length} chars`)

async function trial(fieldName, client) {
  const id = ++client.nextId
  let text = ''
  let finished = false
  let err = null

  const onNote = (m) => {
    const u = m.params?.update
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text ?? ''
  }
  const onResp = (m) => {
    if (m.id !== id) return
    finished = true
    if (m.error) err = m.error
  }
  client.on('notification', onNote)
  client.on('rpc-response', onResp)

  const imageBlock = { type: 'image', data: b64, [fieldName]: 'image/png' }
  const prompt = [
    { type: 'text', text: '这张图是什么颜色？只回答一个颜色词。' },
    imageBlock,
  ]
  console.log(`[${fieldName}] prompt blocks = ${JSON.stringify(prompt.map((b) => (b.type === 'image' ? `image{${Object.keys(b).join(',')}}` : 'text')))}`)

  client._write({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: client.sessionId, prompt } })

  const t0 = Date.now()
  while (!finished && Date.now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 100))

  client.off('notification', onNote)
  client.off('rpc-response', onResp)

  console.log(`[${fieldName}] finished=${finished} 耗时=${Date.now() - t0}ms`)
  if (err) console.log(`[${fieldName}] rpc error = ${JSON.stringify(err)}`)
  console.log(`[${fieldName}] 正文 = ${JSON.stringify(text.slice(0, 200))}`)
  return { ok: finished && !err, text, err }
}

const results = {}
for (const field of ['mimeType', 'mediaType']) {
  const client = new AgyAcpClient({
    bin: `${AGY_ROOT}/bin/agy.exe`,
    home: `${AGY_ROOT}/home`,
    proxy: 'http://127.0.0.1:8868',
    cwd: process.cwd(),
    agent: 'dsh_bridge',
    permissionPolicy: () => false,
  })
  client.on('error', (e) => console.error(`[${field} client-error]`, e?.message ?? e))
  try {
    await client.initialize()
    await client.newSession({
      cwd: process.cwd(),
      systemPromptAppend: '你是视觉测试助手，必须看图回答。',
      mcpServers: [],
    })
    results[field] = await trial(field, client)
  } catch (e) {
    console.error(`[${field}] 异常`, e?.message ?? e)
    results[field] = { ok: false, err: String(e?.message ?? e) }
  } finally {
    await client.stop().catch(() => {})
  }
}

console.log('---')
for (const [k, v] of Object.entries(results)) {
  console.log(`${k.padEnd(10)} ok=${v.ok} text=${JSON.stringify((v.text || '').slice(0, 60))} err=${v.err ? JSON.stringify(v.err) : 'none'}`)
}
process.exit(0)

// 真机终验（风控纪律：单 session、串行、失败即停、不重试）
// 一次跑完三件事：
//   1. 工具 park 闭环（read → 宿主执行 → resume 续流）
//   2. 顶层图片投递（{type:'image',data,mimeType} 真被 agy 看见）
//   3. usage_update 被 adapter 记到 turn/binding 上
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { AgyCliAdapter } from './lib/index.js'

const AGY_ROOT = 'C:/Users/KonomiHasu/.dsh/profiles/web/agy-runtime'
const MODEL = process.argv[2] || 'gemini-4-hydrogen-medium'
const SECRET = 'FINAL_OK_9427'
const TARGET = path.join(process.cwd(), 'tmp-final-target.txt')
fs.writeFileSync(TARGET, `${SECRET}\n`, 'utf8')

// ---- 纯色 PNG ----
const T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c } return t })()
const crc = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]) }
function makePng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc(size * (1 + size * 3))
  for (let y = 0; y < size; y++) { const row = y * (1 + size * 3); raw[row] = 0; for (let x = 0; x < size; x++) { raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b } }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const PNG_B64 = makePng(8, [0, 128, 255]).toString('base64')

const adapter = new AgyCliAdapter({
  bin: `${AGY_ROOT}/bin/agy.exe`,
  home: `${AGY_ROOT}/home`,
  proxy: 'http://127.0.0.1:8868',
  cwd: process.cwd(),
  seed: false, // 真机 home 已经播过种，别动它
  onError: (e) => console.error('[adapter-error]', e?.message ?? e),
})

const readTool = {
  name: 'read',
  description: '读取一个文本文件的完整内容。',
  inputSchema: { type: 'object', properties: { path: { type: 'string', description: '绝对路径' } }, required: ['path'] },
}

const sys = { role: 'system', content: [{ type: 'text', text: '你是测试助手。要求用工具就用工具，要求看图就看图。' }] }
const results = { tool: false, image: false, usage: 0, resumed: false, err: null }

async function round(messages, tag, tools = []) {
  let text = ''
  let toolCall = null
  const kinds = []
  for await (const c of adapter.stream({ provider: 'agycli', model: MODEL, sessionId: 'final-e2e', messages, tools })) {
    kinds.push(c.type)
    if (c.type === 'text-delta') text += c.text
    else if (c.type === 'block-end' && c.block?.type === 'tool-call') toolCall = c.block
    else if (c.type === 'usage') results.usage = c.usage?.totalTokens ?? results.usage
    else if (c.type === 'finish') console.log(`[${tag} finish] ${JSON.stringify(c.reason)}`)
  }
  console.log(`[${tag}] kinds=${kinds.join(',')} text=${JSON.stringify(text.slice(0, 120))}`)
  return { text, toolCall }
}

try {
  // ---- 第 1 步：工具 ----
  const u1 = { role: 'user', content: [{ type: 'text', text: `用 read 工具读 ${TARGET}，然后只回复文件里那串字符。` }] }
  const r1 = await round([sys, u1], 'TOOL-1', [readTool])
  if (r1.toolCall) {
    // ---- 第 2 步：喂结果，验 resume ----
    const r2 = await round([
      sys, u1,
      { role: 'assistant', content: [{ type: 'tool-call', ...r1.toolCall }] },
      { role: 'tool', toolCallId: r1.toolCall.id, content: [{ type: 'text', text: `${SECRET}\n` }] },
    ], 'TOOL-2', [readTool])
    results.tool = true
    results.resumed = r2.text.includes(SECRET)
  }

  // ---- 第 3 步：图片（同一 session，第二个 prompt）----
  const imgMsg = {
    role: 'user',
    content: [
      { type: 'text', text: '这张图是什么颜色？只回答一个颜色词。' },
      { type: 'image', data: PNG_B64, mimeType: 'image/png' },
    ],
  }
  const r3 = await round([sys, imgMsg], 'IMAGE')
  results.image = /蓝|blue/i.test(r3.text)
} catch (e) {
  results.err = String(e?.message ?? e)
  console.error('[threw]', e?.stack ?? e)
} finally {
  await adapter.dispose()
  try { fs.unlinkSync(TARGET) } catch {}
}

console.log('---')
console.log(`模型 ${MODEL}`)
console.log(`工具 park 闭环: ${results.tool ? '通' : '未触发'}    resume 复述: ${results.resumed ? '通' : '否'}`)
console.log(`图片投递: ${results.image ? '通' : '失败'}    usage: ${results.usage}`)
console.log(`异常: ${results.err ?? '无'}`)
process.exit(results.err ? 1 : 0)

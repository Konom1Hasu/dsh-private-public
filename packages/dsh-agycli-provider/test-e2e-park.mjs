// 真机端到端：验证两条未验证假设
//   1) agy acp 的 session/new 是否接受 mcpServers 的 {type:'http', url, headers}
//   2) park 之后 agy 是否在同一个 session/prompt 内续流（resume 不重发 prompt）
// 会真实烧账号额度，单次最小请求。
import fs from 'node:fs'
import path from 'node:path'
import { AgyCliAdapter } from './lib/index.js'

const AGY_ROOT = 'C:/Users/KonomiHasu/.dsh/profiles/web/agy-runtime'
const TARGET = path.join(process.cwd(), 'tmp-e2e-target.txt')
const SECRET = 'PARK_OK_7731'
fs.writeFileSync(TARGET, `${SECRET}\n`, 'utf8')

const adapter = new AgyCliAdapter({
  bin: `${AGY_ROOT}/bin/agy.exe`,
  home: `${AGY_ROOT}/home`,
  proxy: 'http://127.0.0.1:8868',
  cwd: process.cwd(),
  // A4 播种隔离：端到端验证不碰真机 home
  seed: false,
  onError: (e) => console.error('[adapter-error]', e?.message ?? e),
})

const model = process.argv[2] || 'gemini-3.8-flash-low'
const readTool = {
  name: 'read',
  description: '读取一个文本文件的完整内容。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '绝对路径' } },
    required: ['path'],
  },
}
// DSH 侧字段名若是 parameters，一并给上，避免因字段名不匹配导致 schema 为空
readTool.parameters = readTool.inputSchema

const systemMsg = {
  role: 'system',
  content: [{ type: 'text', text: '你是测试助手。必须使用 read 工具读取文件，不允许猜测内容。' }],
}
const userMsg = {
  role: 'user',
  content: [
    { type: 'text', text: `请用 read 工具读取 ${TARGET} 这个文件，然后只回复文件里的那串字符。` },
  ],
}

const events = []
let toolCall = null
let text1 = ''

const t0 = Date.now()

async function runRound(messages, tag) {
  let text = ''
  const seen = []
  for await (const chunk of adapter.stream({ provider: 'agycli', model, messages, tools: [readTool] })) {
    seen.push(chunk.type)
    if (chunk.type === 'text-delta') {
      text += chunk.text
      process.stdout.write(chunk.text)
    } else if (chunk.type === 'block-end') {
      const b = chunk.block
      if (b?.type === 'tool-call') {
        toolCall = b
        console.log(`\n[${tag} tool-call] id=${b.id} name=${b.name} args=${String(b.arguments ?? '').slice(0, 300)}`)
      } else if (b?.type === 'text') {
        console.log(`\n[${tag} text-block] len=${b.text?.length ?? 0}`)
      }
    } else if (chunk.type === 'finish') {
      console.log(`[${tag} finish] ${JSON.stringify(chunk.reason)}`)
    } else if (chunk.type === 'usage') {
      console.log(`[${tag} usage] ${JSON.stringify(chunk.usage)}`)
    }
  }
  events.push({ tag, seen: seen.join(','), text })
  return text
}

try {
  text1 = await runRound([systemMsg, userMsg], 'R1')

  if (!toolCall) {
    console.log('\n结论: agy 没有发出 tools/call —— mcpServers 未被接受或工具未挂上')
  } else {
    const callId = toolCall.id
    console.log(`\n--- 进入第 2 轮（喂 tool-result，应当 resume 而不是重发 prompt）---`)
    const toolMsg = {
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text: `${SECRET}\n` }],
    }
    const text2 = await runRound(
      [systemMsg, userMsg, { role: 'assistant', content: [{ type: 'tool-call', ...toolCall }] }, toolMsg],
      'R2',
    )
    console.log(`\nR2 正文 ${JSON.stringify(text2)}`)
    console.log(`R2 是否复述密钥: ${text2.includes(SECRET) ? '是' : '否'}`)
  }
} catch (e) {
  console.error('[e2e threw]', e?.stack ?? e)
} finally {
  await adapter.dispose()
  try { fs.unlinkSync(TARGET) } catch {}
}

console.log('---')
console.log(`模型 ${model}  耗时 ${Date.now() - t0}ms`)
console.log(`轮次明细 ${JSON.stringify(events)}`)
console.log(`工具调用 ${toolCall ? '有' : '无'}`)
process.exit(0)

// 真机探针：agy 的 session/update 里到底推不推 token 用量（usage_update）
// 目的：SQLite 里没有明文 estimated_tokens_used，看流里有没有更靠谱的来源
import { AgyAcpClient } from './lib/agy-acp-client.mjs'

const AGY_ROOT = 'C:/Users/KonomiHasu/.dsh/profiles/web/agy-runtime'

const client = new AgyAcpClient({
  bin: `${AGY_ROOT}/bin/agy.exe`,
  home: `${AGY_ROOT}/home`,
  proxy: 'http://127.0.0.1:8868',
  cwd: process.cwd(),
  agent: 'dsh_bridge',
  permissionPolicy: () => false,
})
client.on('error', (e) => console.error('[client-error]', e?.message ?? e))

const seen = new Map()
client.on('notification', (m) => {
  if (m.method !== 'session/update') return
  const u = m.params?.update
  const kind = u?.sessionUpdate ?? '(none)'
  const n = (seen.get(kind) ?? 0) + 1
  seen.set(kind, n)
  const payload = JSON.stringify(u)
  if (n <= 3) console.log(`[update ${kind} #${n}] ${payload.slice(0, 500)}`)
})

try {
  await client.initialize()
  await client.newSession({
    cwd: process.cwd(),
    systemPromptAppend: '回答要极短。',
    mcpServers: [],
  })
  let text = ''
  for await (const c of client.promptStream('用一句话介绍你自己', { signal: undefined })) {
    if (c?.text) text += c.text
  }
  console.log('---')
  console.log('正文:', JSON.stringify(text.slice(0, 120)))
  console.log('sessionUpdate 类型统计:')
  for (const [k, v] of seen) console.log(`  ${k}: ${v} 次`)
} catch (e) {
  console.error('[threw]', e?.message ?? e)
} finally {
  await client.stop().catch(() => {})
}
process.exit(0)

// 离线自测：直接驱动 adapter.stream()，验证 messages → ACP → StreamChunk 全链路。
import { AgyCliAdapter } from './lib/index.js'

const AGY_ROOT = 'C:/Users/KonomiHasu/.dsh/profiles/web/agy-runtime'

const adapter = new AgyCliAdapter({
  bin: `${AGY_ROOT}/bin/agy.exe`,
  home: `${AGY_ROOT}/home`,
  proxy: 'http://127.0.0.1:8868',
  cwd: process.cwd(),
  // A4 播种隔离：这条只做连通性验证，不许往真机 home 里种文件
  seed: false,
  onError: (e) => console.error('[adapter-error]', e?.message ?? e),
})

const model = process.argv[2] || 'gemini-3.8-flash-low'

const options = {
  provider: 'agycli',
  model,
  messages: [
    { role: 'system', content: [{ type: 'text', text: '你是一个连接测试助手，回答要极短。' }] },
    { role: 'user', content: [{ type: 'text', text: '只回复两个字：通道' }] },
  ],
}

const t0 = Date.now()
let text = ''
const seen = []

try {
  for await (const chunk of adapter.stream(options)) {
    seen.push(chunk.type)
    if (chunk.type === 'text-delta') {
      text += chunk.text
      process.stdout.write(chunk.text)
    } else if (chunk.type === 'finish') {
      console.log(`\n[finish] ${JSON.stringify(chunk.reason)}`)
    } else if (chunk.type === 'usage') {
      console.log(`[usage] ${JSON.stringify(chunk.usage)}`)
    } else if (chunk.type === 'block-end') {
      console.log(`[block-end] text.length=${chunk.block?.text?.length ?? 0}`)
    }
  }
} catch (e) {
  console.error('[stream threw]', e?.message ?? e)
} finally {
  await adapter.dispose()
}

console.log('---')
console.log(`模型   ${model}`)
console.log(`耗时   ${Date.now() - t0}ms`)
console.log(`正文   ${JSON.stringify(text)}`)
console.log(`chunks ${seen.join(',')}`)
process.exit(text.trim().length > 0 ? 0 : 1)

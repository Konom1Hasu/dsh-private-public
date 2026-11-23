// 附件服务取用方式的自测：可选服务走 ctx.get，绝不能裸读 ctx.attachments。
// 真机症状：裸读抛 "cannot get property ... without inject"，把整个 inject 回调整段炸掉，
// 渠道压根没注册，UI 里连 agycli 整组都没有，而插件状态还是绿的「启用中」。
import assert from 'node:assert'
import { apply } from './lib/index.js'

let pass = 0, fail = 0
async function test(label, fn) {
  try { await fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

const fakeStore = { readImage: async () => ({ data: Buffer.from('x') }) }

// 模拟真 cordis：裸读未声明 inject 的属性就抛；ctx.get 对没装的服务返回 undefined
function makeCtx({ withStore }) {
  const captured = { adapter: null, logs: [] }
  const ctx = {
    llm: { registerAdapter: (p, a) => { captured.adapter = a; captured.provider = p; return () => {} } },
    effect: () => {},
    inject: (deps, cb) => cb(ctx),
    logger: { info: (s) => captured.logs.push(s), warn: (s) => captured.logs.push(s) },
    get: (name) => (name === 'attachments' && withStore ? fakeStore : undefined),
  }
  Object.defineProperty(ctx, 'attachments', {
    get() { throw new Error('cannot get property "attachments" without inject') },
    configurable: true,
  })
  return { ctx, captured }
}

await test('服务在装：attachments 拿到实例，注册照常成功', async () => {
  const { ctx, captured } = makeCtx({ withStore: true })
  apply(ctx, {})
  assert.ok(captured.adapter, '渠道没注册')
  assert.equal(captured.adapter.opts.attachments, fakeStore, 'attachments 没拿到')
})

await test('服务没装：不抛错、注册照常成功、attachments 为 null', async () => {
  const { ctx, captured } = makeCtx({ withStore: false })
  apply(ctx, {})
  assert.ok(captured.adapter, '渠道没注册')
  assert.equal(captured.adapter.opts.attachments, null, '没装服务时应降级 null')
})

await test('裸读陷阱验证：直接读 ctx.attachments 确实会抛（证明测试场景是真的）', async () => {
  const { ctx } = makeCtx({ withStore: true })
  assert.throws(() => ctx.attachments, /without inject/)
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

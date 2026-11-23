// 模拟 cordis 加载：验证 apply() 不抛、路由注册正确、listModels/resolveModel 正常。
import { apply, PROVIDER } from './lib/index.js'

const log = []
let registered = null
const ctx = {
  llm: {
    registerAdapter(routes, adapter) {
      registered = { routes, adapter }
      log.push(`registerAdapter routes=${routes.join(',')}`)
      return () => { log.push('disposed') }
    },
  },
  effect(fn) { log.push('effect registered') },
  logger: { warn: (...a) => log.push(`warn ${a.join(' ')}`) },
  on() { log.push('ctx.on fallback') },
  // 模拟 cordis 的 ctx.inject(['llm'], cb)：依赖已就绪 → 同步执行回调，
  // 返回一个清理函数（真实实现会在依赖卸载时回调它）。
  inject(deps, cb) {
    const list = Array.isArray(deps) ? deps : [deps]
    log.push(`inject ${list.join(',')}`)
    const dispose = cb(ctx)
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

apply(ctx, { proxy: 'http://127.0.0.1:8868', agent: 'dsh_bridge' })

if (!registered) {
  console.error('FAIL: registerAdapter 没被调用')
  process.exit(1)
}
if (registered.routes.length !== 1 || registered.routes[0] !== PROVIDER) {
  console.error(`FAIL: routes 不对 ${JSON.stringify(registered.routes)}`)
  process.exit(1)
}

const adapter = registered.adapter
const models = await adapter.listModels(PROVIDER)
const resolved = await adapter.resolveModel(PROVIDER, 'gemini-3.8-flash-low')
const prepared = await adapter.prepareCall(PROVIDER, 'gemini-3.8-flash-low')

console.log(log.join('\n'))
console.log(`providerInfo  ${JSON.stringify(adapter.providerInfo(PROVIDER))}`)
console.log(`listModels    ${models.length} 个，首个 ${models[0].id}`)
console.log(`resolveModel  contextWindow=${resolved.context?.contextWindow} defaultMaxTokens=${resolved.defaultMaxTokens} efforts=${resolved.reasoning?.efforts.map(e=>e.id).join('/')}`)
console.log(`prepareCall   model.id=${prepared.model.id} stream=${typeof prepared.stream}`)
console.log('OK: apply/listModels/resolveModel/prepareCall 全部通过')

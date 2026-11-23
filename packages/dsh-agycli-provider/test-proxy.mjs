// A2 验收：代理动态发现（3s TTL / ETIMEDOUT 刷新 / 静默回落 / NO_PROXY 恒定 / 显式覆盖优先）
import assert from 'node:assert/strict'
import {
  AgyAcpClient,
  PROXY_CACHE_TTL_MS,
  NO_PROXY_BASE,
  parseRegistryProxyDump,
  normalizeProxyServer,
  mergeNoProxy,
  readSystemProxyRegistry,
} from './lib/agy-acp-client.mjs'

let failures = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures += 1
    console.error(`FAIL  ${name}\n      ${e?.message ?? e}`)
  }
}

// 环境隔离：不让宿主的 AGY_PROXY / 代理变量污染断言
const ENV_KEYS = ['AGY_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']
const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]))
for (const k of ENV_KEYS) delete process.env[k]

const RE_DUMP = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:7890',
  '    ProxyOverride    REG_SZ    <local>',
  '',
].join('\r\n')

await test('常量与默认值：TTL=3000、NO_PROXY 保底串正确', () => {
  assert.equal(PROXY_CACHE_TTL_MS, 3000)
  assert.equal(NO_PROXY_BASE, '127.0.0.1,localhost,::1')
  assert.equal(new AgyAcpClient({ seed: false }).proxyTtlMs, 3000)
})

await test('注册表解析：ProxyEnable=1 取值，=0 忽略', () => {
  assert.equal(parseRegistryProxyDump(RE_DUMP), 'http://127.0.0.1:7890')
  assert.equal(parseRegistryProxyDump(RE_DUMP.replace('0x1', '0x0')), null)
  assert.equal(parseRegistryProxyDump(''), null)
  assert.equal(parseRegistryProxyDump('ProxyServer REG_SZ 1.2.3.4:1'), null)
})

await test('ProxyServer 各种写法归一', () => {
  assert.equal(normalizeProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyServer('http://127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyServer('socks5://127.0.0.1:1280'), 'socks5://127.0.0.1:1280')
  assert.equal(normalizeProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyServer('https=10.0.0.1:3128'), 'http://10.0.0.1:3128')
  assert.equal(normalizeProxyServer(''), null)
  // 认不出形状的一律 null，不拼非法值
  assert.equal(normalizeProxyServer('socks=127.0.0.1:1080'), null)
  assert.equal(normalizeProxyServer('http=user:pass=@host:8080'), null)
})

await test('ProxyEnable 十进制也能认', () => {
  assert.equal(
    parseRegistryProxyDump('ProxyEnable REG_DWORD 1\r\nProxyServer REG_SZ 127.0.0.1:7890'),
    'http://127.0.0.1:7890',
  )
})

await test('NO_PROXY 合并：loopback 保底 + 用户条目保留', () => {
  assert.equal(mergeNoProxy(), '127.0.0.1,localhost,::1')
  assert.equal(mergeNoProxy(''), '127.0.0.1,localhost,::1')
  assert.equal(mergeNoProxy('localhost, *.corp.internal'), '127.0.0.1,localhost,::1,*.corp.internal')
  assert.equal(mergeNoProxy('127.0.0.1,::1,a.test'), '127.0.0.1,localhost,::1,a.test')
  process.env.NO_PROXY = '*.corp.internal'
  const env = new AgyAcpClient({ seed: false, registryProbe: () => null })._env()
  assert.ok(env.NO_PROXY.startsWith('127.0.0.1,localhost,::1'), env.NO_PROXY)
  assert.ok(env.NO_PROXY.includes('*.corp.internal'), env.NO_PROXY)
  delete process.env.NO_PROXY
})

await test('TTL 窗口内重复 _env() 不重复取源', () => {
  let reads = 0
  const c = new AgyAcpClient({
    seed: false,
    proxyTtlMs: 5000,
    registryProbe: () => { reads += 1; return 'http://127.0.0.1:7890' },
  })
  const e1 = c._env()
  const e2 = c._env()
  const e3 = c._env()
  assert.equal(e1.HTTP_PROXY, 'http://127.0.0.1:7890')
  assert.equal(e2.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(e3.http_proxy, 'http://127.0.0.1:7890')
  assert.equal(c.https_proxy, undefined)
  assert.equal(reads, 1, `TTL 内取了 ${reads} 次源`)
  assert.equal(c._proxyReads, 1)
  assert.equal(c.proxy, 'http://127.0.0.1:7890')
})

await test('TTL 过期后自动重读', async () => {
  let reads = 0
  const c = new AgyAcpClient({
    seed: false,
    proxyTtlMs: 60,
    registryProbe: () => { reads += 1; return `http://127.0.0.1:${7890 + reads}` },
  })
  c._env()
  assert.equal(reads, 1)
  await sleep(110)
  assert.equal(c._env().HTTP_PROXY, 'http://127.0.0.1:7892')
  assert.equal(reads, 2)
})

await test('真实默认 3s 窗口内不重读（不注入假 probe，等 3s 边界之前）', async () => {
  let reads = 0
  const c = new AgyAcpClient({
    seed: false,
    registryProbe: () => { reads += 1; return 'http://127.0.0.1:7890' },
  })
  assert.equal(c.proxyTtlMs, 3000)
  c._env()
  await sleep(1200)
  c._env()
  c._env()
  assert.equal(reads, 1, `3s 内取了 ${reads} 次源`)
  await sleep(2000) // 越过 3s
  c._env()
  assert.equal(reads, 2, '过 3s 应该重读一次')
})

await test('伪造握手 ETIMEDOUT → 刷新缓存并读到新代理', async () => {
  let current = 'http://127.0.0.1:1111'
  let reads = 0
  const c = new AgyAcpClient({
    seed: false,
    proxyTtlMs: 60_000, // 故意设很长，确保刷新只可能来自超时路径
    registryProbe: () => { reads += 1; return current },
  })
  assert.equal(c._env().HTTP_PROXY, 'http://127.0.0.1:1111')
  assert.equal(reads, 1)
  // 代理被换掉了
  current = 'http://127.0.0.1:2222'
  // TTL 还没过期，直接取还是旧值
  assert.equal(c._env().HTTP_PROXY, 'http://127.0.0.1:1111')
  assert.equal(reads, 1)

  // 真路径：initialize 的 _rpc 抛 ETIMEDOUT，必须触发刷新
  const refreshes = []
  c.on('proxy-refresh', (i) => refreshes.push(i))
  c.start = () => c // 不真拉进程
  c._rpc = async () => { throw Object.assign(new Error('rpc 超时: initialize'), { code: 'ETIMEDOUT' }) }
  await assert.rejects(() => c.initialize(), /rpc 超时/)
  assert.equal(refreshes.length, 1, 'ETIMEDOUT 没触发 proxy-refresh')
  assert.equal(refreshes[0].reason, 'handshake-timeout')
  assert.equal(refreshes[0].method, 'initialize')
  assert.equal(c._env().HTTP_PROXY, 'http://127.0.0.1:2222', '刷新后没读到新代理')
  assert.equal(reads, 2)
})

await test('空闲期 noteIdle 后重读', async () => {
  let reads = 0
  const c = new AgyAcpClient({ seed: false, proxyTtlMs: 60_000, registryProbe: () => { reads += 1; return 'http://127.0.0.1:7890' } })
  c._env()
  c._env()
  assert.equal(reads, 1)
  c.noteIdle()
  c._env()
  assert.equal(reads, 2, '空闲期没有重读')
})

await test('拿不到代理：静默回落、不抛、不注入任何代理变量', () => {
  for (const probe of [
    () => null,
    () => { throw new Error('reg query 被策略拒了') },
    () => '',
    () => 42,
  ]) {
    const c = new AgyAcpClient({ seed: false, registryProbe: probe })
    const env = c._env() // 不许抛
    assert.equal(env.HTTP_PROXY, undefined)
    assert.equal(env.HTTPS_PROXY, undefined)
    assert.equal(env.http_proxy, undefined)
    assert.equal(env.https_proxy, undefined)
    assert.equal(c.resolveProxy(), null)
  }
})

await test('NO_PROXY 无条件恒存在（有代理/无代理都一样）', () => {
  const withProxy = new AgyAcpClient({ seed: false, proxy: 'http://127.0.0.1:7890' })._env()
  const noProxy = new AgyAcpClient({ seed: false, registryProbe: () => null })._env()
  for (const env of [withProxy, noProxy]) {
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1')
    assert.equal(env.no_proxy, '127.0.0.1,localhost,::1')
  }
})

await test('环境变量 AGY_PROXY 生效（无显式、注册表为空时）', () => {
  process.env.AGY_PROXY = 'http://127.0.0.1:7899'
  const c = new AgyAcpClient({ seed: false, registryProbe: () => null })
  assert.equal(c._env().HTTP_PROXY, 'http://127.0.0.1:7899')
  delete process.env.AGY_PROXY
})

await test('显式 proxy 覆盖优先级最高，且完全不碰注册表', () => {
  process.env.AGY_PROXY = 'http://127.0.0.1:7899'
  let reads = 0
  const c = new AgyAcpClient({
    seed: false,
    proxy: 'http://127.0.0.1:8868',
    registryProbe: () => { reads += 1; return 'http://127.0.0.1:7890' },
  })
  assert.equal(c._env().HTTP_PROXY, 'http://127.0.0.1:8868')
  assert.equal(c._env().HTTPS_PROXY, 'http://127.0.0.1:8868')
  assert.equal(reads, 0, '显式指定时不该去取源')
  assert.equal(c._proxyReads, 0)
  delete process.env.AGY_PROXY
})

await test('注册表真读一次不抛（当前机器可能没开系统代理）', () => {
  const v = readSystemProxyRegistry()
  assert.ok(v === null || typeof v === 'string')
  if (typeof v === 'string') assert.match(v, /^[a-z][a-z0-9+.-]*:\/\//i)
})

await test('_env() 保留自动更新/安全过滤契约不丢', () => {
  const env = new AgyAcpClient({ seed: false, registryProbe: () => null })._env()
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true')
  assert.equal(env.AGY_CLI_DISABLE_SAFETY_FILTERING, '1')
})

// 还原环境
for (const k of ENV_KEYS) {
  if (saved.get(k) === undefined) delete process.env[k]
  else process.env[k] = saved.get(k)
}

if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项`)
  process.exit(1)
}
console.log('\nOK: A2 代理动态发现全绿')

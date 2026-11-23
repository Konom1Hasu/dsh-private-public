// 会话串行槽（D5）：同会话同一时刻只放一条 stream，其余排队；
// 排队期被中止必须当场摘队并抛 ABORTED —— 否则槽变僵尸锁，后面的请求全饿死。
import assert from 'node:assert'
import { StreamGate, abortError } from './lib/index.js'

let pass = 0, fail = 0
async function test(label, fn) {
  try { await fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

await test('空闲时立刻拿到锁', async () => {
  const g = new StreamGate()
  const r = await g.acquire('A')
  assert.equal(typeof r, 'function')
  assert.equal(g.stats('A').held, true)
  r()
  assert.equal(g.stats('A').held, false)
})

await test('同 key 第二个排队，第一个释放后过继给它', async () => {
  const g = new StreamGate()
  const r1 = await g.acquire('A')
  let second = null
  const p2 = g.acquire('A').then((r) => { second = r; return r })
  assert.equal(g.stats('A').queued, 1)
  assert.equal(second, null, '第二个不该立刻拿到锁')
  r1()
  await p2
  assert.equal(typeof second, 'function', '第一个释放后第二个该拿到')
  assert.equal(g.stats('A').queued, 0)
  second()
  assert.equal(g.stats('A').held, false, '全释放后锁不该残留')
})

await test('不同 key 互不阻塞', async () => {
  const g = new StreamGate()
  const ra = await g.acquire('A')
  const rb = await g.acquire('B') // 不该卡住
  assert.equal(typeof rb, 'function')
  ra(); rb()
})

await test('排队中被中止：当场出队 + 抛 ABORTED，不留僵尸', async () => {
  const g = new StreamGate()
  const r1 = await g.acquire('A')
  const ac = new AbortController()
  const p2 = g.acquire('A', ac.signal)
  assert.equal(g.stats('A').queued, 1)
  ac.abort()
  await assert.rejects(p2, (e) => e?.code === 'ABORTED')
  assert.equal(g.stats('A').queued, 0, '被中止的请求必须从队列里摘掉')
  // 队列干净了，释放后锁要正常回收
  r1()
  assert.equal(g.stats('A').held, false)
})

await test('重复释放幂等（finally 里多调一次不会把别人的锁放掉）', async () => {
  const g = new StreamGate()
  const r1 = await g.acquire('A')
  const r2p = g.acquire('A')
  r1(); r1() // 第二次是空操作
  const r2 = await r2p
  assert.equal(typeof r2, 'function')
  assert.equal(g.stats('A').held, true, '锁已被第二个人持有')
  r2()
  assert.equal(g.stats('A').held, false)
})

await test('已 abort 的 signal 直接拒，不进队列', async () => {
  const g = new StreamGate()
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(g.acquire('A', ac.signal), (e) => e?.code === 'ABORTED')
  assert.equal(g.stats('A').queued, 0)
  assert.equal(g.stats('A').held, false)
})

await test('abortError 带 ABORTED 码', async () => {
  const e = abortError()
  assert.equal(e.code, 'ABORTED')
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

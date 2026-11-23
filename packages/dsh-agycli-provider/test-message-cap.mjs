// 消息条数轮换判据：agy 单会话消息过 ~500 会卡死。
// 轮数判据兜不住它 —— 工具密集时一轮 turn 能带好几条 message，200 轮可能已攒几千条。
import assert from 'node:assert'
import { AgyCliAdapter, MAX_SESSION_MESSAGES } from './lib/index.js'

let pass = 0, fail = 0
function test(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

function makeAdapter() {
  return new AgyCliAdapter({ cwd: 'C:/fake', seed: false, persistBindings: false, clientFactory: () => ({}) })
}

test('阈值低于 500 硬顶，留出余量', () => {
  assert.ok(MAX_SESSION_MESSAGES < 500, `阈值 ${MAX_SESSION_MESSAGES} 太贴 500`)
  assert.ok(MAX_SESSION_MESSAGES >= 200, '阈值太低会让正常长会话频繁换')
})

test('撞到上限就轮换，理由为 messages-cap', () => {
  const a = makeAdapter()
  const d = a._rotateDecision({ turns: 3, usageUsed: 1000 }, MAX_SESSION_MESSAGES)
  assert.equal(d.rotate, true, '没触发轮换')
  assert.equal(d.reason, 'messages-cap')
})

test('超过上限一截也还轮换（不是只等于才触发）', () => {
  const a = makeAdapter()
  const d = a._rotateDecision({ turns: 3, usageUsed: 1000 }, MAX_SESSION_MESSAGES + 250)
  assert.equal(d.rotate, true)
  assert.equal(d.reason, 'messages-cap')
})

test('刚到上限下一条不轮换', () => {
  const a = makeAdapter()
  const d = a._rotateDecision({ turns: 3, usageUsed: 1000 }, MAX_SESSION_MESSAGES - 1)
  assert.equal(d.rotate, false, '没到上限不该换')
})

test('消息数很低时仍走原有的轮数/token 判据', () => {
  const a = makeAdapter()
  // 轮数撞顶（默认 200）还是要换
  const d = a._rotateDecision({ turns: 200, usageUsed: 1000 }, 10)
  assert.equal(d.rotate, true)
  assert.equal(d.reason, 'turns')
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

// 会话死锁识别：agy 单会话约 469 步后会永久 502 "The model is currently unreachable"。
// 这类错误重试同一个会话只会原地卡死，必须标记脏让下一轮走 session/new 重建。
import assert from 'node:assert'
import { NoticeFilter, DEAD_SESSION_CODES } from './lib/index.js'

let pass = 0, fail = 0
function test(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

function feed(text) {
  const f = new NoticeFilter()
  const out = f.push(text.endsWith('\n') ? text : text + '\n')
  const tail = f.flush()
  return [...(out.notices ?? []), ...(tail.notices ?? [])]
}

test('识别 unreachable 死锁并归为 DEAD_SESSION', () => {
  const notices = feed('⚠ API error: The model is currently unreachable')
  const dead = notices.find((n) => n.code === 'DEAD_SESSION')
  assert.ok(dead, `没识别成 DEAD_SESSION，实际: ${JSON.stringify(notices)}`)
})

test('DEAD_SESSION 在强制轮换名单里', () => {
  assert.ok(DEAD_SESSION_CODES.has('DEAD_SESSION'))
})

test('普通 429 仍是可重试的 RATE_LIMIT，不能被当成死锁', () => {
  const notices = feed('⚠ API error 429 Too Many Requests')
  const hit = notices.find((n) => n.code === 'RATE_LIMIT')
  assert.ok(hit, '没识别成 RATE_LIMIT')
  assert.ok(!DEAD_SESSION_CODES.has('RATE_LIMIT'), '限流不该触发会话重建')
})

test('正常正文不会被当成错误', () => {
  const notices = feed('我读完了三个文件，没发现问题')
  assert.equal(notices.length, 0, `误伤: ${JSON.stringify(notices)}`)
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

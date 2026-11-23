// 增量算空导致"模型只收到一团空气"的回归守卫。
// 场景：重连重试 / syncedMsgsCount 已追平 / 上一轮记了数却没发出去 → delta 为空 →
// 空 prompt 发过去，模型只能说"没看到你说什么"，还会把计数继续推进吞掉下一条。
import assert from 'node:assert'
import { renderPrompt, lastUserTurn, deltaMessages } from './lib/index.js'

let pass = 0, fail = 0
function test(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

const u = (t) => ({ role: 'user', content: t })
const a = (t) => ({ role: 'assistant', content: t })

test('增量为空时，最后一条用户消息能被捞回来', () => {
  const messages = [u('第一句'), a('收到'), u('agycli渠道呢')]
  const picked = lastUserTurn(messages)
  assert.equal(picked.length, 1)
  assert.equal(picked[0].content, 'agycli渠道呢')
})

test('捞回来的消息真的能渲染出非空 prompt', () => {
  const picked = lastUserTurn([u('第一句'), a('收到'), u('agycli渠道呢')])
  const text = renderPrompt({ messages: picked })
  assert.ok(text.trim().length > 0, '兜底后还是空 prompt')
  assert.ok(text.includes('agycli渠道呢'))
})

test('syncedMsgsCount 追平 messages 时，delta 为空、兜底生效', () => {
  const messages = [u('第一句'), a('收到'), u('第二句')]
  const binding = { syncedMsgsCount: messages.length, lastReply: '' }
  const { delta } = deltaMessages({ messages }, binding)
  assert.equal(delta.length, 0, '这个前提没成立，测试本身失效')
  const fallback = lastUserTurn(messages)
  assert.ok(renderPrompt({ messages: fallback }).includes('第二句'))
})

test('拿不到任何用户消息时返回空数组（让上层报错而不是瞎发）', () => {
  assert.deepEqual(lastUserTurn([a('只有助手的话')]), [])
  assert.deepEqual(lastUserTurn([]), [])
})

test('空 prompt 一定被识别（trim 后为空）', () => {
  const text = renderPrompt({ messages: [] })
  assert.equal(text.trim(), '', '空消息竟然拼出了内容')
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

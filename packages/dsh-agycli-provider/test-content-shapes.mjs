// 用户消息凭空消失（"只丢了一团空气过来"）的回归：
// DSH 的 content 结构一直在变，任何取不到文本的形态都必须有兜底，绝不能静默跳过。
import assert from 'node:assert'
import { renderPrompt, MAX_PROMPT_BYTES } from './lib/index.js'

let pass = 0, fail = 0
function test(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

const render = (messages, opts) => renderPrompt({ messages }, opts ?? {})

test('最常见的字符串 content', () => {
  assert.ok(render([{ role: 'user', content: 'agycli渠道呢' }]).includes('agycli渠道呢'))
})

test('单 block 对象（历史踩过的形态）', () => {
  assert.ok(render([{ role: 'user', content: { type: 'text', text: 'agycli渠道呢' } }]).includes('agycli渠道呢'))
})

test('block 数组', () => {
  const t = render([{ role: 'user', content: [{ type: 'text', text: 'agycli渠道呢' }] }])
  assert.ok(t.includes('agycli渠道呢'))
})

test('未知 type 但带 text —— 以前会被 default 吞掉', () => {
  assert.ok(render([{ role: 'user', content: { type: 'mystery_block', text: 'agycli渠道呢' } }]).includes('agycli渠道呢'))
})

test('外面多包一层 blocks', () => {
  const t = render([{ role: 'user', content: { blocks: [{ type: 'text', text: 'agycli渠道呢' }] } }])
  assert.ok(t.includes('agycli渠道呢'))
})

test('外面多包一层 parts', () => {
  const t = render([{ role: 'user', content: { parts: [{ type: 'text', text: 'agycli渠道呢' }] } }])
  assert.ok(t.includes('agycli渠道呢'))
})

test('嵌套 content.content', () => {
  const t = render([{ role: 'user', content: { content: { type: 'text', text: 'agycli渠道呢' } } }])
  assert.ok(t.includes('agycli渠道呢'))
})

test('完全不认识的形态也不会变成空气', () => {
  const t = render([{ role: 'user', content: { weird: 'agycli渠道呢' } }])
  assert.ok(t.includes('agycli渠道呢'), `兜底没生效，实际: ${JSON.stringify(t)}`)
})

test('取不到文本时会回调诊断，且带原始结构', () => {
  const seen = []
  render([{ role: 'user', content: null }], { onEmptyMessage: (info) => seen.push(info) })
  assert.equal(seen.length, 1, '应当回调一次')
  assert.equal(seen[0].role, 'user')
})

test('正常消息不触发诊断回调', () => {
  const seen = []
  render([{ role: 'user', content: '你好' }], { onEmptyMessage: (info) => seen.push(info) })
  assert.equal(seen.length, 0)
})

test('字节顶仍然生效（没被兜底破坏）', () => {
  const long = '喵'.repeat(200000)
  const t = render([{ role: 'user', content: long }])
  assert.ok(Buffer.byteLength(t, 'utf8') <= MAX_PROMPT_BYTES, '超出字节顶')
  assert.ok(t.startsWith('User: '), '不该把 role 标签切掉')
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

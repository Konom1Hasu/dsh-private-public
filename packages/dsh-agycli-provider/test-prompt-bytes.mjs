// prompt 包体积的双顶守护：字符顶（agy 65,000 字符线）+ 字节顶（ACP 请求体 192KB 硬墙）。
// 中文一字 3 字节，只守字符会写出 180KB 的包，再叠一张图就被底层挡回来。
import assert from 'node:assert'
import { renderPrompt, MAX_PROMPT_CHARS, MAX_PROMPT_BYTES } from './lib/index.js'

let pass = 0, fail = 0
function test(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

const bytes = (s) => Buffer.byteLength(s, 'utf8')
const msg = (role, text) => ({ role, content: text })

test('英文长历史：字符顶兜住', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', 'a'.repeat(3000)))
  const text = renderPrompt({ messages })
  assert.ok(text.length <= MAX_PROMPT_CHARS, `字符超顶: ${text.length}`)
  assert.ok(bytes(text) <= MAX_PROMPT_BYTES, `字节超顶: ${bytes(text)}`)
})

test('中文长历史：字节顶兜住（这是原来会撞 192KB 的那条）', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', '喵'.repeat(3000)))
  const text = renderPrompt({ messages })
  // 39 万字节的中文原始输入，必须压进字节预算
  assert.ok(bytes(text) <= MAX_PROMPT_BYTES, `字节超顶: ${bytes(text)}`)
})

test('图片占了字节预算时，正文要相应让路', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', '喵'.repeat(3000)))
  const reserve = 120_000 // 一张 90KB 的图转 base64 后大约这个量级
  const text = renderPrompt({ messages }, { reserveBytes: reserve })
  assert.ok(bytes(text) + reserve <= MAX_PROMPT_BYTES, `正文+图超顶: ${bytes(text) + reserve}`)
})

test('截断不切断多字节字符（半个汉字会让 JSON 变形）', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg('user', '喵'.repeat(3000)))
  const text = renderPrompt({ messages })
  // 能正常 decode 回字符串就说明没切碎字节
  assert.ok(!text.includes('\ufffd'), '出现替换字符，说明切断了多字节字符')
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text)
})

test('小对话原样保留，不做无谓截断', () => {
  const messages = [msg('user', '你好喵'), msg('assistant', '在呢'), msg('user', '读个文件')]
  const text = renderPrompt({ messages })
  assert.ok(text.includes('你好喵') && text.includes('读个文件'), '短对话被削了')
})

test('system 不占正文预算（它走 systemPromptAppend）', () => {
  const messages = [msg('system', '很长的系统提示'.repeat(100)), msg('user', '你好')]
  const text = renderPrompt({ messages })
  assert.ok(!text.includes('很长的系统提示'), 'system 混进正文了')
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

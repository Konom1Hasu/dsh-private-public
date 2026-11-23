// agyacp 协议层三条硬坑的回归：
//  ① 系统回执续写熔断（正文里自导自演 "Background subagent ... finished" 后接真 tool_call）
//  ② 重建历史时远古截图不能被当成本轮新图重发
//  ③ 熔断后权限一律拒（否则模型自说自话就把盘改了）
import assert from 'node:assert'
import { detectSystemEcho } from './lib/index.js'

let pass = 0, fail = 0
function test(label, fn) {
  try { fn(); pass++; console.log(`  ok   ${label}`) }
  catch (e) { fail++; console.log(`  FAIL ${label}: ${e?.message}`) }
}

// ---- ① 熔断句式识别 ----
test('识别 Background subagent 完成回执', () => {
  assert.ok(detectSystemEcho('Background subagent explorer finished'))
  assert.ok(detectSystemEcho('  Background subagent #2 completed.  '))
})

test('识别 [assistant] / [user] 角色标签自续', () => {
  assert.ok(detectSystemEcho('[assistant]'))
  assert.ok(detectSystemEcho('  [user]  '))
})

test('识别 USER_REQUEST 与系统回执标签', () => {
  assert.ok(detectSystemEcho('</USER_REQUEST>'))
  assert.ok(detectSystemEcho('<USER_REQUEST>'))
  assert.ok(detectSystemEcho('</tool_result>'))
  assert.ok(detectSystemEcho('<function_calls>'))
})

test('正常正文不误伤', () => {
  assert.equal(detectSystemEcho('我读完了文件，发现三个问题喵'), null)
  assert.equal(detectSystemEcho('The subagent design is documented here'), null)
  assert.equal(detectSystemEcho('assistant 这个角色在对话里'), null)
  assert.equal(detectSystemEcho(''), null)
  assert.equal(detectSystemEcho(null), null)
})

test('多行里只有一行命中也能抓到', () => {
  const text = '先说明一下\nBackground subagent reviewer finished\n然后我要改个文件'
  assert.ok(detectSystemEcho(text))
})

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'}: ${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exit(1)

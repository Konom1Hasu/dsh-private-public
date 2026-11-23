// A4 验收：隔离 home 幂等播种（目录树 / 配置形状 / gate-tools 行为 / 原子写 / 不残留 tmp）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import {
  ensureIsolatedGeminiDir,
  buildHooksJson,
  writeIfChangedSync,
  DSH_BRIDGE_AGENT_MD,
} from './lib/isolated-home.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-seed-'))
const home = path.join(root, 'home')
let failures = 0

function test(name, fn) {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (e) {
    failures += 1
    console.error(`FAIL  ${name}\n      ${e?.message ?? e}`)
  }
}
const rel = (p) => path.join(home, p)
const read = (p) => fs.readFileSync(rel(p), 'utf8')

// ---- 首次播种 ----
const first = ensureIsolatedGeminiDir(home)

test('首播返回全部 written', () => {
  assert.equal(first.home, path.resolve(home))
  assert.equal(first.unchanged.length, 0)
  assert.equal(first.written.length, 11, `written=${first.written.length} ${first.written.join(',')}`)
})

test('目录树齐全（含 conversations 落点）', () => {
  const dirs = [
    'config', 'config/agents', 'config/hooks', 'config/projects',
    'config/plugins/dsh_bridge', 'config/plugins/dsh_bridge/agents',
    'antigravity-cli', 'antigravity-cli/cache', 'antigravity-cli/conversations',
    'agy', 'agy/cache', 'agy/conversations',
  ]
  for (const d of dirs) assert.ok(fs.statSync(rel(d)).isDirectory(), `缺目录 ${d}`)
})

test('dsh_bridge.md 双路径存在且无 tools: []', () => {
  for (const p of ['config/agents/dsh_bridge.md', 'config/plugins/dsh_bridge/agents/dsh_bridge.md']) {
    const body = read(p)
    assert.ok(!/^\s*tools\s*:/m.test(body), `${p} 出现了 tools: 字段`)
    assert.match(body, /^description: .+$/m, `${p} 缺 description`)
    assert.match(body, /^inheritMcp: true$/m)
    assert.match(body, /^mainAgent: true$/m)
    assert.match(body, /^subagent: false$/m)
    assert.match(body, /^excludeDefaultComponents: true$/m)
    for (const k of ['skills', 'rules', 'agents', 'plugins']) {
      assert.match(body, new RegExp(`^${k}: \\[\\]$`, 'm'), `${p} 缺 ${k}: []`)
    }
    assert.equal(body, DSH_BRIDGE_AGENT_MD)
  }
})

test('plugin.json / settings.json / onboarding / project 形状正确', () => {
  assert.deepEqual(JSON.parse(read('config/plugins/dsh_bridge/plugin.json')), { name: 'dsh_bridge' })

  for (const p of ['antigravity-cli/settings.json', 'agy/settings.json']) {
    assert.deepEqual(JSON.parse(read(p)), {
      contextWindow: '900K',
      toolPermission: 'request-review',
      agentMode: '',
    }, p)
  }

  for (const p of ['antigravity-cli/cache/onboarding.json', 'agy/cache/onboarding.json']) {
    assert.deepEqual(JSON.parse(read(p)), {
      consumerOnboardingComplete: true,
      enterpriseOnboardingComplete: false,
      onboardingComplete: true,
    }, p)
  }

  assert.deepEqual(JSON.parse(read('config/projects/default-cli-project.json')), {
    id: 'default-cli-project',
    name: 'CLI Project',
    projectResources: {},
  })
})

test('hooks.json 是具名组且命令路径全正斜杠', () => {
  for (const p of ['config/hooks.json', 'antigravity-cli/hooks.json']) {
    const obj = JSON.parse(read(p))
    assert.deepEqual(Object.keys(obj), ['gate-tools'], `${p} 顶层不是具名组`)
    assert.ok(Array.isArray(obj['gate-tools'].PreToolUse))
    const hook = obj['gate-tools'].PreToolUse[0]
    assert.equal(hook.matcher, '.*')
    assert.equal(hook.hooks[0].type, 'command')
    assert.equal(hook.hooks[0].timeout, 5)
    const cmd = hook.hooks[0].command
    assert.ok(!cmd.includes('\\'), `命令路径含反斜杠: ${cmd}`)
    assert.ok(cmd.includes('/config/hooks/gate-tools.cjs'), cmd)
  }
  // 两份必须同字节
  assert.equal(read('config/hooks.json'), read('antigravity-cli/hooks.json'))
  assert.equal(read('antigravity-cli/settings.json'), read('agy/settings.json'))
  assert.equal(read('antigravity-cli/cache/onboarding.json'), read('agy/cache/onboarding.json'))
  assert.equal(buildHooksJson(path.resolve(home)), read('config/hooks.json'))
})

test('gate-tools.cjs：mcp_dsh_read 放行，run_command 拒绝', () => {
  const cjs = rel('config/hooks/gate-tools.cjs')
  const run = (payload) => {
    const r = spawnSync(process.execPath, [cjs], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 20_000,
    })
    assert.equal(r.status, 0, `hook exit=${r.status} stderr=${r.stderr}`)
    const line = String(r.stdout).trim().split('\n').filter(Boolean).pop()
    return JSON.parse(line)
  }
  assert.equal(run({ toolCall: { name: 'mcp_dsh_read' } }).decision, 'allow')
  assert.equal(run({ toolCall: { name: 'mcp_dsh_dsh_await_result' } }).decision, 'allow')
  const denied = run({ toolCall: { name: 'run_command' } })
  assert.equal(denied.decision, 'deny')
  assert.match(denied.reason, /Built-in tool disabled/)
  assert.equal(run({ tool_name: 'read_file' }).decision, 'deny')
})

// ---- 幂等：第二次不重写 ----
const watched = [
  'config/agents/dsh_bridge.md',
  'config/plugins/dsh_bridge/agents/dsh_bridge.md',
  'config/plugins/dsh_bridge/plugin.json',
  'config/hooks.json',
  'antigravity-cli/hooks.json',
  'config/hooks/gate-tools.cjs',
  'antigravity-cli/settings.json',
  'agy/settings.json',
  'antigravity-cli/cache/onboarding.json',
  'agy/cache/onboarding.json',
  'config/projects/default-cli-project.json',
]
const before = new Map(watched.map((p) => [p, fs.statSync(rel(p)).mtimeMs]))
const beforeInodes = new Map(watched.map((p) => [p, fs.statSync(rel(p)).ino]))
// 让 mtime 有机会变化（Windows mtime 精度 ~ 毫秒级，保险起见等 30ms）
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
wait(30)
const second = ensureIsolatedGeminiDir(home)

test('第二次播种 written=0、mtime 与 inode 均未变', () => {
  assert.deepEqual(second.written, [], `第二次仍写了 ${second.written.join(',')}`)
  assert.equal(second.unchanged.length, watched.length)
  assert.deepEqual(second.createdDirs, [], `第二次仍建了 ${second.createdDirs.join(',')}`)
  for (const p of watched) {
    assert.equal(fs.statSync(rel(p)).mtimeMs, before.get(p), `${p} mtime 被动了`)
    assert.equal(fs.statSync(rel(p)).ino, beforeInodes.get(p), `${p} 被替换了（inode 变了）`)
  }
})

test('内容漂移才重写（只写那一份）', () => {
  fs.writeFileSync(rel('agy/settings.json'), '{"contextWindow":"256K"}\n', 'utf8')
  const third = ensureIsolatedGeminiDir(home)
  assert.deepEqual(third.written, ['agy/settings.json'])
  assert.equal(JSON.parse(read('agy/settings.json')).contextWindow, '900K')
})

test('tmp 文件不残留', () => {
  const leftovers = []
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(abs)
      else if (ent.name.endsWith('.tmp') || ent.name.includes('.tmp.')) leftovers.push(abs)
    }
  }
  walk(home)
  assert.deepEqual(leftovers, [])
})

// ---- 原子写本身的行为 ----
test('writeIfChangedSync：同内容不写、不同内容原子替换、不留 tmp', () => {
  const f = path.join(root, 'atomic.json')
  assert.equal(writeIfChangedSync(f, 'a\n'), 'written')
  const m1 = fs.statSync(f).mtimeMs
  const i1 = fs.statSync(f).ino
  wait(20)
  assert.equal(writeIfChangedSync(f, 'a\n'), 'unchanged')
  assert.equal(fs.statSync(f).mtimeMs, m1)
  assert.equal(fs.statSync(f).ino, i1)
  assert.equal(writeIfChangedSync(f, 'b\n'), 'written')
  assert.equal(fs.readFileSync(f, 'utf8'), 'b\n')
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('.tmp')), [])
})

test('空 home 抛 TypeError（不静默乱播种）', () => {
  assert.throws(() => ensureIsolatedGeminiDir(''), TypeError)
  assert.throws(() => ensureIsolatedGeminiDir(null), TypeError)
})

// 清理
fs.rmSync(root, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nFAILED: ${failures} 项`)
  process.exit(1)
}
console.log('\nOK: A4 播种全绿')

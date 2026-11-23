// 离线单测：lib/binding-store.mjs（绑定持久化）。不碰网络、不拉 agy 子进程。
// 覆盖：落盘后重载能取回 / 坏 JSON 容忍 / 超 200 条淘汰最久未用 / flush 强制落盘 /
//       tmp 文件不残留 / 脏条目被丢弃 / close 收尾落盘。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersistedBindingStore, defaultBindingPath, MAX_PERSISTED_BINDINGS } from './lib/binding-store.mjs'

let pass = 0
const failures = []

async function test(label, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures.push({ label, e })
    console.log(`  FAIL ${label}\n       ${e?.message ?? e}`)
  }
}

const dirs = []
function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-agycli-${tag}-`))
  dirs.push(dir)
  return dir
}

function entry(agySessionId, extra = {}) {
  return {
    agySessionId,
    systemHash: 'sys-abc',
    syncedMsgsCount: 12,
    prefixHash: 'pre-xyz',
    modelId: 'gemini-3.8-flash-high',
    provider: 'agycli',
    ...extra,
  }
}

function readFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

try {
  console.log('binding-store')

  await test('落盘后重新 load 能取回全部字段', () => {
    const dir = tmpDir('roundtrip')
    const file = path.join(dir, 'bindings.json')
    const a = new PersistedBindingStore({ file })
    a.set('h:aaa', entry('sess-1'))
    assert.equal(a.flush(), true)
    assert.equal(fs.existsSync(file), true)

    const b = new PersistedBindingStore({ file })
    b.load()
    assert.equal(b.size, 1)
    const got = b.get('h:aaa')
    assert.deepEqual(
      { ...got, updatedAt: 0 },
      {
        agySessionId: 'sess-1',
        systemHash: 'sys-abc',
        syncedMsgsCount: 12,
        prefixHash: 'pre-xyz',
        modelId: 'gemini-3.8-flash-high',
        provider: 'agycli',
        turns: 0,
        updatedAt: 0,
      },
    )
    assert.deepEqual(b.keys(), ['h:aaa'])
  })

  await test('坏 JSON 容忍回落成空表且不抛', () => {
    const dir = tmpDir('badjson')
    const file = path.join(dir, 'bindings.json')
    fs.writeFileSync(file, '{"version":1,"bindings":[{"key":"h:x"', 'utf8')
    const s = new PersistedBindingStore({ file })
    assert.equal(s.load(), s)
    assert.equal(s.size, 0)
    assert.ok(s.lastLoadError instanceof Error)
    assert.equal(s.get('h:x'), null)

    // 形状完全不对（数字）同样不抛
    fs.writeFileSync(file, '42', 'utf8')
    const s2 = new PersistedBindingStore({ file })
    s2.load()
    assert.equal(s2.size, 0)
  })

  await test('缺文件 load 静默回落（ENOENT 不算错误）', () => {
    const dir = tmpDir('missing')
    const s = new PersistedBindingStore({ file: path.join(dir, 'nope', 'bindings.json') })
    s.load()
    assert.equal(s.size, 0)
    assert.equal(s.lastLoadError, null)
  })

  await test('超 200 条淘汰最久未用，且淘汰后立刻落盘', () => {
    const dir = tmpDir('lru')
    const file = path.join(dir, 'bindings.json')
    const s = new PersistedBindingStore({ file, flushDelayMs: 60_000 }) // 定时器不参与，只看淘汰触发的写盘
    for (let i = 0; i < MAX_PERSISTED_BINDINGS; i += 1) s.set(`k${i}`, entry(`sess-${i}`))
    assert.equal(s.size, MAX_PERSISTED_BINDINGS)

    // 把 k0 提成最近使用 → 最旧的变成 k1
    assert.ok(s.get('k0'))
    s.set('k200', entry('sess-200'))

    assert.equal(s.size, MAX_PERSISTED_BINDINGS)
    assert.equal(s.has('k1'), false, 'k1 应被淘汰')
    assert.equal(s.has('k0'), true, '被 get 过的 k0 不该淘汰')
    assert.equal(s.has('k200'), true)

    const onDisk = readFile(file)
    assert.equal(onDisk.bindings.length, MAX_PERSISTED_BINDINGS)
    assert.equal(onDisk.bindings.some((b) => b.key === 'k1'), false)
    assert.equal(onDisk.bindings.at(-1).key, 'k200')
    assert.deepEqual(s.keys().slice(-2), ['k0', 'k200'])
  })

  await test('flush 强制落盘，tmp 文件不残留', () => {
    const dir = tmpDir('flush')
    const file = path.join(dir, 'nested', 'bindings.json')
    const s = new PersistedBindingStore({ file, flushDelayMs: 60_000 })
    s.set('h:one', entry('sess-flush'))
    assert.equal(fs.existsSync(file), false, 'dirty 未 flush 前不该有文件')

    assert.equal(s.flush(), true)
    assert.equal(fs.existsSync(file), true)
    const onDisk = readFile(file)
    assert.equal(onDisk.bindings.length, 1)
    assert.equal(onDisk.bindings[0].agySessionId, 'sess-flush')

    const leftovers = fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['bindings.json'])
  })

  await test('脏条目被丢弃：缺 agySessionId / 非对象 / 类型不对', () => {
    const dir = tmpDir('dirty')
    const file = path.join(dir, 'bindings.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bindings: [
          { key: 'h:good', ...entry('sess-good') },
          { key: 'h:no-session', systemHash: 'x', syncedMsgsCount: 3 },
          { key: 'h:bad-session', agySessionId: 12345 },
          { key: 'h:empty-session', agySessionId: '   ' },
          'not-an-object',
          { agySessionId: 'sess-nokey' },
        ],
      }),
      'utf8',
    )
    const s = new PersistedBindingStore({ file })
    s.load()
    assert.equal(s.size, 1)
    assert.deepEqual(s.keys(), ['h:good'])
    const got = s.get('h:good')
    assert.equal(got.agySessionId, 'sess-good')
    assert.equal(got.syncedMsgsCount, 12)
  })

  await test('脏字段回落成安全默认值而不是整条丢掉', () => {
    const dir = tmpDir('coerce')
    const file = path.join(dir, 'bindings.json')
    fs.writeFileSync(
      file,
      JSON.stringify({ bindings: [{ key: 'h:x', agySessionId: 'sess-x', syncedMsgsCount: -5, systemHash: 9, modelId: '', turns: 'abc' }] }),
      'utf8',
    )
    const s = new PersistedBindingStore({ file })
    s.load()
    const got = s.get('h:x')
    assert.equal(got.syncedMsgsCount, 0)
    assert.equal(got.systemHash, '')
    assert.equal(got.modelId, null)
    assert.equal(got.turns, 0)
  })

  await test('delete / size / keys 行为', () => {
    const dir = tmpDir('crud')
    const s = new PersistedBindingStore({ file: path.join(dir, 'bindings.json'), flushDelayMs: 0 })
    s.set('a', entry('sa'))
    s.set('b', entry('sb'))
    assert.equal(s.size, 2)
    assert.deepEqual(s.keys(), ['a', 'b'])
    assert.equal(s.delete('a'), true)
    assert.equal(s.delete('a'), false)
    assert.equal(s.size, 1)
    assert.equal(s.set('', entry('nope')), null, '空 key 拒绝')
    assert.equal(s.set('c', { systemHash: 'x' }), null, '缺 agySessionId 拒绝')
  })

  await test('flush 失败不抛（目录不可写时降级），错误留在 lastWriteError', () => {
    const dir = tmpDir('readonly')
    const file = path.join(dir, 'bindings.json')
    fs.writeFileSync(file, 'x', 'utf8')
    const s = new PersistedBindingStore({ file })
    s.set('h:x', entry('sess'))
    // 把 file 换成一个目录，rename 必然失败
    fs.rmSync(file, { force: true })
    fs.mkdirSync(file)
    assert.equal(s.flush(), false)
    assert.ok(s.lastWriteError instanceof Error)
    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
  })

  await test('close() 把未落盘的 dirty 内容刷下去', () => {
    const dir = tmpDir('close')
    const file = path.join(dir, 'bindings.json')
    const s = new PersistedBindingStore({ file, flushDelayMs: 60_000 })
    s.set('h:last', entry('sess-last'))
    assert.equal(fs.existsSync(file), false)
    assert.equal(s.close(), true)
    assert.equal(readFile(file).bindings[0].agySessionId, 'sess-last')
  })

  await test('agySessionId 前后空白被 trim，key 也 trim', () => {
    const dir = tmpDir('trim')
    const file = path.join(dir, 'bindings.json')
    const s = new PersistedBindingStore({ file, flushDelayMs: 0 })
    s.set('  h:padded  ', entry('  sess-padded  '))
    assert.deepEqual(s.keys(), ['h:padded'])
    assert.equal(s.get('h:padded').agySessionId, 'sess-padded')
    assert.equal(readFile(file).bindings[0].agySessionId, 'sess-padded')
  })

  await test('load 失败后首次写盘把原文件留成 .bad，不直接覆盖', () => {
    const dir = tmpDir('preserve')
    const file = path.join(dir, 'bindings.json')
    fs.writeFileSync(file, '{broken json', 'utf8')
    const s = new PersistedBindingStore({ file, flushDelayMs: 0 })
    s.load()
    assert.equal(s.size, 0)
    s.set('h:new', entry('sess-new'))
    assert.equal(fs.existsSync(`${file}.bad`), true, '坏文件应被留档')
    assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{broken json')
    assert.equal(readFile(file).bindings[0].agySessionId, 'sess-new')
  })

  await test('close() 之后继续 set 仍会落盘（不静默丢）', () => {
    const dir = tmpDir('afterclose')
    const file = path.join(dir, 'bindings.json')
    const s = new PersistedBindingStore({ file, flushDelayMs: 0 })
    s.set('a', entry('sa'))
    s.close()
    s.set('b', entry('sb'))
    assert.deepEqual(readFile(file).bindings.map((b) => b.key), ['a', 'b'])
  })

  await test('load 期裁剪超量条目会触发 onEvict', () => {
    const dir = tmpDir('evictload')
    const file = path.join(dir, 'bindings.json')
    const bindings = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, ...entry(`s${i}`) }))
    fs.writeFileSync(file, JSON.stringify({ bindings }), 'utf8')
    const evicted = []
    const s = new PersistedBindingStore({ file, maxBindings: 3, onEvict: (k) => evicted.push(k), flushDelayMs: 60_000 })
    s.load()
    assert.equal(s.size, 3)
    assert.deepEqual(evicted, ['k0', 'k1'])
    assert.deepEqual(s.keys(), ['k2', 'k3', 'k4'])
  })

  await test('带 BOM 的文件仍能 load（不算坏文件）', () => {
    const dir = tmpDir('bom')
    const file = path.join(dir, 'bindings.json')
    fs.writeFileSync(file, `\uFEFF${JSON.stringify({ version: 1, bindings: [{ key: 'h:bom', ...entry('sess-bom') }] })}`, 'utf8')
    const s = new PersistedBindingStore({ file, flushDelayMs: 0 })
    s.load()
    assert.equal(s.size, 1)
    assert.equal(s.get('h:bom').agySessionId, 'sess-bom')
    assert.equal(s.lastLoadError, null)
  })

  await test('.bad 已存在时再留档不炸（覆盖旧的 .bad）', () => {
    const dir = tmpDir('bad2')
    const file = path.join(dir, 'bindings.json')
    fs.writeFileSync(`${file}.bad`, 'older backup', 'utf8')
    fs.writeFileSync(file, '{broken again', 'utf8')
    const s = new PersistedBindingStore({ file, flushDelayMs: 0 })
    s.load()
    s.set('h:z', entry('sess-z'))
    assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{broken again')
    assert.equal(readFile(file).bindings[0].agySessionId, 'sess-z')
  })

  await test('默认路径在 cwd 下的 .dsh-agycli（不是 os.tmpdir）', () => {
    const def = defaultBindingPath('/some/project')
    assert.equal(def, path.join('/some/project', '.dsh-agycli', 'bindings.json'))
    const s = new PersistedBindingStore()
    assert.equal(s.file, path.join(process.cwd(), '.dsh-agycli', 'bindings.json'))
    assert.equal(s.maxBindings, MAX_PERSISTED_BINDINGS)
    assert.equal(MAX_PERSISTED_BINDINGS, 200)
  })
} finally {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1

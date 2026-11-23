// lib/binding-store.mjs —— 会话绑定持久化（教程 §3.3「会话绑定持久化（SessionBindingStore）」/ checklist B4）
//
// 现状：**本模块已实现、尚未接线。**
//   lib/index.js 里的 SessionBindingStore（内存版，条目带 client / toolsTenant 等运行时字段）
//   一行未动；这里只把「能落盘的那半张表」单独养起来。下一轮接线时由 index.js 在
//   create() / touch() / delete() 处把字段投影进来，加载时先 load()，停机时 close()。
//   所以本文件同时给默认导出与具名导出，接线时按需取。
//
// 落盘契约（版本 1）：
//   { version: 1, savedAt: <ms>, bindings: [ { key, agySessionId, systemHash,
//     syncedMsgsCount, prefixHash, modelId, provider, turns, updatedAt }, ... ] }
//   数组顺序 = LRU 顺序，越靠后越新；尾部有一个换行。
//
// 三条工程约束（照教程 / B4）：
//   - 写盘走 tmp + rename 原子替换：读侧永远看不到半截文件。没有 fsync，
//     进程/机器崩溃时可能丢最后一次写入（甚至 rename 本身），但不丢已落盘的旧版本；
//   - 容量 200 条 LRU，超了淘汰最久未用，淘汰后立刻落盘；
//   - set 不直接写盘：dirty 标记 + 节流 flush（默认 250ms，只节流不防抖——定时器已在跑
//     就不重置），另给 flush() 强制落盘与 close() 收尾。写盘失败不抛，返回 false 并把
//     错误留在 lastWriteError；dirty 保持 true，由下一次变更或显式 flush() 重试。
import fs from 'node:fs'
import path from 'node:path'

/** 教程 §3.3 的容量上限：200 条 LRU。 */
export const MAX_PERSISTED_BINDINGS = 200

/** 落盘文件版本号；读到别的版本仍按同结构尽力解析，版本号记在 fileVersion 里备用。 */
export const PERSIST_VERSION = 1

/** key 长度上限，防脏数据把文件撑大（正常 key 是 16 位 hex 或 s:<id>）。 */
export const MAX_KEY_CHARS = 512

/** load 时接受的配置文件大小上限，超过就当坏文件处理，别把启动卡在读盘上。 */
export const MAX_BINDINGS_FILE_BYTES = 8 * 1024 * 1024

/** setTimeout 上限（2^31-1）；超过会被 Node 压成 1ms，反倒变成狂写盘。 */
const MAX_TIMER_DELAY = 2_147_483_647

/**
 * 默认落盘路径：<cwd>/.dsh-agycli/bindings.json（不放 os.tmpdir()，重启才留得住）。
 * cwd 在构造时就定死——进程中途 chdir 或换启动方式会让路径漂移，
 * 生产接线请显式传 file，别吃默认值。
 */
export function defaultBindingPath(cwd = process.cwd()) {
  return path.join(cwd, '.dsh-agycli', 'bindings.json')
}

function numOr(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function strOr(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

/** key 规范化：只认非空字符串，去空白，超长直接判死。 */
function normalizeKey(key) {
  if (typeof key !== 'string') return null
  const trimmed = key.trim()
  if (!trimmed || trimmed.length > MAX_KEY_CHARS) return null
  return trimmed
}

/** 兼容 entry.key / entry.bindingKey 两种写法，空串视同没有。 */
function firstKey(entry) {
  return normalizeKey(entry?.key) ?? normalizeKey(entry?.bindingKey)
}

/**
 * 结构校验 + 字段收窄。缺 agySessionId 的一律判死（返回 null），
 * 脏字段回落成安全默认值而不是整条丢掉。
 * @param {boolean} [freshTimestamp] false 时缺 updatedAt 补 0（load 旧数据不该冒充「刚用过」）
 */
function normalizeEntry(key, value, freshTimestamp = true) {
  const normalizedKey = normalizeKey(key)
  if (!normalizedKey) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const sessionId = typeof value.agySessionId === 'string' ? value.agySessionId.trim() : ''
  if (!sessionId) return null // 校验和落盘用同一个值，别出现「校验 trim 过、存的是带空白」
  const updatedAt =
    Number.isFinite(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : freshTimestamp ? Date.now() : 0
  return {
    agySessionId: sessionId,
    systemHash: strOr(value.systemHash, ''),
    syncedMsgsCount: numOr(value.syncedMsgsCount, 0),
    prefixHash: strOr(value.prefixHash, ''),
    modelId: strOr(value.modelId, null),
    provider: strOr(value.provider, null),
    turns: numOr(value.turns, 0),
    updatedAt,
  }
}

/** 对外返回浅拷贝：内部条目被调用方原地改掉会绕过 dirty 标记，那是最难查的一类 bug。 */
function copyEntry(entry) {
  return entry ? { ...entry } : null
}

export class PersistedBindingStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 落盘路径，默认 defaultBindingPath()；测试请传临时目录
   * @param {number} [opts.maxBindings] LRU 容量，默认 200
   * @param {number} [opts.flushDelayMs] 节流写盘间隔，默认 250；0 表示每次变更立刻写
   * @param {(key: string, value: object) => void} [opts.onEvict] 淘汰回调（load 期裁剪也会触发）
   */
  constructor({ file = null, maxBindings = MAX_PERSISTED_BINDINGS, flushDelayMs = 250, onEvict = null } = {}) {
    this.file = typeof file === 'string' && file.trim() ? file : defaultBindingPath()
    this.maxBindings = Number.isFinite(maxBindings) && maxBindings > 0 ? Math.floor(maxBindings) : MAX_PERSISTED_BINDINGS
    const delay = Number.isFinite(flushDelayMs) && flushDelayMs >= 0 ? Math.floor(flushDelayMs) : 250
    this.flushDelayMs = Math.min(delay, MAX_TIMER_DELAY)
    this.onEvict = typeof onEvict === 'function' ? onEvict : null
    this.map = new Map()
    this.dirty = false
    this.flushTimer = null
    this.writeCount = 0
    this.fileVersion = null
    this.lastLoadError = null
    this.lastLoadStats = null
    this.lastWriteError = null
    this._tmpSeq = 0
    this._dirReady = false
    this._preserveOriginal = false // load 失败过：首次写盘前先把原文件留成 .bad，别直接覆盖
  }

  get size() {
    return this.map.size
  }

  /**
   * 启动时读盘。坏文件 / 缺文件 / 形状不对一律容忍并回落成空表，绝不抛。
   * 同步读盘：只该在启动路径调用一次；文件超过 MAX_BINDINGS_FILE_BYTES 直接按坏文件处理。
   * @returns {this}
   */
  load() {
    this.map.clear()
    this.lastLoadError = null
    this.lastLoadStats = null
    this.fileVersion = null
    this._preserveOriginal = false
    let raw
    try {
      const stat = fs.statSync(this.file)
      if (!stat.isFile() || stat.size > MAX_BINDINGS_FILE_BYTES) {
        this.lastLoadError = new Error(`bindings file rejected: size=${stat.size} isFile=${stat.isFile()}`)
        this._preserveOriginal = true
        return this
      }
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        this.lastLoadError = e
        this._preserveOriginal = true // 读不动 ≠ 空表：别让下一次 flush 把它盖掉
      }
      return this
    }
    let parsed
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) // Windows 编辑器常带 BOM，别把它当坏文件
    } catch (e) {
      this.lastLoadError = e
      this._preserveOriginal = true
      return this
    }
    if (Number.isFinite(parsed?.version)) this.fileVersion = parsed.version

    let list = null
    if (Array.isArray(parsed)) list = parsed
    else if (Array.isArray(parsed?.bindings)) list = parsed.bindings
    else if (parsed?.bindings && typeof parsed.bindings === 'object') {
      list = Object.entries(parsed.bindings)
        .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
        .map(([key, value]) => ({ ...value, key }))
    }
    if (!list) {
      this.lastLoadError = new Error(`unexpected bindings file shape: ${parsed === null ? 'null' : typeof parsed}`)
      this._preserveOriginal = true
      return this
    }

    let dropped = 0
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        dropped += 1
        continue
      }
      const key = firstKey(entry)
      const value = normalizeEntry(key, entry, false)
      if (!value) {
        dropped += 1
        continue
      }
      this._touch(key, value) // 重复 key：后者覆盖且占新位
    }

    const trimmed = this._evictOverflow()
    this.lastLoadStats = { total: list.length, kept: this.map.size, dropped, trimmed }
    // 丢过脏条目或裁过量：走节流写盘把文件顺便洗干净（不阻塞启动；进程若立刻退出则下次再来）
    if (dropped > 0 || trimmed > 0) this._markDirty()
    return this
  }

  /**
   * 读一条；命中即提到队尾（LRU）。顺序变化会走节流落盘，重启后才接得上「最近用过」。
   * 返回浅拷贝：要改字段请走 set()，原地改返回值不会触发落盘。
   */
  get(key) {
    const normalizedKey = normalizeKey(key)
    if (!normalizedKey) return null
    const entry = this.map.get(normalizedKey)
    if (!entry) return null
    this._touch(normalizedKey, entry)
    this._markDirty()
    return copyEntry(entry)
  }

  /**
   * 写一条。结构不合法返回 null 且不入表；成功返回规范化后的浅拷贝。
   * 超容量时淘汰最久未用并立刻落盘。
   */
  set(key, value) {
    const normalizedKey = normalizeKey(key)
    const entry = normalizeEntry(normalizedKey, value)
    if (!entry) return null
    this._touch(normalizedKey, entry)
    if (this._evictOverflow() > 0) {
      // 淘汰后立刻落盘。先置脏再写：写成功会清掉 dirty，写失败则保持 true，
      // 由下一次变更或显式 flush() 重试（内存与磁盘的容量口径在下一次成功写入时收敛）。
      this.dirty = true
      this.flush()
    } else {
      this._markDirty()
    }
    return copyEntry(entry)
  }

  /** 删一条；返回是否真删到了。 */
  delete(key) {
    const normalizedKey = normalizeKey(key)
    if (!normalizedKey || !this.map.has(normalizedKey)) return false
    this.map.delete(normalizedKey)
    this._markDirty()
    return true
  }

  has(key) {
    const normalizedKey = normalizeKey(key)
    return normalizedKey ? this.map.has(normalizedKey) : false
  }

  /** LRU 顺序的 key 列表，最旧在前。 */
  keys() {
    return [...this.map.keys()]
  }

  /** 条目浅拷贝数组，LRU 顺序。 */
  values() {
    return [...this.map.values()].map(copyEntry)
  }

  /** 落盘快照（_writeNow 与测试用）。 */
  snapshot() {
    return this.keys().map((key) => ({ key, ...this.map.get(key) }))
  }

  /** 强制落盘。返回是否写成功（失败不抛，错误留在 lastWriteError）。 */
  flush() {
    this._clearTimer()
    return this._writeNow()
  }

  /** 收尾：清定时器 + 最后强行落盘。之后仍可继续用（后续变更会重新排程写盘）。 */
  close() {
    return this.flush()
  }

  _touch(key, entry) {
    this.map.delete(key) // 先删后插：Map 保持插入序，重插即提到队尾
    this.map.set(key, entry)
  }

  /** 超容量裁剪，返回被淘汰的条数；淘汰逐条回调 onEvict。 */
  _evictOverflow() {
    let evicted = 0
    while (this.map.size > this.maxBindings) {
      const oldest = this.map.keys().next().value
      const victim = this.map.get(oldest)
      this.map.delete(oldest)
      evicted += 1
      try { this.onEvict?.(oldest, copyEntry(victim)) } catch {}
    }
    return evicted
  }

  _markDirty() {
    this.dirty = true
    if (this.flushDelayMs === 0) {
      this.flush()
      return
    }
    if (this.flushTimer) return // 只节流不防抖：定时器已经在跑就不重置
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.dirty) this._writeNow()
    }, this.flushDelayMs)
    this.flushTimer?.unref?.() // 别把宿主进程吊住
  }

  _clearTimer() {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  _writeNow() {
    const dir = path.dirname(this.file)
    const payload = `${JSON.stringify({ version: PERSIST_VERSION, savedAt: Date.now(), bindings: this.snapshot() })}\n`
    // pid + 实例内序号 + 随机后缀：同 pid 复用、同进程多实例同 file 都不会撞名
    const tmp = `${this.file}.${process.pid}.${this._tmpSeq++}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      if (!this._dirReady) {
        fs.mkdirSync(dir, { recursive: true })
        this._dirReady = true
      }
      if (this._preserveOriginal && fs.existsSync(this.file)) {
        // 坏文件先留档；留档失败就不写，宁可这次 flush 返回 false 也别把原文件冲掉
        fs.renameSync(this.file, `${this.file}.bad`)
      }
      this._preserveOriginal = false
      fs.writeFileSync(tmp, payload, 'utf8')
      fs.renameSync(tmp, this.file) // 原子替换：读侧永远看不到半截
      this.dirty = false
      this.writeCount += 1
      this.lastWriteError = null
      return true
    } catch (e) {
      this.lastWriteError = e
      if (e?.code === 'ENOENT') this._dirReady = false // 目录被删了就重建，别永久卡死
      try { fs.unlinkSync(tmp) } catch {} // tmp 不残留；dirty 保持 true，下次 flush 重试
      return false
    }
  }
}

export default PersistedBindingStore

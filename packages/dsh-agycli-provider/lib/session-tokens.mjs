// lib/session-tokens.mjs —— agy 会话 token 死线读取（教程 §3.3「主动轮换防永久 502」/ checklist B4）
//
// 现状：**本模块已实现、尚未接线。**
//   lib/index.js 现在只有 `const ROTATE_TOKEN_THRESHOLD = 660_602` 这个注释常量，
//   轮换判据实际只用了轮数（MAX_SESSION_TURNS）。本模块把「读 SQLite 实际用量」
//   和「三分支轮换判定」拆出来，下一轮由 index.js 在提交 prompt 前调用
//   shouldRotate({ turns, estimatedTokens: readEstimatedTokens(home, sessionId) }) 即可。
//
// 死线来历：786,432 * 0.84 = 660,602.88 → floor = 660,602。agy 单会话累积约 469 个内部步骤后
// 永久卡死报 502 The model is currently unreachable，所以必须在死线前主动软轮换。
//
// 读取实现：Node 24 内置 node:sqlite 的 DatabaseSync，以只读模式打开
//   <AGY_ISOLATED_HOME>/antigravity-cli/conversations/<agySessionId>.db，
// 不引任何第三方 sqlite 包。表名/列名按宽松探测，读不到一律返回 null，绝不抛。
// 读取是同步的（DatabaseSync / statSync）：接线时请在「每轮提交 prompt 前」调用一次，
// 不要放进流式回调里高频调。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** 660,602 = floor(786,432 * 0.84)，token 轮换死线；单一真值，tokenRotateThreshold() 由它对齐。 */
export const TOKEN_ROTATE_THRESHOLD = 660_602

/** 教程里的 model 上下文窗口上限与安全比例，阈值就是从这两个数来的。 */
export const CONTEXT_WINDOW_CAP = 786_432
export const TOKEN_SAFETY_RATIO = 0.84

/** 小于这个值的窗口是脏输入（会算出 0 阈值 → 任何用量都触发轮换），一律回落成上限。 */
export const MIN_USABLE_CONTEXT_WINDOW = 1024

/** 单会话轮数上限（与 index.js 的 MAX_SESSION_TURNS 对齐；两处各一份常量，改上限要同步）。 */
export const MAX_SESSION_TURNS = 200

/** 单次读取最多探多少候选列 / 扫多少张表：别让同步 I/O 在事件循环上越跑越久。 */
export const MAX_TOKEN_PROBES = 16
export const MAX_TABLES_SCANNED = 64

/** 会话 id 的合法形状：不许路径分隔符、不许 ..、不许 NUL，防拼出库目录之外的文件。 */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,256}$/

/** 光靠字符集挡不住 "." / ".."（path.join 会吃掉一级目录），单独判死。 */
function isSafeSessionId(agySessionId) {
  if (typeof agySessionId !== 'string' || !SESSION_ID_RE.test(agySessionId)) return false
  if (agySessionId === '.' || agySessionId === '..') return false
  if (agySessionId.startsWith('..')) return false
  return true
}

/** 由上下文窗口算死线：floor(Math.min(contextWindow, 786432) * 0.84)。 */
export function tokenRotateThreshold(contextWindow = CONTEXT_WINDOW_CAP) {
  const win =
    Number.isFinite(contextWindow) && contextWindow >= MIN_USABLE_CONTEXT_WINDOW ? contextWindow : CONTEXT_WINDOW_CAP
  return Math.floor(Math.min(win, CONTEXT_WINDOW_CAP) * TOKEN_SAFETY_RATIO)
}

/**
 * conversations 目录候选：默认 <home>/antigravity-cli/conversations，兼容把 home 指到子目录的写法。
 * 导出的公共函数，传入非法输入只返回空数组，不抛（path.join 遇到 NUL 字节会抛）。
 */
export function conversationDbCandidates(homeDir, agySessionId) {
  if (typeof homeDir !== 'string' || !homeDir) return []
  if (!isSafeSessionId(agySessionId)) return []
  try {
    const file = `${agySessionId}.db`
    return [
      path.join(homeDir, 'antigravity-cli', 'conversations', file),
      path.join(homeDir, 'conversations', file),
      path.join(homeDir, file),
    ]
  } catch {
    return []
  }
}

let sqliteModule
function loadSqlite() {
  // 缓存 null 的代价：运行期才给 Node 补实验标志也恢复不了，得重启进程。
  if (sqliteModule !== undefined) return sqliteModule
  try {
    const require = createRequire(import.meta.url)
    sqliteModule = require('node:sqlite')
  } catch {
    sqliteModule = null // 老 Node / 未开实验标志：调用方拿到 null，只能靠轮数兜底
  }
  return sqliteModule
}

/** node:sqlite 是否可用（接线方可以据此决定要不要打日志 / 走轮数兜底）。 */
export function sqliteAvailable() {
  return Boolean(loadSqlite()?.DatabaseSync)
}

const COLUMN_RE = /(estimated|token)/i
const TABLE_RE = /token/i
// 声明类型是文本/二进制时，CAST 出来的 0 多半是「这列不是数字」，别当真值
const TEXTISH_RE = /char|clob|text|blob/i

function quoteIdent(name) {
  // PRAGMA table_info 不接受参数绑定，只能拼标识符，所以必须自己转义双引号
  return `"${String(name).replace(/"/g, '""')}"`
}

function listTables(db) {
  try {
    // LIKE 里 '_' 是通配符，用 ESCAPE 才能真正表达 sqlite_ 前缀；再补一道 JS 过滤
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all()
    return rows
      .map((r) => r?.name)
      .filter((n) => typeof n === 'string' && n && !n.startsWith('sqlite_'))
      .slice(0, MAX_TABLES_SCANNED)
  } catch {
    return []
  }
}

function listColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all()
    return rows
      .filter((r) => typeof r?.name === 'string' && r.name)
      .map((r) => ({ name: r.name, type: typeof r.type === 'string' ? r.type : '' }))
  } catch {
    return []
  }
}

/**
 * 宽松探测候选列：先看表名含 token 的表，再退到全表扫列名含 estimated/token 的列。
 * 顺序即优先级（去重保序），MAX_TOKEN_PROBES 截断时先保「表名像用量表」的那批。
 */
function findCandidateColumns(db) {
  const seen = new Set()
  const candidates = []
  const registerCandidate = (table, column, declaredType) => {
    const id = `${table}\u0000${column}`
    if (seen.has(id)) return
    seen.add(id)
    candidates.push({ table, column, declaredType })
  }

  const byTable = new Map()
  for (const table of listTables(db)) byTable.set(table, listColumns(db, table))

  for (const [table, columns] of byTable) {
    if (!TABLE_RE.test(table)) continue
    for (const column of columns) if (COLUMN_RE.test(column.name)) registerCandidate(table, column.name, column.type)
  }
  for (const [table, columns] of byTable) {
    for (const column of columns) if (COLUMN_RE.test(column.name)) registerCandidate(table, column.name, column.type)
  }
  return candidates
}

function maxOfColumn(db, { table, column, declaredType }) {
  try {
    const row = db.prepare(`SELECT MAX(CAST(${quoteIdent(column)} AS INTEGER)) AS m FROM ${quoteIdent(table)}`).get()
    const n = Number(row?.m) // node:sqlite 可能给 BigInt，Number(10n) 正常；混合类型才会抛，已包在 catch 里
    if (!Number.isFinite(n) || n < 0) return null
    if (n === 0 && TEXTISH_RE.test(declaredType)) return null // 文本列 CAST 出的 0 当噪音
    return n
  } catch {
    return null
  }
}

/** 多个候选路径都存在时按 mtime 从新到旧排；最新那份读不出来时还能退到旧的。 */
function existingPathsNewestFirst(candidates) {
  const found = []
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) found.push({ file, mtimeMs: stat.mtimeMs })
    } catch {}
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((x) => x.file)
}

function readFromDbPath(sqlite, dbPath) {
  let db = null
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
    let best = null
    for (const candidate of findCandidateColumns(db).slice(0, MAX_TOKEN_PROBES)) {
      const value = maxOfColumn(db, candidate)
      if (value === null) continue
      if (best === null || value > best) best = value
    }
    return best
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

/**
 * 读某个 agy 会话已用的估算 token 数。
 * 读不到（文件不在 / 不是 sqlite / 结构探测失败 / 无 node:sqlite / 被写锁挡住）
 * 一律返回 null，绝不抛；调用方按 null 走轮数兜底，不自动重试（下一轮提交前再读一次即可）。
 * @param {string} homeDir AGY_ISOLATED_HOME（或直接指到 antigravity-cli / conversations）
 * @param {string} agySessionId 会话 id，对应 <id>.db
 * @returns {number|null}
 */
export function readEstimatedTokens(homeDir, agySessionId) {
  const sqlite = loadSqlite()
  if (!sqlite?.DatabaseSync) return null
  const candidates = conversationDbCandidates(homeDir, agySessionId)
  if (candidates.length === 0) return null
  for (const dbPath of existingPathsNewestFirst(candidates)) {
    const value = readFromDbPath(sqlite, dbPath)
    if (value !== null) return value // 取最新那份可读的；读不出来才退到更旧的副本
  }
  return null
}

/**
 * 轮换判定（纯函数）。轮数先判——两个条件同时满足时 reason 记 'turns'。
 * maxTurns / tokenThreshold 传非法值（非正数）时回落默认值，避免「阈值 0 → 每轮都换」。
 * estimatedTokens 为 null/NaN 时 Number() 得 0/NaN，都够不到正阈值，等价于「读不到 → 只按轮数判」；
 * Infinity 视为已超限。
 * @param {{ turns?: number, estimatedTokens?: number|null, maxTurns?: number, tokenThreshold?: number }} input
 * @returns {{ rotate: boolean, reason: 'turns'|'tokens'|null }}
 */
export function shouldRotate({
  turns,
  estimatedTokens,
  maxTurns = MAX_SESSION_TURNS,
  tokenThreshold = TOKEN_ROTATE_THRESHOLD,
} = {}) {
  const turnLimit = Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : MAX_SESSION_TURNS
  const tokenLimit = Number.isFinite(tokenThreshold) && tokenThreshold > 0 ? tokenThreshold : TOKEN_ROTATE_THRESHOLD
  const turnCount = Number(turns)
  if (Number.isFinite(turnCount) && turnCount >= turnLimit) return { rotate: true, reason: 'turns' }
  const tokens = Number(estimatedTokens)
  if (tokens === Infinity || (Number.isFinite(tokens) && tokens >= tokenLimit)) return { rotate: true, reason: 'tokens' }
  return { rotate: false, reason: null }
}

export default {
  TOKEN_ROTATE_THRESHOLD,
  CONTEXT_WINDOW_CAP,
  TOKEN_SAFETY_RATIO,
  MIN_USABLE_CONTEXT_WINDOW,
  MAX_SESSION_TURNS,
  MAX_TOKEN_PROBES,
  MAX_TABLES_SCANNED,
  tokenRotateThreshold,
  conversationDbCandidates,
  sqliteAvailable,
  readEstimatedTokens,
  shouldRotate,
}

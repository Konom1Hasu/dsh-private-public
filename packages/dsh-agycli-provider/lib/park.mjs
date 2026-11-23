// Park-and-Resume 的状态对象与查找工具。
//
// 一次 DSH step 里，adapter 的 stream() 吐出一个 tool-call block 后就 return（park）；
// DSH 本地执行完工具，下一轮 stream() 带着 role:'tool' 的 tool-result 消息回来，
// adapter 认出 toolCallId 属于某个 parked TurnState，把结果写回桥上挂起的 HTTP 响应（resume）。
//
// 这里只放纯数据结构和纯函数，进程/桥/流都在 index.js 里。

export const MAX_TURN_STATES = 3

// 末尾连续的 role:'tool' 消息就是本轮要回填的结果（中间一旦不是 tool 就停）
export function trailingToolResults(messages) {
  const out = []
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== 'tool') break
    if (typeof m.toolCallId === 'string' && m.toolCallId) out.unshift(m)
  }
  return out
}

export function toolResultText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

export function newTurnState({ sessionKey, acpSessionId, binding, turnSeq }) {
  return {
    sessionKey,
    turnSeq,
    status: 'prompting', // prompting | parked | resuming | done | aborted
    acpSessionId: acpSessionId ?? null,
    binding: binding ?? null,
    pendingCalls: new Map(), // toolCallId -> { bridgeCallKey, name, argsJson }
    bridgeCallIds: new Map(), // bridgeCallKey(=agy 的 request id) -> toolCallId
    seenToolResults: new Set(),
    events: [],
    waiters: new Set(),
    pumpDone: false,
    pumpError: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// 容量很小的 LRU：前台单号，同时挂着的 turn 不会多；淘汰时必须收掉挂起响应，否则泄漏 socket
export class TurnStateStore {
  constructor({ maxEntries = MAX_TURN_STATES, onEvict = null } = {}) {
    this.maxEntries = Math.max(1, maxEntries)
    this.onEvict = onEvict
    this.map = new Map()
  }

  get size() {
    return this.map.size
  }

  touch(key) {
    const state = this.map.get(key)
    if (!state) return null
    this.map.delete(key)
    this.map.set(key, state)
    return state
  }

  set(key, state) {
    this.map.set(key, state)
    this._evict(key)
    return state
  }

  delete(key) {
    return this.map.delete(key)
  }

  keys() {
    return [...this.map.keys()]
  }

  /** 只读遍历（不动 LRU 顺序）：权限校验这类旁路查询用。 */
  values() {
    return [...this.map.values()]
  }

  find(predicate) {
    for (const state of this.map.values()) {
      if (predicate(state)) return state
    }
    return null
  }

  _evict(keepKey) {
    while (this.map.size > this.maxEntries) {
      const victim = this.keys().find((k) => k !== keepKey)
      if (victim === undefined) break
      const state = this.map.get(victim)
      this.map.delete(victim)
      try { this.onEvict?.(state) } catch {}
    }
  }

  clear() {
    const all = [...this.map.values()]
    this.map.clear()
    return all
  }
}

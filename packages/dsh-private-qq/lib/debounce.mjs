/**
 * Per-chat sliding inbound debouncer.
 * - Coalesces rapid consecutive text messages within `debounceMs` (default 2000ms).
 * - Caps total wait at `maxWaitMs` (default 8000ms) so continuous typing still flushes.
 * - Immediately flushes if a message contains media, a quote-reply, or starts with '/'.
 */
export class InboundDebouncer {
  constructor({ debounceMs = 2000, maxWaitMs = 8000, onFlush }) {
    this.debounceMs = Number(debounceMs)
    this.maxWaitMs = Number(maxWaitMs)
    this.onFlush = onFlush
    this.buckets = new Map()
  }

  push(chatKey, msg) {
    const immediate =
      Boolean(msg.hasMedia) ||
      Boolean(msg.replyMsgId) ||
      String(msg.text || '').trim().startsWith('/')

    let bucket = this.buckets.get(chatKey)
    if (!bucket) {
      bucket = {
        msgs: [],
        firstAt: Date.now(),
        timer: null,
      }
      this.buckets.set(chatKey, bucket)
    }

    bucket.msgs.push(msg)

    if (bucket.timer) {
      clearTimeout(bucket.timer)
      bucket.timer = null
    }

    const elapsed = Date.now() - bucket.firstAt
    if (immediate || this.debounceMs <= 0 || elapsed >= this.maxWaitMs) {
      this._flush(chatKey)
      return
    }

    const remaining = Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - elapsed))
    bucket.timer = setTimeout(() => this._flush(chatKey), remaining)
  }

  _flush(chatKey) {
    const bucket = this.buckets.get(chatKey)
    if (!bucket) return
    if (bucket.timer) clearTimeout(bucket.timer)
    this.buckets.delete(chatKey)

    const msgs = bucket.msgs
    if (!msgs.length) return

    const last = msgs[msgs.length - 1]
    const mergedText = msgs
      .map((m) => String(m.text || '').trim())
      .filter(Boolean)
      .join('\n')
    const mergedAttachments = msgs.flatMap((m) => m.attachments || [])
    const replyMsgId = [...msgs].reverse().find((m) => m.replyMsgId)?.replyMsgId || null
    const replySummary = [...msgs].reverse().find((m) => m.replySummary)?.replySummary || ''

    const combined = {
      ...last,
      text: mergedText,
      attachments: mergedAttachments,
      hasMedia: mergedAttachments.length > 0 || msgs.some((m) => m.hasMedia),
      replyMsgId,
      replySummary,
      mergedIds: msgs.map((m) => m.rawId).filter(Boolean),
    }

    Promise.resolve(this.onFlush(chatKey, combined)).catch((err) => {
      console.warn('[private-qq] debounce flush error:', err?.message || err)
    })
  }

  dispose() {
    for (const chatKey of [...this.buckets.keys()]) {
      this._flush(chatKey)
    }
    this.buckets.clear()
  }
}

/**
 * Noise & flood filter adapted from Desktop/微信QQ接入/noise.mjs.
 * Note: For whitelisted owners in private chat, short replies like "嗯"/"1"/"好"
 * are allowed so confirmations and casual chat are never swallowed.
 */

const EMOJI_ONLY = /^[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}\s\p{P}~\u3000]+$/u
const MEANINGLESS = /^(嗯+|哦+|啊+|哈+|呵+|额+|呃+|草+|1+|6+|\.+|。+|\?+|？+|\s+)$/

export class NoiseFilter {
  constructor() {
    this.recent = new Map()
  }

  check(msg, cfg = {}, { isOwnerPrivate = false } = {}) {
    if (cfg.enabled === false) return { noise: false, why: '' }

    const text = String(msg.text || '').trim()
    const chatId = String(msg.chatId || '')
    const senderId = String(msg.senderId || '')

    if (cfg.ignoreBots && (msg.isBot || /^\[(CQ:at|机器人)/.test(text))) {
      return { noise: true, why: 'bot' }
    }

    if (!isOwnerPrivate) {
      if (cfg.ignorePureMedia && /^\[(发来|file)\]/.test(text)) {
        return { noise: true, why: 'pure-media' }
      }
      if (cfg.ignorePureEmoji && text && EMOJI_ONLY.test(text)) {
        return { noise: true, why: 'emoji-only' }
      }
      if (!msg.hasMedia && !msg.replyMsgId && MEANINGLESS.test(text)) {
        return { noise: true, why: 'meaningless' }
      }
      const minLen = Number(cfg.minTextLength ?? 2)
      if (!msg.hasMedia && !msg.replyMsgId && text.replace(/\s/g, '').length < minLen) {
        return { noise: true, why: 'too-short' }
      }
      for (const p of cfg.blockedPatterns || []) {
        try {
          if (new RegExp(p, 'i').test(text)) return { noise: true, why: 'pattern:' + p.slice(0, 12) }
        } catch {
          // ignore invalid regex
        }
      }
    }

    const maxPerMin = Number(cfg.maxPerMinute ?? (isOwnerPrivate ? 30 : 8))
    if (maxPerMin > 0) {
      const key = `${chatId}:${senderId}`
      const now = Date.now()
      const arr = (this.recent.get(key) || []).filter((t) => now - t < 60_000)
      arr.push(now)
      this.recent.set(key, arr)
      if (arr.length > maxPerMin) return { noise: true, why: 'flood' }
    }

    if (!isOwnerPrivate) {
      const maxRepeat = Number(cfg.maxSameRepeat ?? 3)
      if (maxRepeat > 0 && text) {
        const key = `${chatId}:${senderId}:${text.slice(0, 40)}`
        const now = Date.now()
        const hit = (this.recent.get(key) || []).filter((t) => now - t < 120_000)
        hit.push(now)
        this.recent.set(key, hit)
        if (hit.length > maxRepeat) return { noise: true, why: 'repeat' }
      }
    }

    return { noise: false, why: '' }
  }

  sweep(maxAgeMs = 300_000) {
    const now = Date.now()
    for (const [k, arr] of this.recent) {
      const kept = arr.filter((t) => now - t < maxAgeMs)
      if (!kept.length) this.recent.delete(k)
      else this.recent.set(k, kept)
    }
  }
}
